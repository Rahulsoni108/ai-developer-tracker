import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { Uri } from 'vscode';
import type { TrackerEvent } from './eventSchema';
import { ACTIVE_QUEUE_OWNERS, LocalEventQueueError, QUEUE_PROCESS_INSTANCE_ID,
	type QueueFailureCode, type QueueHealth, type QueueOptions, type RecordingSessionStatus } from './localEventQueue';

export type QueueOperation = 'enqueue' | 'getPending' | 'markAcknowledged' | 'getPendingCount' | 'getHealth' | 'beginSession' | 'finishSession' | 'getRecordingSessions' | 'close';
export interface QueueRequest { id: number; operation: QueueOperation; argument?: unknown }
export type QueueReply = { type: 'ready'; health: QueueHealth } | { type: 'health'; health: QueueHealth }
	| { type: 'failed'; code: QueueFailureCode } | { type: 'result'; id: number; ok: boolean; value?: unknown; code?: QueueFailureCode };
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

	static async open(globalStorageUri: StorageUri, workspaceFolders: readonly { uri: StorageUri }[], options: Pick<QueueOptions, 'maxStorageBytes'> = {}): Promise<AsyncLocalEventQueue> {
		let worker: Worker;
		const ownerId = randomUUID();
		ACTIVE_QUEUE_OWNERS.add(ownerId);
		try {
			worker = new Worker(join(__dirname, 'localEventQueueWorker.js'), { workerData: {
				storage: { scheme: globalStorageUri.scheme, fsPath: globalStorageUri.fsPath },
				options: { ...options, ownerId, processInstanceId: QUEUE_PROCESS_INSTANCE_ID, liveOwnerIds: [...ACTIVE_QUEUE_OWNERS] },
				folders: workspaceFolders.map(folder => ({ uri: { scheme: folder.uri.scheme, fsPath: folder.uri.fsPath } }))
			} });
		} catch { ACTIVE_QUEUE_OWNERS.delete(ownerId); throw new LocalEventQueueError('Unable to open local event queue.', 'unavailable'); }
		const queue = new AsyncLocalEventQueue(worker, ownerId);
		try {
			await new Promise<void>((resolve, reject) => {
				const ready = (reply: QueueReply) => {
					if (reply.type === 'ready') { cleanup(); resolve(); }
					else if (reply.type === 'failed') { cleanup(); reject(new LocalEventQueueError('Unable to open local event queue.', reply.code)); }
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

	async enqueue(event: unknown): Promise<void> { await this.request('enqueue', event); }
	async getPending(limit: number): Promise<TrackerEvent[]> { return await this.request('getPending', limit) as TrackerEvent[]; }
	async markAcknowledged(eventIds: readonly string[]): Promise<void> { await this.request('markAcknowledged', [...eventIds]); }
	async getPendingCount(): Promise<number> { return await this.request('getPendingCount') as number; }
	async getHealth(): Promise<QueueHealth> { return await this.request('getHealth') as QueueHealth; }
	async beginSession(sessionId: string): Promise<void> { await this.request('beginSession', sessionId); }
	async finishSession(sessionId: string, status: 'completed' | 'cancelled' = 'completed'): Promise<void> {
		await this.request('finishSession', { sessionId, status });
	}
	async getRecordingSessions(limit = 1000): Promise<RecordingSessionStatus[]> { return await this.request('getRecordingSessions', limit) as RecordingSessionStatus[]; }
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
