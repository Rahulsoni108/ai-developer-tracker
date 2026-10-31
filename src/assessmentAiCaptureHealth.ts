import type { RecordingController } from './recording';
import type { TrackerEvent } from './eventSchema';

export const AI_CAPTURE_STATUS_COMMAND = 'ai-developer-tracker.showAssessmentAiCaptureStatus';
export const CONNECT_AI_CHAT_COMMAND = 'ai-developer-tracker.connectCurrentAiChat';
export const NATIVE_CHAT_CONTRACT_BLOCKER = 'Native AI chat connection is unavailable under the current Rails assessment-workflow.v1 policy (extension_launched_only). Recording consent and a workspace match cannot authorize a native conversation. Rails must explicitly support verified native-session enrollment before it can be connected. The optional Launch Assessment AI Session command remains available; it does not connect your existing native chat.';
export function stopAssessmentCaptureForWorkspaceChange(recording: RecordingController, isAssessment: (id: string) => boolean): boolean {
	if (!recording.isRecording || !recording.sessionId || !isAssessment(recording.sessionId)) { return false; }
	recording.stop(); return true;
}
type Provider = 'codex' | 'claude';
type ReaderState = 'initializing' | 'ready' | 'interrupted';
export interface AiCaptureHealthView {
	state: 'not_connected' | 'initializing' | 'ready' | 'interrupted' | 'stopped';
	connectedSessions: number; prompts: number; responses: number; countsLimited: boolean;
	readers: { provider: Provider; state: ReaderState }[];
}
/** Observations only, never an approval/capture authority. Feed sanitized successful SQLite writes. */
export class AssessmentAiCaptureHealth {
	private recordingId?: string;
	private readonly sessions = new Map<string, Provider>();
	private readonly readers = new Map<Provider, ReaderState>();
	private readonly seen = new Set<string>();
	private prompts = 0;
	private responses = 0;
	private countsLimited = false;
	private warned = false;
	private lastPublished = '';
	private timer?: ReturnType<typeof setTimeout>;
	private readonly listener: { dispose(): void };
	constructor(private readonly recording: RecordingController, private readonly isAssessment: (id: string) => boolean,
		private readonly onChange: (view: AiCaptureHealthView) => void = () => {}, private readonly warn: () => void = () => {}, private readonly maxEvents = 32768) {
		if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 32768) { throw new Error('Invalid health observation limit'); }
		this.listener = recording.addLifecycleListener({ prepare: async () => {}, started: id => this.started(id),
			stopped: id => { if (id === this.recordingId) { clearTimeout(this.timer); this.changed(); } }, cancelled: () => {} });
	}
	private started(id: string): void {
		clearTimeout(this.timer); this.recordingId = this.isAssessment(id) ? id : undefined;
		this.sessions.clear(); this.readers.clear(); this.seen.clear(); this.prompts = 0; this.responses = 0; this.countsLimited = false; this.warned = false;
		if (this.recordingId) { this.timer = setTimeout(() => this.checkMissingMessages(), 30000); this.timer.unref?.(); }
		this.changed();
	}
	private get active(): boolean { return !!this.recordingId && this.recording.isRecording && this.recording.sessionId === this.recordingId && this.isAssessment(this.recordingId); }
	initializing(provider: Provider): void { if (this.active && !this.readers.has(provider)) { this.readers.set(provider, 'initializing'); this.changed(); } }
	/** Called only after the adapter has verified its source, authorization and actual reader initialization. */
	readerReady(provider: Provider, sourceIds: readonly string[]): void {
		if (!this.active || !sourceIds.length) { return; }
		for (const id of sourceIds) { const key = `${provider}:${id}`; if (this.sessions.size < 32 || this.sessions.has(key)) { this.sessions.set(key, provider); } }
		this.readers.set(provider, 'ready'); this.changed();
	}
	interrupted(provider: Provider): void {
		if (!this.active || this.readers.get(provider) === 'interrupted') { return; }
		for (const [key, source] of this.sessions) { if (source === provider) { this.sessions.delete(key); } }
		this.readers.set(provider, 'interrupted'); this.changed();
	}
	/** In-memory adapter status only. This never scans files or creates source permissions. */
	reconcile(provider: Provider, initializedSourceIds: readonly string[]): void {
		if (!this.active || !this.readers.has(provider)) { return; }
		const live = new Set(initializedSourceIds.map(id => `${provider}:${id}`));
		let removed = false;
		for (const [key, source] of this.sessions) { if (source === provider && !live.has(key)) { this.sessions.delete(key); removed = true; } }
		if (initializedSourceIds.length) { this.readerReady(provider, initializedSourceIds); }
		else if (removed) { this.interrupted(provider); }
	}
	observe(event: Readonly<TrackerEvent>): void {
		if (!this.recordingId || event.sessionId !== this.recordingId || !this.isAssessment(event.sessionId)
			|| !['codex', 'claude'].includes(event.source) || !event.sourceSessionId || !event.eventType.startsWith('ai.')) { return; }
		const provider = event.source as Provider;
		// A successful, filtered, scoped write proves activity reached SQLite, not just that a terminal opened.
		if (event.eventType !== 'ai.session.ended' && this.active && (this.readers.get(provider) !== 'interrupted' || event.eventType === 'ai.session.started')) { this.readerReady(provider, [event.sourceSessionId]); }
		if (event.eventType === 'ai.session.ended') {
			this.sessions.delete(`${provider}:${event.sourceSessionId}`);
			if (![...this.sessions.values()].includes(provider)) { this.readers.delete(provider); }
			this.changed(); return;
		}
		if (event.eventType !== 'ai.prompt.submitted' && event.eventType !== 'ai.response.completed' || this.seen.has(event.eventId)) { return; }
		if (this.seen.size >= this.maxEvents) { this.countsLimited = true; this.changed(); return; }
		this.seen.add(event.eventId);
		if (event.eventType === 'ai.prompt.submitted') { this.prompts++; } else { this.responses++; }
		this.changed();
	}
	checkMissingMessages(): void {
		if (this.active && !this.warned && !this.prompts && !this.responses) { this.warned = true; this.warn(); }
	}
	get view(): AiCaptureHealthView {
		const readers = [...this.readers].map(([provider, state]) => ({ provider, state }));
		const state = !this.recordingId ? 'not_connected' : !this.active ? 'stopped' : readers.some(r => r.state === 'interrupted') ? 'interrupted'
			: readers.some(r => r.state === 'ready') ? 'ready' : readers.length ? 'initializing' : 'not_connected';
		return { state, connectedSessions: this.active ? [...this.sessions.values()].filter(provider => this.readers.get(provider) === 'ready').length : 0,
			prompts: this.prompts, responses: this.responses, countsLimited: this.countsLimited, readers };
	}
	private changed(): void {
		const view = this.view; const fingerprint = JSON.stringify(view); if (fingerprint === this.lastPublished) { return; } this.lastPublished = fingerprint;
		try { this.onChange(view); } catch { /* Observations never control recording. */ }
	}
	clearStopped(): void { if (!this.recording.isRecording) { clearTimeout(this.timer); this.recordingId = undefined; this.sessions.clear(); this.readers.clear(); this.seen.clear(); this.prompts = 0; this.responses = 0; this.countsLimited = false; this.changed(); } }
	dispose(): void { clearTimeout(this.timer); this.listener.dispose(); this.sessions.clear(); this.readers.clear(); this.seen.clear(); }
}
export function describeAiCaptureHealth(view: AiCaptureHealthView): string {
	const labels = { not_connected: 'AI session not connected', initializing: 'AI capture initializing', ready: 'AI capture ready', interrupted: 'AI capture interrupted', stopped: 'AI capture stopped' };
	return `${labels[view.state]}. Connected readable sessions: ${view.connectedSessions}. Observed prompts: ${view.prompts}; observed responses: ${view.responses}.`
		+ ` Readers: ${view.readers.map(r => `${r.provider}: ${r.state}`).join(', ') || 'none'}.`
		+ ' Counts are successful sanitized SQLite captures observed in this recording/process, not proof of complete conversation coverage or server upload.'
		+ (view.countsLimited ? ' Observation limit reached; counts are lower bounds. Use Show Recorded Event Summary for retained pending totals.' : '')
		+ (view.state === 'ready' && !view.prompts && !view.responses ? ' Reader initialized; no prompt or response capture has been observed yet.' : '')
		+ (view.state === 'not_connected' ? ' No AI conversation capture is ready. Use Connect Current AI Chat to inspect native connection availability.' : '');
}
