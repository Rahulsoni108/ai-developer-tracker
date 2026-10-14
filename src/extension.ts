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
import { ActivityCorrelator } from './activityCorrelator';
import { isAbsolute } from 'node:path';
import { DEFAULT_QUEUE_STORAGE_BYTES, LocalEventQueue, safeQueueError, type QueueFailureCode, type QueueHealth } from './localEventQueue';
import { AsyncLocalEventQueue } from './asyncLocalEventQueue';
import { EventPersistence, EventPersistenceError, type PersistenceDiagnostic } from './eventPersistence';

let activeTracker: FileTracker | undefined;
let activeDiffTracker: DiffTracker | undefined;
let activeDiscovery: CodexSessionDiscovery | undefined;
let activeCodexReader: CodexJsonlReader | undefined;
let activeCodexParser: CodexEventParser | undefined;
let activeCorrelator: ActivityCorrelator | undefined;
let activePersistence: EventPersistence | undefined;
let activeRecording: RecordingController | undefined;
export const QUEUE_HEALTH_COMMAND = 'ai-developer-tracker.showQueueHealth';

export async function activate(context: vscode.ExtensionContext) {
	// Local desktop profiles expose this disk-backed directory through a userdata URI.
	// Normalize only the trusted context URI; do not accept arbitrary virtual/remote paths.
	const queueStorageUri = context.globalStorageUri.scheme === 'vscode-userdata'
		&& !context.globalStorageUri.authority && vscode.env.uiKind === vscode.UIKind.Desktop && !vscode.env.remoteName
		? vscode.Uri.file(context.globalStorageUri.fsPath) : context.globalStorageUri;
	const storageDirectory = context.storageUri?.scheme === 'file' ? context.storageUri : context.globalStorageUri;
	const logUri = vscode.Uri.joinPath(storageDirectory, EVENT_LOG_FILENAME);
	const output = vscode.window.createOutputChannel('AI Developer Tracker');
	const queueConfiguration = vscode.workspace.getConfiguration('ai-developer-tracker.queue');
	const configuredMiB = queueConfiguration.inspect<number>('maxSizeMB')?.globalValue ?? 100;
	const validLimit = Number.isSafeInteger(configuredMiB) && configuredMiB >= 1 && configuredMiB <= 10240;
	if (!validLimit) { output.appendLine('Invalid queue storage limit. Using the default 100 MB limit.'); }
	let queue: AsyncLocalEventQueue | undefined;
	let startupFailure: QueueFailureCode | undefined;
	try { queue = await AsyncLocalEventQueue.open(queueStorageUri, vscode.workspace.workspaceFolders ?? [], {
		maxStorageBytes: validLimit ? configuredMiB * 1024 * 1024 : DEFAULT_QUEUE_STORAGE_BYTES
	}); }
	catch (error) { startupFailure = safeQueueError(error).code; }
	const queueStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	queueStatus.name = 'AI Developer Tracker queue health';
	queueStatus.command = QUEUE_HEALTH_COMMAND;
	const degradation = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	degradation.name = 'AI Developer Tracker persistence';
	let queueDegraded = !queue;
	const warnings = new Set<PersistenceDiagnostic>();
	output.appendLine(`Local activity log: ${logUri.fsPath}`);
	output.appendLine(`Unversioned ${LEGACY_EVENT_LOG_FILENAME} records are legacy schema v0 and remain unchanged. New records use schema v1 in ${EVENT_LOG_FILENAME}.`);
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	statusBar.name = 'AI Developer Tracker';
	const recording = new RecordingController(statusBar, async isCurrentRequest => {
		if (queueDegraded) {
			void vscode.window.showErrorMessage('AI Developer Tracker cannot record because its local event queue is unavailable. Resolve the storage problem and reload the extension.');
			return false;
		}
		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			await vscode.window.showWarningMessage('Open a workspace folder before starting recording.');
			return false;
		}
		try { await LocalEventQueue.assertStorageOutsideWorkspaces(queueStorageUri, folders); }
		catch {
			void vscode.window.showErrorMessage('AI Developer Tracker cannot record a workspace containing its local event queue. Open another workspace.');
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
	activeRecording = recording;
	const reportPersistence = (reason: PersistenceDiagnostic, code?: QueueFailureCode) => {
		if (reason === 'queue_failed') { queueDegraded = true; recording.stop(); }
		degradation.text = queueDegraded ? '$(warning) Recording degraded' : '$(warning) JSONL degraded';
		degradation.tooltip = queueDegraded ? 'Local event queue failed. Recording stopped; resolve storage and reload.'
			: 'Events are safely queued in SQLite, but the JSONL debug mirror is unavailable.';
		degradation.show();
		if (warnings.has(reason)) { return; }
		warnings.add(reason);
		const failures: Record<QueueFailureCode, string> = {
			corrupt: 'the local event queue failed its integrity check',
			disk_full: 'the storage device is full',
			permission_denied: 'local event storage permission was denied',
			locked: 'the local event queue is locked',
			storage_limit: 'the local queue storage limit cannot safely accommodate more events',
			unavailable: 'the storage worker is unavailable',
			operation_failed: 'durable local event storage failed'
		};
		const message = reason === 'queue_failed'
			? `AI Developer Tracker stopped recording because ${failures[code ?? 'operation_failed']}. Existing events are preserved. Resolve the storage problem or increase the queue limit, then reload the extension.`
			: 'AI Developer Tracker JSONL output failed. Recording continues safely in the local SQLite queue.';
		output.appendLine(message);
		void vscode.window.showWarningMessage(message);
	};
	const reportError = (error: unknown) => {
		if (error instanceof EventPersistenceError) { return; }
		recording.stop();
		output.appendLine('File activity tracking failed. Recording stopped.');
		void vscode.window.showErrorMessage('AI Developer Tracker stopped recording because file activity tracking failed. See its Output channel for details.');
	};
	const writer = new EventPersistence(queue ?? {
		enqueue: async () => { throw new EventPersistenceError(); }, close: async () => {}
	}, new JsonlWriter(logUri.fsPath), reportPersistence);
	activePersistence = writer;
	context.subscriptions.push(writer.attachRecording(recording));
	if (!queue) { reportPersistence('queue_failed', startupFailure); }
	let warnedStorage = false;
	const renderHealth = (health: QueueHealth) => {
		queueStatus.text = `Queue: ${health.pendingCount} pending (${(health.storageBytes / 1048576).toFixed(1)} MB)`;
		queueStatus.tooltip = `Local storage: ${(health.storageBytes / 1048576).toFixed(1)} / ${(health.maxStorageBytes / 1048576).toFixed(0)} MB. ${health.interruptedSessionCount} interrupted/incomplete sessions. Click for queue health.`;
		queueStatus.show();
		if (health.status === 'full') { reportPersistence('queue_failed', 'storage_limit'); }
		else if (health.status === 'warning' && !warnedStorage) {
			warnedStorage = true;
			const message = 'AI Developer Tracker local queue has reached 80% of its storage limit. Existing events will not be deleted or automatically acknowledged. Increase the queue limit if needed; reload to apply changes.';
			output.appendLine(message); void vscode.window.showWarningMessage(message);
		}
	};
	if (queue) {
		context.subscriptions.push(queue.onDidChangeHealth(renderHealth));
		if (queue.latestHealth) {
			renderHealth(queue.latestHealth);
			if (queue.latestHealth.recoveredSessionCount > 0) {
				output.appendLine(`Recovered ${queue.latestHealth.recoveredSessionCount} interrupted recording sessions. Committed pending events are preserved; recording remains stopped until fresh consent.`);
			}
		}
	} else { queueStatus.text = 'Queue unavailable'; queueStatus.show(); }
	const tracker = new FileTracker(recording, writer, storageDirectory, reportError);
	const correlator = new ActivityCorrelator(recording, writer, {
		approvedWorkspaces: () => tracker.getApprovedFolders().map(folder => createHash('sha256').update(folder.uri.toString()).digest('hex')),
		isExcludedPath,
		onDiagnostic: reason => output.appendLine('Activity correlation diagnostic: ' + reason)
	});
	activeCorrelator = correlator;
	const correlationSubscription = writer.onDidWrite(event => correlator.observe(event));
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
			resolveToolPath: (path, source) => {
				if (!path || /[\u0000-\u001f\u007f]/.test(path) || path.replace(/\\/g, '/').split('/').includes('..')) { return undefined; }
				const folder = tracker.getApprovedFolders().find(folder =>
					createHash('sha256').update(folder.uri.toString()).digest('hex') === source.workspaceId);
				const registration = discovery.getRegistry().find(entry => entry.sourceFileId === source.sourceFileId);
				if (!folder || !registration || /^[a-z][a-z0-9+.-]*:/i.test(path) && !isAbsolute(path)) { return undefined; }
				const uri = isAbsolute(path) ? vscode.Uri.file(path)
					: vscode.Uri.joinPath(folder.uri, registration.workspaceRelativeCwd ?? '.', path);
				const file = tracker.getFileContext(uri);
				return file?.workspaceId === source.workspaceId ? file.relativePath : undefined;
			},
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
		queueStatus,
		degradation,
		recording,
		diffs,
		tracker,
		correlator,
		correlationSubscription,
		output,
		vscode.commands.registerCommand(QUEUE_HEALTH_COMMAND, async () => {
			if (!queue) { reportPersistence('queue_failed', startupFailure); return { status: 'unavailable', code: startupFailure }; }
			try {
				const health = await queue.getHealth(); renderHealth(health);
				void vscode.window.showInformationMessage(`AI Developer Tracker queue: ${health.pendingCount} pending events; ${(health.storageBytes / 1048576).toFixed(1)} / ${(health.maxStorageBytes / 1048576).toFixed(0)} MB used; ${health.interruptedSessionCount} interrupted/incomplete sessions.`);
				return health;
			} catch (error) {
				const code = safeQueueError(error).code;
				reportPersistence('queue_failed', code); return { status: 'unavailable', code };
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(async () => {
			const stoppedSession = recording.sessionId;
			recording.stop();
			await diffs.flush();
			await tracker.flush();
			await activeCodexReader?.flush();
			await activeCodexParser?.flush();
			await correlator.finishSession(stoppedSession);
			await writer.flush();
			await writer.completeSession(stoppedSession);
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
			const stoppedSession = recording.sessionId;
			recording.stop();
			await diffs.flush();
			await tracker.flush();
			await activeCodexReader?.flush();
			await activeCodexParser?.flush();
			await activeDiscovery?.flush();
			await correlator.finishSession(stoppedSession);
			await writer.flush();
			await writer.completeSession(stoppedSession);
			if (queue) { try { renderHealth(await queue.getHealth()); } catch (error) { reportPersistence('queue_failed', safeQueueError(error).code); } }
		})
	);
}

// VS Code disposes the commands and controller in context.subscriptions.
export async function deactivate(): Promise<void> {
	const stoppedSession = activeRecording?.sessionId;
	activeRecording?.stop();
	try {
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
		await activeCorrelator?.finishSession(stoppedSession);
		activeCorrelator?.dispose();
		await activeCorrelator?.flush();
		activeCorrelator = undefined;
		await activePersistence?.completeSession(stoppedSession);
	} finally {
		try { await activePersistence?.close(); } catch { /* Persistence already reports a sanitized visible warning. */ }
		activePersistence = undefined;
		activeRecording = undefined;
	}
}
