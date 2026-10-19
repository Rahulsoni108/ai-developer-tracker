import { createHash } from 'node:crypto';
import type { UploadPrivacyContext } from './uploadPrivacyContext';
import { setImmediate } from 'node:timers/promises';
import { types } from 'node:util';
import { validateEvent, type TrackerEvent } from './eventSchema';
import type { ActivityWriter } from './jsonlWriter';
import { safeQueueError, type LocalEventQueue, type QueueFailureCode } from './localEventQueue';
import type { RecordingController } from './recording';
import { PrivacyFilter, PRIVACY_REASON_CODES, type PrivacyContext, type PrivacyReasonCode, type PrivacyResult } from './privacyFilter';

export type PersistenceDiagnostic = 'queue_failed' | 'jsonl_failed' | 'privacy_rejected' | 'privacy_gap';
export type PrivacyApprovals = Omit<PrivacyContext, 'recordingActive' | 'sessionId'>;
export interface PersistencePrivacyOptions {
	/** Explicit trusted admission context for embedding/testing without attachRecording. No permissive default. */
	context?: () => PrivacyContext | undefined;
	filter?: Pick<PrivacyFilter, 'filter'>;
}
export class EventPersistenceError extends Error {
	constructor() { super('Durable event persistence failed.'); this.name = 'EventPersistenceError'; }
}

/** One queue-first path for every collector. JSONL is a best-effort debug mirror. */
export class EventPersistence implements ActivityWriter {
	private pending: Promise<void> = Promise.resolve();
	private closing = false;
	private closePromise?: Promise<void>;
	private bufferedBytes = 0;
	private readonly committed = new Set<string>();
	private readonly listeners = new Set<(event: Readonly<TrackerEvent>) => void>();
	private readonly sessions = new Set<string>();
	private degraded = false;
	private readonly failureSubscription?: { dispose(): void };
	private readonly filter: Pick<PrivacyFilter, 'filter'>;
	private readonly uploadApprovals = new Map<string, { digest: string; context: UploadPrivacyContext; bytes: number }>();
	private uploadApprovalBytes = 0;
	private readonly admissions = new Map<string, PrivacyContext>();
	private recording?: RecordingController;
	private approvals?: (sessionId: string) => PrivacyApprovals;

	constructor(private readonly queue: Pick<LocalEventQueue, 'enqueue' | 'close'> & Partial<Pick<LocalEventQueue, 'beginSession' | 'finishSession' | 'recordPrivacyRejection' | 'enqueueApproved' | 'getUploadPrivacyContext' | 'revokeEvidenceApprovals'>>
		& { onDidFail?: (listener: (code: QueueFailureCode) => void) => { dispose(): void } },
		private readonly jsonl: ActivityWriter,
		private readonly onDiagnostic: (reason: PersistenceDiagnostic, code?: QueueFailureCode) => void = () => {},
		private readonly privacy: PersistencePrivacyOptions = {}) {
		this.filter = privacy.filter ?? new PrivacyFilter();
		this.failureSubscription = queue.onDidFail?.(code => this.diagnostic('queue_failed', code));
	}

	attachRecording(recording: RecordingController, approvals: (sessionId: string) => PrivacyApprovals = () => ({
		approvedWorkspaceIds: [], confirmedCodexSessions: [], codexContentConsent: false
	})): { dispose(): void } {
		this.recording = recording; this.approvals = approvals;
		return recording.addLifecycleListener({
			prepare: async sessionId => {
				try { await this.queue.beginSession?.(sessionId); if (this.queue.beginSession) { this.sessions.add(sessionId); } }
				catch (error) { this.diagnostic('queue_failed', safeQueueError(error).code); throw new EventPersistenceError(); }
			},
			started: sessionId => { this.snapshotApprovals(sessionId); },
			// Register before producers: freeze approvals before their Stop handlers expire consent.
			stopped: sessionId => { this.snapshotApprovals(sessionId); },
			cancelled: sessionId => { void this.completeSession(sessionId, 'cancelled'); }
		});
	}

	/** Complete only after the caller has drained all producers and correlations. */
	async completeSession(sessionId?: string, status: 'completed' | 'cancelled' = 'completed'): Promise<void> {
		await this.flush();
		if (sessionId) { this.admissions.delete(sessionId); }
		if (!sessionId || !this.sessions.has(sessionId) || this.degraded) { return; }
		try { await this.queue.finishSession?.(sessionId, status); this.sessions.delete(sessionId); }
		catch (error) { this.diagnostic('queue_failed', safeQueueError(error).code); }
	}

	/** Notifications mean durable SQLite capture, independently of JSONL success. */
	get isDegraded(): boolean { return this.degraded; }

	onDidWrite(listener: (event: Readonly<TrackerEvent>) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	write(event: unknown): Promise<void> {
		if (this.closing) { return Promise.reject(new EventPersistenceError()); }
		let context: PrivacyContext | undefined;
		let result: PrivacyResult;
		const verifiedToolPaths: NonNullable<UploadPrivacyContext['verifiedToolPaths']> = [];
		let proofOversized = false;
		let proofPathBytes = 0;
		try {
			if (this.recording?.isRecording && this.recording.sessionId) { this.snapshotApprovals(this.recording.sessionId); }
			const id = event && typeof event === 'object' && !types.isProxy(event)
				? Object.getOwnPropertyDescriptor(event, 'sessionId')?.value : undefined;
			context = this.recording ? this.admissions.get(id) ?? (this.recording.sessionId ? this.admissions.get(this.recording.sessionId) : undefined)
				: this.privacy.context?.();
			const guardedContext = context?.resolveToolPath ? { ...context, resolveToolPath: (path: string, workspaceId: string) => {
				const relativePath = context!.resolveToolPath!(path, workspaceId);
				if (relativePath !== undefined && !verifiedToolPaths.some(entry => entry.path === path && entry.workspaceId === workspaceId)) {
					proofPathBytes += Buffer.byteLength(path) + Buffer.byteLength(relativePath) + Buffer.byteLength(workspaceId);
					if (verifiedToolPaths.length >= 128 || proofPathBytes > 65536) { proofOversized = true; }
					else { verifiedToolPaths.push({ path, workspaceId, relativePath }); }
				}
				return relativePath;
			} } : context;
			result = this.filter.filter(event, guardedContext ?? { recordingActive: false, sessionId: '', approvedWorkspaceIds: [],
				confirmedCodexSessions: [], codexContentConsent: false });
		} catch { result = { status: 'rejected', reasonCodes: ['filter_failed'] }; }
		if (result.status === 'rejected') { return this.rejectPrivateEvent(context, result.reasonCodes); }
		let filtered = result.event;
		if (result.requiresReconstructionGap && (filtered.eventType === 'file.diff' || filtered.eventType === 'file.baseline')) {
			// A modified patch cannot attest to the original hashes. Preserve identity, retain no patch.
			filtered = { ...filtered, eventType: 'file.gap', payload: { relativePath: filtered.payload.relativePath,
				reason: 'privacy_filter', changeReason: filtered.payload.changeReason,
				beforeHash: filtered.payload.beforeHash, afterHash: filtered.payload.afterHash } };
			this.diagnostic('privacy_gap');
		}
		const validation = validateEvent(filtered);
		if (!validation.valid) { return this.rejectPrivateEvent(context, ['filter_failed']); }
		const uploadContext: UploadPrivacyContext | undefined = context && !proofOversized ? {
			recordingActive: context.recordingActive, sessionId: context.sessionId,
			approvedWorkspaceIds: context.approvedWorkspaceIds.filter(id => id === validation.event.workspaceId),
			confirmedCodexSessions: context.confirmedCodexSessions.filter(entry => entry.sourceSessionId === validation.event.sourceSessionId
				&& entry.workspaceId === validation.event.workspaceId).map(entry => ({ ...entry })),
			codexContentConsent: context.codexContentConsent,
			confirmedClaudeSessions: context.confirmedClaudeSessions?.filter(entry => entry.sourceSessionId === validation.event.sourceSessionId
				&& entry.workspaceId === validation.event.workspaceId).map(entry => ({ ...entry })),
			claudeContentConsent: context.claudeContentConsent, verifiedToolPaths
		} : undefined;
		if (!uploadContext) { return this.rejectPrivateEvent(context, [proofOversized ? 'processing_limit' : 'filter_failed']); }
		const snapshot = JSON.stringify(validation.event);
		const bytes = Buffer.byteLength(snapshot);
		// Bound outstanding content; overload is visible rather than silently dropping it.
		if (this.bufferedBytes + bytes > 32 * 1024 * 1024) {
			this.diagnostic('queue_failed');
			return Promise.reject(new EventPersistenceError());
		}
		this.bufferedBytes += bytes;
		const eventId = validation.event.eventId;
		const writing = this.pending.then(async () => {
			if (this.committed.has(eventId)) { return; }
			// Yield between individual commits: never synchronously drain a large batch.
			await setImmediate();
			try {
				if (uploadContext && this.queue.enqueueApproved) { await this.queue.enqueueApproved(JSON.parse(snapshot), uploadContext); }
				else { await this.queue.enqueue(JSON.parse(snapshot)); }
			}
			catch (error) {
				this.diagnostic('queue_failed', safeQueueError(error).code);
				throw new EventPersistenceError();
			}
			if (uploadContext) {
				const proof = { digest: createHash('sha256').update(snapshot).digest('hex'), context: uploadContext,
					bytes: Buffer.byteLength(JSON.stringify(uploadContext)) + 256 };
				const previous = this.uploadApprovals.get(eventId); this.uploadApprovalBytes -= previous?.bytes ?? 0;
				this.uploadApprovals.set(eventId, proof); this.uploadApprovalBytes += proof.bytes;
				while (this.uploadApprovals.size > 4096 || this.uploadApprovalBytes > 8 * 1024 * 1024) {
					const oldest = this.uploadApprovals.keys().next().value!;
					this.uploadApprovalBytes -= this.uploadApprovals.get(oldest)!.bytes; this.uploadApprovals.delete(oldest);
				}
			}
			this.committed.add(eventId);
			if (this.committed.size > 2048) { this.committed.delete(this.committed.values().next().value!); }
			try { await this.jsonl.write(JSON.parse(snapshot)); }
			catch { this.diagnostic('jsonl_failed'); }
			for (const listener of this.listeners) {
				try { listener(JSON.parse(snapshot)); } catch { /* Observer errors cannot invalidate a durable event. */ }
			}
		}).finally(() => { this.bufferedBytes -= bytes; });
		this.pending = writing.catch(() => {});
		return writing;
	}

	/** Production uses authenticated worker proofs; never fall back to volatile approvals after a worker failure. */
	async resolveUploadPrivacyContext(event: TrackerEvent): Promise<UploadPrivacyContext | undefined> {
		if (this.queue.getUploadPrivacyContext) {
			try { return await this.queue.getUploadPrivacyContext(event); }
			catch { this.diagnostic('queue_failed'); return undefined; }
		}
		return this.getUploadPrivacyContext(event);
	}
	async revokeEvidenceApprovals(sessionId: string): Promise<void> {
		// Block immediately in memory as well as durably. This does not delete evidence or acknowledge it.
		for (const [id, proof] of this.uploadApprovals) {
			if (proof.context.sessionId === sessionId) { this.uploadApprovals.delete(id); this.uploadApprovalBytes -= proof.bytes; }
		}
		if (!this.queue.revokeEvidenceApprovals) { throw new EventPersistenceError(); }
		await this.queue.revokeEvidenceApprovals(sessionId);
	}

	/** Legacy in-memory view for embedders. Production upload resolution always uses the storage worker. */
	getUploadPrivacyContext(event: TrackerEvent): UploadPrivacyContext | undefined {
		try {
			const proof = this.uploadApprovals.get(event.eventId); if (!proof) { return undefined; }
			const validation = validateEvent(event);
			if (!validation.valid || createHash('sha256').update(JSON.stringify(validation.event)).digest('hex') !== proof.digest) { return undefined; }
			return structuredClone(proof.context);
		} catch { return undefined; }
	}

	async flush(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.pending;
			await pending;
		} while (pending !== this.pending);
		try { await this.jsonl.flush(); } catch { this.diagnostic('jsonl_failed'); }
	}
	/** Call only after stopped producers have drained and confirmed storage cleanup completes. */
	resetAfterCleanup(): void {
		if (this.recording?.isRecording || this.recording?.isStarting) { throw new EventPersistenceError(); }
		this.committed.clear(); this.sessions.clear(); this.admissions.clear(); this.uploadApprovals.clear(); this.uploadApprovalBytes = 0;
		this.degraded = false;
	}

	/** Call after producers and the correlator have drained their own pending work. */
	close(): Promise<void> {
		if (!this.closePromise) {
			this.closing = true;
			this.closePromise = (async () => {
				await this.flush();
				for (const sessionId of this.sessions) { await this.completeSession(sessionId); }
				try { await this.queue.close(); }
				catch (error) { this.diagnostic('queue_failed', safeQueueError(error).code); throw new EventPersistenceError(); }
				finally { this.failureSubscription?.dispose(); this.listeners.clear(); this.committed.clear(); this.sessions.clear(); this.admissions.clear(); this.uploadApprovals.clear(); this.uploadApprovalBytes = 0; }
			})();
		}
		return this.closePromise;
	}

	private snapshotApprovals(sessionId: string): void {
		try {
			const scope = this.approvals!(sessionId);
			this.admissions.set(sessionId, { ...scope, sessionId, recordingActive: true,
				approvedWorkspaceIds: [...scope.approvedWorkspaceIds], confirmedCodexSessions: scope.confirmedCodexSessions.map(session => ({ ...session })) });
		} catch { this.admissions.delete(sessionId); }
	}

	private rejectPrivateEvent(context: PrivacyContext | undefined, reasons: readonly PrivacyReasonCode[]): Promise<void> {
		// No payload, paths, source IDs, exception text or event IDs enter health metadata.
		const safeReasons = reasons.length && reasons.length <= PRIVACY_REASON_CODES.length
			&& reasons.every(reason => PRIVACY_REASON_CODES.includes(reason)) ? [...new Set(reasons)] : ['filter_failed' as const];
		const healthSession = context?.sessionId ?? this.recording?.sessionId;
		this.diagnostic('privacy_rejected');
		const rejected = this.pending.then(async () => {
			if (healthSession && this.sessions.has(healthSession)) {
				try {
					if (!this.queue.recordPrivacyRejection) { throw new EventPersistenceError(); }
					await this.queue.recordPrivacyRejection(healthSession, safeReasons);
				} catch (error) { this.diagnostic('queue_failed', safeQueueError(error).code); }
			}
			throw new EventPersistenceError();
		});
		this.pending = rejected.catch(() => {});
		return rejected;
	}

	private diagnostic(reason: PersistenceDiagnostic, code?: QueueFailureCode): void {
		if (reason === 'queue_failed' && code !== 'maintenance_active') { this.degraded = true; }
		try { this.onDiagnostic(reason, code); } catch { /* Diagnostics must not expose exceptions or break capture. */ }
	}
}
