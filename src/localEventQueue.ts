import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Uri } from 'vscode';
import { EventValidationError, isUuid, validateEvent, type TrackerEvent } from './eventSchema';

export const LOCAL_QUEUE_FILENAME = 'event-queue.v1.sqlite';
export const MAX_QUEUE_BATCH = 1000;
// Allow JSON escaping overhead for diffs up to the common schema's 2 MiB limit.
export const MAX_QUEUE_EVENT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_QUEUE_STORAGE_BYTES = 100 * 1024 * 1024;
export const QUEUE_DATABASE_VERSION = 2;
// Shared with the worker proxy to distinguish live threads from abandoned threads in this process.
export const QUEUE_PROCESS_INSTANCE_ID = randomUUID();
export const ACTIVE_QUEUE_OWNERS = new Set<string>();
export type QueueFailureCode = 'operation_failed' | 'corrupt' | 'disk_full' | 'permission_denied' | 'locked' | 'storage_limit' | 'unavailable';
export interface QueueOptions {
	maxStorageBytes?: number;
	/** Internal ownership information supplied by the storage-worker proxy. */
	ownerId?: string;
	processInstanceId?: string;
	liveOwnerIds?: readonly string[];
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
			if (version !== 0 && version !== 1 && version !== QUEUE_DATABASE_VERSION) { throw new LocalEventQueueError('Unsupported queue database version.'); }
			const integrity = database.prepare('PRAGMA integrity_check(1)').all();
			if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
				throw new LocalEventQueueError('Queue database integrity check failed.', 'corrupt');
			}
			if (version === 0) {
				if (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").get()) {
					throw new LocalEventQueueError('Unrecognized queue database.');
				}
				database.exec(`BEGIN IMMEDIATE;
					CREATE TABLE queued_events (
						sequence INTEGER PRIMARY KEY AUTOINCREMENT,
						event_id TEXT NOT NULL UNIQUE,
						event_json TEXT,
						acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1)),
						CHECK (acknowledged = 1 OR event_json IS NOT NULL)
					) STRICT;
					CREATE INDEX pending_events ON queued_events(sequence) WHERE acknowledged = 0;
					PRAGMA user_version = 1;
					COMMIT;`);
			}
			const journal = database.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
			if (journal !== 'wal') { throw new LocalEventQueueError('Durable queue journaling unavailable.'); }
			// Avoid transaction spills; admission reserves WAL frames before COMMIT.
			database.exec('PRAGMA cache_spill = OFF; PRAGMA wal_autocheckpoint = 128;');
			const queue = new LocalEventQueue(database, path, maxStorageBytes, ownerId);
			queue.transaction(() => {
				// One consistent snapshot: another window cannot invalidate counter checks mid-startup.
				queue.verifyStoredEvents();
				if (database!.prepare('PRAGMA user_version').get()?.user_version !== QUEUE_DATABASE_VERSION) { queue.migrateRecoveryMetadata(); }
				queue.verifyCounters();
				const pageSize = Number(database!.prepare('PRAGMA page_size').get()?.page_size);
				database!.exec(`PRAGMA max_page_count = ${Math.floor(maxStorageBytes / pageSize)}`);
				queue.recoverOwners(options);
			});
			await checkDatabaseFiles(path);
			ACTIVE_QUEUE_OWNERS.add(ownerId);
			return queue;
		} catch (error) {
			try { database?.close(); } catch { /* Preserve the safe opening error. */ }
			ACTIVE_QUEUE_OWNERS.delete(ownerId);
			throw safeQueueError(error, 'Unable to open local event queue.');
		}
	}

	enqueue(event: unknown): Promise<void> {
		if (this.closing) { return Promise.reject(new LocalEventQueueError('Local event queue is closed.')); }
		const validation = validateEvent(event);
		if (!validation.valid) { return Promise.reject(new EventValidationError(validation.errors)); }
		// Snapshot before scheduling: callers cannot change the persisted event later.
		const json = JSON.stringify(validation.event);
		if (Buffer.byteLength(json) > MAX_QUEUE_EVENT_BYTES) {
			return Promise.reject(new LocalEventQueueError('Queue event exceeds size limit.'));
		}
		const eventId = validation.event.eventId;
		return this.schedule(async () => {
			// Deduplication is permitted even if no space remains; never revive an acknowledged ID.
			if (this.database.prepare('SELECT 1 FROM queued_events WHERE event_id = ?').get(eventId)) { return; }
			await this.writeWithReservation(Buffer.byteLength(json), () => {
				this.database.prepare(`INSERT INTO recording_sessions(session_id, status, started_at, owner_id)
					VALUES (?, 'active', ?, ?) ON CONFLICT(session_id) DO NOTHING`)
					.run(validation.event.sessionId, validation.event.timestamp, this.ownerId);
				this.database.prepare('INSERT INTO queued_events(event_id, event_json) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING')
					.run(eventId, json);
			});
		});
	}

	getPending(limit: number): Promise<TrackerEvent[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUEUE_BATCH) {
			return Promise.reject(new LocalEventQueueError('Pending limit must be between 1 and 1000.'));
		}
		return this.schedule(() => this.database.prepare(
			'SELECT event_id, event_json FROM queued_events WHERE acknowledged = 0 ORDER BY sequence LIMIT ?'
		).all(limit).map(row => {
			const parsed: unknown = JSON.parse(String(row.event_json));
			const validation = validateEvent(parsed);
			if (!validation.valid || validation.event.eventId !== row.event_id) {
				throw new LocalEventQueueError('Invalid stored queue event.', 'corrupt');
			}
			return parsed as TrackerEvent;
		}));
	}

	markAcknowledged(eventIds: readonly string[]): Promise<void> {
		if (!Array.isArray(eventIds) || eventIds.length > MAX_QUEUE_BATCH || !eventIds.every(isUuid)) {
			return Promise.reject(new LocalEventQueueError('Invalid acknowledgment batch.'));
		}
		const ids = [...new Set(eventIds)];
		return this.schedule(() => this.transaction(() => {
			const update = this.database.prepare('UPDATE queued_events SET acknowledged = 1, event_json = NULL WHERE event_id = ?');
			for (const id of ids) { update.run(id); }
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
			await this.writeWithReservation(1024, () => {
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

	/** Drain already accepted operations. Acknowledged IDs survive as deduplication tombstones. */
	close(): Promise<void> {
		if (!this.closePromise) {
			this.closing = true;
			this.closePromise = this.pending.then(() => {
				try {
					this.transaction(() => {
						this.database.prepare(`UPDATE recording_sessions SET status = 'interrupted', ended_at = ?, reason = 'unfinished_recording'
							WHERE owner_id = ? AND status = 'active'`).run(new Date().toISOString(), this.ownerId);
						this.database.prepare('DELETE FROM queue_owners WHERE owner_id = ?').run(this.ownerId);
					});
				} catch (error) { throw safeQueueError(error, 'Unable to close local event queue.'); }
				finally { ACTIVE_QUEUE_OWNERS.delete(this.ownerId); this.database.close(); }
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

	private verifyStoredEvents(): void {
		for (const row of this.database.prepare('SELECT event_id, event_json, acknowledged FROM queued_events').iterate()) {
			if (!isUuid(row.event_id)) { throw new LocalEventQueueError('Invalid stored event identity.', 'corrupt'); }
			if (row.acknowledged === 0) {
				try {
					const validation = validateEvent(JSON.parse(String(row.event_json)));
					if (!validation.valid || validation.event.eventId !== row.event_id) { throw new Error(); }
				} catch { throw new LocalEventQueueError('Invalid stored queue event.', 'corrupt'); }
			}
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
			'count_interrupted_insert', 'count_interrupted_update', 'pending_events', 'session_owners', 'session_history'];
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
