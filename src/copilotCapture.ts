import type { RecordingController } from './recording';
import type { ActivityWriter } from './jsonlWriter';
import { discoverCopilotWorkspace, type CopilotDiscoveryResult } from './copilotDiscovery';
import { CopilotChatReader, type CopilotReadBatch } from './copilotChatReader';
import { CopilotEventParser } from './copilotEventParser';
import { PrivacyFilter } from './privacyFilter';

export type CopilotCaptureState =
	| 'not_started'
	| 'initializing'
	| 'ready'
	| 'interrupted'
	| 'unavailable'
	| 'stopped';

export interface CopilotCaptureOptions {
	workspacePath: string;
	codeUserDir?: string;
	codeUserDirs?: string[];
	pollIntervalMs?: number;
	privacyFilter?: PrivacyFilter;
	onDiagnostic?: (diagnostic: string, details?: unknown) => void;
	onStateChange?: (state: CopilotCaptureState) => void;
}

/**
 * Coordinates GitHub Copilot Chat workspace discovery, JSONL polling, and event parsing
 * during active assessment recordings.
 */
export class CopilotCapture {
	private reader?: CopilotChatReader;
	private parser?: CopilotEventParser;
	private readonly lifecycle: { dispose(): void };
	private disposed = false;
	private state: CopilotCaptureState = 'not_started';
	private discovery?: CopilotDiscoveryResult;
	private startPromise?: Promise<boolean>;

	constructor(
		private readonly recording: RecordingController,
		private readonly writer: ActivityWriter,
		private readonly options: CopilotCaptureOptions
	) {
		this.lifecycle = recording.addLifecycleListener({
			prepare: async () => {},
			started: (id) => { this.startPromise = this.onStarted(id); },
			stopped: () => { void this.onStopped(); },
			cancelled: () => { void this.onStopped(); }
		});
	}

	getState(): CopilotCaptureState {
		return this.state;
	}

	async waitForReady(): Promise<boolean> {
		if (this.startPromise) {
			return this.startPromise;
		}
		return this.state === 'ready';
	}

	getDiscovery(): CopilotDiscoveryResult | undefined {
		return this.discovery;
	}

	getReader(): CopilotChatReader | undefined {
		return this.reader;
	}

	getParser(): CopilotEventParser | undefined {
		return this.parser;
	}

	async onStarted(recordingId: string): Promise<boolean> {
		if (this.disposed || !this.recording.isRecording || this.recording.sessionId !== recordingId) {
			return false;
		}

		this.setState('initializing');

		const discovery = await discoverCopilotWorkspace(this.options.workspacePath, {
			codeUserDir: this.options.codeUserDir,
			codeUserDirs: this.options.codeUserDirs
		});
		this.discovery = discovery;

		if (discovery.status !== 'ready' || !discovery.chatSessionsDir) {
			this.setState(discovery.status === 'storage_dir_missing' ? 'unavailable' : 'interrupted');
			this.options.onDiagnostic?.('discovery_failed', discovery);
			return false;
		}

		// Create Parser
		this.parser = new CopilotEventParser(this.writer, {
			recordingSessionId: recordingId,
			workspaceId: discovery.workspaceId ?? 'copilot-workspace',
			sourceSessionId: discovery.workspaceId,
			privacyFilter: this.options.privacyFilter,
			onDiagnostic: (diag, details) => this.options.onDiagnostic?.(diag, details)
		});

		// Create Reader
		this.reader = new CopilotChatReader({
			chatSessionsDir: discovery.chatSessionsDir,
			startTimestampMs: Date.now(),
			pollIntervalMs: this.options.pollIntervalMs ?? 1000,
			onDiagnostic: (diag, details) => {
				if (diag === 'directory_not_found') {
					this.setState('interrupted');
				}
				this.options.onDiagnostic?.(diag, details);
			}
		});

		// Start polling
		this.reader.start(async (batch: CopilotReadBatch) => {
			if (!this.parser || this.state !== 'ready') {
				return;
			}
			for (const p of batch.prompts) {
				await this.parser.handlePrompt(p);
			}
			for (const r of batch.responses) {
				await this.parser.handleResponse(r);
			}
		});

		this.setState('ready');
		return true;
	}

	async onStopped(): Promise<void> {
		this.reader?.dispose();
		this.reader = undefined;
		this.parser?.dispose();
		this.parser = undefined;
		this.setState('stopped');
	}

	private setState(newState: CopilotCaptureState): void {
		if (this.state !== newState) {
			this.state = newState;
			this.options.onStateChange?.(newState);
		}
	}

	dispose(): void {
		this.disposed = true;
		this.lifecycle.dispose();
		void this.onStopped();
	}
}
