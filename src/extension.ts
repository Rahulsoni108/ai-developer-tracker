import * as vscode from 'vscode';
import { RecordingController, START_RECORDING_COMMAND, STOP_RECORDING_COMMAND } from './recording';
import { FileTracker } from './fileTracker';
import { JsonlWriter } from './jsonlWriter';
import { EVENT_LOG_FILENAME, LEGACY_EVENT_LOG_FILENAME } from './eventSchema';
import { DiffTracker, DEFAULT_DIFF_OPTIONS } from './diffTracker';

let activeTracker: FileTracker | undefined;
let activeDiffTracker: DiffTracker | undefined;

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
			{ modal: true, detail: `Folders: ${folders.map(folder => folder.name).join(', ')}\n\nFile activity metadata, initial code baselines, and incremental source-code diffs are saved locally. Captured code is sensitive and may include secrets within otherwise eligible files. Sensitive/generated paths and configured size limits are excluded. Nothing is sent externally.\n\nLog: ${logUri.fsPath}` },
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
	const diffs = new DiffTracker(recording, tracker, writer, reportError, options);
	activeTracker = tracker;
	activeDiffTracker = diffs;

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
		})
	);
}

// VS Code disposes the commands and controller in context.subscriptions.
export async function deactivate(): Promise<void> {
	activeDiffTracker?.dispose();
	await activeDiffTracker?.flush();
	activeDiffTracker = undefined;
	activeTracker?.dispose();
	await activeTracker?.flush();
	activeTracker = undefined;
}
