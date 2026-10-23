import type { AssessmentFinalizationRequest, FinalizationScope } from './assessmentFinalization';
import type { AssessmentApprovalBinding } from './assessmentEventApproval';
import type { UploadPrivacyContext } from './uploadPrivacyContext';
import type { EvidenceConsentState } from './evidenceConsent';
import type { UploadRetryState, UploadPauseReason } from './uploadState';
import type { PreparedEventBatch, DeliveryStatus } from './eventBatchManager';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { Uri } from 'vscode';
import type { TrackerEvent } from './eventSchema';
import { ACTIVE_QUEUE_OWNERS, LocalEventQueueError, QUEUE_PROCESS_INSTANCE_ID,
	type RecordedEventSummary, type QueueFailureCode, type QueueHealth, type QueueOptions, type RecordingSessionStatus, type RecordingPrivacyHealth, type CleanupScope, type CleanupResult, type LocalDataSummary } from './localEventQueue';
import type { DiagnosticDirectories } from './localDiagnosticFiles';
import type { PrivacyReasonCode } from './privacyFilter';
import { EvidenceEncryptionError, type EncryptionKeys, type EncryptionRequirements } from './evidenceEncryption';
import { supplyEvidenceKeys, type EvidenceSecretStorage } from './evidenceKeyStorage';

export type QueueOperation = 'freezeFinalization' | 'getAssessmentUploadContext' | 'enqueueApproved' | 'getUploadPrivacyContext' | 'revokeEvidenceApprovals' | 'getEvidenceConsent' | 'setEvidenceConsent' | 'getSessionEvidenceStatus' | 'getRecordedEventSummary' | 'getUploadRetryState' | 'configureUpload' | 'claimUploadAttempt' | 'finishUploadAttempt' | 'prepareBatch' | 'markDelivered' | 'releaseBatch' | 'getDeliveryStatus' | 'enqueue' | 'getPending' | 'markAcknowledged' | 'getPendingCount' | 'getHealth' | 'beginSession' | 'finishSession' | 'getRecordingSessions' | 'recordPrivacyRejection' | 'getPrivacyHealth' | 'getLocalDataSummary' | 'acquireMaintenance' | 'releaseMaintenance' | 'deleteEvidence' | 'expireAcknowledged' | 'close';
export interface LocalStorageSummary extends LocalDataSummary { legacyLogCount: number; diagnosticFileCount: number }
export interface LocalCleanupResult extends CleanupResult { deletedFiles: number; filesFailed: boolean; storageFailed?: boolean }
export interface QueueRequest { id: number; operation: QueueOperation; argument?: unknown }
export type QueueReply = { type: 'ready'; health: QueueHealth } | { type: 'health'; health: QueueHealth }
	| { type: 'keys_required'; requirements: EncryptionRequirements }
	| { type: 'failed'; code: QueueFailureCode } | { type: 'result'; id: number; ok: boolean; value?: unknown; code?: QueueFailureCode };
export type KeySupplyReply = { type: 'keys_supplied'; keys: EncryptionKeys; liveOwnerIds: string[] } | { type: 'keys_failed'; code: QueueFailureCode };
type StorageUri = Pick<Uri, 'scheme' | 'fsPath'>;

/** Run the existing LocalEventQueue off the extension host; no event consumer or uploader. */
export class AsyncLocalEventQueue {
	private readonly requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private nextId = 0;
	private closing = false;
	private failed = false;
	private closePromise?: Promise<void>;
	private readonly exited: Promise<void>;
	private health?: QueueHealth;
	private readonly healthListeners = new Set<(health: QueueHealth) => void>();
	private readonly failureListeners = new Set<(code: QueueFailureCode) => void>();
	private constructor(private readonly worker: Worker, private readonly ownerId: string) {
		this.exited = new Promise(resolve => { worker.once('exit', () => { ACTIVE_QUEUE_OWNERS.delete(this.ownerId); this.fail(); resolve(); }); });
		worker.on('error', () => this.fail());
		worker.on('message', (reply: QueueReply) => {
			if (reply.type === 'failed') { this.fail(reply.code); void worker.terminate(); return; }
			if (reply.type === 'ready' || reply.type === 'health') {
				this.health = reply.health;
				for (const listener of this.healthListeners) { try { listener({ ...reply.health }); } catch { /* No diagnostic contents. */ } }
				return;
			}
			if (reply.type !== 'result') { return; }
			const request = this.requests.get(reply.id);
			if (!request) { return; }
			this.requests.delete(reply.id);
			if (reply.ok) { request.resolve(reply.value); }
			else { request.reject(new LocalEventQueueError('Local event queue operation failed.', reply.code)); }
		});
	}

	static async open(globalStorageUri: StorageUri, workspaceFolders: readonly { uri: StorageUri }[], options: Pick<QueueOptions, 'maxStorageBytes'> & { diagnosticDirectories?: DiagnosticDirectories } = {},
		secrets?: EvidenceSecretStorage): Promise<AsyncLocalEventQueue> {
		let worker: Worker;
		const ownerId = randomUUID();
		ACTIVE_QUEUE_OWNERS.add(ownerId);
		try {
			worker = new Worker(join(__dirname, 'localEventQueueWorker.js'), { workerData: {
				storage: { scheme: globalStorageUri.scheme, fsPath: globalStorageUri.fsPath },
				options: { maxStorageBytes: options.maxStorageBytes, ownerId, processInstanceId: QUEUE_PROCESS_INSTANCE_ID, liveOwnerIds: [...ACTIVE_QUEUE_OWNERS] },
				folders: workspaceFolders.map(folder => ({ uri: { scheme: folder.uri.scheme, fsPath: folder.uri.fsPath } })),
				diagnosticDirectories: options.diagnosticDirectories
			} });
		} catch { ACTIVE_QUEUE_OWNERS.delete(ownerId); throw new LocalEventQueueError('Unable to open local event queue.', 'unavailable'); }
		const queue = new AsyncLocalEventQueue(worker, ownerId);
		try {
			await new Promise<void>((resolve, reject) => {
				let supplying = false;
				const ready = (reply: QueueReply) => {
					if (reply.type === 'ready') { cleanup(); resolve(); }
					else if (reply.type === 'failed') { cleanup(); reject(new LocalEventQueueError('Unable to open local event queue.', reply.code)); }
					else if (reply.type === 'keys_required' && !supplying) {
						supplying = true;
						void supplyEvidenceKeys(secrets, reply.requirements).then(keys => {
							try {
								// Transfer ownership: sender buffers detach. No keys in workerData, RPC results or diagnostics.
								worker.postMessage({ type: 'keys_supplied', keys, liveOwnerIds: [...ACTIVE_QUEUE_OWNERS] } satisfies KeySupplyReply, keys.keys.map(key => key.bytes));
							} catch { for (const key of keys.keys) { if (key.bytes.byteLength) { new Uint8Array(key.bytes).fill(0); } } }
						}, error => {
							const code = error instanceof EvidenceEncryptionError ? error.code : 'key_storage_unavailable';
							try { worker.postMessage({ type: 'keys_failed', code } satisfies KeySupplyReply); } catch { /* Startup failure is already handled. */ }
						});
					}
				};
				const failure = () => { cleanup(); reject(new LocalEventQueueError('Unable to open local event queue.')); };
				const cleanup = () => { worker.off('message', ready); worker.off('error', failure); worker.off('exit', failure); };
				worker.on('message', ready); worker.once('error', failure); worker.once('exit', failure);
			});
			return queue;
		} catch (error) {
			await worker.terminate();
			throw error instanceof LocalEventQueueError ? error : new LocalEventQueueError('Unable to open local event queue.', 'unavailable');
		}
	}

	async getUploadRetryState(): Promise<UploadRetryState | null> { return await this.request('getUploadRetryState') as UploadRetryState | null; }
	async configureUpload(endpointHash: string): Promise<void> { await this.request('configureUpload', endpointHash); }
	async claimUploadAttempt(endpointHash: string, now: number, recoveryAt: number): Promise<UploadRetryState | null> {
		return await this.request('claimUploadAttempt', { endpointHash, now, recoveryAt }) as UploadRetryState | null;
	}
	async finishUploadAttempt(nextAttemptAt: number, pauseReason: UploadPauseReason | null, resetAttempts: boolean): Promise<void> {
		await this.request('finishUploadAttempt', { nextAttemptAt, pauseReason, resetAttempts });
	}

	async prepareBatch(maxEvents: number, maxBytes: number, localSessionId?: string): Promise<PreparedEventBatch | null> {
		return await this.request('prepareBatch', { maxEvents, maxBytes, localSessionId }) as PreparedEventBatch | null;
	}
	async markDelivered(batchId: string, acknowledgedEventIds: readonly string[]): Promise<void> {
		await this.request('markDelivered', { batchId, acknowledgedEventIds: [...acknowledgedEventIds] });
	}
	async releaseBatch(batchId: string): Promise<void> { await this.request('releaseBatch', batchId); }
	async getDeliveryStatus(): Promise<DeliveryStatus> { return await this.request('getDeliveryStatus') as DeliveryStatus; }
	async enqueue(event: unknown): Promise<void> { await this.request('enqueue', event); }
	async enqueueApproved(event: unknown, context: UploadPrivacyContext): Promise<void> { await this.request('enqueueApproved', { event, context }); }
	async getUploadPrivacyContext(event: TrackerEvent): Promise<UploadPrivacyContext | undefined> { return await this.request('getUploadPrivacyContext', event) as UploadPrivacyContext | undefined; }
	async getAssessmentUploadContext(event: TrackerEvent, binding: AssessmentApprovalBinding): Promise<UploadPrivacyContext | undefined> {
		return await this.request('getAssessmentUploadContext', { event, binding }) as UploadPrivacyContext | undefined;
	}

	async revokeEvidenceApprovals(sessionId: string): Promise<void> { await this.request('revokeEvidenceApprovals', sessionId); }
	async getEvidenceConsent(sessionId: string): Promise<EvidenceConsentState | undefined> { return await this.request('getEvidenceConsent', sessionId) as EvidenceConsentState | undefined; }
	async setEvidenceConsent(state: EvidenceConsentState): Promise<void> { await this.request('setEvidenceConsent', state); }

	async freezeFinalization(scope: FinalizationScope, existingOnly = false): Promise<AssessmentFinalizationRequest> {
		return await this.request('freezeFinalization', { scope, existingOnly }) as AssessmentFinalizationRequest;
	}

	async getPending(limit: number): Promise<TrackerEvent[]> { return await this.request('getPending', limit) as TrackerEvent[]; }
	async markAcknowledged(eventIds: readonly string[]): Promise<void> { await this.request('markAcknowledged', [...eventIds]); }
	async getRecordedEventSummary(): Promise<RecordedEventSummary> { return await this.request('getRecordedEventSummary') as RecordedEventSummary; }
	async getSessionEvidenceStatus(sessionIds: readonly string[]): Promise<{ totalEvents: number; pendingEvents: number; missingSessions: number }> {
		return await this.request('getSessionEvidenceStatus', [...sessionIds]) as { totalEvents: number; pendingEvents: number; missingSessions: number };
	}
	async getPendingCount(): Promise<number> { return await this.request('getPendingCount') as number; }
	async getHealth(): Promise<QueueHealth> { return await this.request('getHealth') as QueueHealth; }
	async beginSession(sessionId: string): Promise<void> { await this.request('beginSession', sessionId); }
	async finishSession(sessionId: string, status: 'completed' | 'cancelled' = 'completed'): Promise<void> {
		await this.request('finishSession', { sessionId, status });
	}
	async getRecordingSessions(limit = 1000): Promise<RecordingSessionStatus[]> { return await this.request('getRecordingSessions', limit) as RecordingSessionStatus[]; }
	async recordPrivacyRejection(sessionId: string, reasons: readonly PrivacyReasonCode[]): Promise<void> {
		await this.request('recordPrivacyRejection', { sessionId, reasons: [...reasons] });
	}
	async getPrivacyHealth(sessionId: string): Promise<RecordingPrivacyHealth> { return await this.request('getPrivacyHealth', sessionId) as RecordingPrivacyHealth; }
	async getLocalDataSummary(): Promise<LocalStorageSummary> { return await this.request('getLocalDataSummary') as LocalStorageSummary; }
	async acquireMaintenance(): Promise<void> { await this.request('acquireMaintenance'); }
	async releaseMaintenance(): Promise<void> { await this.request('releaseMaintenance'); }
	async deleteEvidence(scope: CleanupScope): Promise<LocalCleanupResult> { return await this.request('deleteEvidence', scope) as LocalCleanupResult; }
	async expireAcknowledged(cutoff: string): Promise<LocalCleanupResult> { return await this.request('expireAcknowledged', cutoff) as LocalCleanupResult; }
	get latestHealth(): QueueHealth | undefined { return this.health && { ...this.health }; }
	onDidChangeHealth(listener: (health: QueueHealth) => void): { dispose(): void } {
		this.healthListeners.add(listener);
		return { dispose: () => { this.healthListeners.delete(listener); } };
	}
	onDidFail(listener: (code: QueueFailureCode) => void): { dispose(): void } {
		this.failureListeners.add(listener);
		return { dispose: () => { this.failureListeners.delete(listener); } };
	}

	close(): Promise<void> {
		if (!this.closePromise) {
			const closing = this.failed ? Promise.resolve() : this.request('close');
			this.closing = true;
			this.closePromise = (async () => {
				try { await closing; await this.exited; }
				catch { await this.worker.terminate(); throw new LocalEventQueueError('Unable to close local event queue.'); }
			})();
		}
		return this.closePromise;
	}

	private request(operation: QueueOperation, argument?: unknown): Promise<unknown> {
		if (this.closing || this.failed || this.requests.size >= 256) {
			return Promise.reject(new LocalEventQueueError('Local event queue is unavailable.', 'unavailable'));
		}
		return new Promise((resolve, reject) => {
			const id = ++this.nextId;
			this.requests.set(id, { resolve, reject });
			try { this.worker.postMessage({ id, operation, argument } satisfies QueueRequest); }
			catch { this.requests.delete(id); reject(new LocalEventQueueError('Local event queue operation failed.')); }
		});
	}
	private fail(code: QueueFailureCode = 'unavailable'): void {
		if (!this.failed && !this.closing) {
			for (const listener of this.failureListeners) { try { listener(code); } catch { /* Safe notifications only. */ } }
		}
		this.failed = true;
		for (const request of this.requests.values()) { request.reject(new LocalEventQueueError('Local event queue is unavailable.', code)); }
		this.requests.clear();
		this.healthListeners.clear(); this.failureListeners.clear();
	}
}
