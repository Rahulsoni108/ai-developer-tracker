import { AssessmentWorkflowConsent, type AssessmentWorkflowLifecycle } from './assessmentWorkflowConsent';
import { RailsWorkflowConsentClient } from './railsWorkflowConsentClient';
import { ManagedCodexCapture } from './managedCodexCapture';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RailsProcessorPolicyClient } from './processorPolicy';
import { startRecordingCommand, stopRecordingCommand, type RecordingStartChoice } from './recordingCommands';
import { DisclosureCaptureMonitor } from './disclosureCaptureMonitor';
import { registerDisclosureCommands } from './assessmentDisclosureCommands';
import { registerProcessingCommands } from './assessmentProcessingCommands';
import { AssessmentProcessingConsent } from './assessmentProcessingConsent';
import { RailsProcessingConsentClient } from './railsProcessingConsentClient';
import { AssessmentDisclosureConsent } from './assessmentDisclosureConsent';
import { RailsDisclosureConsentClient } from './railsDisclosureConsentClient';
import { approveRecordingWorkspaces, describeAssessmentStart, type AssessmentStartStep } from './assessmentStartDiagnostics';
import { AssessmentEvidenceConsent } from './assessmentEvidenceConsent';
import { RailsAssessmentApiClient } from './railsAssessmentApiClient';
import { AssessmentEventDelivery } from './assessmentEventDelivery';
import { PRIVACY_EVENT_TYPES } from './privacyFilter';
import { ClaudeEventParser } from './claudeEventParser';
import { ClaudeCapture } from './claudeCapture';
import { ClaudeCaptureUi, START_CLAUDE_CAPTURE_COMMAND, REVOKE_CLAUDE_CAPTURE_COMMAND } from './claudeCaptureUi';
import { join } from 'node:path';
import { RECORDED_EVENT_SUMMARY_COMMAND, RECORDED_EVENT_SUMMARY_TITLE, showRecordedEventSummary } from './recordedEventSummary';
import { EventUploader } from './eventUploader';
import { EventBatchManager } from './eventBatchManager';
import { UploadController, CONFIGURE_UPLOAD_ENDPOINT_COMMAND, CONFIGURE_UPLOAD_AUTHENTICATION_COMMAND,
	ENABLE_UPLOADS_COMMAND, DISABLE_UPLOADS_COMMAND, SHOW_UPLOAD_STATUS_COMMAND, type UploadNotice } from './uploadController';
import { validatedUploadEndpoint } from './httpsEventTransport';
import { UPLOAD_TOKEN_SECRET } from './eventUploader';
import * as vscode from 'vscode';
import { RecordingController, START_RECORDING_COMMAND, STOP_RECORDING_COMMAND } from './recording';
import { FileTracker, isExcludedPath } from './fileTracker';
import { JsonlWriter } from './jsonlWriter';
import { DiffTracker, DEFAULT_DIFF_OPTIONS } from './diffTracker';
import { CodexSessionDiscovery, type DiscoveryDiagnostic } from './codexSessionDiscovery';
import { CodexDiscoveryUi, REVIEW_CODEX_SESSIONS_COMMAND } from './codexDiscoveryUi';
import { createHash } from 'node:crypto';
import { CodexJsonlReader } from './codexJsonlReader';
import { CodexEventParser } from './codexEventParser';
import { ActivityCorrelator } from './activityCorrelator';
import { isAbsolute, relative } from 'node:path';
import { DEFAULT_QUEUE_STORAGE_BYTES, LocalEventQueue, safeQueueError, type QueueFailureCode, type QueueHealth } from './localEventQueue';
import { AsyncLocalEventQueue } from './asyncLocalEventQueue';
import { EventPersistence, EventPersistenceError, type PersistenceDiagnostic } from './eventPersistence';
import { LocalDataController, DEFAULT_RETENTION_DAYS, DELETE_LOCAL_EVIDENCE_COMMAND, CLEANUP_LEGACY_EVIDENCE_COMMAND, type LocalDataNotice } from './localDataController';
import { DIAGNOSTIC_LOG_PREFIX } from './jsonlWriter';
import { AssessmentController } from './assessmentController';
import { AssessmentApiError, MockAssessmentApiClient, UnavailableAssessmentApiClient } from './assessmentApiClient';
import { AssessmentConnectionStore } from './assessmentStorage';
import { formatAssessmentStatus, registerAssessmentCommands } from './assessmentCommands';

let activeWorkflow: AssessmentWorkflowConsent | undefined;
let activeManagedCodex: ManagedCodexCapture | undefined;
let activeAssessment: AssessmentController | undefined;
let activeRailsApi: RailsAssessmentApiClient | undefined;
let activeClaudeParser: ClaudeEventParser | undefined;
let activeClaudeUi: ClaudeCaptureUi | undefined;
let activeUploads: UploadController | undefined;
let activeTracker: FileTracker | undefined;
let activeDiffTracker: DiffTracker | undefined;
let activeDiscovery: CodexSessionDiscovery | undefined;
let activeCodexReader: CodexJsonlReader | undefined;
let activeCodexParser: CodexEventParser | undefined;
let activeCorrelator: ActivityCorrelator | undefined;
let activePersistence: EventPersistence | undefined;
let activeRecording: RecordingController | undefined;
let activeLocalData: LocalDataController | undefined;
export const QUEUE_HEALTH_COMMAND = 'ai-developer-tracker.showQueueHealth';

export async function activate(context: vscode.ExtensionContext) {
	// Local desktop profiles expose this disk-backed directory through a userdata URI.
	// Normalize only the trusted context URI; do not accept arbitrary virtual/remote paths.
	const queueStorageUri = context.globalStorageUri.scheme === 'vscode-userdata'
		&& !context.globalStorageUri.authority && vscode.env.uiKind === vscode.UIKind.Desktop && !vscode.env.remoteName
		? vscode.Uri.file(context.globalStorageUri.fsPath) : context.globalStorageUri;
	const storageDirectory = context.storageUri?.scheme === 'file' ? context.storageUri : context.globalStorageUri;
	const diagnosticsDirectory = vscode.Uri.joinPath(queueStorageUri, 'diagnostics');
	const legacyDirectories = [...new Set([queueStorageUri.fsPath, storageDirectory.fsPath])];
	const output = vscode.window.createOutputChannel('AI Developer Tracker');
	const queueConfiguration = vscode.workspace.getConfiguration('ai-developer-tracker.queue');
	const configuredMiB = queueConfiguration.inspect<number>('maxSizeMB')?.globalValue ?? 100;
	const validLimit = Number.isSafeInteger(configuredMiB) && configuredMiB >= 1 && configuredMiB <= 10240;
	if (!validLimit) { output.appendLine('Invalid queue storage limit. Using the default 100 MB limit.'); }
	let queue: AsyncLocalEventQueue | undefined;
	let startupFailure: QueueFailureCode | undefined;
	try { queue = await AsyncLocalEventQueue.open(queueStorageUri, vscode.workspace.workspaceFolders ?? [], {
		maxStorageBytes: validLimit ? configuredMiB * 1024 * 1024 : DEFAULT_QUEUE_STORAGE_BYTES,
		diagnosticDirectories: { legacy: legacyDirectories, diagnostics: diagnosticsDirectory.fsPath }
	}, context.secrets); }
	catch (error) { startupFailure = safeQueueError(error).code; }
	const queueStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	queueStatus.name = 'AI Developer Tracker queue health';
	queueStatus.command = QUEUE_HEALTH_COMMAND;
	const degradation = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	degradation.name = 'AI Developer Tracker persistence';
	let queueDegraded = !queue;
	const warnings = new Set<PersistenceDiagnostic>();
	output.appendLine('SQLite is the authoritative encrypted event store. JSONL diagnostics contain safe metadata only.');
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	statusBar.name = 'AI Developer Tracker';
	const traceRecordingStart = (step: AssessmentStartStep) => {
		output.appendLine('Recording start prerequisite: ' + step); activeAssessment?.reportStartPrerequisite(step);
	};
	const recording: RecordingController = new RecordingController(statusBar, async (isCurrentRequest): Promise<boolean> => {
		if (activeLocalData?.busy) {
			traceRecordingStart('maintenance_active');
			void vscode.window.showWarningMessage('Local data maintenance is in progress. Retry Start Recording afterward.'); return false;
		}
		if (queueDegraded) {
			traceRecordingStart('storage_unavailable');
			void vscode.window.showErrorMessage('AI Developer Tracker cannot record because its local event queue is unavailable. Resolve the storage problem and reload the extension.');
			return false;
		}
		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			traceRecordingStart('workspace_required');
			await vscode.window.showWarningMessage('Open a workspace folder before starting recording.');
			return false;
		}
		try { await LocalEventQueue.assertStorageOutsideWorkspaces(queueStorageUri, folders); }
		catch {
			traceRecordingStart('workspace_storage_overlap');
			void vscode.window.showErrorMessage('AI Developer Tracker cannot record a workspace containing its local event queue. Open another workspace.');
			return false;
		}
		traceRecordingStart('recording_consent');
		const consent = activeAssessment?.workflowStartPending ? (await activeWorkflow?.confirmRecording(isCurrentRequest) ? 'Start Recording' : undefined) : await vscode.window.showInformationMessage(
			'Start recording file activity in all workspace folders?',
			{ modal: true, detail: `Folders: ${folders.map(folder => folder.name).join(', ')}\n\nFile activity metadata, initial code baselines, and incremental source-code diffs are saved locally in encrypted SQLite after privacy filtering. Captured code is sensitive. JSONL diagnostics contain safe metadata only. Sensitive/generated paths and configured size limits are excluded. Recording consent does not authorize uploads. Transmitting sanitized evidence requires separate endpoint-scoped upload consent.\n\nWhen enabled, local Codex session metadata is discovered only during recording. Associations require separate confirmation. Conversation and tool content is captured only after a separate explicit consent dialog.` },
			'Start Recording'
		);
		if (consent !== 'Start Recording' || !isCurrentRequest()) {
			traceRecordingStart(isCurrentRequest() ? 'recording_consent_declined' : 'request_cancelled'); return false;
		}
		try {
			return await approveRecordingWorkspaces(folders, tracker, isCurrentRequest, () => vscode.workspace.workspaceFolders, traceRecordingStart);
		} catch (error) {
			reportError(error);
			return false;
		}
	}, () => new Date(), traceRecordingStart);
	activeRecording = recording;
	const assessmentRecordingNotice = () => { if (activeAssessment?.isAssociatedSession(recording.sessionId ?? '')) { void vscode.window.showInformationMessage('Use Launch Assessment AI Session for tracker-managed Codex/Claude capture. Native or unverified chats are excluded from automatic assessment capture.'); return true; } return false; };
	let privacyDiscovery: CodexSessionDiscovery | undefined;
	let privacyParser: CodexEventParser | undefined;
	const reportPersistence = (reason: PersistenceDiagnostic, code?: QueueFailureCode) => {
		if (code === 'maintenance_active') {
			void vscode.window.showWarningMessage('Local data maintenance is in progress in another window. Retry Start Recording afterward.'); return;
		}
		if (reason === 'queue_failed') { queueDegraded = true; recording.stop(); }
		const privacyDegraded = reason === 'privacy_rejected' || reason === 'privacy_gap' || warnings.has('privacy_rejected') || warnings.has('privacy_gap');
		degradation.text = queueDegraded || privacyDegraded ? '$(warning) Recording degraded' : '$(warning) JSONL degraded';
		degradation.tooltip = queueDegraded ? 'Local event queue failed. Recording stopped; resolve storage and reload.'
			: privacyDegraded ? 'Privacy filtering omitted evidence. Rejection counts are stored in recording health; filtered code changes are reconstruction gaps.'
				: 'Events are safely queued in SQLite, but metadata-only JSONL diagnostics are unavailable.';
		degradation.show();
		if (warnings.has(reason)) { return; }
		warnings.add(reason);
		const failures: Record<QueueFailureCode, string> = {
			maintenance_active: 'local data maintenance is active',
			recording_active: 'another recording is active',
			key_storage_unavailable: 'secure local evidence key storage is unavailable',
			key_missing: 'a required local evidence encryption key is missing',
			key_invalid: 'the local evidence encryption key is invalid',
			authentication_failed: 'local evidence authentication failed',
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
			: reason === 'privacy_rejected' ? 'AI Developer Tracker privacy filtering rejected evidence. Recording is degraded; only safe counts and reason codes are stored for rejected events.'
				: reason === 'privacy_gap' ? 'AI Developer Tracker privacy filtering omitted code patches containing sensitive values. These changes are recorded as reconstruction gaps.'
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
	}, new JsonlWriter(() => vscode.Uri.joinPath(diagnosticsDirectory, DIAGNOSTIC_LOG_PREFIX + new Date().toISOString().slice(0, 10) + '.jsonl').fsPath), reportPersistence);
	activePersistence = writer;
	const interactionCounts = new Map<string, number>();
	context.subscriptions.push(writer.onDidWrite(event => {
		if (event.eventType !== 'ai.prompt.submitted' && event.eventType !== 'ai.response.completed') { return; }
		interactionCounts.set(event.sessionId, (interactionCounts.get(event.sessionId) ?? 0) + 1);
		if (interactionCounts.size > 32) { interactionCounts.delete(interactionCounts.keys().next().value!); }
	}));
	context.subscriptions.push(writer.attachRecording(recording, sessionId => {
		const folders = tracker.getApprovedFolders().map(folder => ({ uri: folder.uri,
			workspaceId: createHash('sha256').update(folder.uri.toString()).digest('hex') }));
		return {
			approvedWorkspaceIds: folders.map(folder => folder.workspaceId),
			confirmedCodexSessions: [...(activeManagedCodex?.getApprovals(sessionId) ?? []), ...(privacyDiscovery?.getRegistry() ?? []).filter(entry => entry.recordingSessionId === sessionId
				&& entry.status === 'confirmed' && entry.reason === 'user_confirmed' && entry.sourceSessionId && entry.workspaceId)
				.map(entry => ({ sourceSessionId: entry.sourceSessionId!, workspaceId: entry.workspaceId! }))],
			codexContentConsent: (activeManagedCodex?.getApprovals(sessionId).length ?? 0) > 0 || (privacyParser?.hasAdmittedContentConsent(sessionId) ?? false),
			confirmedClaudeSessions: activeClaudeParser?.getApprovals(sessionId) ?? [],
			claudeContentConsent: (activeClaudeParser?.getApprovals(sessionId).length ?? 0) > 0,
			resolveToolPath: (path, workspaceId) => {
				const folder = folders.find(folder => folder.workspaceId === workspaceId);
				if (!folder || folder.uri.scheme !== 'file' || !isAbsolute(path)) { return undefined; }
				const resolved = relative(folder.uri.fsPath, path).replace(/\\/g, '/');
				return resolved && resolved !== '..' && !resolved.startsWith('../') && !isAbsolute(resolved) ? resolved : undefined;
			}
		};
	}));
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
			onCandidatesChanged: candidates => { if (!activeAssessment?.isAssociatedSession(recording.sessionId ?? '')) { ui?.notify(candidates); } }
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
		privacyDiscovery = discovery; privacyParser = parser;
		ui = new CodexDiscoveryUi(recording, discovery, undefined, {
			hasConsent: sessionId => parser.hasContentConsent(sessionId),
			grant: sessionId => parser.grantContentConsent(sessionId),
			request: async () => (await vscode.window.showWarningMessage(
				'Allow local capture of Codex conversation content for this recording?',
				{ modal: true, detail: 'User prompts, visible assistant responses, tool inputs, and tool outputs from sessions you explicitly confirm will be saved in the encrypted local SQLite assessment queue after privacy filtering. These may include source code, credentials, or other sensitive text. System/developer instructions and private reasoning are excluded. Path exclusions do not redact every secret inside ordinary messages. This content-capture consent does not authorize uploads. Upload consent is separate. Content-capture consent expires when recording stops.' },
				'Allow Content Capture'
			)) === 'Allow Content Capture'
		}, (summary, contentConsent) => output.appendLine('Codex discovery review: ' + JSON.stringify({ ...summary, contentConsent })));
		activeDiscovery = discovery;
		activeCodexParser = parser;
		const reader = new CodexJsonlReader(recording, discovery, {
			// Source identifiers are untrusted strings; debug output needs only fixed kinds and indexes.
			onRecord: metadata => output.appendLine('Codex record metadata: ' + JSON.stringify({ recordIndex: metadata.recordIndex,
				eventType: metadata.eventType, payloadType: metadata.payloadType, timestamp: metadata.timestamp })),
			canCaptureContent: registration => parser.canCapture(registration),
			onSourceRecord: (record, context) => parser.handle(record, context),
			onDiagnostic: diagnostic => output.appendLine('Codex reader diagnostic: ' + JSON.stringify({
				reason: diagnostic.reason, recordIndex: diagnostic.recordIndex }))
		});
		activeCodexReader = reader;
		context.subscriptions.push(discovery, parser, reader, ui, vscode.commands.registerCommand(REVIEW_CODEX_SESSIONS_COMMAND, () => assessmentRecordingNotice() ? undefined : ui.review()));
	} else {
		context.subscriptions.push(vscode.commands.registerCommand(REVIEW_CODEX_SESSIONS_COMMAND, () =>
			vscode.window.showInformationMessage('Codex session discovery is disabled in AI Developer Tracker settings.')));
	}

	const claudeParser = new ClaudeEventParser(recording, writer, reason => output.appendLine('Claude capture diagnostic: ' + reason));
	activeClaudeParser = claudeParser;
	const claudeUi = new ClaudeCaptureUi(recording, tracker, nodeExecutable => new ClaudeCapture(recording, claudeParser, {
		storageDirectory: join(queueStorageUri.fsPath, 'claude-runtime'), nodeExecutable, bridgePath: join(__dirname, 'claudeHookBridge.js'),
		assertOutsideWorkspaces: async path => { await LocalEventQueue.assertStorageOutsideWorkspaces(vscode.Uri.file(path), vscode.workspace.workspaceFolders ?? []); },
		authorizeSource: async (id, workspaceId, sourceSessionId) => {
			if (activeAssessment?.isAssociatedSession(id)) {
				if (!activeWorkflow?.permits(id, 'claude')) { throw new AssessmentApiError('consent_required'); }
				await activeWorkflow.enroll('claude', sourceSessionId, workspaceId);
			}
		}
	}), reason => {
		const messages = { unavailable: 'Claude Code capture requires an available Claude Code CLI and Node.js on PATH. No sessions were imported.',
			revoked: 'Claude Code capture revoked. Local evidence is preserved; capture requires fresh approval.',
			failed: 'Claude Code capture could not start safely. Check installation and local workspace/storage availability.' };
		output.appendLine(messages[reason]); void vscode.window.showWarningMessage(messages[reason]);
	}, undefined, id => activeAssessment?.isAssociatedSession(id) ? activeWorkflow?.permits(id, 'claude') ?? false : undefined);
	activeClaudeUi = claudeUi;
	context.subscriptions.push({ dispose: () => { void claudeUi.dispose(); claudeParser.dispose(); } },
		vscode.commands.registerCommand(START_CLAUDE_CAPTURE_COMMAND, async () => {
			if (!recording.isRecording) { void vscode.window.showInformationMessage('Start recording before approving a Claude Code assessment session.'); return; }
			await claudeUi.start();
		}),
		vscode.commands.registerCommand(REVOKE_CLAUDE_CAPTURE_COMMAND, () => claudeUi.revoke()));

	if (queue) {
		const notices: Record<LocalDataNotice, string> = {
			recording_active: 'Stop all recordings before cleaning local assessment data.',
			maintenance_active: 'Local data maintenance is already in progress. Retry afterward.',
			cancelled: 'Local assessment cleanup cancelled. Existing data was preserved.',
			cleanup_complete: 'Selected local assessment evidence was deleted. Encryption keys were retained. Deletion does not guarantee erasure from storage media or backups.',
			cleanup_partial: 'Cleanup partially completed. SQLite deletion committed, but diagnostic deletion or storage compaction could not complete. Review local data counts and retry. Deletion does not guarantee secure erasure.',
			cleanup_failed: 'Local assessment cleanup failed. Some operations may have completed; review local data counts before retrying.',
			retention_failed: 'Local retention could not complete. Existing pending evidence is preserved; review local data counts.'
		};
		const readRetentionDays = () => {
			const days = vscode.workspace.getConfiguration('ai-developer-tracker.retention').inspect<number>('days')?.globalValue ?? DEFAULT_RETENTION_DAYS;
			return Number.isSafeInteger(days) && days >= 0 && days <= 3650 ? days : DEFAULT_RETENTION_DAYS;
		};
		activeLocalData = new LocalDataController(recording, queue, {
			retentionDays: readRetentionDays,
			guard: async () => {
				for (const path of [...legacyDirectories, diagnosticsDirectory.fsPath]) {
					await LocalEventQueue.assertStorageOutsideWorkspaces(vscode.Uri.file(path), vscode.workspace.workspaceFolders ?? []);
				}
			},
			drain: async () => { await diffs.flush(); await tracker.flush(); await activeManagedCodex?.flush(); await activeCodexReader?.flush(); await activeCodexParser?.flush(); await activeClaudeParser?.flush(); await correlator.flush(); await writer.flush(); },
			cleared: async () => {
				await diffs.clearStoppedEvidence(); await correlator.clearStoppedEvidence(); activeDiscovery?.clearStoppedRegistry(); writer.resetAfterCleanup();
				const health = await queue!.getHealth(); renderHealth(health);
				if (health.status !== 'full') { queueDegraded = false; warnings.delete('queue_failed'); degradation.hide(); }
			},
			confirm: async (scope, summary) => {
				const pending = scope === 'all' ? summary.pendingCount : summary.legacyPendingDeletionCount;
				const detail = scope === 'all'
					? `Delete unarchived SQLite events (up to ${pending} pending events; archived events are excluded), recording-session and correlation evidence, privacy-health history, known historical assessment JSONL logs, and metadata diagnostics in this extension's current local storage?`
					: `Delete historical plaintext assessment JSONL logs (${summary.legacyLogCount} detected), plus unarchived SQLite recording sessions containing plaintext events (${summary.legacySqliteCount} detected)? This also deletes encrypted events and correlation evidence in those same sessions, including up to ${pending} pending events; archived sessions are excluded.`;
				return (await vscode.window.showWarningMessage('Delete selected local assessment evidence?', { modal: true,
					detail: detail + '\n\nPending evidence in this scope will be permanently lost from the queue. Archived assessment connections and their SQLite evidence are retained and excluded from this cleanup. Workspace source files, original Codex session files, other storage profiles/workspace logs, and encryption keys are not deleted. Deleting rows/files may not securely erase bytes from backups or storage media.' }, 'Delete Evidence')) === 'Delete Evidence';
			},
			notice: reason => { output.appendLine(notices[reason]); if (reason !== 'cancelled') { void vscode.window.showWarningMessage(notices[reason]); } }
		});
		const data = activeLocalData;
		context.subscriptions.push(
			vscode.commands.registerCommand(DELETE_LOCAL_EVIDENCE_COMMAND, () => data.cleanup('all')),
			vscode.commands.registerCommand(CLEANUP_LEGACY_EVIDENCE_COMMAND, () => data.cleanup('legacy'))
		);
		try {
			const historical = await queue.getLocalDataSummary();
			if (historical.legacyLogCount || historical.legacySqliteCount) {
				const message = `Historical plaintext assessment data detected: ${historical.legacyLogCount} log files and ${historical.legacySqliteCount} SQLite events. Nothing was automatically deleted. Use AI Developer Tracker: Clean Up Historical Plaintext Evidence to review cleanup.`;
				output.appendLine(message); void vscode.window.showWarningMessage(message);
			}
		} catch { output.appendLine('Historical plaintext detection could not complete. Existing data was preserved.'); }
		await data.automaticRetention();
		const timer = setInterval(() => { void data.automaticRetention(); }, 86400000);
		context.subscriptions.push({ dispose: () => { clearInterval(timer); data.dispose(); } });
	} else {
		output.appendLine('Historical plaintext detection and cleanup are unavailable until local storage and its required keys can be opened. Existing data was preserved.');
		for (const command of [DELETE_LOCAL_EVIDENCE_COMMAND, CLEANUP_LEGACY_EVIDENCE_COMMAND]) {
			context.subscriptions.push(vscode.commands.registerCommand(command, () => vscode.window.showWarningMessage('Local assessment storage is unavailable. Cleanup is disabled to preserve existing data.')));
		}
	}

	if (queue) {
		const configuration = () => vscode.workspace.getConfiguration('ai-developer-tracker.upload');
		const readSettings = () => {
			const settings = configuration();
			// Workspace/repository settings must never redirect evidence or enable uploads.
			return { endpoint: settings.inspect<string>('endpoint')?.globalValue ?? '',
				enabled: settings.inspect<boolean>('enabled')?.globalValue ?? false,
				maxEvents: settings.inspect<number>('maxEvents')?.globalValue ?? 100,
				maxBytes: settings.inspect<number>('maxBytes')?.globalValue ?? 1048576,
				timeoutMs: settings.inspect<number>('timeoutMs')?.globalValue ?? 30000 };
		};
		const messages: Record<UploadNotice, string> = {
			disabled: 'Uploads disabled. Pending evidence remains in the encrypted local queue.',
			waiting: 'Uploads enabled; waiting for the next eligible attempt.',
			empty: 'Upload queue has no available pending events.',
			delivered: 'The destination explicitly acknowledged delivery of an event batch.',
			retry: 'Event upload will retry. Undelivered evidence remains pending.',
			cancelled: 'Event upload cancelled. Undelivered evidence remains pending.',
			authentication: 'Uploads paused: configure valid authentication, then explicitly enable uploads again.',
			configuration: 'Upload configuration is invalid or unavailable. Verify HTTPS endpoint and bounds; pending evidence is preserved.',
			protocol: 'Uploads paused: the destination did not provide verifiable event acknowledgments. Pending evidence is preserved.',
			privacy: 'Uploads paused: a queued event lacks sufficient capture-time approval or fails current privacy checks. Historical events without approval remain blocked.',
			storage: 'Uploads stopped or paused because local delivery storage is unavailable. Pending evidence is preserved.',
			token_configured: 'Upload authentication stored securely. Use Enable Uploads to approve transmission.',
			token_removed: 'Upload authentication removed; uploads disabled. Pending evidence is preserved.',
			endpoint_configured: 'Upload endpoint updated; uploads disabled. New destination consent is required.',
			consent_cancelled: 'Upload consent cancelled. Uploads remain disabled.',
			consent_required: 'Upload settings cannot grant consent. Use Enable Uploads to review the destination and approve transmission.'
		};
		const uploads = new UploadController(queue, context.secrets, {
			readSettings,
			writeEnabled: async enabled => { await configuration().update('enabled', enabled, vscode.ConfigurationTarget.Global); },
			writeEndpoint: async endpoint => { await configuration().update('endpoint', endpoint, vscode.ConfigurationTarget.Global); },
			requestEndpoint: async current => vscode.window.showInputBox({ title: 'Configure Upload Endpoint', value: current,
				prompt: 'HTTPS event endpoint. Leave empty to disable configuration. Do not include credentials, queries or fragments.', ignoreFocusOut: true,
				validateInput: value => { if (!value) { return undefined; } try { validatedUploadEndpoint(value); return undefined; } catch { return 'Enter an HTTPS endpoint without credentials, queries or fragments.'; } } }),
			requestAuthenticationAction: async () => {
				const choice = await vscode.window.showQuickPick([{ label: 'Configure Token', action: 'configure' as const },
					{ label: 'Remove Token', action: 'remove' as const }], { title: 'Configure Upload Authentication', ignoreFocusOut: true });
				return choice?.action;
			},
			requestToken: async () => vscode.window.showInputBox({ title: 'Configure Upload Authentication', password: true,
				prompt: 'Enter the upload bearer token. Stored only in VS Code SecretStorage; never in settings or diagnostics.', ignoreFocusOut: true,
				validateInput: token => /^[\x21-\x7e]{1,8192}$/.test(token) ? undefined : 'Enter a non-empty token without whitespace or control characters.' }),
			confirmUpload: async hostname => (await vscode.window.showWarningMessage(`Enable assessment uploads to ${hostname}?`, { modal: true,
				detail: `Destination hostname: ${hostname}\n\nSanitized source code, diffs, AI prompts, responses and tool activity from verified local recording events may be transmitted over HTTPS. Filtering cannot guarantee removal of every sensitive value. Recording consent does not authorize transmission. Historical events without sufficient approval evidence remain blocked.\n\nUpload approval is scoped to this exact configured endpoint and expires on reload, endpoint or batch-setting changes, or explicit revocation. Use Disable Uploads to revoke it; pending events stay local. No real assessment backend is included.` }, 'Enable Uploads')) === 'Enable Uploads',
			notice: reason => {
				output.appendLine(messages[reason]);
				if (['authentication', 'configuration', 'protocol', 'privacy', 'storage', 'consent_required'].includes(reason)) { void vscode.window.showWarningMessage(messages[reason]); }
			}
		}, (settings, hooks) => new EventUploader(new EventBatchManager(queue), queue, context.secrets, {
			...settings, ...hooks, privacyContext: event => activeAssessment && !activeAssessment.allowsDevelopmentUpload(event.sessionId)
				? undefined : writer.resolveUploadPrivacyContext(event)
		}));
		activeUploads = uploads;
		await uploads.initialize();
		context.subscriptions.push(
			{ dispose: () => { void uploads.dispose(); } },
			vscode.commands.registerCommand(CONFIGURE_UPLOAD_ENDPOINT_COMMAND, () => uploads.configureEndpoint()),
			vscode.commands.registerCommand(CONFIGURE_UPLOAD_AUTHENTICATION_COMMAND, () => uploads.configureAuthentication()),
			vscode.commands.registerCommand(ENABLE_UPLOADS_COMMAND, () => uploads.enable()),
			vscode.commands.registerCommand(DISABLE_UPLOADS_COMMAND, async () => { const revoking = activeAssessment?.revokeUploadConsent(); await uploads.disable(); await revoking; void vscode.window.showInformationMessage(messages.disabled); }),
			vscode.commands.registerCommand(SHOW_UPLOAD_STATUS_COMMAND, async () => {
				const status = await uploads.showStatus();
				void vscode.window.showInformationMessage(`Uploads: ${status.enabled ? 'enabled with consent' : 'disabled'}; destination hostname: ${status.hostname ?? 'not configured'}; authentication: ${status.authenticationConfigured ? 'configured' : 'missing'}; status: ${status.pauseReason ?? status.outcome}; pending events: ${status.pendingEvents ?? 'unavailable'}.`);
				return status;
			}),
			vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('ai-developer-tracker.upload')) { void uploads.settingsChanged(); } }),
			context.secrets.onDidChange(event => { if (event.key === UPLOAD_TOKEN_SECRET) { void uploads.disable(); } })
		);
	} else {
		for (const command of [CONFIGURE_UPLOAD_ENDPOINT_COMMAND, CONFIGURE_UPLOAD_AUTHENTICATION_COMMAND, ENABLE_UPLOADS_COMMAND, DISABLE_UPLOADS_COMMAND, SHOW_UPLOAD_STATUS_COMMAND]) {
			context.subscriptions.push(vscode.commands.registerCommand(command, () => vscode.window.showWarningMessage('Uploads are unavailable while local event storage is unavailable. Existing evidence is preserved.')));
		}
	}

	const flushStoppedRecording = async (stoppedSession: string | undefined): Promise<void> => {
		await diffs.flush(); await tracker.flush(); await activeManagedCodex?.flush(); await activeCodexReader?.flush(); await activeCodexParser?.flush();
		await activeClaudeParser?.flush(); await activeDiscovery?.flush(); await activeClaudeParser?.finishRecording();
		await correlator.finishSession(stoppedSession); await writer.flush(); await writer.completeSession(stoppedSession);
		if (stoppedSession) { await queue?.suspendDisclosureCapture(stoppedSession, undefined, true); }
		await activeWorkflow?.flush();
	};
	const mockAssessments = vscode.workspace.getConfiguration('ai-developer-tracker.assessment.mock').inspect<boolean>('enabled')?.globalValue === true;
	const assessmentOrigin = vscode.workspace.getConfiguration('ai-developer-tracker.assessment').inspect<string>('apiOrigin')?.globalValue ?? '';
	let assessmentApi: MockAssessmentApiClient | RailsAssessmentApiClient | UnavailableAssessmentApiClient = new UnavailableAssessmentApiClient();
	if (mockAssessments) { assessmentApi = new MockAssessmentApiClient(); }
	else if (assessmentOrigin) {
		try { assessmentApi = new RailsAssessmentApiClient(assessmentOrigin); activeRailsApi = assessmentApi; }
		catch { output.appendLine('Invalid assessment HTTPS origin. Pairing is disabled; no mock fallback is used.'); }
	}
	if (assessmentApi instanceof MockAssessmentApiClient) { assessmentApi.seedInvitation('DEMO-ASSESSMENT', '1'); }
	const assessmentStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	assessmentStatus.name = 'AI Developer Tracker assessment'; assessmentStatus.command = 'ai-developer-tracker.showAssessmentStatus';
	const assessmentConsents = queue ? new AssessmentEvidenceConsent(queue,
		assessmentApi instanceof RailsAssessmentApiClient ? assessmentApi : undefined, () => ({
			workspaceIds: tracker.getApprovedFolders().map(folder => createHash('sha256').update(folder.uri.toString()).digest('hex')),
			eventTypes: [...PRIVACY_EVENT_TYPES]
		})) : undefined;
	const assessmentStore = new AssessmentConnectionStore(context.globalState, context.secrets, queue ?? {
		archiveAssessment: async () => { throw new AssessmentApiError('storage'); },
		getAssessmentArchiveIndex: async () => { throw new AssessmentApiError('storage'); }
	});
	const assessmentDelivery = queue && assessmentApi instanceof RailsAssessmentApiClient
		? new AssessmentEventDelivery(queue, assessmentStore, assessmentApi, status => {
			output.appendLine('Assessment delivery status: ' + status);
			if (status === 'authentication') { void activeAssessment?.showStatus(); }
		}) : undefined;
	const workflowLifecycle: AssessmentWorkflowLifecycle | undefined = queue && assessmentApi instanceof RailsAssessmentApiClient ? {
		prepare: (auth, signal) => activeWorkflow!.prepare(auth, signal),
		start: (auth, id, signal) => activeWorkflow!.start(auth, id, signal),
		recover: (auth, ids, signal) => activeWorkflow!.recover(auth, ids, signal)
	} : undefined;
	const assessment = new AssessmentController(assessmentApi, assessmentStore, recording, {
		flushStopped: async id => {
			await flushStoppedRecording(id);
			if (writer.isDegraded || !queue) { throw new AssessmentApiError('storage'); }
		},
		freezeFinalization: async (scope, existingOnly) => { if (!queue) { throw new AssessmentApiError('storage'); } return queue.freezeFinalization(scope, existingOnly); },
		getStatus: async ids => { if (!queue) { throw new AssessmentApiError('storage'); } return queue.getSessionEvidenceStatus(ids); },
		disableDevelopmentUploads: async () => { await activeUploads?.disable(); }
	}, async hostname => (await vscode.window.showWarningMessage(`Allow assessment uploads to ${hostname}?`, { modal: true,
		detail: `Separate upload consent: sanitized code, diffs, AI conversations and tool activity may be transmitted for this paired assessment. Recording consent alone does not allow uploads.\n\nSelected workspace identifiers: ${tracker.getApprovedFolders().map(folder => createHash('sha256').update(folder.uri.toString()).digest('hex')).join(', ')}\nEvent categories: ${PRIVACY_EVENT_TYPES.join(', ')}\nScope: assessment_evidence (assessment-evidence.v1), limited to this assessment/recording and destination. Expires at the earliest server assessment deadline, credential expiry or revocation. Disable Uploads revokes consent; Stop & Submit closes the capture window after local writes drain.\n\n${mockAssessments ? 'Local mock only: no evidence is transmitted.' : 'The pinned R4.2D Rails contract sends only encrypted-queue events with verifiable capture-time approvals and matching scoped receipts. A receipt alone never authorizes an event. Stop & Submit freezes evidence, closes capture windows, uploads approved events and requests Rails finalization. Success requires a verified durable submission receipt before the original deadline.'} Reload requires fresh upload consent; Codex/Claude content still requires separate source approval.` }, 'Allow Assessment Uploads')) === 'Allow Assessment Uploads',
	view => { assessmentStatus.text = `Assessment: ${view.archiving ? 'archiving' : view.state === 'unpaired' && view.archivedCount ? 'ready to pair' : view.state.replace(/_/g, ' ')}${view.mode === 'mock' ? ' (mock)' : ''}`;
		assessmentStatus.tooltip = formatAssessmentStatus(view); if (view.state === 'unpaired' && !view.archivedCount) { assessmentStatus.hide(); } else { assessmentStatus.show(); } }, 10000, assessmentConsents, assessmentDelivery, value => output.appendLine(describeAssessmentStart(value)), workflowLifecycle);
	activeAssessment = assessment;
	const disclosureClient = queue && assessmentApi instanceof RailsAssessmentApiClient ? new RailsDisclosureConsentClient() : undefined;
	if (disclosureClient) { context.subscriptions.push(disclosureClient); }
	const approvedAssessmentSources = (id: string) => [
			...(privacyParser?.hasAdmittedContentConsent(id) ? (privacyDiscovery?.getRegistry() ?? []).filter(entry => entry.recordingSessionId === id
				&& entry.status === 'confirmed' && entry.reason === 'user_confirmed' && entry.sourceSessionId && entry.workspaceId)
				.map(entry => ({ workspaceId: entry.workspaceId!, session: { source: 'codex' as const, source_session_id: entry.sourceSessionId! } })) : []),
			...(activeClaudeParser?.getApprovals(id) ?? []).map(entry => ({ workspaceId: entry.workspaceId,
				session: { source: 'claude' as const, source_session_id: entry.sourceSessionId } }))
		];
	const disclosureConsent = queue && disclosureClient ? new AssessmentDisclosureConsent(queue, disclosureClient, approvedAssessmentSources) : undefined;
	const processingClient = queue && assessmentApi instanceof RailsAssessmentApiClient ? new RailsProcessingConsentClient() : undefined;
	if (processingClient) { context.subscriptions.push(processingClient); }
	const processorPolicyClient = processingClient ? new RailsProcessorPolicyClient() : undefined;
	if (processorPolicyClient) { context.subscriptions.push(processorPolicyClient); }
	const processingConsent = queue && processingClient ? new AssessmentProcessingConsent(context.secrets, queue, processingClient, approvedAssessmentSources, scope => processorPolicyClient!.get(scope.auth, AbortSignal.timeout(10000))) : undefined;
	if (queue && assessmentApi instanceof RailsAssessmentApiClient && processingConsent) {
		const messages = { ready: 'Assessment permissions ready. Use Launch Assessment AI Session for tracked Codex/Claude work; unrelated native chats are excluded.',
			source_ready: 'Assessment AI session capture ready.', source_blocked: 'Assessment AI session authorization failed. No unapproved session content was imported.',
			unavailable: 'Assessment permission refresh failed or consent changed. Capture stopped safely; evidence is preserved. Check Assessment Status before resuming.',
			withdrawn: 'Assessment workflow consent withdrawn. Existing evidence is retained; withdrawal is not submission or deletion.' };
		activeWorkflow = new AssessmentWorkflowConsent(recording, queue, context.secrets, new RailsWorkflowConsentClient(undefined,
			check => output.appendLine(`Assessment workflow response validation failed: ${check}. No response content was logged.`)),
			() => (vscode.workspace.workspaceFolders ?? []).map(folder => createHash('sha256').update(folder.uri.toString()).digest('hex')),
			async detail => await vscode.window.showWarningMessage('Agree to this assessment recording, upload, disclosure and AI-processing scope?', { modal: true,
				detail: 'Workspace folders: ' + (vscode.workspace.workspaceFolders ?? []).map(folder => folder.name).join(', ') + '\n\n' + detail }, 'Agree & Start Assessment') === 'Agree & Start Assessment',
			async (auth, state) => processingConsent.acceptWorkflowReceipt({ auth, localSessionIds: [state.request.local_recording_session_id],
				currentRecording: state.request.local_recording_session_id,
				current: () => assessment.isAssociatedSession(state.request.local_recording_session_id) && !assessment.view.archiving }, state),
			code => { output.appendLine(messages[code]); if (code !== 'source_ready') { void vscode.window.showInformationMessage(messages[code]); } },
			async () => {
				const available: ('codex' | 'claude')[] = [];
				const results = await Promise.allSettled([
					promisify(execFile)('codex', ['--help'], { timeout: 5000, maxBuffer: 65536 }),
					promisify(execFile)('claude', ['--help'], { timeout: 5000, maxBuffer: 65536 })
				]);
				if (results[0].status === 'fulfilled' && results[0].value.stdout.includes('--no-daemon') && results[0].value.stdout.includes('--cd')) { available.push('codex'); }
				if (results[1].status === 'fulfilled' && results[1].value.stdout.includes('--plugin-dir') && results[1].value.stdout.includes('--session-id')) { available.push('claude'); }
				return available;
			});
		activeManagedCodex = new ManagedCodexCapture(recording, writer, activeWorkflow, join(queueStorageUri.fsPath, 'provider-runtime', 'codex'),
			async path => LocalEventQueue.assertStorageOutsideWorkspaces(vscode.Uri.file(path), vscode.workspace.workspaceFolders ?? []),
			reason => { const message = { waiting: 'Codex launch prepared. Sign in if requested, then wait for capture-ready confirmation before entering assessment prompts. Native Codex chats are not included.',
				ready: 'Assessment Codex capture ready.', unavailable: 'Assessment Codex session could not be verified or enrolled. No unrelated conversations were imported.',
				pre_enrollment_omitted: 'Codex activity before source enrollment was omitted. Wait for capture-ready confirmation before entering assessment prompts.' }[reason];
				output.appendLine(message); void vscode.window.showInformationMessage(message); });
		context.subscriptions.push(activeWorkflow, { dispose: () => { void activeManagedCodex?.dispose(); } },
			vscode.commands.registerCommand('ai-developer-tracker.launchAssessmentAiSession', async () => {
				try {
					const id = recording.sessionId;
					if (!id || !assessment.isAssociatedSession(id) || !recording.isRecording) { throw new AssessmentApiError('consent_required'); }
					const provider = await vscode.window.showQuickPick(['Codex', 'Claude Code'], { title: 'Launch a tracked assessment AI session' });
					if (!provider) { return; }
					if (provider === 'Claude Code') { await claudeUi.start(); return; }
					const folders = tracker.getApprovedFolders(); const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, folder })), { title: 'Assessment workspace' }))?.folder;
					if (!folder || !activeWorkflow!.permits(id, 'codex')) { throw new AssessmentApiError('consent_required'); }
					const help = (await promisify(execFile)('codex', ['--help'], { timeout: 5000, maxBuffer: 65536 })).stdout;
					if (!help.includes('--no-daemon') || !help.includes('--cd')) { throw new AssessmentApiError('unavailable'); }
					const launch = await activeManagedCodex!.create(folder.uri.fsPath, createHash('sha256').update(folder.uri.toString()).digest('hex'));
					const terminal = vscode.window.createTerminal({ name: 'Codex assessment session', cwd: vscode.Uri.file(launch.root), shellPath: 'codex',
						shellArgs: ['--no-daemon', '--cd', launch.root, '-c', 'cli_auth_credentials_store="keyring"'],
						env: { CODEX_HOME: launch.home, OPENAI_API_KEY: null, CODEX_API_KEY: null } }); terminal.show();
				} catch { void vscode.window.showWarningMessage('Assessment AI launch unavailable. Check active workflow consent, installed CLI support and approved workspace. No unrelated sessions were imported.'); }
			}),
			vscode.commands.registerCommand('ai-developer-tracker.revokeAssessmentWorkflowConsent', async () => {
				if (await vscode.window.showWarningMessage('Withdraw assessment recording and evidence permissions?', { modal: true,
					detail: 'Stops capture and delivery, preserves encrypted evidence, and requests server revocation. This does not delete already processed data or submit the assessment. Network failure leaves remote revocation unconfirmed.' }, 'Withdraw Assessment Permissions') !== 'Withdraw Assessment Permissions') { return; }
				try { await assessment.withDisclosureContext(false, async scope => {
					const id = scope.currentRecording ?? scope.localSessionIds.at(-1); if (!id) { throw new AssessmentApiError('consent_required'); }
					await assessment.revokeUploadConsent(); await activeWorkflow!.revoke(scope.auth, id);
				}); } catch { void vscode.window.showWarningMessage('Permissions are not confirmed revoked on Rails. Local capture/delivery remain blocked; evidence is retained. Retry the relevant revoke command after restoring connectivity.'); }
			}));
	}
	await assessment.initialize();
	if (disclosureConsent && queue) { context.subscriptions.push(new DisclosureCaptureMonitor(recording, assessment, disclosureConsent, queue, undefined, 5000, id => !!workflowLifecycle && assessment.isAssociatedSession(id))); }
	context.subscriptions.push(assessmentStatus, ...registerAssessmentCommands(assessment, mockAssessments, async () => {
		const id = recording.sessionId;
		if (recording.isRecording && id && assessment.isAssociatedSession(id) && !interactionCounts.get(id)) {
			void vscode.window.showWarningMessage('No AI prompt/response events were captured in this recording. Submission will continue with the evidence actually retained. Native/unverified chats are excluded; use Launch Assessment AI Session and wait for capture-ready confirmation. Use Show Recorded Event Summary to inspect counts.');
		}
	}),
		...registerDisclosureCommands(assessment, disclosureConsent),
		...registerProcessingCommands(assessment, processingConsent),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('ai-developer-tracker.assessment')) { void assessment.revokeUploadConsent();
				void vscode.window.showWarningMessage('Assessment settings changed. Upload consent was revoked; reload before pairing or resuming with the new configuration.'); }
		}));
	const recordedEventSummaryOutput = vscode.window.createOutputChannel(RECORDED_EVENT_SUMMARY_TITLE);
	context.subscriptions.push(
		recordedEventSummaryOutput,
		vscode.commands.registerCommand(RECORDED_EVENT_SUMMARY_COMMAND, () => showRecordedEventSummary(queue, recordedEventSummaryOutput)),
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
			await activeClaudeParser?.flush();
			await activeClaudeParser?.finishRecording();
			await correlator.finishSession(stoppedSession);
			await writer.flush();
			await writer.completeSession(stoppedSession);
			tracker.clearWorkspace();
			output.appendLine('Workspace folders changed. Start recording again to include all current folders.');
		}),
		vscode.commands.registerCommand(START_RECORDING_COMMAND, async () => {
			try {
				output.appendLine('Manual Start Recording command invoked. Use Start Assessment for the Rails lifecycle.');
				await startRecordingCommand(recording, () => assessment.view, async () => vscode.window.showWarningMessage<RecordingStartChoice>(
					'A Rails assessment is paired. Choose the recording workflow.', { modal: true,
						detail: 'Start Assessment requests fresh recording and separate upload consent, then asks Rails to authorize the official timer. Manual recording is only for local development; it does not start Rails and its evidence cannot be attached to this assessment. Cancel to leave everything unchanged.' },
					'Start Assessment', 'Start Manual Recording'), async () => vscode.commands.executeCommand('ai-developer-tracker.startAssessment'));
			} catch (error) {
				reportError(error);
			}
		}),
		vscode.commands.registerCommand(STOP_RECORDING_COMMAND, async () => {
			const stoppedSession = await stopRecordingCommand(recording, flushStoppedRecording);
			if (stoppedSession && !assessment.isAssociatedSession(stoppedSession) && assessment.view.mode === 'rails' && assessment.view.state !== 'unpaired') {
				void vscode.window.showInformationMessage('Manual recording stopped and local writes drained. Evidence was retained. The paired assessment was not submitted or archived. Use Start Assessment to begin its authorized workflow.');
			}
			await activeLocalData?.automaticRetention();
			if (queue) { try { renderHealth(await queue.getHealth()); } catch (error) { reportPersistence('queue_failed', safeQueueError(error).code); } }
		})
	);
}

// VS Code disposes the commands and controller in context.subscriptions.
export async function deactivate(): Promise<void> {
	await activeAssessment?.dispose(); activeWorkflow?.dispose(); activeWorkflow = undefined;
	await activeManagedCodex?.flush(); await activeManagedCodex?.dispose(); activeManagedCodex = undefined; activeRailsApi?.dispose(); activeRailsApi = undefined;
	await activeClaudeUi?.dispose(); activeClaudeUi = undefined;
	await activeUploads?.dispose(); activeUploads = undefined;
	const stoppedSession = activeRecording?.sessionId;
	activeRecording?.stop();
	activeLocalData?.dispose(); await activeLocalData?.flush(); activeLocalData = undefined;
	try {
		activeCodexReader?.dispose();
		await activeCodexReader?.flush();
		activeCodexReader = undefined;
		activeCodexParser?.dispose();
		await activeCodexParser?.flush();
		await activeClaudeParser?.flush();
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
		await activeClaudeParser?.finishRecording();
		activeClaudeParser?.dispose(); activeClaudeParser = undefined;
		await activeCorrelator?.finishSession(stoppedSession);
		activeCorrelator?.dispose();
		await activeCorrelator?.flush();
		activeCorrelator = undefined;
		await activePersistence?.completeSession(stoppedSession);
	} finally {
		try { await activePersistence?.close(); } catch { /* Persistence already reports a sanitized visible warning. */ }
		activePersistence = undefined;
		activeRecording = undefined;
		activeAssessment = undefined;
	}
}
