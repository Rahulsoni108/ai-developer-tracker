import type { StatusBarItem } from 'vscode';
import { randomUUID } from 'node:crypto';

export const START_RECORDING_COMMAND = 'ai-developer-tracker.startRecording';
export const STOP_RECORDING_COMMAND = 'ai-developer-tracker.stopRecording';

type RecordingStatusBar = Pick<StatusBarItem, 'text' | 'tooltip' | 'command' | 'show' | 'dispose'>;

export type RecordingPreparation = 'local_storage' | 'diff_baseline' | 'assessment_authorization';
export interface RecordingLifecycle {
	readonly preparation?: RecordingPreparation;
	prepare(sessionId: string, isCurrentRequest: () => boolean): Promise<void>;
	started(sessionId: string): void;
	stopped(sessionId: string): void;
	cancelled(sessionId: string): void;
}

export class RecordingController {
	private recording = false;
	private recordingSessionId: string | undefined;
	private recordingStartedAt: string | undefined;
	private pendingConsent: object | undefined;
	private disposed = false;
	private readonly lifecycle = new Set<RecordingLifecycle>();

	constructor(
		private readonly statusBar: RecordingStatusBar,
		private readonly requestConsent: (isCurrentRequest: () => boolean) => PromiseLike<boolean>,
		private readonly now: () => Date = () => new Date(),
		private readonly onPrepare: (step: RecordingPreparation) => void = () => {}
	) {
		this.updateStatusBar();
		this.statusBar.show();
	}

	get isRecording(): boolean {
		return this.recording;
	}
	get isStarting(): boolean { return this.pendingConsent !== undefined; }

	get sessionId(): string | undefined {
		return this.recordingSessionId;
	}

	get startedAt(): string | undefined {
		return this.recordingStartedAt;
	}

	addLifecycleListener(listener: RecordingLifecycle): { dispose(): void } {
		this.lifecycle.add(listener);
		return { dispose: () => { this.lifecycle.delete(listener); } };
	}

	async start(): Promise<void> {
		if (this.disposed || this.recording || this.pendingConsent) {
			return;
		}

		const request = {};
		this.pendingConsent = request;
		let preparedSessionId: string | undefined;
		const isCurrentRequest = () => !this.disposed && this.pendingConsent === request;
		try {
			const consent = await this.requestConsent(isCurrentRequest);
			if (consent && isCurrentRequest()) {
				preparedSessionId = randomUUID();
				for (const listener of this.lifecycle) {
					if (listener.preparation) { try { this.onPrepare(listener.preparation); } catch { /* Diagnostics cannot authorize or interrupt recording. */ } }
					await listener.prepare(preparedSessionId, isCurrentRequest);
					if (!isCurrentRequest()) {
						return;
					}
				}
				this.recordingSessionId = preparedSessionId;
				this.recordingStartedAt = this.now().toISOString();
				this.recording = true;
				this.updateStatusBar();
				for (const listener of this.lifecycle) {
					listener.started(preparedSessionId);
				}
			}
		} finally {
			if (preparedSessionId && this.recordingSessionId !== preparedSessionId) {
				for (const listener of this.lifecycle) {
					listener.cancelled(preparedSessionId);
				}
			}
			if (this.pendingConsent === request) {
				this.pendingConsent = undefined;
			}
		}
	}

	stop(): void {
		this.pendingConsent = undefined;
		if (this.disposed || !this.recording) {
			return;
		}
		const sessionId = this.recordingSessionId!;
		this.recording = false;
		this.recordingSessionId = undefined;
		this.recordingStartedAt = undefined;
		this.updateStatusBar();
		for (const listener of this.lifecycle) {
			listener.stopped(sessionId);
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.stop();
		this.disposed = true;
		this.pendingConsent = undefined;
		this.recording = false;
		this.recordingSessionId = undefined;
		this.recordingStartedAt = undefined;
		this.statusBar.dispose();
	}

	private updateStatusBar(): void {
		this.statusBar.text = this.recording ? 'Recording' : 'Not Recording';
		this.statusBar.tooltip = this.recording
			? 'AI Developer Tracker: Click to stop recording'
			: 'AI Developer Tracker: Click to start recording';
		this.statusBar.command = this.recording ? STOP_RECORDING_COMMAND : START_RECORDING_COMMAND;
	}
}
