import { validDisclosureState, type DisclosureState } from './assessmentDisclosure';
import { assessmentArchiveKey, validAssessmentArchive, MAX_ASSESSMENT_ARCHIVES, type AssessmentArchive, type AssessmentArchiveIndex } from './assessmentArchive';
import { validFinalizationRequest, type AssessmentFinalizationRequest, type FinalizationScope } from './assessmentFinalization';
import { createAssessmentEventApproval, type AssessmentApprovalBinding } from './assessmentEventApproval';
import { createEvidenceApproval, verifyEvidenceApproval, validOrigin, type EvidenceApproval } from './evidenceApproval';
import { consentCoversEvent, validConsentState, utcTime, type EvidenceConsentState } from './evidenceConsent';
import type { UploadPrivacyContext } from './uploadPrivacyContext';
import type { UploadRetryState, UploadPauseReason } from './uploadState';
import { MAX_DELIVERY_BATCH_BYTES, type PreparedEventBatch, type DeliveryStatus } from './eventBatchManager';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Uri } from 'vscode';
import { EventValidationError, isUuid, validateEvent, type TrackerEvent } from './eventSchema';
import { PRIVACY_EVENT_TYPES, PRIVACY_REASON_CODES, type PrivacyReasonCode } from './privacyFilter';
import { EvidenceCipher, EvidenceEncryptionError, type EncryptionFailureCode, type EncryptionKeys, type EncryptionRequirements } from './evidenceEncryption';

export const LOCAL_QUEUE_FILENAME = 'event-queue.v1.sqlite';
export const MAX_QUEUE_BATCH = 1000;
// Allow JSON escaping overhead for diffs up to the common schema's 2 MiB limit.
export const MAX_QUEUE_EVENT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_QUEUE_STORAGE_BYTES = 100 * 1024 * 1024;
export const QUEUE_DATABASE_VERSION = 11;
// Shared with the worker proxy to distinguish live threads from abandoned threads in this process.
export const QUEUE_PROCESS_INSTANCE_ID = randomUUID();
export const ACTIVE_QUEUE_OWNERS = new Set<string>();
export type QueueFailureCode = 'operation_failed' | 'corrupt' | 'disk_full' | 'permission_denied' | 'locked' | 'storage_limit' | 'unavailable' | 'maintenance_active' | 'recording_active' | EncryptionFailureCode;
export interface QueueOptions {
	maxStorageBytes?: number;
	/** Internal ownership information supplied by the storage-worker proxy. */
	ownerId?: string;
	processInstanceId?: string;
	liveOwnerIds?: readonly string[];
	/** Internal only: production requests SecretStorage material through the worker's private channel. */
	keyProvider?: (requirements: EncryptionRequirements) => Promise<EncryptionKeys>;
}
export interface QueueHealth {
	pendingCount: number;
	storageBytes: number;
	maxStorageBytes: number;
	usageRatio: number;
	status: 'healthy' | 'warning' | 'full';
	interruptedSessionCount: number;
	recoveredSessionCount: number;
}
export interface RecordingSessionStatus {
	sessionId: string;
	status: 'active' | 'completed' | 'interrupted' | 'cancelled' | 'incomplete';
	startedAt: string;
	endedAt: string | null;
	reason: string | null;
}
export interface RecordingPrivacyHealth {
	rejectedCount: number;
	reasonCounts: Partial<Record<PrivacyReasonCode, number>>;
}
export type CleanupScope = 'legacy' | 'all';
export interface LocalDataSummary {
	pendingCount: number;
	legacySqliteCount: number;
	legacyPendingDeletionCount: number;
}
/** Deliberately contains no session identity, event objects or caller-provided strings. */
export interface RecordedEventSummary {
	total: number;
	counts: Partial<Record<TrackerEvent['eventType'], number>>;
}
export interface CleanupResult { deletedRecords: number; deletedSessions: number }

/** Deliberately excludes SQLite error details, paths and bound event contents. */
export class LocalEventQueueError extends Error {
	constructor(message: string, readonly code: QueueFailureCode = 'operation_failed') {
		super(message);
		this.name = 'LocalEventQueueError';
	}
}

/** Classify platform and SQLite errors without carrying their messages, paths or SQL. */
export function safeQueueError(error: unknown, message = 'Local event queue operation failed.'): LocalEventQueueError {
	if (error instanceof LocalEventQueueError) { return error; }
	if (error instanceof EvidenceEncryptionError) { return new LocalEventQueueError(message, error.code); }
	const details = error as { errcode?: number; code?: string } | undefined;
	const sqliteCode = typeof details?.errcode === 'number' ? details.errcode & 0xff : undefined;
	const code: QueueFailureCode = [11, 26].includes(sqliteCode ?? -1) ? 'corrupt'
		: sqliteCode === 13 || details?.code === 'ENOSPC' ? 'disk_full'
			: [3, 8, 14].includes(sqliteCode ?? -1) || ['EACCES', 'EPERM'].includes(details?.code ?? '') ? 'permission_denied'
				: [5, 6].includes(sqliteCode ?? -1) || details?.code === 'EBUSY' ? 'locked' : 'operation_failed';
	return new LocalEventQueueError(message, code);
}

type StorageUri = Pick<Uri, 'scheme' | 'fsPath'>;

function inside(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === '' || (path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path));
}

/** Resolve existing ancestors too, before creating a directory through a symlink. */
async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) { throw error; }
		return join(await canonicalPath(dirname(path)), basename(path));
	}
}

async function checkDatabaseFiles(path: string): Promise<void> {
	for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
		try {
			const info = await lstat(candidate);
			if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
				throw new LocalEventQueueError('Unsafe queue storage file.');
			}
			await chmod(candidate, 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
		}
	}
}

async function resolveStorageDirectory(globalStorageUri: StorageUri, workspaceFolders: readonly { uri: StorageUri }[]): Promise<string> {
	if (globalStorageUri.scheme !== 'file' || !isAbsolute(globalStorageUri.fsPath)) {
		throw new LocalEventQueueError('Queue storage requires a local globalStorageUri.');
	}
	const requested = resolve(globalStorageUri.fsPath);
	const directory = await canonicalPath(requested);
	for (const folder of workspaceFolders) {
		if (folder.uri.scheme === 'file' && (inside(resolve(folder.uri.fsPath), requested)
			|| inside(await canonicalPath(resolve(folder.uri.fsPath)), directory))) {
			throw new LocalEventQueueError('Queue storage must be outside workspace folders.');
		}
	}
	return directory;
}

/** Durable event storage; production runs all database operations on the storage thread. */
export class LocalEventQueue {
	private pending: Promise<void> = Promise.resolve();
	private closing = false;
	private closePromise?: Promise<void>;
	private storageLimited = false;
	private recoveredSessions = 0;
	private cipher?: EvidenceCipher;
	private maintenance = false;

	private constructor(private readonly database: DatabaseSync, private readonly path: string,
		private readonly maxStorageBytes: number, private readonly ownerId: string) { }

	/** Recheck before approving folders added after activation; includes symlink aliases. */
	static async assertStorageOutsideWorkspaces(globalStorageUri: StorageUri, workspaceFolders: readonly { uri: StorageUri }[]): Promise<void> {
		try { await resolveStorageDirectory(globalStorageUri, workspaceFolders); }
		catch { throw new LocalEventQueueError('Queue storage must be local and outside workspace folders.'); }
	}

	/** Pass context.globalStorageUri and vscode.workspace.workspaceFolders ?? []. */
	static async open(globalStorageUri: StorageUri, workspaceFolders: readonly { uri: StorageUri }[], options: QueueOptions = {}): Promise<LocalEventQueue> {
		let database: DatabaseSync | undefined;
		let queue: LocalEventQueue | undefined;
		const ownerId = options.ownerId ?? randomUUID();
		try {
			const maxStorageBytes = options.maxStorageBytes ?? DEFAULT_QUEUE_STORAGE_BYTES;
			if (!Number.isSafeInteger(maxStorageBytes) || maxStorageBytes < 1024 * 1024 || maxStorageBytes > 10 * 1024 * 1024 * 1024) {
				throw new LocalEventQueueError('Queue storage limit must be between 1 MiB and 10 GiB.');
			}
			const directory = await resolveStorageDirectory(globalStorageUri, workspaceFolders);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await chmod(directory, 0o700);
			const path = join(directory, LOCAL_QUEUE_FILENAME);
			await checkDatabaseFiles(path);
			// Create the database with private permissions before SQLite opens it.
			const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
			await file.close();
			database = new DatabaseSync(path, { allowExtension: false });
			database.exec('PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;');
			const version = database.prepare('PRAGMA user_version').get()?.user_version;
			if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, QUEUE_DATABASE_VERSION].includes(Number(version))) { throw new LocalEventQueueError('Unsupported queue database version.'); }
			const integrity = database.prepare('PRAGMA integrity_check(1)').all();
			if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
				throw new LocalEventQueueError('Queue database integrity check failed.', 'corrupt');
			}
			if (version === 0) {
				database.exec('BEGIN IMMEDIATE');
				try {
					// Recheck under the writer lock: another first-use window may have initialized it.
					if (database.prepare('PRAGMA user_version').get()?.user_version === 0) {
						if (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").get()) { throw new LocalEventQueueError('Unrecognized queue database.'); }
						database.exec(`
					CREATE TABLE queued_events (
						sequence INTEGER PRIMARY KEY AUTOINCREMENT,
						event_id TEXT NOT NULL UNIQUE,
						event_json TEXT,
						acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1)),
						CHECK (acknowledged = 1 OR event_json IS NOT NULL)
					) STRICT;
					CREATE INDEX pending_events ON queued_events(sequence) WHERE acknowledged = 0;
					PRAGMA user_version = 1;`);
					}
					database.exec('COMMIT');
				} catch (error) { try { database.exec('ROLLBACK'); } catch { /* Safe error below. */ } throw error; }
			}
			const journal = database.prepare('PRAGMA journal_mode').get()?.journal_mode === 'wal' ? 'wal'
				: database.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
			if (journal !== 'wal') { throw new LocalEventQueueError('Durable queue journaling unavailable.'); }
			// Avoid transaction spills; admission reserves WAL frames before COMMIT.
			database.exec('PRAGMA cache_spill = OFF; PRAGMA wal_autocheckpoint = 128;');
			queue = new LocalEventQueue(database, path, maxStorageBytes, ownerId);
			database.exec('BEGIN IMMEDIATE');
			try {
				// One consistent snapshot: another window cannot invalidate counter checks mid-startup.
				if (Number(database.prepare('PRAGMA user_version').get()?.user_version) < 4) { queue.verifyLegacyEvents(); }
				if (database!.prepare('PRAGMA user_version').get()?.user_version === 1) { queue.migrateRecoveryMetadata(); }
				if (database!.prepare('PRAGMA user_version').get()?.user_version === 2) {
					database!.exec(`CREATE TABLE recording_privacy_health (
						session_id TEXT PRIMARY KEY REFERENCES recording_sessions(session_id),
						rejected_count INTEGER NOT NULL CHECK(rejected_count >= 0), reason_counts TEXT NOT NULL
					) STRICT; PRAGMA user_version = 3;`);
				}
				if (database.prepare('PRAGMA user_version').get()?.user_version === 3) {
					// Add representation metadata only. Historical event JSON is not rewritten.
					database.exec(`ALTER TABLE queued_events ADD COLUMN payload_format INTEGER NOT NULL DEFAULT 0 CHECK(payload_format IN (0, 1));
						CREATE TABLE queue_encryption_keys (key_id TEXT PRIMARY KEY) STRICT;
						PRAGMA user_version = 4;`);
				}
				// A damaged legacy-format marker must not cause key creation before rejecting an encrypted envelope.
				queue.verifyLegacyEvents(true);
				const required = database.prepare('SELECT key_id FROM queue_encryption_keys LIMIT 33').all().map(row => String(row.key_id));
				if (required.length > 32 || required.some(id => !isUuid(id))
					|| database.prepare('SELECT 1 FROM queued_events WHERE payload_format = 1 LIMIT 1').get() && !required.length) {
					throw new LocalEventQueueError('Invalid queue encryption metadata.', 'corrupt');
				}
				// Hold the database writer lock through provisioning so simultaneous windows cannot replace first-use keys.
				if (options.keyProvider) {
					queue.cipher = new EvidenceCipher(await options.keyProvider({ keyIds: required }));
					if (required.some(id => !queue!.cipher!.hasKey(id))) { throw new EvidenceEncryptionError('key_missing'); }
					database.prepare('INSERT INTO queue_encryption_keys VALUES (?) ON CONFLICT DO NOTHING').run(queue.cipher.activeKeyId);
				} else if (required.length) { throw new EvidenceEncryptionError('key_missing'); }
				queue.verifyStoredEvents();
				if (database.prepare('PRAGMA user_version').get()?.user_version === 4) {
					database.exec(`ALTER TABLE queued_events ADD COLUMN session_id TEXT;
						ALTER TABLE queued_events ADD COLUMN acknowledged_at TEXT;
						CREATE INDEX retention_events ON queued_events(session_id, acknowledged, acknowledged_at);
						CREATE TABLE queue_maintenance(singleton INTEGER PRIMARY KEY CHECK(singleton = 1), owner_id TEXT NOT NULL) STRICT;
						CREATE TRIGGER count_event_delete AFTER DELETE ON queued_events WHEN OLD.acknowledged = 0
						BEGIN UPDATE queue_health SET pending_count = pending_count - 1 WHERE singleton = 1; END;
						CREATE TRIGGER count_session_delete AFTER DELETE ON recording_sessions WHEN OLD.status IN ('interrupted', 'incomplete')
						BEGIN UPDATE queue_health SET interrupted_count = interrupted_count - 1 WHERE singleton = 1; END;
						PRAGMA user_version = 5;`);
					// Index authenticated session IDs without rewriting any event payload. Old tombstone ages stay unknown.
					for (const row of database.prepare('SELECT event_id, event_json, payload_format FROM queued_events WHERE acknowledged = 0').iterate()) {
						const event = queue.readStoredEvent(row);
						database.prepare('UPDATE queued_events SET session_id = ? WHERE event_id = ?').run(event.sessionId, event.eventId);
					}
				}
				if (database.prepare('PRAGMA user_version').get()?.user_version === 5) {
					database.exec(`CREATE TABLE delivery_batches (
						batch_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, created_at TEXT NOT NULL,
						status TEXT NOT NULL CHECK(status IN ('active', 'delivered', 'released', 'recovered'))
					) STRICT;
					CREATE INDEX delivery_owners ON delivery_batches(owner_id, status);
					CREATE TABLE delivery_members (
						batch_id TEXT NOT NULL REFERENCES delivery_batches(batch_id), event_id TEXT NOT NULL REFERENCES queued_events(event_id),
						ordinal INTEGER NOT NULL CHECK(ordinal >= 0), claimed INTEGER NOT NULL CHECK(claimed IN (0, 1)),
						delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0, 1)),
						PRIMARY KEY(batch_id, event_id), UNIQUE(batch_id, ordinal), CHECK(claimed = 0 OR delivered = 0)
					) STRICT;
					CREATE UNIQUE INDEX delivery_claims ON delivery_members(event_id) WHERE claimed = 1;
					PRAGMA user_version = 6;`);
				}
				if (database.prepare('PRAGMA user_version').get()?.user_version === 6) {
					database.exec(`CREATE TABLE upload_retry_state (
						singleton INTEGER PRIMARY KEY CHECK(singleton = 1), endpoint_hash TEXT NOT NULL,
						attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 1000000), next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at >= 0),
						pause_reason TEXT CHECK(pause_reason IN ('authentication', 'configuration', 'protocol', 'privacy', 'storage')),
						owner_id TEXT
					) STRICT; PRAGMA user_version = 7;`);
				}
				if (database.prepare('PRAGMA user_version').get()?.user_version === 7) {
					database.exec(`CREATE TABLE event_approvals (event_id TEXT PRIMARY KEY REFERENCES queued_events(event_id), approval_json TEXT NOT NULL) STRICT;
						CREATE TABLE evidence_consents (session_id TEXT PRIMARY KEY, consent_json TEXT NOT NULL) STRICT;
						CREATE TABLE approval_revocations (session_id TEXT PRIMARY KEY, revocation_json TEXT NOT NULL) STRICT;
						PRAGMA user_version = 8;`);
				}
				if (database.prepare('PRAGMA user_version').get()?.user_version === 8) {
					database.exec(`CREATE TABLE assessment_finalizations (request_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL) STRICT;
						CREATE TABLE finalization_recordings (session_id TEXT PRIMARY KEY REFERENCES recording_sessions(session_id),
						request_id TEXT NOT NULL REFERENCES assessment_finalizations(request_id)) STRICT;
						PRAGMA user_version = 9;`);
				}
				if (database.prepare('PRAGMA user_version').get()?.user_version === 9) {
					database.exec(`CREATE TABLE assessment_archives (archive_id TEXT PRIMARY KEY, assessment_key TEXT NOT NULL, archive_json TEXT NOT NULL) STRICT;
						CREATE INDEX archived_assessments ON assessment_archives(assessment_key);
						CREATE TABLE assessment_archive_recordings (session_id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES assessment_archives(archive_id)) STRICT;
						CREATE INDEX archive_recordings ON assessment_archive_recordings(archive_id); PRAGMA user_version = 10;`);
				}
				if (database.prepare('PRAGMA user_version').get()?.user_version === 10) {
					database.exec(`CREATE TABLE disclosure_consents (request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state_json TEXT NOT NULL) STRICT;
						CREATE INDEX disclosure_recordings ON disclosure_consents(session_id); PRAGMA user_version = 11;`);
				}
				queue.readAssessmentArchiveIndex();
				queue.verifyCounters();
				queue.verifyDeliveryState();
				const pageSize = Number(database!.prepare('PRAGMA page_size').get()?.page_size);
				database!.exec(`PRAGMA max_page_count = ${Math.floor(maxStorageBytes / pageSize)}`);
				queue.recoverOwners(options);
				database.exec('COMMIT');
			} catch (error) { try { database.exec('ROLLBACK'); } catch { /* Safe opening error below. */ } throw error; }
			await checkDatabaseFiles(path);
			ACTIVE_QUEUE_OWNERS.add(ownerId);
			return queue;
		} catch (error) {
			queue?.cipher?.dispose();
			try { database?.close(); } catch { /* Preserve the safe opening error. */ }
			ACTIVE_QUEUE_OWNERS.delete(ownerId);
			throw safeQueueError(error, 'Unable to open local event queue.');
		}
	}

	enqueue(event: unknown): Promise<void> { return this.enqueueSnapshot(event); }

	/** Only EventPersistence calls this after filtering; event and approval commit in one transaction. */
	enqueueApproved(event: unknown, context: UploadPrivacyContext): Promise<void> { return this.enqueueSnapshot(event, context); }

	private enqueueSnapshot(event: unknown, context?: UploadPrivacyContext): Promise<void> {
		if (this.closing) { return Promise.reject(new LocalEventQueueError('Local event queue is closed.')); }
		const validation = validateEvent(event);
		if (!validation.valid) { return Promise.reject(new EventValidationError(validation.errors)); }
		// Snapshot before scheduling: callers cannot change the persisted event later.
		const json = JSON.stringify(validation.event);
		if (Buffer.byteLength(json) > MAX_QUEUE_EVENT_BYTES) {
			return Promise.reject(new LocalEventQueueError('Queue event exceeds size limit.'));
		}
		const eventId = validation.event.eventId;
		let proof: EvidenceApproval | undefined;
		try { if (context) { proof = createEvidenceApproval(validation.event, context); } }
		catch { return Promise.reject(new LocalEventQueueError('Evidence approval validation failed.')); }
		return this.schedule(async () => {
			this.assertCollectionAllowed();
			// Deduplication is permitted even if no space remains; never revive an acknowledged ID.
			const existing = this.database.prepare('SELECT event_id, event_json, payload_format, session_id, acknowledged FROM queued_events WHERE event_id = ?').get(eventId);
			if (existing) {
				// No approval is ever added to an existing legacy row. Approved snapshots are immutable.
				if (!existing.acknowledged && this.database.prepare('SELECT 1 FROM event_approvals WHERE event_id = ?').get(eventId)
					&& JSON.stringify(this.readStoredEvent(existing)) !== json) { throw new LocalEventQueueError('Conflicting approved event.'); }
				return;
			}
			if (!this.cipher) { throw new EvidenceEncryptionError('key_storage_unavailable'); }
			const encrypted = JSON.stringify(this.cipher.encrypt(eventId, json));
			// Include Base64/format overhead in admission; never reserve merely the plaintext size.
			await this.writeWithReservation(Buffer.byteLength(encrypted) + (proof ? Buffer.byteLength(JSON.stringify(proof)) * 2 + 2048 : 0), () => {
				this.assertCollectionAllowed();
				// Recheck under BEGIN IMMEDIATE: a different extension window may have committed meanwhile.
				const raced = this.database.prepare('SELECT event_id, event_json, payload_format, session_id, acknowledged FROM queued_events WHERE event_id = ?').get(eventId);
				if (raced) {
					if (!raced.acknowledged && this.database.prepare('SELECT 1 FROM event_approvals WHERE event_id = ?').get(eventId)
						&& JSON.stringify(this.readStoredEvent(raced)) !== json) { throw new LocalEventQueueError('Conflicting approved event.'); }
					return;
				}
				if (this.isArchivedRecording(validation.event.sessionId) || this.database.prepare('SELECT 1 FROM finalization_recordings WHERE session_id = ?').get(validation.event.sessionId)) {
					throw new LocalEventQueueError('Recording evidence is frozen.');
				}
				let encryptedApproval: string | undefined;
				if (proof && !this.isApprovalRevoked(validation.event.sessionId)) {
					const scope = this.readEvidenceConsent(validation.event.sessionId);
					if (scope) {
						proof.assessment = { codingSessionId: scope.codingSessionId, origin: scope.origin,
							...(consentCoversEvent(scope, validation.event) ? { consentId: scope.receipt!.consent_id } : {}) };
						if (proof.assessment.consentId) {
							proof.version = 2;
							proof.assessmentEventApproval = createAssessmentEventApproval(validation.event, proof.assessment.consentId);
						}
					}
					encryptedApproval = JSON.stringify(this.cipher!.encrypt(eventId, JSON.stringify(proof), 'approval'));
				}
				this.database.prepare(`INSERT INTO recording_sessions(session_id, status, started_at, owner_id)
					VALUES (?, 'active', ?, ?) ON CONFLICT(session_id) DO NOTHING`)
					.run(validation.event.sessionId, validation.event.timestamp, this.ownerId);
				this.database.prepare('INSERT INTO queued_events(event_id, event_json, payload_format, session_id) VALUES (?, ?, 1, ?) ON CONFLICT(event_id) DO NOTHING')
					.run(eventId, encrypted, validation.event.sessionId);
				if (encryptedApproval) { this.database.prepare('INSERT INTO event_approvals VALUES (?, ?)').run(eventId, encryptedApproval); }
			});
		});
	}

	/** Exact, authenticated, capture-time approval only. Assessments remain blocked pending a Rails proof protocol. */
	getUploadPrivacyContext(event: TrackerEvent): Promise<UploadPrivacyContext | undefined> {
		const validated = validateEvent(event);
		if (!validated.valid) { return Promise.resolve(undefined); }
		const snapshot = JSON.stringify(validated.event);
		return this.schedule(() => {
			const current = JSON.parse(snapshot) as TrackerEvent;
			if (this.isArchivedRecording(current.sessionId) || this.isApprovalRevoked(current.sessionId) || this.readEvidenceConsent(current.sessionId)) { return undefined; }
			const row = this.database.prepare(`SELECT e.event_id, e.event_json, e.payload_format, e.session_id, a.approval_json
				FROM queued_events e JOIN event_approvals a ON a.event_id = e.event_id WHERE e.event_id = ? AND e.acknowledged = 0`).get(current.eventId);
			if (!row) { return undefined; }
			if (row.payload_format !== 1) { throw new EvidenceEncryptionError('authentication_failed'); }
			if (!this.cipher) { throw new EvidenceEncryptionError('key_missing'); }
			const stored = this.readStoredEvent(row);
			if (JSON.stringify(stored) !== snapshot) { return undefined; }
			let proof: EvidenceApproval;
			try { proof = verifyEvidenceApproval(this.cipher.decrypt(current.eventId, JSON.parse(String(row.approval_json)), 'approval'), stored); }
			catch { throw new EvidenceEncryptionError('authentication_failed'); }
			if (proof.assessment) { return undefined; }
			return { ...proof.context, exactEventDigest: proof.eventDigest };
		});
	}

	/** Preparation only: returns an existing capture-time envelope. Does not authorize network transmission. */
	getAssessmentUploadContext(event: TrackerEvent, binding: AssessmentApprovalBinding): Promise<UploadPrivacyContext | undefined> {
		const validation = validateEvent(event);
		if (!validation.valid || !binding || typeof binding.codingSessionId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(binding.codingSessionId)
			|| !validOrigin(binding.origin) || !isUuid(binding.consentReceiptId) || !utcTime(binding.serverTime)
			|| Object.keys(binding).length !== 4) { return Promise.resolve(undefined); }
		const json = JSON.stringify(validation.event); const target = { ...binding };
		return this.schedule(() => {
			const current = JSON.parse(json) as TrackerEvent;
			if (this.isArchivedRecording(current.sessionId) || this.isApprovalRevoked(current.sessionId)) { return undefined; }
			const scope = this.readEvidenceConsent(current.sessionId); const receipt = scope?.receipt;
			if (scope && this.isArchivedAssessment(scope.codingSessionId, scope.origin)) { return undefined; }
			if (!scope || !receipt || scope.locallyRevoked || scope.pendingAction || !['active', 'stopped'].includes(receipt.state)
				|| scope.captureClosed && receipt.state !== 'stopped' || scope.codingSessionId !== target.codingSessionId || scope.origin !== target.origin
				|| receipt.consent_id !== target.consentReceiptId || receipt.destination_origin !== target.origin
				|| Date.parse(target.serverTime) < Date.parse(receipt.server_time) || Date.parse(target.serverTime) >= Date.parse(receipt.expires_at)
				|| Date.parse(target.serverTime) >= Date.parse(scope.deadline) || Date.parse(current.timestamp) > Date.parse(target.serverTime)
				|| Date.parse(current.timestamp) < Date.parse(receipt.evidence_window.starts_at) || Date.parse(current.timestamp) > Date.parse(receipt.evidence_window.ends_at)
				|| !receipt.approved_workspace_ids.includes(current.workspaceId!) || !receipt.event_types.includes(current.eventType)) { return undefined; }
			const row = this.database.prepare(`SELECT e.event_id, e.event_json, e.payload_format, e.session_id, a.approval_json
				FROM queued_events e JOIN event_approvals a ON a.event_id = e.event_id WHERE e.event_id = ? AND e.acknowledged = 0`).get(current.eventId);
			if (!row) { return undefined; }
			if (row.payload_format !== 1 || !this.cipher) { throw new EvidenceEncryptionError('authentication_failed'); }
			const stored = this.readStoredEvent(row); if (JSON.stringify(stored) !== json) { return undefined; }
			let proof: EvidenceApproval;
			try { proof = verifyEvidenceApproval(this.cipher.decrypt(current.eventId, JSON.parse(String(row.approval_json)), 'approval'), stored); }
			catch { throw new EvidenceEncryptionError('authentication_failed'); }
			if (proof.version !== 2 || !proof.assessmentEventApproval || proof.assessment?.codingSessionId !== target.codingSessionId
				|| proof.assessment.origin !== target.origin || proof.assessment.consentId !== target.consentReceiptId) { return undefined; }
			return { ...proof.context, exactEventDigest: proof.eventDigest, assessmentEventApproval: proof.assessmentEventApproval, assessmentApprovalBinding: target };
		});
	}

	revokeEvidenceApprovals(sessionId: string): Promise<void> {
		if (!isUuid(sessionId)) { return Promise.reject(new LocalEventQueueError('Invalid approval scope.')); }
		return this.schedule(async () => {
			if (!this.cipher) { throw new EvidenceEncryptionError('key_missing'); }
			const encrypted = JSON.stringify(this.cipher.encrypt(sessionId, JSON.stringify({ version: 1, sessionId, revoked: true }), 'revocation'));
			await this.writeWithReservation(Buffer.byteLength(encrypted), () => {
				if (this.isArchivedRecording(sessionId)) { throw new LocalEventQueueError('Archived evidence scope is immutable.'); }
				this.database.prepare('INSERT INTO approval_revocations VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING').run(sessionId, encrypted);
			});
		});
	}
	private isApprovalRevoked(sessionId: string): boolean {
		const row = this.database.prepare('SELECT revocation_json FROM approval_revocations WHERE session_id = ?').get(sessionId);
		if (!row) { return false; }
		const value = this.cipher?.decrypt(sessionId, JSON.parse(String(row.revocation_json)), 'revocation') as { version: number; sessionId: string; revoked: boolean } | undefined;
		if (!value || value.version !== 1 || value.sessionId !== sessionId || value.revoked !== true) { throw new EvidenceEncryptionError('authentication_failed'); }
		return true;
	}
	getEvidenceConsent(sessionId: string): Promise<EvidenceConsentState | undefined> {
		if (!isUuid(sessionId)) { return Promise.reject(new LocalEventQueueError('Invalid consent scope.')); }
		return this.schedule(() => this.readEvidenceConsent(sessionId));
	}
	private readEvidenceConsent(sessionId: string): EvidenceConsentState | undefined {
		const row = this.database.prepare('SELECT consent_json FROM evidence_consents WHERE session_id = ?').get(sessionId);
		if (!row) { return undefined; }
		const value = this.cipher?.decrypt(sessionId, JSON.parse(String(row.consent_json)), 'consent') as EvidenceConsentState;
		if (!value || !validConsentState(value) || value.request.local_recording_session_id !== sessionId) { throw new EvidenceEncryptionError('authentication_failed'); }
		return value;
	}
	/** State updates cannot move a recording to another assessment, reopen capture, or undo revocation. */
	setEvidenceConsent(state: EvidenceConsentState): Promise<void> {
		let snapshot: EvidenceConsentState;
		try { snapshot = JSON.parse(JSON.stringify(state)); if (!validConsentState(snapshot)) { throw new Error(); } }
		catch { return Promise.reject(new LocalEventQueueError('Invalid evidence consent.')); }
		return this.schedule(async () => {
			const id = snapshot.request.local_recording_session_id;
			if (this.isArchivedRecording(id) || this.isArchivedAssessment(snapshot.codingSessionId, snapshot.origin)) { throw new LocalEventQueueError('Archived evidence scope is immutable.'); }
			if (!this.cipher) { throw new EvidenceEncryptionError('key_missing'); }
			const encrypted = JSON.stringify(this.cipher.encrypt(id, JSON.stringify(snapshot), 'consent'));
			await this.writeWithReservation(Buffer.byteLength(encrypted), () => {
				if (this.isArchivedRecording(id) || this.isArchivedAssessment(snapshot.codingSessionId, snapshot.origin)) { throw new LocalEventQueueError('Archived evidence scope is immutable.'); }
				const previous = this.readEvidenceConsent(id);
				if (previous && (previous.codingSessionId !== snapshot.codingSessionId || previous.origin !== snapshot.origin
					|| JSON.stringify(previous.request) !== JSON.stringify(snapshot.request) || previous.deadline !== snapshot.deadline
					|| previous.credentialDigest !== snapshot.credentialDigest
					|| previous.locallyRevoked && !snapshot.locallyRevoked || previous.captureClosed && !snapshot.captureClosed
					|| previous.receipt && (!snapshot.receipt || previous.receipt.consent_id !== snapshot.receipt.consent_id
						|| previous.receipt.consented_at !== snapshot.receipt.consented_at || previous.receipt.expires_at !== snapshot.receipt.expires_at
						|| Date.parse(snapshot.receipt.server_time) < Date.parse(previous.receipt.server_time)
						|| Date.parse(snapshot.receipt.evidence_window.ends_at) > Date.parse(previous.receipt.evidence_window.ends_at)
						|| previous.receipt.state === 'revoked' && snapshot.receipt.state !== 'revoked'
						|| previous.receipt.evidence_window.stopped_at !== undefined && snapshot.receipt.evidence_window.stopped_at !== previous.receipt.evidence_window.stopped_at))) {
					throw new LocalEventQueueError('Conflicting evidence consent.');
				}
				// An existing event can never acquire assessment authorization retroactively.
				if (!previous && this.database.prepare('SELECT 1 FROM queued_events WHERE session_id = ? LIMIT 1').get(id)) {
					throw new LocalEventQueueError('Evidence scope must precede capture.');
				}
				this.database.prepare('INSERT INTO evidence_consents VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET consent_json = excluded.consent_json').run(id, encrypted);
			});
		});
	}

	getDisclosureConsents(sessionId: string): Promise<DisclosureState[]> {
		if (!isUuid(sessionId)) { return Promise.reject(new LocalEventQueueError('Invalid disclosure scope.')); }
		return this.schedule(() => this.readDisclosureConsents(sessionId));
	}
	private readDisclosureConsents(sessionId: string): DisclosureState[] {
		return this.database.prepare('SELECT request_id, state_json FROM disclosure_consents WHERE session_id = ? ORDER BY rowid LIMIT 129').all(sessionId).map(row => {
			const value = this.cipher?.decrypt(String(row.request_id), JSON.parse(String(row.state_json)), 'disclosure') as DisclosureState;
			if (!validDisclosureState(value) || value.request.request_id !== row.request_id || value.request.local_recording_session_id !== sessionId) { throw new EvidenceEncryptionError('authentication_failed'); }
			return value;
		});
	}
	/** Disclosure receipts do not create or change event approvals. Archived scopes remain immutable. */
	setDisclosureConsent(state: DisclosureState): Promise<void> {
		let snapshot: DisclosureState;
		try { snapshot = JSON.parse(JSON.stringify(state)); if (!validDisclosureState(snapshot)) { throw new Error(); } }
		catch { return Promise.reject(new LocalEventQueueError('Invalid disclosure consent.')); }
		return this.schedule(async () => {
			if (!this.cipher) { throw new EvidenceEncryptionError('key_missing'); }
			const id = snapshot.request.local_recording_session_id;
			const encrypted = JSON.stringify(this.cipher.encrypt(snapshot.request.request_id, JSON.stringify(snapshot), 'disclosure'));
			await this.writeWithReservation(Buffer.byteLength(encrypted), () => {
				if (this.isArchivedRecording(id) || this.isArchivedAssessment(snapshot.codingSessionId, snapshot.origin)) { throw new LocalEventQueueError('Archived evidence scope is immutable.'); }
				const upload = this.readEvidenceConsent(id);
				if (!upload || upload.codingSessionId !== snapshot.codingSessionId || upload.origin !== snapshot.origin
					|| upload.credentialDigest !== snapshot.credentialDigest || upload.deadline !== snapshot.deadline
					|| upload.receipt?.consent_id !== snapshot.request.upload_consent_id
					|| snapshot.request.approved_workspace_ids.some(w => !upload.request.approved_workspace_ids.includes(w))
					|| snapshot.receipt && (Date.parse(snapshot.receipt.expires_at) > Date.parse(upload.receipt!.expires_at)
						|| Date.parse(snapshot.receipt.consented_at) < Date.parse(upload.receipt!.consented_at))) { throw new LocalEventQueueError('Conflicting disclosure scope.'); }
				const states = this.readDisclosureConsents(id);
				const previous = states.find(s => s.request.request_id === snapshot.request.request_id);
				if (!previous && (states.length >= 128 || upload.locallyRevoked || upload.captureClosed || upload.pendingAction || upload.receipt.state !== 'active')) { throw new LocalEventQueueError('Disclosure scope unavailable.'); }
				if (previous && (JSON.stringify({ ...previous, receipt: undefined, pendingAction: undefined, locallyRevoked: false }) !== JSON.stringify({ ...snapshot, receipt: undefined, pendingAction: undefined, locallyRevoked: false })
					|| previous.locallyRevoked && !snapshot.locallyRevoked
					|| previous.receipt && (!snapshot.receipt || previous.receipt.consent_id !== snapshot.receipt.consent_id
						|| previous.receipt.consented_at !== snapshot.receipt.consented_at || previous.receipt.expires_at !== snapshot.receipt.expires_at
						|| Date.parse(snapshot.receipt.server_time) < Date.parse(previous.receipt.server_time)
						|| previous.receipt.revoked_at !== null && snapshot.receipt.revoked_at !== previous.receipt.revoked_at))) { throw new LocalEventQueueError('Conflicting disclosure consent.'); }
				this.database.prepare('INSERT INTO disclosure_consents VALUES (?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET state_json = excluded.state_json WHERE session_id = excluded.session_id')
					.run(snapshot.request.request_id, id, encrypted);
				const saved = this.database.prepare('SELECT session_id FROM disclosure_consents WHERE request_id = ?').get(snapshot.request.request_id);
				if (saved?.session_id !== id) { throw new LocalEventQueueError('Conflicting disclosure scope.'); }
			});
		});
	}

	getPending(limit: number): Promise<TrackerEvent[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUEUE_BATCH) {
			return Promise.reject(new LocalEventQueueError('Pending limit must be between 1 and 1000.'));
		}
		return this.schedule(() => this.database.prepare(
			'SELECT event_id, event_json, payload_format, session_id FROM queued_events WHERE acknowledged = 0 ORDER BY sequence LIMIT ?'
		).all(limit).map(row => this.readStoredEvent(row)));
	}

	markAcknowledged(eventIds: readonly string[]): Promise<void> {
		if (!Array.isArray(eventIds) || eventIds.length > MAX_QUEUE_BATCH || !eventIds.every(isUuid)) {
			return Promise.reject(new LocalEventQueueError('Invalid acknowledgment batch.'));
		}
		const ids = [...new Set(eventIds)];
		return this.schedule(() => this.transaction(() => {
			this.assertCollectionAllowed();
			const update = this.database.prepare('UPDATE queued_events SET acknowledged = 1, event_json = NULL, acknowledged_at = COALESCE(acknowledged_at, ?) WHERE event_id = ?');
			const now = new Date().toISOString();
			for (const id of ids) {
				this.assertUnarchivedEvent(id);
				if (this.database.prepare('SELECT 1 FROM delivery_members WHERE event_id = ? AND claimed = 1').get(id)) {
					throw new LocalEventQueueError('Claimed events require batch acknowledgment.');
				}
				update.run(now, id);
			}
		}));
	}

	prepareBatch(maxEvents: number, maxBytes: number, localSessionId?: string): Promise<PreparedEventBatch | null> {
		if (localSessionId !== undefined && !isUuid(localSessionId) || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_QUEUE_BATCH
			|| !Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > MAX_DELIVERY_BATCH_BYTES) {
			return Promise.reject(new LocalEventQueueError('Invalid delivery batch limits.'));
		}
		return this.schedule(async () => {
			let batch: PreparedEventBatch | null = null;
			const scope = `AND NOT EXISTS (SELECT 1 FROM assessment_archive_recordings a WHERE a.session_id = e.session_id) ${localSessionId === undefined ? '' : 'AND e.session_id = ?'}`;
			const parameters = localSessionId === undefined ? [] : [localSessionId];
			this.assertCollectionAllowed();
			if (!this.database.prepare(`SELECT 1 FROM queued_events e WHERE e.acknowledged = 0 ${scope} AND NOT EXISTS
				(SELECT 1 FROM delivery_members m WHERE m.event_id = e.event_id AND m.claimed = 1) LIMIT 1`).get(...parameters)) { return null; }
			await this.writeWithReservation(maxEvents * 512, () => {
				this.assertCollectionAllowed();
				const events: TrackerEvent[] = []; let byteSize = 2;
				for (const row of this.database.prepare(`SELECT e.event_id, e.event_json, e.payload_format, e.session_id
					FROM queued_events e WHERE e.acknowledged = 0 ${scope} AND NOT EXISTS
					(SELECT 1 FROM delivery_members m WHERE m.event_id = e.event_id AND m.claimed = 1)
					ORDER BY e.sequence LIMIT ?`).iterate(...parameters, maxEvents)) {
					const event = this.readStoredEvent(row);
					const bytes = Buffer.byteLength(JSON.stringify(event)) + (events.length ? 1 : 0);
					if (byteSize + bytes > maxBytes) {
						if (!events.length) { throw new LocalEventQueueError('Oldest available event exceeds batch byte limit.'); }
						break;
					}
					events.push(event); byteSize += bytes;
				}
				if (!events.length) { return; }
				batch = { batchId: randomUUID(), createdAt: new Date().toISOString(), byteSize, events };
				this.database.prepare("INSERT INTO delivery_batches VALUES (?, ?, ?, 'active')").run(batch.batchId, this.ownerId, batch.createdAt);
				const insert = this.database.prepare('INSERT INTO delivery_members(batch_id, event_id, ordinal, claimed) VALUES (?, ?, ?, 1)');
				events.forEach((event, index) => insert.run(batch!.batchId, event.eventId, index));
			});
			return batch;
		});
	}

	markDelivered(batchId: string, acknowledgedEventIds: readonly string[]): Promise<void> {
		if (!isUuid(batchId) || !Array.isArray(acknowledgedEventIds) || acknowledgedEventIds.length > MAX_QUEUE_BATCH || !acknowledgedEventIds.every(isUuid)) {
			return Promise.reject(new LocalEventQueueError('Invalid delivery acknowledgment.'));
		}
		const ids = [...new Set(acknowledgedEventIds)];
		return this.schedule(() => this.transaction(() => {
			this.assertCollectionAllowed();
			const batch = this.ownedBatch(batchId);
			if (!['active', 'delivered'].includes(String(batch.status))) { throw new LocalEventQueueError('Delivery batch is no longer active.'); }
			for (const id of ids) {
				this.assertUnarchivedEvent(id);
				const member = this.database.prepare('SELECT claimed, delivered FROM delivery_members WHERE batch_id = ? AND event_id = ?').get(batchId, id);
				if (!member || !member.claimed && !member.delivered) { throw new LocalEventQueueError('Acknowledgment does not belong to this batch.'); }
			}
			const now = new Date().toISOString();
			for (const id of ids) {
				this.database.prepare('UPDATE queued_events SET acknowledged = 1, event_json = NULL, acknowledged_at = COALESCE(acknowledged_at, ?) WHERE event_id = ?').run(now, id);
				this.database.prepare('UPDATE delivery_members SET claimed = 0, delivered = 1 WHERE batch_id = ? AND event_id = ?').run(batchId, id);
			}
			this.database.prepare(`UPDATE delivery_batches SET status = 'delivered' WHERE batch_id = ? AND NOT EXISTS
				(SELECT 1 FROM delivery_members WHERE batch_id = ? AND claimed = 1)`).run(batchId, batchId);
		}));
	}

	releaseBatch(batchId: string): Promise<void> {
		if (!isUuid(batchId)) { return Promise.reject(new LocalEventQueueError('Invalid delivery batch ID.')); }
		return this.schedule(() => this.transaction(() => {
			this.assertCollectionAllowed(); const batch = this.ownedBatch(batchId);
			if (batch.status !== 'active') { return; }
			this.database.prepare('UPDATE delivery_members SET claimed = 0 WHERE batch_id = ?').run(batchId);
			this.database.prepare("UPDATE delivery_batches SET status = 'released' WHERE batch_id = ?").run(batchId);
		}));
	}

	getDeliveryStatus(): Promise<DeliveryStatus> {
		return this.schedule(() => {
			// A single read snapshot keeps totals consistent with other windows' transactions.
			const row = this.database.prepare(`SELECT (SELECT pending_count FROM queue_health WHERE singleton = 1) AS pending,
				(SELECT COUNT(*) FROM delivery_members WHERE claimed = 1) AS claimed,
				(SELECT COUNT(*) FROM delivery_batches WHERE status = 'active') AS active,
				(SELECT COUNT(*) FROM delivery_batches WHERE status = 'delivered') AS delivered,
				(SELECT COUNT(*) FROM delivery_batches WHERE status = 'released') AS released,
				(SELECT COUNT(*) FROM delivery_batches WHERE status = 'recovered') AS recovered`).get()!;
			return { pendingEvents: Number(row.pending), claimedEvents: Number(row.claimed), availableEvents: Number(row.pending) - Number(row.claimed),
				activeBatches: Number(row.active), deliveredBatches: Number(row.delivered), releasedBatches: Number(row.released), recoveredBatches: Number(row.recovered) };
		});
	}

	private ownedBatch(batchId: string): { [key: string]: unknown } {
		const row = this.database.prepare('SELECT owner_id, status FROM delivery_batches WHERE batch_id = ?').get(batchId);
		if (!row || row.owner_id !== this.ownerId) { throw new LocalEventQueueError('Delivery batch is unavailable to this worker.'); }
		return row;
	}
	private releaseOwnerBatches(ownerId: string, status: 'released' | 'recovered'): void {
		this.database.prepare('UPDATE upload_retry_state SET owner_id = NULL WHERE owner_id = ?').run(ownerId);
		this.database.prepare(`UPDATE delivery_members SET claimed = 0 WHERE batch_id IN
			(SELECT batch_id FROM delivery_batches WHERE owner_id = ? AND status = 'active')`).run(ownerId);
		this.database.prepare("UPDATE delivery_batches SET status = ? WHERE owner_id = ? AND status = 'active'").run(status, ownerId);
	}
	private verifyDeliveryState(): void {
		const retry = this.database.prepare('SELECT * FROM upload_retry_state').get();
		if (retry && (!/^[a-f0-9]{64}$/.test(String(retry.endpoint_hash)) || !Number.isSafeInteger(retry.next_attempt_at)
			|| retry.owner_id !== null && (!isUuid(retry.owner_id) || !this.database.prepare('SELECT 1 FROM queue_owners WHERE owner_id = ?').get(retry.owner_id)))) {
			throw new LocalEventQueueError('Invalid upload retry metadata.', 'corrupt');
		}
		for (const row of this.database.prepare('SELECT * FROM delivery_batches').iterate()) {
			if (!isUuid(row.batch_id) || !isUuid(row.owner_id) || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))
				|| row.status === 'active' && (!this.database.prepare('SELECT 1 FROM queue_owners WHERE owner_id = ?').get(row.owner_id)
					|| !this.database.prepare('SELECT 1 FROM delivery_members WHERE batch_id = ? AND claimed = 1').get(row.batch_id))) {
				throw new LocalEventQueueError('Invalid delivery ownership metadata.', 'corrupt');
			}
		}
		if (this.database.prepare(`SELECT 1 FROM delivery_members m LEFT JOIN delivery_batches b ON b.batch_id = m.batch_id
			LEFT JOIN queued_events e ON e.event_id = m.event_id WHERE b.batch_id IS NULL OR e.event_id IS NULL
			OR (m.claimed = 1 AND (b.status != 'active' OR e.acknowledged != 0))
			OR (m.delivered = 1 AND e.acknowledged != 1)
			OR (b.status = 'active' AND m.claimed = 0 AND m.delivered = 0)
			OR (b.status = 'delivered' AND m.delivered != 1) LIMIT 1`).get()) {
			throw new LocalEventQueueError('Invalid delivery membership metadata.', 'corrupt');
		}
	}

	getUploadRetryState(): Promise<UploadRetryState | null> {
		return this.schedule(() => this.readUploadRetryState());
	}
	private readUploadRetryState(): UploadRetryState | null {
		const row = this.database.prepare('SELECT * FROM upload_retry_state').get();
		return row ? { endpointHash: String(row.endpoint_hash), attempts: Number(row.attempts), nextAttemptAt: Number(row.next_attempt_at),
			pauseReason: row.pause_reason as UploadPauseReason | null, busy: row.owner_id !== null } : null;
	}
	configureUpload(endpointHash: string): Promise<void> {
		if (!/^[a-f0-9]{64}$/.test(endpointHash)) { return Promise.reject(new LocalEventQueueError('Invalid upload configuration.')); }
		return this.schedule(async () => this.writeWithReservation(1024, () => {
			this.assertCollectionAllowed();
			if (this.readUploadRetryState()?.busy) { throw new LocalEventQueueError('Upload is already active.'); }
			// Fresh explicit consent may unpause; never reset persisted throttling simply on restart.
			this.database.prepare(`INSERT INTO upload_retry_state VALUES (1, ?, 0, 0, NULL, NULL)
				ON CONFLICT(singleton) DO UPDATE SET endpoint_hash = excluded.endpoint_hash, pause_reason = NULL`).run(endpointHash);
		}));
	}
	claimUploadAttempt(endpointHash: string, now: number, recoveryAt: number): Promise<UploadRetryState | null> {
		if (!/^[a-f0-9]{64}$/.test(endpointHash) || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(recoveryAt) || recoveryAt <= now) {
			return Promise.reject(new LocalEventQueueError('Invalid upload attempt.'));
		}
		return this.schedule(() => {
			let result: UploadRetryState | null = null;
			this.transaction(() => {
				this.assertCollectionAllowed(); const state = this.readUploadRetryState();
				if (!state || state.endpointHash !== endpointHash || state.busy || state.pauseReason || state.nextAttemptAt > now) { return; }
				this.database.prepare(`UPDATE upload_retry_state SET owner_id = ?, attempts = MIN(attempts + 1, 1000000), next_attempt_at = ? WHERE singleton = 1`).run(this.ownerId, recoveryAt);
				result = this.readUploadRetryState();
			}); return result;
		});
	}
	finishUploadAttempt(nextAttemptAt: number, pauseReason: UploadPauseReason | null, resetAttempts: boolean): Promise<void> {
		if (!Number.isSafeInteger(nextAttemptAt) || nextAttemptAt < 0 || typeof resetAttempts !== 'boolean'
			|| pauseReason !== null && !['authentication', 'configuration', 'protocol', 'privacy', 'storage'].includes(pauseReason)) {
			return Promise.reject(new LocalEventQueueError('Invalid upload retry update.'));
		}
		return this.schedule(() => this.transaction(() => {
			const result = this.database.prepare(`UPDATE upload_retry_state SET next_attempt_at = ?, pause_reason = ?,
				attempts = CASE WHEN ? THEN 0 ELSE attempts END, owner_id = NULL WHERE owner_id = ?`).run(nextAttemptAt, pauseReason, Number(resetAttempts), this.ownerId);
			if (Number(result.changes) !== 1) { throw new LocalEventQueueError('Upload ownership is unavailable.'); }
		}));
	}

	getPendingCount(): Promise<number> {
		return this.schedule(() => Number(this.database.prepare('SELECT pending_count FROM queue_health WHERE singleton = 1').get()?.pending_count));
	}

	getHealth(): Promise<QueueHealth> {
		return this.schedule(async () => {
			const storageBytes = await this.storageUsage();
			const row = this.database.prepare('SELECT pending_count, interrupted_count FROM queue_health WHERE singleton = 1').get()!;
			const usageRatio = storageBytes / this.maxStorageBytes;
			return { pendingCount: Number(row.pending_count), interruptedSessionCount: Number(row.interrupted_count), recoveredSessionCount: this.recoveredSessions,
				storageBytes, maxStorageBytes: this.maxStorageBytes, usageRatio,
				status: this.storageLimited || usageRatio >= 1 ? 'full' : usageRatio >= 0.8 ? 'warning' : 'healthy' };
		});
	}

	beginSession(sessionId: string): Promise<void> {
		if (!isUuid(sessionId)) { return Promise.reject(new LocalEventQueueError('Invalid recording session ID.')); }
		return this.schedule(async () => {
			this.assertCollectionAllowed();
			await this.writeWithReservation(1024, () => {
				this.assertCollectionAllowed();
				if (this.isArchivedRecording(sessionId)) { throw new LocalEventQueueError('Archived recording is closed.'); }
				this.database.prepare(`INSERT INTO recording_sessions(session_id, status, started_at, owner_id)
					VALUES (?, 'active', ?, ?)`).run(sessionId, new Date().toISOString(), this.ownerId);
			});
		});
	}

	finishSession(sessionId: string, status: 'completed' | 'cancelled' = 'completed'): Promise<void> {
		if (!isUuid(sessionId) || !['completed', 'cancelled'].includes(status)) { return Promise.reject(new LocalEventQueueError('Invalid session completion.')); }
		return this.schedule(() => this.transaction(() => {
			this.database.prepare(`UPDATE recording_sessions SET status = ?, ended_at = ?
				WHERE session_id = ? AND owner_id = ? AND status = 'active'`).run(status, new Date().toISOString(), sessionId, this.ownerId);
		}));
	}

	getRecordingSessions(limit = MAX_QUEUE_BATCH): Promise<RecordingSessionStatus[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUEUE_BATCH) { return Promise.reject(new LocalEventQueueError('Invalid session read limit.')); }
		return this.schedule(() => this.database.prepare(`SELECT session_id, status, started_at, ended_at, reason
			FROM recording_sessions ORDER BY started_at DESC, session_id LIMIT ?`).all(limit).map(row => ({
			sessionId: String(row.session_id), status: row.status as RecordingSessionStatus['status'], startedAt: String(row.started_at),
			endedAt: row.ended_at as string | null, reason: row.reason as string | null
		})));
	}

	private isArchivedAssessment(codingSessionId: string, origin: string): boolean {
		return !!this.database.prepare('SELECT 1 FROM assessment_archives WHERE assessment_key = ?').get(assessmentArchiveKey({ codingSessionId, apiOrigin: origin }));
	}
	private isArchivedRecording(sessionId: string): boolean {
		return !!this.database.prepare('SELECT 1 FROM assessment_archive_recordings WHERE session_id = ?').get(sessionId);
	}
	private assertUnarchivedEvent(eventId: string): void {
		if (this.database.prepare(`SELECT 1 FROM queued_events e JOIN assessment_archive_recordings a ON a.session_id = e.session_id WHERE e.event_id = ?`).get(eventId)) {
			throw new LocalEventQueueError('Archived evidence cannot be delivered.');
		}
	}
	private readAssessmentArchive(id: string, ciphertext: string): AssessmentArchive {
		const value = this.cipher?.decrypt(id, JSON.parse(ciphertext), 'archive');
		if (!validAssessmentArchive(value) || value.archiveId !== id
			|| this.database.prepare('SELECT assessment_key FROM assessment_archives WHERE archive_id = ?').get(id)?.assessment_key !== assessmentArchiveKey(value.metadata.connection)) { throw new EvidenceEncryptionError('authentication_failed'); }
		const indexed = this.database.prepare('SELECT session_id FROM assessment_archive_recordings WHERE archive_id = ? ORDER BY session_id').all(id).map(row => String(row.session_id));
		if (JSON.stringify(indexed) !== JSON.stringify([...value.metadata.localRecordingSessionIds].sort())) { throw new EvidenceEncryptionError('authentication_failed'); }
		return value;
	}
	private readAssessmentArchiveIndex(): AssessmentArchiveIndex {
		const rows = this.database.prepare('SELECT archive_id, archive_json FROM assessment_archives LIMIT ?').all(MAX_ASSESSMENT_ARCHIVES + 1);
		if (rows.length > MAX_ASSESSMENT_ARCHIVES) { throw new LocalEventQueueError('Archive capacity exceeded.'); }
		if (this.database.prepare('SELECT 1 FROM assessment_archive_recordings r WHERE NOT EXISTS (SELECT 1 FROM assessment_archives a WHERE a.archive_id = r.archive_id) LIMIT 1').get()) {
			throw new EvidenceEncryptionError('authentication_failed');
		}
		return { archives: rows.map(row => {
			const value = this.readAssessmentArchive(String(row.archive_id), String(row.archive_json));
			return { archiveId: value.archiveId, assessmentKey: assessmentArchiveKey(value.metadata.connection), recordingSessionIds: [...value.metadata.localRecordingSessionIds], submissionConfirmed: value.submissionConfirmed };
		}) };
	}
	getAssessmentArchiveIndex(): Promise<AssessmentArchiveIndex> { return this.schedule(() => this.readAssessmentArchiveIndex()); }
	/** Commit the complete connection and permanent upload quarantine atomically. No credentials, events,
	 * approvals, receipts, manifests or acknowledgment flags are changed. */
	archiveAssessment(input: AssessmentArchive): Promise<void> {
		let snapshot: AssessmentArchive;
		try { snapshot = structuredClone(input); if (!validAssessmentArchive(snapshot)) { throw new Error(); } }
		catch { return Promise.reject(new LocalEventQueueError('Invalid assessment archive.')); }
		return this.schedule(async () => {
			if (!this.cipher) { throw new EvidenceEncryptionError('key_missing'); }
			const encrypted = JSON.stringify(this.cipher.encrypt(snapshot.archiveId, JSON.stringify(snapshot), 'archive'));
			await this.writeWithReservation(Buffer.byteLength(encrypted) + snapshot.metadata.localRecordingSessionIds.length * 256, () => {
				this.assertCollectionAllowed();
				const existing = this.database.prepare('SELECT archive_json FROM assessment_archives WHERE archive_id = ?').get(snapshot.archiveId);
				if (existing) {
					const original = this.readAssessmentArchive(snapshot.archiveId, String(existing.archive_json));
					// A retry after an unknown commit outcome never replaces the original audit snapshot.
					if (JSON.stringify(original.metadata.connection) !== JSON.stringify(snapshot.metadata.connection)
						|| original.metadata.submitRequestId !== snapshot.metadata.submitRequestId
						|| JSON.stringify([...original.metadata.localRecordingSessionIds].sort()) !== JSON.stringify([...snapshot.metadata.localRecordingSessionIds].sort())) {
						throw new LocalEventQueueError('Conflicting assessment archive.');
					} return;
				}
				if (Number(this.database.prepare('SELECT COUNT(*) AS count FROM assessment_archives').get()!.count) >= MAX_ASSESSMENT_ARCHIVES) { throw new LocalEventQueueError('Archive capacity reached.'); }
				for (const id of snapshot.metadata.localRecordingSessionIds) {
					const scope = this.readEvidenceConsent(id);
					const frozen = this.database.prepare('SELECT request_id FROM finalization_recordings WHERE session_id = ?').get(id);
					if (scope && (scope.codingSessionId !== snapshot.metadata.connection.codingSessionId || scope.origin !== snapshot.metadata.connection.apiOrigin)
						|| frozen && frozen.request_id !== snapshot.metadata.submitRequestId) { throw new LocalEventQueueError('Assessment archive ownership conflict.'); }
					if (this.database.prepare("SELECT 1 FROM recording_sessions WHERE session_id = ? AND status = 'active'").get(id)
						|| this.database.prepare(`SELECT 1 FROM delivery_members m JOIN queued_events e ON e.event_id = m.event_id WHERE e.session_id = ? AND m.claimed = 1`).get(id)) {
						throw new LocalEventQueueError('Recording or delivery still active.', 'locked');
					}
				}
				// Another window may know additional recordings. Refuse incomplete ownership
				// coverage rather than silently attaching them to this archive or leaving them live.
				for (const row of this.database.prepare('SELECT session_id FROM evidence_consents').iterate()) {
					const id = String(row.session_id); const scope = this.readEvidenceConsent(id)!;
					if (scope.codingSessionId === snapshot.metadata.connection.codingSessionId && scope.origin === snapshot.metadata.connection.apiOrigin
						&& !snapshot.metadata.localRecordingSessionIds.includes(id)) { throw new LocalEventQueueError('Assessment recording coverage requires recovery.'); }
				}
				this.database.prepare('INSERT INTO assessment_archives VALUES (?, ?, ?)').run(snapshot.archiveId, assessmentArchiveKey(snapshot.metadata.connection), encrypted);
				for (const id of snapshot.metadata.localRecordingSessionIds) { this.database.prepare('INSERT INTO assessment_archive_recordings VALUES (?, ?)').run(id, snapshot.archiveId); }
			});
		});
	}

	/** Snapshot all original IDs (including acknowledged tombstones) on the storage worker.
	 * No payload or event-ID list is returned. SQLite serializes freezing with collection and retention. */
	freezeFinalization(scope: FinalizationScope, existingOnly = false): Promise<AssessmentFinalizationRequest> {
		const selection = structuredClone(scope);
		return this.schedule(async () => {
			const ids = selection.localRecordingSessionIds;
			if (!isUuid(selection.requestId) || selection.requestId !== selection.requestId.toLowerCase()
				|| !/^[1-9][0-9]{0,19}$/.test(selection.codingSessionId) || !validOrigin(selection.origin)
				|| !Array.isArray(ids) || !ids.length || ids.length > 32 || !ids.every(id => isUuid(id) && id === id.toLowerCase()) || new Set(ids).size !== ids.length) {
				throw new LocalEventQueueError('Invalid finalization scope.');
			}
			if (!this.cipher) { throw new EvidenceEncryptionError('key_missing'); }
			let request!: AssessmentFinalizationRequest;
			await this.writeWithReservation(32768, () => {
				this.assertCollectionAllowed();
				request = { contract_version: 1, request_id: selection.requestId, recordings: [] };
				for (const id of [...ids].sort()) {
					if (!existingOnly && this.isArchivedRecording(id)) { throw new LocalEventQueueError('Archived assessment cannot finalize.'); }
					const session = this.database.prepare('SELECT status FROM recording_sessions WHERE session_id = ?').get(id);
					const consent = this.readEvidenceConsent(id);
					if (!session || !['completed', 'interrupted', 'incomplete'].includes(String(session.status))
						|| !consent || consent.codingSessionId !== selection.codingSessionId || consent.origin !== selection.origin
						|| !consent.captureClosed || consent.locallyRevoked || consent.pendingAction || consent.receipt?.state !== 'stopped'
						|| this.isApprovalRevoked(id)) { throw new LocalEventQueueError('Recording cannot be reconciled.'); }
					const hash = createHash('sha256'); hash.update('['); let count = 0;
					for (const row of this.database.prepare(`SELECT e.event_id, e.event_json, e.payload_format, e.session_id, e.acknowledged, a.approval_json
						FROM queued_events e LEFT JOIN event_approvals a ON a.event_id = e.event_id WHERE e.session_id = ? ORDER BY e.event_id`).iterate(id)) {
						const eventId = String(row.event_id);
						if (!isUuid(eventId) || eventId !== eventId.toLowerCase() || !row.approval_json || row.payload_format !== 1) { throw new LocalEventQueueError('Unapproved evidence.'); }
						const proof = this.cipher!.decrypt(eventId, JSON.parse(String(row.approval_json)), 'approval') as EvidenceApproval;
						if (!row.acknowledged) { verifyEvidenceApproval(proof, this.readStoredEvent(row)); }
						// Acknowledged payloads have been removed; their immutable, authenticated capture approvals remain.
						const envelope = proof?.assessmentEventApproval;
						if (proof?.version !== 2 || proof.eventId !== eventId || proof.sessionId !== id
							|| proof.assessment?.codingSessionId !== selection.codingSessionId || proof.assessment.origin !== selection.origin
							|| proof.assessment.consentId !== consent.receipt.consent_id || envelope?.eventId !== eventId
							|| envelope.localRecordingSessionId !== id || envelope.consentReceiptId !== consent.receipt.consent_id
							|| !consent.receipt.approved_workspace_ids.includes(proof.workspaceId) || !consent.receipt.event_types.includes(proof.eventType)) {
							throw new LocalEventQueueError('Unapproved evidence.');
						}
						hash.update((count++ ? ',' : '') + JSON.stringify(eventId));
					}
					hash.update(']'); request.recordings.push({ local_recording_session_id: id, event_count: count, event_ids_sha256: hash.digest('hex') });
				}
				if (!validFinalizationRequest(request)) { throw new LocalEventQueueError('Invalid frozen manifest.'); }
				const stored = this.database.prepare('SELECT snapshot_json FROM assessment_finalizations WHERE request_id = ?').get(selection.requestId);
				const snapshot = { codingSessionId: selection.codingSessionId, origin: selection.origin, request };
				if (stored) {
					const previous = this.cipher!.decrypt(selection.requestId, JSON.parse(String(stored.snapshot_json)), 'finalization');
					if (JSON.stringify(previous) !== JSON.stringify(snapshot)) { throw new LocalEventQueueError('Frozen manifest conflict.'); }
				} else {
					if (existingOnly) { throw new LocalEventQueueError('Frozen manifest unavailable.'); }
					this.database.prepare('INSERT INTO assessment_finalizations VALUES (?, ?)').run(selection.requestId,
						JSON.stringify(this.cipher!.encrypt(selection.requestId, JSON.stringify(snapshot), 'finalization')));
					for (const id of ids) { this.database.prepare('INSERT INTO finalization_recordings VALUES (?, ?)').run(id, selection.requestId); }
				}
			}); return request;
		});
	}

	/** Indexed metadata-only delivery check. Missing/retained-away recordings cannot prove delivery. */
	getSessionEvidenceStatus(sessionIds: readonly string[]): Promise<{ totalEvents: number; pendingEvents: number; missingSessions: number }> {
		return this.schedule(() => {
			if (!Array.isArray(sessionIds) || sessionIds.length > 32 || !sessionIds.every(isUuid)
				|| new Set(sessionIds).size !== sessionIds.length) { throw new LocalEventQueueError('Invalid recording selection.'); }
			const result = { totalEvents: 0, pendingEvents: 0, missingSessions: 0 };
			this.database.exec('BEGIN');
			try {
				for (const id of sessionIds) {
					if (!this.database.prepare('SELECT 1 FROM recording_sessions WHERE session_id = ?').get(id)) { result.missingSessions++; }
					const row = this.database.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN acknowledged = 0 THEN 1 ELSE 0 END), 0) AS pending
						FROM queued_events WHERE session_id = ?`).get(id)!;
					result.totalEvents += Number(row.total); result.pendingEvents += Number(row.pending);
				}
				this.database.exec('COMMIT'); return result;
			} catch (error) { this.database.exec('ROLLBACK'); throw error; }
		});
	}

	/** Read-only snapshot. Decrypted evidence stays on the storage worker in production. */
	getRecordedEventSummary(): Promise<RecordedEventSummary> {
		return this.schedule(() => {
			const summary: RecordedEventSummary = { total: 0, counts: {} };
			this.database.exec('BEGIN');
			try {
				// Include empty/interrupted sessions; never substitute an older session with more data.
				// Insertion order breaks ties when recording starts share a millisecond.
				const latest = this.database.prepare(`SELECT session_id FROM recording_sessions WHERE status != 'cancelled'
					ORDER BY started_at DESC, rowid DESC LIMIT 1`).get();
				if (latest) {
					for (const row of this.database.prepare(`SELECT event_id, event_json, payload_format, session_id FROM queued_events
						WHERE session_id = ? AND acknowledged = 0 ORDER BY sequence`).iterate(latest.session_id)) {
						const event = this.readStoredEvent(row);
						if (!PRIVACY_EVENT_TYPES.includes(event.eventType)) { throw new LocalEventQueueError('Invalid recorded event type.', 'corrupt'); }
						summary.counts[event.eventType] = (summary.counts[event.eventType] ?? 0) + 1;
						summary.total++;
					}
				}
				this.database.exec('COMMIT'); return summary;
			} catch (error) {
				try { this.database.exec('ROLLBACK'); } catch { /* No SQLite details or partial summary returned. */ }
				throw error;
			}
		});
	}

	getLocalDataSummary(): Promise<LocalDataSummary> {
		return this.schedule(() => ({
			pendingCount: Number(this.database.prepare('SELECT pending_count FROM queue_health WHERE singleton = 1').get()!.pending_count),
			legacySqliteCount: Number(this.database.prepare('SELECT COUNT(*) AS count FROM queued_events WHERE payload_format = 0 AND acknowledged = 0').get()!.count),
			legacyPendingDeletionCount: Number(this.database.prepare(`SELECT COUNT(*) AS count FROM queued_events WHERE acknowledged = 0
				AND session_id IN (SELECT session_id FROM queued_events WHERE payload_format = 0 AND acknowledged = 0)`).get()!.count)
		}));
	}

	/** Cross-window lease: a cleanup confirmation cannot race a new recording. */
	acquireMaintenance(): Promise<void> {
		return this.schedule(() => this.transaction(() => {
			if (this.database.prepare('SELECT 1 FROM queue_maintenance').get()) { throw new LocalEventQueueError('Local data maintenance is in progress.', 'maintenance_active'); }
			if (this.database.prepare("SELECT 1 FROM recording_sessions WHERE status = 'active' LIMIT 1").get()) {
				throw new LocalEventQueueError('Local data cleanup requires stopped recordings.', 'recording_active');
			}
			if (this.readUploadRetryState()?.busy) { throw new LocalEventQueueError('Local data cleanup requires stopped uploads.'); }
			this.database.prepare('INSERT INTO queue_maintenance VALUES (1, ?)').run(this.ownerId); this.maintenance = true;
		}));
	}
	releaseMaintenance(): Promise<void> {
		return this.schedule(() => this.transaction(() => {
			this.database.prepare('DELETE FROM queue_maintenance WHERE owner_id = ?').run(this.ownerId); this.maintenance = false;
		}));
	}
	private assertCollectionAllowed(): void {
		if (this.database.prepare('SELECT 1 FROM queue_maintenance').get()) { throw new LocalEventQueueError('Local data maintenance is in progress.', 'maintenance_active'); }
	}
	private assertMaintenance(): void {
		if (!this.maintenance || this.database.prepare('SELECT owner_id FROM queue_maintenance').get()?.owner_id !== this.ownerId) {
			throw new LocalEventQueueError('Local data cleanup requires a maintenance lease.', 'maintenance_active');
		}
		if (this.database.prepare("SELECT 1 FROM recording_sessions WHERE status = 'active' LIMIT 1").get()) {
			throw new LocalEventQueueError('Local data cleanup requires stopped recordings.', 'recording_active');
		}
	}
	deleteEvidence(scope: CleanupScope): Promise<CleanupResult> {
		if (!['legacy', 'all'].includes(scope)) { return Promise.reject(new LocalEventQueueError('Invalid cleanup scope.')); }
		return this.schedule(() => {
			let result!: CleanupResult;
			this.transaction(() => {
				this.assertMaintenance();
				this.database.exec('CREATE TEMP TABLE cleanup_sessions(session_id TEXT PRIMARY KEY)');
				try {
					this.database.exec(scope === 'all' ? 'INSERT INTO cleanup_sessions SELECT session_id FROM recording_sessions s WHERE NOT EXISTS (SELECT 1 FROM assessment_archive_recordings a WHERE a.session_id = s.session_id)'
						: 'INSERT INTO cleanup_sessions SELECT DISTINCT session_id FROM queued_events e WHERE payload_format = 0 AND acknowledged = 0 AND NOT EXISTS (SELECT 1 FROM assessment_archive_recordings a WHERE a.session_id = e.session_id)');
					result = this.deleteSelectedSessions(scope === 'all' && !this.database.prepare('SELECT 1 FROM assessment_archives LIMIT 1').get());
				} finally { this.database.exec('DROP TABLE cleanup_sessions'); }
			});
			return result;
		});
	}
	/** Expire whole closed sessions only, so pending relationship references never dangle. */
	expireAcknowledged(cutoff: string): Promise<CleanupResult> {
		if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cutoff) || !Number.isFinite(Date.parse(cutoff)) || Date.parse(cutoff) > Date.now()) {
			return Promise.reject(new LocalEventQueueError('Invalid retention cutoff.'));
		}
		return this.schedule(() => {
			let result!: CleanupResult;
			this.transaction(() => {
				this.assertMaintenance(); this.database.exec('CREATE TEMP TABLE cleanup_sessions(session_id TEXT PRIMARY KEY)');
				try {
					this.database.prepare(`INSERT INTO cleanup_sessions SELECT session_id FROM recording_sessions s WHERE status != 'active'
						AND ended_at IS NOT NULL AND ended_at < ?
						AND NOT EXISTS (SELECT 1 FROM finalization_recordings f WHERE f.session_id = s.session_id)
						AND NOT EXISTS (SELECT 1 FROM assessment_archive_recordings a WHERE a.session_id = s.session_id)
						AND NOT EXISTS (SELECT 1 FROM queued_events e WHERE e.session_id = s.session_id
							AND (acknowledged = 0 OR acknowledged_at IS NULL OR acknowledged_at >= ?))`).run(cutoff, cutoff);
					result = this.deleteSelectedSessions(false);
				} finally { this.database.exec('DROP TABLE cleanup_sessions'); }
			}); return result;
		});
	}
	private deleteSelectedSessions(all: boolean): CleanupResult {
		// Explicit cleanup/retention also removes delivery references; release other members of affected batches.
		this.database.exec(`UPDATE delivery_batches SET status = 'released' WHERE status = 'active' AND batch_id IN
			(SELECT m.batch_id FROM delivery_members m JOIN queued_events e ON e.event_id = m.event_id ${all ? '' : 'WHERE e.session_id IN (SELECT session_id FROM cleanup_sessions)'});
			UPDATE delivery_members SET claimed = 0 WHERE batch_id IN (SELECT batch_id FROM delivery_batches WHERE status = 'released');
			DELETE FROM delivery_members WHERE event_id IN (SELECT event_id FROM queued_events ${all ? '' : 'WHERE session_id IN (SELECT session_id FROM cleanup_sessions)'});
			DELETE FROM delivery_batches WHERE NOT EXISTS (SELECT 1 FROM delivery_members m WHERE m.batch_id = delivery_batches.batch_id);`);
		this.database.exec(`DELETE FROM finalization_recordings ${all ? '' : 'WHERE session_id IN (SELECT session_id FROM cleanup_sessions)'};
			DELETE FROM assessment_finalizations WHERE NOT EXISTS (SELECT 1 FROM finalization_recordings f WHERE f.request_id = assessment_finalizations.request_id);`);
		this.database.exec(`DELETE FROM event_approvals WHERE event_id IN (SELECT event_id FROM queued_events ${all ? '' : 'WHERE session_id IN (SELECT session_id FROM cleanup_sessions)'});
			DELETE FROM evidence_consents ${all ? '' : 'WHERE session_id IN (SELECT session_id FROM cleanup_sessions)'};
			DELETE FROM disclosure_consents ${all ? '' : 'WHERE session_id IN (SELECT session_id FROM cleanup_sessions)'};
			DELETE FROM approval_revocations ${all ? '' : 'WHERE session_id IN (SELECT session_id FROM cleanup_sessions)'};`);
		const deletedRecords = Number(this.database.prepare('DELETE FROM queued_events'  + (all ? '' : ' WHERE session_id IN (SELECT session_id FROM cleanup_sessions)')).run().changes);
		this.database.exec('DELETE FROM recording_privacy_health WHERE session_id IN (SELECT session_id FROM cleanup_sessions)');
		const deletedSessions = Number(this.database.prepare('DELETE FROM recording_sessions WHERE session_id IN (SELECT session_id FROM cleanup_sessions)').run().changes);
		return { deletedRecords, deletedSessions };
	}
	async assertMaintenanceHeld(): Promise<void> { await this.schedule(() => this.assertMaintenance()); }
	async compactMaintenance(): Promise<void> {
		await this.schedule(() => {
			this.assertMaintenance();
			this.database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
			this.database.exec('VACUUM');
			this.database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
			this.storageLimited = false;
		});
	}

	/** Only fixed categories and counters; rejected event IDs/content never reach SQLite. */
	recordPrivacyRejection(sessionId: string, reasons: readonly PrivacyReasonCode[]): Promise<void> {
		if (!isUuid(sessionId) || !Array.isArray(reasons) || !reasons.length || reasons.length > PRIVACY_REASON_CODES.length
			|| reasons.some(reason => !PRIVACY_REASON_CODES.includes(reason))) {
			return Promise.reject(new LocalEventQueueError('Invalid privacy health update.'));
		}
		const codes: PrivacyReasonCode[] = [...new Set<PrivacyReasonCode>(reasons)];
		return this.schedule(async () => {
			await this.writeWithReservation(2048, () => {
				if (!this.database.prepare("SELECT 1 FROM recording_sessions WHERE session_id = ? AND owner_id = ? AND status = 'active'").get(sessionId, this.ownerId)) {
					throw new LocalEventQueueError('Privacy health requires an admitted recording session.');
				}
				const current = this.readPrivacyHealth(sessionId);
				for (const reason of codes) { current.reasonCounts[reason] = (current.reasonCounts[reason] ?? 0) + 1; }
				this.database.prepare(`INSERT INTO recording_privacy_health VALUES (?, ?, ?)
					ON CONFLICT(session_id) DO UPDATE SET rejected_count = excluded.rejected_count, reason_counts = excluded.reason_counts`)
					.run(sessionId, current.rejectedCount + 1, JSON.stringify(current.reasonCounts));
			});
		});
	}

	getPrivacyHealth(sessionId: string): Promise<RecordingPrivacyHealth> {
		if (!isUuid(sessionId)) { return Promise.reject(new LocalEventQueueError('Invalid privacy health session.')); }
		return this.schedule(() => this.readPrivacyHealth(sessionId));
	}

	private readPrivacyHealth(sessionId: string): RecordingPrivacyHealth {
		const row = this.database.prepare('SELECT rejected_count, reason_counts FROM recording_privacy_health WHERE session_id = ?').get(sessionId);
		if (!row) { return { rejectedCount: 0, reasonCounts: {} }; }
		try {
			const counts = JSON.parse(String(row.reason_counts));
			if (!Number.isSafeInteger(row.rejected_count) || Number(row.rejected_count) < 0 || !counts || Array.isArray(counts)
				|| typeof counts !== 'object' || Object.entries(counts).some(([key, count]) =>
					!PRIVACY_REASON_CODES.includes(key as PrivacyReasonCode) || !Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > Number(row.rejected_count))) { throw new Error(); }
			return { rejectedCount: Number(row.rejected_count), reasonCounts: counts };
		} catch { throw new LocalEventQueueError('Invalid privacy health metadata.', 'corrupt'); }
	}

	/** Drain already accepted operations. Acknowledged IDs survive as deduplication tombstones. */
	close(): Promise<void> {
		if (!this.closePromise) {
			this.closing = true;
			this.closePromise = this.pending.then(() => {
				try {
					this.transaction(() => {
						this.database.prepare(`UPDATE recording_sessions SET status = 'interrupted', ended_at = ?, reason = 'unfinished_recording'
							WHERE owner_id = ? AND status = 'active'`).run(new Date().toISOString(), this.ownerId);
						this.releaseOwnerBatches(this.ownerId, 'released');
						this.database.prepare('DELETE FROM queue_maintenance WHERE owner_id = ?').run(this.ownerId);
						this.database.prepare('DELETE FROM queue_owners WHERE owner_id = ?').run(this.ownerId);
					});
				} catch (error) { throw safeQueueError(error, 'Unable to close local event queue.'); }
				finally { ACTIVE_QUEUE_OWNERS.delete(this.ownerId); this.cipher?.dispose(); this.database.close(); }
			});
		}
		return this.closePromise;
	}

	private schedule<T>(operation: () => T | Promise<T>): Promise<T> {
		if (this.closing) { return Promise.reject(new LocalEventQueueError('Local event queue is closed.')); }
		const result = this.pending.then(async () => {
			try { return await operation(); } catch (error) {
				throw safeQueueError(error);
			}
		});
		this.pending = result.then(() => undefined, () => undefined);
		return result;
	}

	private transaction(operation: () => void): void {
		if (this.database.isTransaction) { operation(); return; }
		this.database.exec('BEGIN IMMEDIATE');
		try {
			operation();
			this.database.exec('COMMIT');
		} catch (error) {
			try { this.database.exec('ROLLBACK'); } catch { /* Do not expose SQLite diagnostics. */ }
			throw error;
		}
	}

	private verifyLegacyEvents(currentFormat = false): void {
		for (const row of this.database.prepare('SELECT event_id, event_json, acknowledged FROM queued_events' + (currentFormat ? ' WHERE payload_format = 0' : '')).iterate()) {
			if (!isUuid(row.event_id)) { throw new LocalEventQueueError('Invalid stored event identity.', 'corrupt'); }
			if (row.acknowledged === 0) {
				try {
					const validation = validateEvent(JSON.parse(String(row.event_json)));
					if (!validation.valid || validation.event.eventId !== row.event_id) { throw new Error(); }
				} catch { throw new LocalEventQueueError('Invalid stored queue event.', 'corrupt'); }
			}
		}
	}

	private readStoredEvent(row: { [key: string]: unknown }): TrackerEvent {
		try {
			if (!isUuid(row.event_id) || ![0, 1].includes(Number(row.payload_format)) || typeof row.event_json !== 'string'
				|| Buffer.byteLength(row.event_json) > MAX_QUEUE_EVENT_BYTES * 2) { throw new Error(); }
			let event: unknown = JSON.parse(row.event_json);
			if (row.payload_format === 1) {
				if (!this.cipher) { throw new EvidenceEncryptionError('key_missing'); }
				const keyId = (event as { keyId?: unknown })?.keyId;
				if (typeof keyId !== 'string' || !this.database.prepare('SELECT 1 FROM queue_encryption_keys WHERE key_id = ?').get(keyId)) { throw new EvidenceEncryptionError('authentication_failed'); }
				event = this.cipher.decrypt(row.event_id, event);
			}
			const valid = validateEvent(event);
			if (!valid.valid || valid.event.eventId !== row.event_id || row.session_id !== undefined && row.session_id !== valid.event.sessionId) { throw new Error(); }
			return event as TrackerEvent;
		} catch (error) {
			if (error instanceof EvidenceEncryptionError) { throw error; }
			throw new LocalEventQueueError('Invalid stored queue event.', 'corrupt');
		}
	}

	private verifyStoredEvents(): void {
		const indexed = Number(this.database.prepare('PRAGMA user_version').get()?.user_version) >= 5;
		for (const row of this.database.prepare('SELECT event_id, event_json, acknowledged, payload_format' + (indexed ? ', session_id' : '') + ' FROM queued_events').iterate()) {
			if (!isUuid(row.event_id) || ![0, 1].includes(Number(row.payload_format))) { throw new LocalEventQueueError('Invalid stored queue identity.', 'corrupt'); }
			if (row.acknowledged === 0) { this.readStoredEvent(row); }
		}
	}

	private migrateRecoveryMetadata(): void {
		this.transaction(() => {
			this.database.exec(`CREATE TABLE queue_health (
				singleton INTEGER PRIMARY KEY CHECK(singleton = 1), pending_count INTEGER NOT NULL, interrupted_count INTEGER NOT NULL
			) STRICT;
			INSERT INTO queue_health VALUES (1, (SELECT COUNT(*) FROM queued_events WHERE acknowledged = 0), 0);
			CREATE TABLE queue_owners (owner_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, process_instance TEXT NOT NULL) STRICT;
			CREATE TABLE recording_sessions (
				session_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'interrupted', 'cancelled', 'incomplete')),
				started_at TEXT NOT NULL, ended_at TEXT, reason TEXT, owner_id TEXT NOT NULL
			) STRICT;
			CREATE INDEX session_owners ON recording_sessions(owner_id, status);
			CREATE INDEX session_history ON recording_sessions(started_at DESC, session_id);
			CREATE TRIGGER count_event_insert AFTER INSERT ON queued_events WHEN NEW.acknowledged = 0
			BEGIN UPDATE queue_health SET pending_count = pending_count + 1 WHERE singleton = 1; END;
			CREATE TRIGGER count_event_ack AFTER UPDATE OF acknowledged ON queued_events
			BEGIN UPDATE queue_health SET pending_count = pending_count + OLD.acknowledged - NEW.acknowledged WHERE singleton = 1; END;
			CREATE TRIGGER count_interrupted_insert AFTER INSERT ON recording_sessions WHEN NEW.status IN ('interrupted', 'incomplete')
			BEGIN UPDATE queue_health SET interrupted_count = interrupted_count + 1 WHERE singleton = 1; END;
			CREATE TRIGGER count_interrupted_update AFTER UPDATE OF status ON recording_sessions
			BEGIN UPDATE queue_health SET interrupted_count = interrupted_count
				+ (NEW.status IN ('interrupted', 'incomplete')) - (OLD.status IN ('interrupted', 'incomplete')) WHERE singleton = 1; END;
			INSERT INTO recording_sessions(session_id, status, started_at, reason, owner_id)
				SELECT json_extract(event_json, '$.sessionId'), 'incomplete', MIN(json_extract(event_json, '$.timestamp')), 'legacy_state_unknown', 'legacy'
				FROM queued_events WHERE acknowledged = 0 GROUP BY json_extract(event_json, '$.sessionId');
			PRAGMA user_version = 2;`);
		});
	}

	private verifyCounters(): void {
		const required = ['queue_health', 'queue_owners', 'recording_sessions', 'count_event_insert', 'count_event_ack',
			'count_interrupted_insert', 'count_interrupted_update', 'pending_events', 'session_owners', 'session_history', 'recording_privacy_health', 'queue_encryption_keys',
			'queue_maintenance', 'retention_events', 'count_event_delete', 'count_session_delete',
			'delivery_batches', 'delivery_members', 'delivery_owners', 'delivery_claims', 'upload_retry_state',
			'event_approvals', 'evidence_consents', 'approval_revocations', 'disclosure_consents', 'disclosure_recordings'];
		const schema = new Set(this.database.prepare('SELECT name FROM sqlite_master').all().map(row => row.name));
		if (required.some(name => !schema.has(name))) { throw new LocalEventQueueError('Queue schema integrity check failed.', 'corrupt'); }
		const counters = this.database.prepare('SELECT * FROM queue_health WHERE singleton = 1').get();
		const pending = this.database.prepare('SELECT COUNT(*) AS count FROM queued_events WHERE acknowledged = 0').get()?.count;
		const interrupted = this.database.prepare("SELECT COUNT(*) AS count FROM recording_sessions WHERE status IN ('interrupted', 'incomplete')").get()?.count;
		if (!counters || counters.pending_count !== pending || counters.interrupted_count !== interrupted) {
			throw new LocalEventQueueError('Queue health integrity check failed.', 'corrupt');
		}
		for (const row of this.database.prepare('SELECT session_id, owner_id, started_at, ended_at FROM recording_sessions').iterate()) {
			if (!isUuid(row.session_id) || row.owner_id !== 'legacy' && !isUuid(row.owner_id)
				|| typeof row.started_at !== 'string' || !Number.isFinite(Date.parse(row.started_at))
				|| row.ended_at !== null && (typeof row.ended_at !== 'string' || !Number.isFinite(Date.parse(row.ended_at)))) {
				throw new LocalEventQueueError('Queue session integrity check failed.', 'corrupt');
			}
		}
		for (const row of this.database.prepare('SELECT session_id FROM recording_privacy_health').iterate()) {
			if (!isUuid(row.session_id) || !this.database.prepare('SELECT 1 FROM recording_sessions WHERE session_id = ?').get(row.session_id)) {
				throw new LocalEventQueueError('Invalid privacy health session.', 'corrupt');
			}
			this.readPrivacyHealth(String(row.session_id));
		}
		for (const row of this.database.prepare('SELECT session_id, acknowledged_at FROM queued_events').iterate()) {
			if (row.session_id !== null && (!isUuid(row.session_id) || !this.database.prepare('SELECT 1 FROM recording_sessions WHERE session_id = ?').get(row.session_id))
				|| row.acknowledged_at !== null && (typeof row.acknowledged_at !== 'string' || !Number.isFinite(Date.parse(row.acknowledged_at)))) {
				throw new LocalEventQueueError('Invalid retention metadata.', 'corrupt');
			}
		}
		for (const row of this.database.prepare('SELECT owner_id FROM queue_maintenance').iterate()) {
			if (!isUuid(row.owner_id) || !this.database.prepare('SELECT 1 FROM queue_owners WHERE owner_id = ?').get(row.owner_id)) {
				throw new LocalEventQueueError('Invalid maintenance ownership.', 'corrupt');
			}
		}
	}

	private recoverOwners(options: QueueOptions): void {
		const processInstance = options.processInstanceId ?? QUEUE_PROCESS_INSTANCE_ID;
		const liveOwners = new Set(options.liveOwnerIds ?? ACTIVE_QUEUE_OWNERS);
		const abandoned: string[] = [];
		for (const owner of this.database.prepare('SELECT * FROM queue_owners').all()) {
			if (!isUuid(owner.owner_id) || !isUuid(owner.process_instance) || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1) {
				throw new LocalEventQueueError('Queue owner integrity check failed.', 'corrupt');
			}
			let live = false;
			if (owner.pid === process.pid) { live = owner.process_instance === processInstance && liveOwners.has(String(owner.owner_id)); }
			else {
				try { process.kill(Number(owner.pid), 0); live = true; }
				catch (error) { live = (error as NodeJS.ErrnoException).code === 'EPERM'; }
			}
			if (!live) { abandoned.push(String(owner.owner_id)); }
		}
		this.transaction(() => {
			for (const owner of abandoned) {
				this.recoveredSessions += Number(this.database.prepare(`UPDATE recording_sessions SET status = 'interrupted', ended_at = ?, reason = 'owner_lost'
					WHERE owner_id = ? AND status = 'active'`).run(new Date().toISOString(), owner).changes);
				this.releaseOwnerBatches(owner, 'recovered');
				this.database.prepare('DELETE FROM queue_maintenance WHERE owner_id = ?').run(owner);
				this.database.prepare('DELETE FROM queue_owners WHERE owner_id = ?').run(owner);
			}
			this.database.prepare('INSERT INTO queue_owners VALUES (?, ?, ?)').run(this.ownerId, process.pid, processInstance);
		});
	}

	private async storageUsage(): Promise<number> {
		let bytes = 0;
		for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`, `${this.path}-journal`]) {
			try { bytes += (await stat(path)).size; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
		}
		return bytes;
	}

	private async writeWithReservation(bytes: number, operation: () => void): Promise<void> {
		await this.reserveStorage(bytes);
		this.database.exec('BEGIN IMMEDIATE');
		try {
			// Recheck under the writer lock, including writes by another extension window.
			await this.reserveStorage(bytes, false);
			operation(); this.database.exec('COMMIT');
		} catch (error) {
			try { this.database.exec('ROLLBACK'); } catch { /* Safe error classification below. */ }
			throw error;
		}
	}

	private async reserveStorage(jsonBytes: number, checkpoint = true): Promise<void> {
		const pageSize = Number(this.database.prepare('PRAGMA page_size').get()?.page_size);
		// Worst-case payload overflow pages plus B-tree, index, counters and session metadata pages.
		const frames = Math.ceil(jsonBytes / (pageSize - 64)) + 32;
		const reserve = frames * (pageSize * 2 + 24) + 32768;
		let usage = await this.storageUsage();
		if (checkpoint && usage + reserve > this.maxStorageBytes) {
			// Checkpointing does not delete events. Pinned reader snapshots may prevent truncation.
			this.database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
			usage = await this.storageUsage();
		}
		if (usage + reserve > this.maxStorageBytes) {
			this.storageLimited = true;
			throw new LocalEventQueueError('Queue storage limit reached.', 'storage_limit');
		}
	}
}
