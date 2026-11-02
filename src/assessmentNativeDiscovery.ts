import { join } from 'node:path';
import type { RecordingController } from './recording';
import type { CodexSessionRegistration, ApprovedWorkspace } from './codexSessionDiscovery';

export interface NativeSessionPickItem {
	label: string;
	description: string;
	detail: string;
	sourceFileId: string;
	resolvedPath: string; // absolute path — used only internally for connect(), never displayed
}

export interface AssessmentNativeDiscoveryOptions {
	/** Maximum candidates to show at once in a multi-session picker */
	maxPickerItems?: number;
	/** Injected for testing */
	notification?: (message: string, ...actions: string[]) => PromiseLike<string | undefined>;
	picker?: (items: readonly NativeSessionPickItem[]) => PromiseLike<NativeSessionPickItem | undefined>;
}

export interface AssessmentNativeDiscoveryConnector {
	/** Connect to a verified session file. Returns true on success. */
	connect(filePath: string, sessionsDirectory: string, workspaces: readonly ApprovedWorkspace[], confirm: (notice: string) => Promise<boolean>): Promise<boolean>;
	/** Returns the sessions root directory string (configured from settings). */
	sessionsDirectory(): string;
	/** Returns current approved workspace folders. */
	workspaces(): readonly ApprovedWorkspace[];
	/** Resolves the exact absolute path of a discovered candidate from discovery registry. */
	resolvePath?(sourceFileId: string): string | undefined;
	/** Checks if native sessions are supported on Rails backend. */
	supportsNative?(): Promise<boolean>;
}

export const CONNECT_ACTION = 'Connect & Allow';
export const NOT_NOW_ACTION = 'Not Now';
export const QUIET_ACTION = "Don't Ask Again For This Assessment";

/** Manages automatic native Codex session discovery notifications during active assessments. */
export class AssessmentNativeDiscovery {
	private readonly declined = new Map<string, Set<string>>(); // recordingId -> Set<sourceFileId>
	private readonly quieted = new Set<string>(); // recordingId
	private connecting = false;
	private prompting = false;
	private readonly lifecycleHandle: { dispose(): void };

	constructor(
		private readonly recording: Pick<RecordingController, 'isRecording' | 'sessionId' | 'addLifecycleListener'>,
		private readonly connector: AssessmentNativeDiscoveryConnector,
		private readonly options: AssessmentNativeDiscoveryOptions = {}
	) {
		this.lifecycleHandle = recording.addLifecycleListener({
			prepare: async () => {},
			started: (sessionId: string) => { this.recordingStarted(sessionId); },
			stopped: () => {},
			cancelled: () => {}
		});
	}

	/** Called by onCandidatesChanged when an assessment IS active. */
	notify(candidates: readonly CodexSessionRegistration[]): void {
		if (!this.recording.isRecording || this.connecting || this.prompting || !candidates.length) { return; }
		const recordingId = this.recording.sessionId;
		if (!recordingId) { return; }
		if (this.isQuieted(recordingId)) { return; }

		const checkAndPrompt = async () => {
			if (this.connector.supportsNative && !await this.connector.supportsNative()) { return; }
			if (!this.recording.isRecording || this.recording.sessionId !== recordingId) { return; }

			const declined = this.declined.get(recordingId) ?? new Set<string>();
			const unvisited = candidates.filter(c => !declined.has(c.sourceFileId) && (c.status === 'eligible' || c.status === 'ambiguous'));
			if (!unvisited.length) { return; }

			const sessDir = this.connector.sessionsDirectory();
			const items = this.buildPickItems(unvisited, sessDir);
			if (!items.length) { return; }

			await this.showPrompt(recordingId, items);
		};

		void checkAndPrompt();
	}

	buildPickItems(candidates: readonly CodexSessionRegistration[], sessionsDirectory: string): NativeSessionPickItem[] {
		const maxItems = this.options.maxPickerItems ?? 10;
		const result: NativeSessionPickItem[] = [];
		for (const candidate of candidates) {
			if (result.length >= maxItems) { break; }
			const sessionSuffix = candidate.sourceSessionId ? candidate.sourceSessionId.slice(-8) : 'unknown';
			const createdDisplay = candidate.createdAt ? formatUtcTime(candidate.createdAt) : 'unknown time';
			const workspaceDisplay = candidate.workspaceRelativeCwd ? `…/${candidate.workspaceRelativeCwd}` : 'workspace root';
			const label = `Codex session …${sessionSuffix}`;
			const description = `Started ${createdDisplay}`;
			const detail = `Workspace: ${workspaceDisplay} · Captures new prompts, responses and tool activity`;
			const resolvedPath = this.connector.resolvePath?.(candidate.sourceFileId) ?? resolveSessionPath(sessionsDirectory, join, candidate);
			if (!resolvedPath) { continue; }
			result.push({ label, description, detail, sourceFileId: candidate.sourceFileId, resolvedPath });
		}
		return result;
	}

	private async showPrompt(recordingId: string, items: NativeSessionPickItem[]): Promise<void> {
		if (this.prompting || this.connecting || this.isQuieted(recordingId) || this.recording.sessionId !== recordingId || !this.recording.isRecording) {
			return;
		}

		this.prompting = true;
		try {
			let chosenItem: NativeSessionPickItem | undefined;

			if (items.length === 1) {
				const item = items[0];
				const declined = this.declined.get(recordingId);
				if (declined?.has(item.sourceFileId)) { return; }

				const notify = this.options.notification ?? defaultNotification;
				const response = await notify(
					'Codex session detected for this assessment. Allow AI Developer Tracker to capture new prompts, responses and tool activity from this verified session?',
					CONNECT_ACTION, NOT_NOW_ACTION, QUIET_ACTION
				);

				if (!this.recording.isRecording || this.recording.sessionId !== recordingId) { return; }

				if (response === QUIET_ACTION) {
					this.quieted.add(recordingId); return;
				}
				if (response === NOT_NOW_ACTION) {
					this.addDeclined(recordingId, item.sourceFileId); return;
				}
				if (response !== CONNECT_ACTION) { return; } // dismissed
				chosenItem = item;
			} else {
				const picker = this.options.picker ?? defaultPicker;
				const selected = await picker(items);
				if (!this.recording.isRecording || this.recording.sessionId !== recordingId) { return; }
				if (!selected) {
					for (const item of items) { this.addDeclined(recordingId, item.sourceFileId); }
					return;
				}
				chosenItem = selected;
			}

			if (!chosenItem || this.connecting) { return; }
			if (!this.recording.isRecording || this.recording.sessionId !== recordingId) { return; }

			this.connecting = true;
			try {
				const sessDir = this.connector.sessionsDirectory();
				const workspaces = this.connector.workspaces();
				await this.connector.connect(
					chosenItem.resolvedPath,
					sessDir,
					workspaces,
					async () => true
				);
			} finally {
				this.connecting = false;
			}
		} finally {
			this.prompting = false;
		}
	}

	private addDeclined(recordingId: string, sourceFileId: string): void {
		if (!this.declined.has(recordingId)) { this.declined.set(recordingId, new Set()); }
		this.declined.get(recordingId)!.add(sourceFileId);
	}

	/** Returns true if auto-discovery should be suppressed (quieted for this recording). */
	isQuieted(recordingId: string): boolean {
		return this.quieted.has(recordingId);
	}

	/** Clear tracking state when a new recording starts. */
	recordingStarted(recordingId: string): void {
		this.declined.delete(recordingId);
		this.quieted.delete(recordingId);
		this.connecting = false;
		this.prompting = false;
	}

	dispose(): void {
		this.lifecycleHandle.dispose();
	}
}

// --- Helpers ---

export function formatUtcTime(iso: string): string {
	try {
		const d = new Date(iso);
		if (isNaN(d.getTime())) { return iso; }
		return d.toUTCString().replace(' GMT', ' UTC');
	} catch {
		return iso;
	}
}

export function resolveSessionPath(
	sessionsDirectory: string,
	pathJoin: (...parts: string[]) => string,
	candidate: CodexSessionRegistration
): string | undefined {
	if (!candidate.sourceSessionId) { return undefined; }
	const id = candidate.sourceSessionId;
	if (!candidate.createdAt) {
		return pathJoin(sessionsDirectory, `${id}.jsonl`);
	}
	const d = new Date(candidate.createdAt);
	if (isNaN(d.getTime())) { return pathJoin(sessionsDirectory, `${id}.jsonl`); }
	const year = d.getUTCFullYear().toString();
	const month = (d.getUTCMonth() + 1).toString().padStart(2, '0');
	const day = d.getUTCDate().toString().padStart(2, '0');
	const hh = d.getUTCHours().toString().padStart(2, '0');
	const mm = d.getUTCMinutes().toString().padStart(2, '0');
	const ss = d.getUTCSeconds().toString().padStart(2, '0');
	const rolloutName = `rollout-${year}-${month}-${day}T${hh}-${mm}-${ss}-${id}.jsonl`;
	return pathJoin(sessionsDirectory, year, month, day, rolloutName);
}

async function defaultNotification(message: string, ...actions: string[]): Promise<string | undefined> {
	const { default: vscode } = await import('vscode');
	return vscode.window.showInformationMessage(message, ...actions);
}

async function defaultPicker(items: readonly NativeSessionPickItem[]): Promise<NativeSessionPickItem | undefined> {
	const { default: vscode } = await import('vscode');
	return vscode.window.showQuickPick([...items], {
		title: 'Detected Codex sessions for this assessment',
		placeHolder: 'Select a verified session to connect (prompts, responses and tool activity will be captured)'
	});
}
