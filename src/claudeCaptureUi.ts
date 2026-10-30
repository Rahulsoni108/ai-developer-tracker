import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { RecordingController } from './recording';
import type { FileTracker } from './fileTracker';
import { ClaudeCapture, type ClaudeLaunch } from './claudeCapture';

export const START_CLAUDE_CAPTURE_COMMAND = 'ai-developer-tracker.startClaudeCapture';
export const REVOKE_CLAUDE_CAPTURE_COMMAND = 'ai-developer-tracker.revokeClaudeCapture';

export interface ClaudeCapturePrompts {
	pick(folders: readonly vscode.WorkspaceFolder[]): Promise<vscode.WorkspaceFolder | undefined>;
	available(): Promise<string | undefined>;
	consent(): Promise<boolean>;
	launch(launch: ClaudeLaunch): void;
}
const defaultPrompts: ClaudeCapturePrompts = {
	pick: async folders => folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map((folder, index) => ({ label: `Approved workspace ${index + 1}`, folder })),
		{ title: 'Choose the assessment workspace for Claude Code' }))?.folder,
	available: async () => {
		try {
			await promisify(execFile)('claude', ['--version'], { timeout: 5000, maxBuffer: 16384 });
			const nodeExecutable = (await promisify(execFile)('node', ['-p', 'process.execPath'], { timeout: 5000, maxBuffer: 16384 })).stdout.trim();
			return isAbsolute(nodeExecutable) ? nodeExecutable : undefined;
		} catch { return undefined; }
	},
	consent: async () => (await vscode.window.showWarningMessage('Allow local Claude Code activity capture for a new assessment session?', { modal: true,
		detail: 'This launches Claude Code in the selected approved workspace with a temporary additive hook plugin. User prompts, visible AI responses, tool inputs/outputs and session lifecycle will be privacy-filtered and saved in encrypted SQLite. These can contain sensitive code or credentials. No unrelated or historical conversations are imported. A bounded, session-specific transcript fallback may read only new assistant text when the response hook lacks it. System instructions, subagents and private reasoning are excluded. Existing Claude hooks/settings are not modified. Upload consent remains separate. Stop Recording or Revoke Claude Capture stops capture. Requires Claude Code supporting command-hook args and --plugin-dir, plus Node.js on PATH.' }, 'Allow Claude Capture')) === 'Allow Claude Capture',
	launch: launch => {
		const terminal = vscode.window.createTerminal({ name: 'Claude Code assessment session', cwd: vscode.Uri.file(launch.root),
			shellPath: 'claude', shellArgs: ['--plugin-dir', launch.pluginDirectory, '--session-id', launch.sourceSessionId] });
		terminal.show();
	}
};

/** Launch-scoped plugin is additive; no shell interpolation and no persistent user-hook edits. */
export class ClaudeCaptureUi {
	private starting = false;
	private generation = 0;
	private disposed = false;
	constructor(private readonly recording: RecordingController, private readonly files: FileTracker,
		private readonly createCapture: (nodeExecutable: string) => ClaudeCapture,
		private readonly notice: (reason: 'unavailable' | 'revoked' | 'failed') => void,
		private readonly prompts: ClaudeCapturePrompts = defaultPrompts,
		private readonly assessmentConsent?: (recordingId: string) => boolean | undefined) {}
	private capture?: ClaudeCapture;
	async start(): Promise<void> {
		if (this.disposed || this.starting || !this.recording.isRecording) { return; }
		this.starting = true; const generation = this.generation; const session = this.recording.sessionId;
		try {
			const folder = await this.prompts.pick(this.files.getApprovedFolders()); if (!folder) { return; }
			const nodeExecutable = await this.prompts.available(); if (!nodeExecutable) { this.notice('unavailable'); return; }
			const scoped = this.assessmentConsent?.(session!);
			const accepted = scoped === undefined ? await this.prompts.consent() : scoped;
			if (!accepted || this.disposed || generation !== this.generation || this.recording.sessionId !== session || !this.recording.isRecording) { return; }

			if (!this.capture) { this.capture = this.createCapture(nodeExecutable); }
			const launch = await this.capture.create(folder.uri.fsPath, createHash('sha256').update(folder.uri.toString()).digest('hex'));
			if (this.disposed || generation !== this.generation || this.recording.sessionId !== session) { await this.capture.revoke(); return; }
			this.prompts.launch(launch);
		} catch { this.notice('failed'); } finally { this.starting = false; }
	}
	async revoke(): Promise<void> { ++this.generation; await this.capture?.revoke(); this.notice('revoked'); }
	async dispose(): Promise<void> { this.disposed = true; ++this.generation; await this.capture?.dispose(); }
}
