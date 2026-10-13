import * as vscode from 'vscode';
import { RecordingController, START_RECORDING_COMMAND, STOP_RECORDING_COMMAND } from './recording';
import { FileTracker, isExcludedPath } from './fileTracker';
import { JsonlWriter } from './jsonlWriter';
import { EVENT_LOG_FILENAME, LEGACY_EVENT_LOG_FILENAME } from './eventSchema';
import { DiffTracker, DEFAULT_DIFF_OPTIONS } from './diffTracker';
import { CodexSessionDiscovery, type DiscoveryDiagnostic } from './codexSessionDiscovery';
import { CodexDiscoveryUi, REVIEW_CODEX_SESSIONS_COMMAND } from './codexDiscoveryUi';
import { createHash } from 'node:crypto';
import { CodexJsonlReader } from './codexJsonlReader';
import { CodexEventParser } from './codexEventParser';

let activeTracker: FileTracker | undefined;
let activeDiffTracker: DiffTracker | undefined;
let activeDiscovery: CodexSessionDiscovery | undefined;
let activeCodexReader: CodexJsonlReader | undefined;
let activeCodexParser: CodexEventParser | undefined;

export function activate(context: vscode.ExtensionContext) {
	const storageDirectory = context.storageUri?.scheme === 'file' ? context.storageUri : context.globalStorageUri;
	const logUri = vscode.Uri.joinPath(storageDirectory, EVENT_LOG_FILENAME);
	const output = vscode.window.createOutputChannel('AI Developer Tracker');
	output.appendLine(`Local activity log: ${logUri.fsPath}`);
	output.appendLine(`Unversioned ${LEGACY_EVENT_LOG_FILENAME} records are legacy schema v0 and remain unchanged. New records use schema v1 in ${EVENT_LOG_FILENAME}.`);
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	statusBar.name = 'AI Developer Tracker';
	const recording = new RecordingController(statusBar, async isCurrentRequest => {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			await vscode.window.showWarningMessage('Open a workspace folder before starting recording.');
			return false;
		}
		const consent = await vscode.window.showInformationMessage(
			'Start recording file activity in all workspace folders?',
			{ modal: true, detail: `Folders: ${folders.map(folder => folder.name).join(', ')}\n\nFile activity metadata, initial code baselines, and incremental source-code diffs are saved locally. Captured code is sensitive and may include secrets within otherwise eligible files. Sensitive/generated paths and configured size limits are excluded. Nothing is sent externally.\n\nWhen enabled, local Codex session metadata is discovered only during recording. Associations require separate confirmation. Conversation and tool content is captured only after a separate explicit consent dialog.\n\nLog: ${logUri.fsPath}` },
			'Start Recording'
		);
		if (consent !== 'Start Recording' || !isCurrentRequest()) {
			return false;
		}
		try {
			await tracker.selectWorkspaces(folders);
			const currentFolders = vscode.workspace.workspaceFolders ?? [];
			return isCurrentRequest() && currentFolders.length === folders.length
				&& folders.every(folder => currentFolders.some(current => current.uri.toString() === folder.uri.toString()));
		} catch (error) {
			reportError(error);
			return false;
		}
	});
	const reportError = (error: unknown) => {
		recording.stop();
		output.appendLine(`File activity tracking failed: ${String(error)}`);
		void vscode.window.showErrorMessage('AI Developer Tracker stopped recording because file activity tracking failed. See its Output channel for details.');
	};
	const writer = new JsonlWriter(logUri.fsPath);
	const tracker = new FileTracker(recording, writer, storageDirectory, reportError);
	const configuration = vscode.workspace.getConfiguration('ai-developer-tracker.diff');
	const options = Object.fromEntries(Object.entries(DEFAULT_DIFF_OPTIONS).map(([name, value]) => [name, configuration.get<number>(name, value)]));
	let diffs: DiffTracker;
	try {
		diffs = new DiffTracker(recording, tracker, writer, reportError, options);
	} catch {
		output.appendLine('Invalid diff-capture settings. Using the default size limits and checkpoint intervals.');
		diffs = new DiffTracker(recording, tracker, writer, reportError);
	}
	activeTracker = tracker;
	activeDiffTracker = diffs;
	const codexConfiguration = vscode.workspace.getConfiguration('ai-developer-tracker.codex');
	// Only machine/user settings may redirect discovery; ignore repository-provided paths.
	if (codexConfiguration.inspect<boolean>('enabled')?.globalValue ?? true) {
		const diagnostics: Record<DiscoveryDiagnostic, string> = {
			missing_directory: 'Codex session discovery: session directory is not available.',
			unsafe_directory: 'Codex session discovery: unsafe or unsupported directory skipped.',
			read_failed: 'Codex session discovery: an unreadable candidate was skipped.',
			scan_limit: 'Codex session discovery: scan budget reached; remaining entries will be checked later.',
			registry_limit: 'Codex session discovery: candidate limit reached.',
			watcher_unavailable: 'Codex session discovery: using bounded polling because a watcher is unavailable.'
		};
		let ui: CodexDiscoveryUi;
		const discovery = new CodexSessionDiscovery(recording, () => tracker.getApprovedFolders().map(folder => ({
			path: folder.uri.fsPath, workspaceId: createHash('sha256').update(folder.uri.toString()).digest('hex')
		})), {
			sessionsDirectory: codexConfiguration.inspect<string>('sessionsDirectory')?.globalValue,
			watch: (root, created, changed) => {
				const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/*.jsonl'), false, false, true);
				return vscode.Disposable.from(watcher, watcher.onDidCreate(uri => created(uri.fsPath)), watcher.onDidChange(uri => changed(uri.fsPath)));
			},
			onDiagnostic: diagnostic => output.appendLine(diagnostics[diagnostic]),
			onCandidatesChanged: candidates => ui?.notify(candidates)
		});
		const parser = new CodexEventParser(recording, discovery, writer, {
			isExcludedPath,
			onDiagnostic: reason => output.appendLine('Codex capture diagnostic: ' + reason)
		});
		ui = new CodexDiscoveryUi(recording, discovery, undefined, {
			hasConsent: sessionId => parser.hasContentConsent(sessionId),
			grant: sessionId => parser.grantContentConsent(sessionId),
			request: async () => (await vscode.window.showWarningMessage(
				'Allow local capture of Codex conversation content for this recording?',
				{ modal: true, detail: 'User prompts, visible assistant responses, tool inputs, and tool outputs from sessions you explicitly confirm will be saved in the local assessment log. These may include source code, credentials, or other sensitive text. System/developer instructions and private reasoning are excluded. Path exclusions do not redact every secret inside ordinary messages. Nothing is uploaded. Consent expires when recording stops.' },
				'Allow Content Capture'
			)) === 'Allow Content Capture'
		});
		activeDiscovery = discovery;
		activeCodexParser = parser;
		const reader = new CodexJsonlReader(recording, discovery, {
			onRecord: metadata => output.appendLine('Codex record metadata: ' + JSON.stringify(metadata)),
			canCaptureContent: registration => parser.canCapture(registration),
			onSourceRecord: (record, context) => parser.handle(record, context),
			onDiagnostic: diagnostic => output.appendLine('Codex reader diagnostic: ' + JSON.stringify(diagnostic))
		});
		activeCodexReader = reader;
		context.subscriptions.push(discovery, parser, reader, ui, vscode.commands.registerCommand(REVIEW_CODEX_SESSIONS_COMMAND, () => ui.review()));
	} else {
		context.subscriptions.push(vscode.commands.registerCommand(REVIEW_CODEX_SESSIONS_COMMAND, () =>
			vscode.window.showInformationMessage('Codex session discovery is disabled in AI Developer Tracker settings.')));
	}

	context.subscriptions.push(
		recording,
		diffs,
		tracker,
		output,
		vscode.workspace.onDidChangeWorkspaceFolders(async () => {
			recording.stop();
			await diffs.flush();
			tracker.clearWorkspace();
			output.appendLine('Workspace folders changed. Start recording again to include all current folders.');
		}),
		vscode.commands.registerCommand(START_RECORDING_COMMAND, async () => {
			try {
				await recording.start();
			} catch (error) {
				reportError(error);
			}
		}),
		vscode.commands.registerCommand(STOP_RECORDING_COMMAND, async () => {
			recording.stop();
			await diffs.flush();
			await tracker.flush();
			await activeCodexReader?.flush();
			await activeCodexParser?.flush();
			await activeDiscovery?.flush();
		})
	);
}

// VS Code disposes the commands and controller in context.subscriptions.
export async function deactivate(): Promise<void> {
	activeCodexReader?.dispose();
	await activeCodexReader?.flush();
	activeCodexReader = undefined;
	activeCodexParser?.dispose();
	await activeCodexParser?.flush();
	activeCodexParser = undefined;
	activeDiscovery?.dispose();
	await activeDiscovery?.flush();
	activeDiscovery = undefined;
	activeDiffTracker?.dispose();
	await activeDiffTracker?.flush();
	activeDiffTracker = undefined;
	activeTracker?.dispose();
	await activeTracker?.flush();
	activeTracker = undefined;
}
