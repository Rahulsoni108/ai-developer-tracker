import type { RecordingController } from './recording';
import type { ActivityWriter } from './jsonlWriter';
import { discoverCursorWorkspace, isCursorEnvironment, type CursorDiscoveryResult } from './cursorDiscovery';
import { CursorSqliteReader, type CursorReadBatch } from './cursorSqliteReader';
import { CursorEventParser } from './cursorEventParser';
import { PrivacyFilter } from './privacyFilter';

export type CursorCaptureState =
	| 'not_started'
	| 'initializing'
	| 'ready'
	| 'interrupted'
	| 'unavailable'
	| 'stopped';

export interface CursorCaptureOptions {
	workspacePath: string;
	appName?: string;
	pollIntervalMs?: number;
	cursorUserDir?: string;
	privacyFilter?: PrivacyFilter;
	onDiagnostic?: (diagnostic: string, details?: unknown) => void;
	onStateChange?: (state: CursorCaptureState) => void;
}

/**
 * Coordinates Cursor IDE discovery, SQLite reader polling, and event parser
 * during active assessment recordings.
 */
export class CursorCapture {
	private reader?: CursorSqliteReader;
	private parser?: CursorEventParser;
	private readonly lifecycle: { dispose(): void };
	private disposed = false;
	private state: CursorCaptureState = 'not_started';
	private discovery?: CursorDiscoveryResult;
	private startPromise?: Promise<boolean>;

	constructor(
		private readonly recording: RecordingController,
		private readonly writer: ActivityWriter,
		private readonly options: CursorCaptureOptions
	) {
		this.lifecycle = recording.addLifecycleListener({
			prepare: async () => {},
			started: (id) => { this.startPromise = this.onStarted(id); },
			stopped: () => { void this.onStopped(); },
			cancelled: () => { void this.onStopped(); }
		});
	}

	getState(): CursorCaptureState {
		return this.state;
	}

	async waitForReady(): Promise<boolean> {
		if (this.startPromise) {
			return this.startPromise;
		}
		return this.state === 'ready';
	}

	getDiscovery(): CursorDiscoveryResult | undefined {
		return this.discovery;
	}

	getReader(): CursorSqliteReader | undefined {
		return this.reader;
	}

	getParser(): CursorEventParser | undefined {
		return this.parser;
	}

	async onStarted(recordingId: string): Promise<boolean> {
		if (this.disposed || !this.recording.isRecording || this.recording.sessionId !== recordingId) {
			return false;
		}

		// Check if environment is Cursor
		const appName = this.options.appName ?? (typeof process !== 'undefined' ? process.env.CURSOR_APP_NAME : undefined);
		if (this.options.appName !== undefined && !isCursorEnvironment(appName)) {
			this.setState('unavailable');
			return false;
		}

		this.setState('initializing');

		const discovery = await discoverCursorWorkspace(this.options.workspacePath, {
			appName: this.options.appName,
			cursorUserDir: this.options.cursorUserDir,
			requireCursorApp: this.options.appName !== undefined
		});
		this.discovery = discovery;

		if (discovery.status !== 'ready' || !discovery.stateDbPath) {
			this.setState(discovery.status === 'not_cursor' ? 'unavailable' : 'interrupted');
			this.options.onDiagnostic?.('discovery_failed', discovery);
			return false;
		}

		// Create Parser
		this.parser = new CursorEventParser(this.writer, {
			recordingSessionId: recordingId,
			workspaceId: discovery.workspaceId ?? 'cursor-workspace',
			sourceSessionId: discovery.workspaceId,
			privacyFilter: this.options.privacyFilter,
			onDiagnostic: (diag, details) => this.options.onDiagnostic?.(diag, details)
		});

		// Create Reader
		this.reader = new CursorSqliteReader({
			stateDbPath: discovery.stateDbPath,
			startTimestampMs: Date.now(),
			pollIntervalMs: this.options.pollIntervalMs ?? 1000,
			onDiagnostic: (diag, details) => {
				if (diag === 'db_not_found' || diag === 'db_error') {
					this.setState('interrupted');
				}
				this.options.onDiagnostic?.(diag, details);
			}
		});

		// Start polling
		this.reader.startPolling(async (batch: CursorReadBatch) => {
			if (!this.parser || this.state !== 'ready') {
				return;
			}
			for (const p of batch.prompts) {
				await this.parser.handlePrompt(p);
			}
			for (const g of batch.generations) {
				await this.parser.handleGeneration(g);
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

	private setState(newState: CursorCaptureState): void {
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
