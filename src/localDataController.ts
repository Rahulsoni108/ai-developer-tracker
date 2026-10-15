import type { AsyncLocalEventQueue, LocalCleanupResult, LocalStorageSummary } from './asyncLocalEventQueue';
import type { RecordingController } from './recording';
import type { CleanupScope } from './localEventQueue';

export const DELETE_LOCAL_EVIDENCE_COMMAND = 'ai-developer-tracker.deleteLocalEvidence';
export const CLEANUP_LEGACY_EVIDENCE_COMMAND = 'ai-developer-tracker.cleanupLegacyEvidence';
export const DEFAULT_RETENTION_DAYS = 30;
export type LocalDataNotice = 'recording_active' | 'maintenance_active' | 'cancelled' | 'cleanup_complete' | 'cleanup_partial' | 'cleanup_failed' | 'retention_failed';
export interface LocalDataOptions {
	confirm(scope: CleanupScope, summary: LocalStorageSummary): Promise<boolean>;
	drain(): Promise<void>;
	cleared(): Promise<void>;
	notice(reason: LocalDataNotice): void;
	retentionDays(): number;
	guard?(): Promise<void>;
	now?: () => Date;
}

/** Trusted UI gate + storage-worker lease. All deletion scopes require explicit confirmation. */
export class LocalDataController {
	private operation?: Promise<unknown>;
	private disposed = false;
	get busy(): boolean { return this.operation !== undefined; }
	constructor(private readonly recording: RecordingController,
		private readonly queue: Pick<AsyncLocalEventQueue, 'acquireMaintenance' | 'releaseMaintenance' | 'getLocalDataSummary' | 'deleteEvidence' | 'expireAcknowledged'>,
		private readonly options: LocalDataOptions) {}
	cleanup(scope: CleanupScope): Promise<LocalCleanupResult | undefined> {
		if (this.disposed) { return Promise.resolve(undefined); }
		if (this.recording.isRecording) { this.notice('recording_active'); return Promise.resolve(undefined); }
		if (this.busy) { this.notice('maintenance_active'); return Promise.resolve(undefined); }
		// Cancel any pending consent request before taking the maintenance lease.
		this.recording.stop();
		return this.run(async () => {
			let leased = false;
			try {
				await this.options.drain(); await this.queue.acquireMaintenance(); leased = true;
				const summary = await this.queue.getLocalDataSummary();
				if (!await this.options.confirm(scope, summary)) { this.notice('cancelled'); return undefined; }
				if (this.disposed) { return undefined; }
				if (this.recording.isRecording || this.recording.isStarting) { this.notice('recording_active'); return undefined; }
				await this.options.guard?.();
				const result = await this.queue.deleteEvidence(scope);
				await this.options.cleared(); this.notice(result.filesFailed || result.storageFailed ? 'cleanup_partial' : 'cleanup_complete'); return result;
			} catch (error) {
				const code = (error as { code?: string })?.code;
				this.notice(code === 'recording_active' || code === 'maintenance_active' ? code : 'cleanup_failed'); return undefined;
			} finally { if (leased) { try { await this.queue.releaseMaintenance(); } catch { this.notice('cleanup_failed'); } } }
		});
	}
	automaticRetention(): Promise<LocalCleanupResult | undefined> {
		if (this.disposed) { return Promise.resolve(undefined); }
		let days: number;
		try { days = this.options.retentionDays(); } catch { this.notice('retention_failed'); return Promise.resolve(undefined); }
		if (this.busy || this.recording.isRecording || this.recording.isStarting || days === 0) { return Promise.resolve(undefined); }
		if (!Number.isSafeInteger(days) || days < 1 || days > 3650) { this.notice('retention_failed'); return Promise.resolve(undefined); }
		return this.run(async () => {
			let leased = false;
			try {
				await this.options.drain();
				if (this.recording.isRecording || this.recording.isStarting) { return undefined; }
				await this.options.guard?.();
				await this.queue.acquireMaintenance(); leased = true;
				if (this.recording.isRecording || this.recording.isStarting) { return undefined; }
				const cutoff = new Date((this.options.now?.() ?? new Date()).getTime() - days * 86400000).toISOString();
				const result = await this.queue.expireAcknowledged(cutoff);
				if (result.filesFailed || result.storageFailed) { this.notice('retention_failed'); }
				return result;
			} catch (error) {
				if (!['recording_active', 'maintenance_active'].includes((error as { code?: string })?.code ?? '')) { this.notice('retention_failed'); }
				return undefined;
			} finally { if (leased) { try { await this.queue.releaseMaintenance(); } catch { this.notice('retention_failed'); } } }
		});
	}
	async flush(): Promise<void> { await this.operation; }
	dispose(): void { this.disposed = true; }
	private notice(reason: LocalDataNotice): void {
		try { this.options.notice(reason); } catch { /* Never propagate diagnostic callback exceptions or content. */ }
	}
	private run<T>(operation: () => Promise<T>): Promise<T> {
		const running = Promise.resolve().then(operation); this.operation = running;
		return running.finally(() => { if (this.operation === running) { this.operation = undefined; } });
	}
}
