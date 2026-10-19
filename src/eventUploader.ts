import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { SecretStorage } from 'vscode';
import { EventBatchManager, type PreparedEventBatch } from './eventBatchManager';
import type { AsyncLocalEventQueue } from './asyncLocalEventQueue';
import { isUuid, type TrackerEvent } from './eventSchema';
import type { UploadPrivacyContext } from './uploadPrivacyContext';
import type { UploadPauseReason } from './uploadState';
import { HttpsEventTransport, UploadTransportError, validatedUploadEndpoint, type UploadTransport } from './httpsEventTransport';

export const UPLOAD_TOKEN_SECRET = 'ai-developer-tracker.upload-token.v1';
export interface EventUploaderOptions {
	endpoint?: string;
	maxEvents?: number;
	maxBytes?: number;
	timeoutMs?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	/** Must display a separate upload consent dialog. Never infer approval from recording consent/settings. */
	confirmUpload: (origin: string) => Promise<boolean>;
	/** Trusted historical approval snapshot, not derived from untrusted event fields. Missing approval fails closed. */
	privacyContext: (event: TrackerEvent) => UploadPrivacyContext | undefined | Promise<UploadPrivacyContext | undefined>;
	onStatus?: (status: UploadOutcome) => void;
}
export type UploadOutcome = 'disabled' | 'waiting' | 'empty' | 'delivered' | 'retry' | 'cancelled' | UploadPauseReason;
export function retryDelay(attempts: number, base: number, maximum: number, retryAfter?: string, now = Date.now()): number {
	const cap = Math.min(maximum, base * 2 ** Math.min(Math.max(attempts - 1, 0), 30));
	let delay = Math.floor(cap / 2 + Math.random() * cap / 2); // Equal jitter with a non-zero floor.
	if (retryAfter && retryAfter.length <= 128) {
		let parsed: number | undefined;
		if (/^\d+$/.test(retryAfter)) { parsed = Number(retryAfter) * 1000; }
		else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter)) {
			parsed = Date.parse(retryAfter) - now;
		}
		if (parsed !== undefined && Number.isFinite(parsed) && parsed >= 0) { delay = Math.max(delay, Math.min(maximum, parsed)); }
	}
	return Math.min(maximum, Math.max(1, delay));
}

type RetryQueue = Pick<AsyncLocalEventQueue, 'getUploadRetryState' | 'configureUpload' | 'claimUploadAttempt' | 'finishUploadAttempt'>;
class SafeUploadFailure extends Error {
	constructor(readonly reason: UploadPauseReason) { super('Event upload could not complete.'); }
}

/** Standalone opt-in delivery driver; never participates in collector persistence or recording consent. */
export class EventUploader {
	private enabled = false;
	private generation = 0;
	private endpoint?: URL;
	private endpointHash?: string;
	private active?: Promise<UploadOutcome>;
	private controller?: AbortController;
	private timer?: NodeJS.Timeout;
	private running = false;
	private readonly transport: UploadTransport;
	private readonly options: Required<Pick<EventUploaderOptions, 'maxEvents' | 'maxBytes' | 'timeoutMs' | 'baseDelayMs' | 'maxDelayMs'>>;
	constructor(private readonly batches: EventBatchManager, private readonly queue: RetryQueue,
		private readonly secrets: Pick<SecretStorage, 'get'>, private readonly hooks: EventUploaderOptions, transport?: UploadTransport) {
		this.options = { maxEvents: hooks.maxEvents ?? 100, maxBytes: hooks.maxBytes ?? 1024 * 1024,
			timeoutMs: hooks.timeoutMs ?? 30000, baseDelayMs: hooks.baseDelayMs ?? 1000, maxDelayMs: hooks.maxDelayMs ?? 3600000 };
		const limits = { maxEvents: [1, 1000], maxBytes: [1024, 4 * 1024 * 1024], timeoutMs: [10, 120000],
			baseDelayMs: [100, 60000], maxDelayMs: [100, 86400000] };
		for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
			if (!Number.isSafeInteger(this.options[key]) || this.options[key] < limits[key][0] || this.options[key] > limits[key][1]) { throw new SafeUploadFailure('configuration'); }
		}
		if (this.options.maxDelayMs < this.options.baseDelayMs) { throw new SafeUploadFailure('configuration'); }
		this.transport = transport ?? new HttpsEventTransport();
	}

	/** Disabled on construction/restart. Enablement always requires fresh separate explicit user approval. */
	async enable(): Promise<boolean> {
		await this.disable(); const generation = ++this.generation;
		try {
			const endpoint = validatedUploadEndpoint(this.hooks.endpoint ?? '');
			if (!await this.hooks.confirmUpload(endpoint.origin) || generation !== this.generation) { return false; }
			const hash = createHash('sha256').update(endpoint.href).digest('hex');
			await this.queue.configureUpload(hash);
			if (generation !== this.generation) { return false; }
			this.endpoint = endpoint; this.endpointHash = hash; this.enabled = true; return true;
		} catch { this.notify('configuration'); return false; }
	}
	async disable(): Promise<void> {
		this.enabled = false; this.running = false; ++this.generation;
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
		this.controller?.abort(); await this.active;
	}
	cancel(): void { this.running = false; if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } this.controller?.abort(); }
	async dispose(): Promise<void> { await this.disable(); if (this.transport instanceof HttpsEventTransport) { this.transport.dispose(); } }

	/** Concurrent calls share one operation; SQLite also leases attempts across separate workers. */
	uploadOnce(): Promise<UploadOutcome> {
		if (this.active) { return this.active; }
		const operation = this.perform(); this.active = operation;
		void operation.finally(() => { if (this.active === operation) { this.active = undefined; } });
		return operation;
	}
	start(): void {
		if (!this.enabled || this.running) { return; } this.running = true;
		void this.pump();
	}
	private async pump(): Promise<void> {
		const outcome = await this.uploadOnce();
		if (!this.running || !this.enabled || ['authentication', 'configuration', 'privacy', 'protocol', 'storage'].includes(outcome)) { this.running = false; return; }
		try {
			const state = await this.queue.getUploadRetryState();
			const delay = Math.max(this.options.baseDelayMs, (state?.nextAttemptAt ?? 0) - Date.now());
			this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, Math.min(delay, this.options.maxDelayMs));
		} catch { this.running = false; this.notify('storage'); }
	}
	private notify(outcome: UploadOutcome): UploadOutcome {
		try { this.hooks.onStatus?.(outcome); } catch { /* Fixed categories only. */ } return outcome;
	}
	private async perform(): Promise<UploadOutcome> {
		if (!this.enabled || !this.endpoint || !this.endpointHash) { return this.notify('disabled'); }
		const controller = new AbortController(); this.controller = controller;
		let claimed = false; let batch: PreparedEventBatch | null = null; let timeout: NodeJS.Timeout | undefined;
		let timedOut = false;
		let outcome: UploadOutcome = 'retry'; let nextAttemptAt = 0; let resetAttempts = false;
		try {
			const state = await this.queue.claimUploadAttempt(this.endpointHash, Date.now(), Date.now() + this.options.timeoutMs + this.options.maxDelayMs);
			if (!state) {
				const existing = await this.queue.getUploadRetryState(); return this.notify(existing?.pauseReason ?? 'waiting');
			}
			claimed = true;
			nextAttemptAt = Date.now() + retryDelay(state.attempts, this.options.baseDelayMs, this.options.maxDelayMs);
			if (controller.signal.aborted || !this.enabled) { outcome = timedOut ? 'retry' : 'cancelled'; return this.notify(outcome); }
			timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.timeoutMs);
			let token: string | undefined;
			try { token = await this.abortable(Promise.resolve(this.secrets.get(UPLOAD_TOKEN_SECRET)), controller.signal); } catch { throw new SafeUploadFailure('authentication'); }
			if (typeof token !== 'string' || !token || !/^[\x21-\x7e]{1,8192}$/.test(token)) { throw new SafeUploadFailure('authentication'); }
			batch = await this.batches.prepareBatch(this.options.maxEvents, this.options.maxBytes - 128);
			if (!batch) { outcome = 'empty'; nextAttemptAt = 0; resetAttempts = true; return this.notify(outcome); }
			const body = await this.prepareBody(batch, controller.signal);
			if (controller.signal.aborted || !this.enabled) { outcome = timedOut ? 'retry' : 'cancelled'; return this.notify(outcome); }
			const response = await this.abortable(this.transport.send({ endpoint: this.endpoint, token, body, signal: controller.signal }), controller.signal);
			if (controller.signal.aborted || !this.enabled) { outcome = timedOut ? 'retry' : 'cancelled'; return this.notify(outcome); }
			if (response.status === 401 || response.status === 403) { throw new SafeUploadFailure('authentication'); }
			if ([408, 429].includes(response.status) || response.status >= 500 && response.status <= 599) {
				nextAttemptAt = Date.now() + retryDelay(state.attempts, this.options.baseDelayMs, this.options.maxDelayMs, response.retryAfter);
				return this.notify('retry');
			}
			if (response.status < 200 || response.status >= 300) { throw new SafeUploadFailure('configuration'); }
			const ids = this.acknowledgments(response.body, response.contentType, batch);
			await this.batches.markDelivered(batch.batchId, ids);
			if (ids.length === batch.events.length) { outcome = 'delivered'; nextAttemptAt = 0; resetAttempts = true; }
			return this.notify(outcome);
		} catch (error) {
			outcome = controller.signal.aborted ? timedOut ? 'retry' : 'cancelled'
				: error instanceof SafeUploadFailure ? error.reason
				: error instanceof UploadTransportError ? error.category === 'network' ? 'retry' : error.category
					: 'storage';
			return this.notify(outcome);
		} finally {
			if (timeout) { clearTimeout(timeout); }
			let storageFailed = false;
			if (batch) { try { await this.batches.releaseBatch(batch.batchId); } catch { storageFailed = true; } }
			if (claimed) {
				const paused = ['authentication', 'configuration', 'protocol', 'privacy', 'storage'].includes(outcome) ? outcome as UploadPauseReason : null;
				try { await this.queue.finishUploadAttempt(nextAttemptAt, storageFailed ? 'storage' : paused, resetAttempts); }
				catch { storageFailed = true; }
			}
			if (storageFailed) { this.running = false; this.enabled = false; this.notify('storage'); }
			this.controller = undefined;
		}
	}
	private abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
		return new Promise((resolve, reject) => {
			const abort = () => reject(new UploadTransportError('network'));
			if (signal.aborted) { abort(); }
			else { signal.addEventListener('abort', abort, { once: true }); }
			operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
		});
	}
	private acknowledgments(body: string, contentType: string | undefined, batch: PreparedEventBatch): string[] {
		try {
			if (Buffer.byteLength(body) > 128 * 1024 || !/^application\/json(?:\s*;|$)/i.test(contentType ?? '')) { throw new Error(); }
			for (const key of ['contractVersion', 'batchId', 'durablyAcceptedEventIds']) {
				if ((body.match(new RegExp(`\"${key}\"\\s*:`, 'g')) ?? []).length !== 1) { throw new Error(); }
			}
			const ack = JSON.parse(body);
			const allowed = new Set(batch.events.map(event => event.eventId));
			if (!ack || Object.keys(ack).length !== 3 || ack.contractVersion !== 1 || ack.batchId !== batch.batchId
				|| !Array.isArray(ack.durablyAcceptedEventIds) || ack.durablyAcceptedEventIds.length > batch.events.length
				|| ack.durablyAcceptedEventIds.some((id: unknown) => !isUuid(id) || !allowed.has(id as string))
				|| new Set(ack.durablyAcceptedEventIds).size !== ack.durablyAcceptedEventIds.length) { throw new Error(); }
			return ack.durablyAcceptedEventIds;
		} catch { throw new SafeUploadFailure('protocol'); }
	}
	private async prepareBody(batch: PreparedEventBatch, signal: AbortSignal): Promise<string> {
		const contexts: UploadPrivacyContext[] = [];
		try {
			// Sequential RPCs bound outstanding requests and allow cancellation between records.
			for (const event of batch.events) {
				if (signal.aborted) { throw new UploadTransportError('network'); }
				const context = await this.hooks.privacyContext(event);
				if (!context || context.isApprovedRelativePath || context.resolveToolPath) { throw new SafeUploadFailure('privacy'); }
				contexts.push(context);
			}
		} catch (error) { throw error instanceof UploadTransportError ? error : new SafeUploadFailure('privacy'); }
		return new Promise((resolve, reject) => {
			let worker: Worker;
			try {
				worker = new Worker(join(__dirname, 'eventUploadPrivacyWorker.js'), { workerData: { batch, contexts, maxBytes: this.options.maxBytes } });
			} catch { reject(new SafeUploadFailure('privacy')); return; }
			const cancel = () => { void worker.terminate(); reject(new UploadTransportError('network')); };
			if (signal.aborted) { cancel(); return; }
			signal.addEventListener('abort', cancel, { once: true });
			worker.once('message', (reply: { ok: boolean; body?: string; reason?: UploadPauseReason }) => {
				if (reply.ok && typeof reply.body === 'string') { resolve(reply.body); }
				else { reject(new SafeUploadFailure(reply.reason === 'configuration' ? 'configuration' : 'privacy')); }
			});
			worker.once('error', () => reject(new SafeUploadFailure('privacy')));
			worker.once('exit', () => { signal.removeEventListener('abort', cancel); reject(new SafeUploadFailure('privacy')); });
		});
	}
}
