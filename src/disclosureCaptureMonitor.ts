import type { AssessmentController } from './assessmentController';
import type { AssessmentDisclosureConsent } from './assessmentDisclosureConsent';
import type { AsyncLocalEventQueue } from './asyncLocalEventQueue';
import type { RecordingController } from './recording';

/** One bounded status poller. Never blocks event collection or restores capture from disk. */
export class DisclosureCaptureMonitor {
	private timer?: ReturnType<typeof setTimeout>;
	private request?: AbortController;
	private disposed = false;
	private readonly listener: { dispose(): void };
	constructor(private readonly recording: RecordingController, private readonly assessment: Pick<AssessmentController, 'withDisclosureContext'>,
		private readonly consent: Pick<AssessmentDisclosureConsent, 'list' | 'inspect'>, private readonly queue: Pick<AsyncLocalEventQueue, 'suspendDisclosureCapture'>,
		private readonly onStatus: (status: 'confirmed' | 'upload_only') => void = () => {}, private readonly intervalMs = 5000,
		private readonly drainBeforeSeal: (recordingId: string) => boolean = () => false) {
		this.listener = recording.addLifecycleListener({ prepare: async () => {}, started: () => this.schedule(),
			stopped: id => { this.request?.abort(); clearTimeout(this.timer); if (!this.drainBeforeSeal(id)) { void this.queue.suspendDisclosureCapture(id, undefined, true).catch(() => {}); } },
			cancelled: id => { void this.queue.suspendDisclosureCapture(id, undefined, true).catch(() => {}); } });
		if (recording.isRecording) { this.schedule(); }
	}
	private schedule(): void {
		clearTimeout(this.timer);
		if (!this.disposed && this.recording.isRecording) { this.timer = setTimeout(() => { void this.refresh(); }, this.intervalMs); this.timer.unref?.(); }
	}
	async refresh(): Promise<void> {
		if (this.disposed || this.request || !this.recording.isRecording) { return; }
		const request = new AbortController(); this.request = request;
		try {
			await this.assessment.withDisclosureContext(true, async context => {
				const current = () => !this.disposed && !request.signal.aborted && context.current();
				const scoped = { ...context, current };
				const latest = (await this.consent.list(scoped)).filter(s => s.request.local_recording_session_id === context.currentRecording).at(-1);
				if (!latest?.receipt || latest.workflowConsentId || latest.locallyRevoked || latest.pendingAction || latest.receipt.state !== 'active') { return; }
				const state = await this.consent.inspect(scoped, latest, AbortSignal.any([request.signal, AbortSignal.timeout(2500)]));
				this.onStatus(state.receipt?.state === 'active' && state.receipt.upload_scope_state === 'active' ? 'confirmed' : 'upload_only');
			});
		} catch {
			await this.queue.suspendDisclosureCapture().catch(() => {});
			this.onStatus('upload_only'); // Fixed category only; never response bodies/source IDs.
		} finally { if (this.request === request) { this.request = undefined; } this.schedule(); }
	}
	dispose(): void { this.disposed = true; clearTimeout(this.timer); this.request?.abort(); this.listener.dispose(); void this.queue.suspendDisclosureCapture().catch(() => {}); }
}
