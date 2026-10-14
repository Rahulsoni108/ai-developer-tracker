import { setImmediate } from 'node:timers/promises';
import { EventValidationError, validateEvent, type TrackerEvent } from './eventSchema';
import type { ActivityWriter } from './jsonlWriter';
import { safeQueueError, type LocalEventQueue, type QueueFailureCode } from './localEventQueue';
import type { RecordingController } from './recording';

export type PersistenceDiagnostic = 'queue_failed' | 'jsonl_failed';
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

	constructor(private readonly queue: Pick<LocalEventQueue, 'enqueue' | 'close'> & Partial<Pick<LocalEventQueue, 'beginSession' | 'finishSession'>>
		& { onDidFail?: (listener: (code: QueueFailureCode) => void) => { dispose(): void } },
		private readonly jsonl: ActivityWriter,
		private readonly onDiagnostic: (reason: PersistenceDiagnostic, code?: QueueFailureCode) => void = () => {}) {
		this.failureSubscription = queue.onDidFail?.(code => this.diagnostic('queue_failed', code));
	}

	attachRecording(recording: RecordingController): { dispose(): void } {
		return recording.addLifecycleListener({
			prepare: async sessionId => {
				try { await this.queue.beginSession?.(sessionId); if (this.queue.beginSession) { this.sessions.add(sessionId); } }
				catch (error) { this.diagnostic('queue_failed', safeQueueError(error).code); throw new EventPersistenceError(); }
			},
			started() {}, stopped() {},
			cancelled: sessionId => { void this.completeSession(sessionId, 'cancelled'); }
		});
	}

	/** Complete only after the caller has drained all producers and correlations. */
	async completeSession(sessionId?: string, status: 'completed' | 'cancelled' = 'completed'): Promise<void> {
		await this.flush();
		if (!sessionId || !this.sessions.has(sessionId) || this.degraded) { return; }
		try { await this.queue.finishSession?.(sessionId, status); this.sessions.delete(sessionId); }
		catch (error) { this.diagnostic('queue_failed', safeQueueError(error).code); }
	}

	/** Notifications mean durable SQLite capture, independently of JSONL success. */
	onDidWrite(listener: (event: Readonly<TrackerEvent>) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	write(event: unknown): Promise<void> {
		if (this.closing) { return Promise.reject(new EventPersistenceError()); }
		const validation = validateEvent(event);
		if (!validation.valid) { return Promise.reject(new EventValidationError(validation.errors)); }
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
			try { await this.queue.enqueue(JSON.parse(snapshot)); }
			catch (error) {
				this.diagnostic('queue_failed', safeQueueError(error).code);
				throw new EventPersistenceError();
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

	async flush(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.pending;
			await pending;
		} while (pending !== this.pending);
		try { await this.jsonl.flush(); } catch { this.diagnostic('jsonl_failed'); }
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
				finally { this.failureSubscription?.dispose(); this.listeners.clear(); this.committed.clear(); this.sessions.clear(); }
			})();
		}
		return this.closePromise;
	}

	private diagnostic(reason: PersistenceDiagnostic, code?: QueueFailureCode): void {
		if (reason === 'queue_failed') { this.degraded = true; }
		try { this.onDiagnostic(reason, code); } catch { /* Diagnostics must not expose exceptions or break capture. */ }
	}
}
