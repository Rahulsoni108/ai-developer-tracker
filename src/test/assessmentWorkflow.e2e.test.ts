import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { RecordingController } from '../recording';
import { AssessmentController, type AssessmentView } from '../assessmentController';
import { AssessmentConnectionStore, ASSESSMENT_METADATA_KEY, assessmentCredentialKey, type AssessmentMetadata } from '../assessmentStorage';
import { MockAssessmentApiClient, AssessmentApiError } from '../assessmentApiClient';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { LOCAL_QUEUE_FILENAME } from '../localEventQueue';
import { EventPersistence } from '../eventPersistence';
import { JsonlWriter } from '../jsonlWriter';
import { FileTracker, isExcludedPath } from '../fileTracker';
import { DiffTracker } from '../diffTracker';
import { CodexEventParser } from '../codexEventParser';
import { ClaudeEventParser } from '../claudeEventParser';
import { ClaudeCapture, type ClaudeLaunch } from '../claudeCapture';
import { forwardClaudeHook } from '../claudeHookBridge';
import { ActivityCorrelator } from '../activityCorrelator';
import { EventBatchManager } from '../eventBatchManager';
import { EventUploader, type UploadOutcome } from '../eventUploader';
import type { UploadHttpRequest, UploadHttpResponse } from '../httpsEventTransport';
import { createFileEvent, validateEvent, type TrackerEvent } from '../eventSchema';

function bounded<T>(operation: Promise<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Assessment integration fixture timed out.')), 5000);
		operation.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}
function deferred<T>() {
	let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
class FixtureWatcher implements vscode.FileSystemWatcher {
	private readonly creates = new vscode.EventEmitter<vscode.Uri>();
	private readonly changes = new vscode.EventEmitter<vscode.Uri>();
	private readonly deletes = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidCreate = this.creates.event; readonly onDidChange = this.changes.event; readonly onDidDelete = this.deletes.event;
	constructor(readonly ignoreCreateEvents = false, readonly ignoreChangeEvents = false, readonly ignoreDeleteEvents = false) {}
	dispose(): void { this.creates.dispose(); this.changes.dispose(); this.deletes.dispose(); }
}
interface BatchRequest { contractVersion: number; batchId: string; events: TrackerEvent[] }

suite('Assessment workflow integration and security E4.2', function () {
	this.timeout(15000);
	let root: string; let folder: vscode.WorkspaceFolder; let workspaceId: string; let queue: AsyncLocalEventQueue;
	let writer: EventPersistence; let recording: RecordingController; let assessment: AssessmentController; let server: MockAssessmentApiClient;
	let files: FileTracker; let diffs: DiffTracker; let codex: CodexEventParser; let claude: ClaudeEventParser; let capture: ClaudeCapture;
	let correlator: ActivityCorrelator; let observer: { dispose(): void }; let launch: ClaudeLaunch | undefined;
	let metadata: Map<string, unknown>; let secrets: Map<string, string>; let views: AssessmentView[]; let diagnostics: string[];
	let serverTime: number; let recordingConsent: boolean; let uploadConsent: boolean; let recordingPrompts: number; let uploadPrompts: number;
	let startRequests: number; let submitRequests: number; let sourceIndex: number; let authorized: boolean;
	let confirmUpload: () => Promise<boolean>; let uploaders: EventUploader[]; let received: BatchRequest[]; let accepted: Set<string>;
	let response: (body: BatchRequest) => UploadHttpResponse;
	const source = 'fixture-codex'; const fileId = 'a'.repeat(64); const code = 'DUMMY-ASSESSMENT-PAIR';
	const storage = () => vscode.Uri.file(join(root, 'queue'));
	const saved = () => metadata.get(ASSESSMENT_METADATA_KEY) as AssessmentMetadata;
	const makeStore = () => new AssessmentConnectionStore({ get: <T>(key: string, fallback?: T) => (metadata.get(key) ?? fallback) as T,
		update: async (key, value) => { metadata.set(key, structuredClone(value)); } }, {
		get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }
	});
	function ack(body: BatchRequest, ids = body.events.map(event => event.eventId)): UploadHttpResponse {
		for (const id of ids) { accepted.add(id); } server.setAcceptedEventCount('42', accepted.size);
		return { status: 200, contentType: 'application/json', body: JSON.stringify({ contractVersion: 1, batchId: body.batchId, durablyAcceptedEventIds: ids }) };
	}
	async function pipeline(): Promise<void> {
		launch = undefined; authorized = false;
		queue = await AsyncLocalEventQueue.open(storage(), [{ uri: folder.uri }], {}, { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); } });
		recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => { recordingPrompts++; return recordingConsent; });
		writer = new EventPersistence(queue, new JsonlWriter(join(root, 'diagnostics', 'safe.jsonl')), reason => diagnostics.push(reason));
		writer.attachRecording(recording, id => ({ approvedWorkspaceIds: [workspaceId], confirmedCodexSessions: [{ sourceSessionId: source, workspaceId }],
			codexContentConsent: codex?.hasAdmittedContentConsent(id) ?? false, confirmedClaudeSessions: claude.getApprovals(id),
			claudeContentConsent: claude.getApprovals(id).length > 0,
			resolveToolPath: path => path === join(folder.uri.fsPath, 'app.ts') ? 'app.ts' : undefined }));
		const host = { onDidChangeTextDocument: vscode.workspace.onDidChangeTextDocument, onDidSaveTextDocument: vscode.workspace.onDidSaveTextDocument,
			getWorkspaceFolder: (uri: vscode.Uri) => uri.fsPath.startsWith(folder.uri.fsPath + '/') ? folder : undefined,
			fs: vscode.workspace.fs, textDocuments: vscode.workspace.textDocuments,
			createFileSystemWatcher: (_pattern: vscode.GlobPattern, create?: boolean, change?: boolean, remove?: boolean) => new FixtureWatcher(create, change, remove) };
		files = new FileTracker(recording, writer, storage(), () => diagnostics.push('file_error'), host); await files.selectWorkspace(folder);
		diffs = new DiffTracker(recording, files, writer, () => diagnostics.push('diff_error'), { debounceMs: 50, maxCheckpointMs: 100 }, host);
		codex = new CodexEventParser(recording, {
			getRegistry: () => [{ recordingSessionId: recording.sessionId!, sourceSessionId: source, workspaceId, sourceFileId: fileId,
				sourceFileReference: 'codex-file:' + fileId, status: 'confirmed', reason: 'user_confirmed' }],
			isConfirmed: (file, local, session) => file === fileId && local === recording.sessionId && session === source
		}, writer, { isExcludedPath });
		claude = new ClaudeEventParser(recording, writer, reason => diagnostics.push(reason), join(root, 'transcripts'));
		capture = new ClaudeCapture(recording, claude, { storageDirectory: join(root, 'runtime'), bridgePath: require.resolve('../claudeHookBridge'), nodeExecutable: process.execPath,
			assertOutsideWorkspaces: async path => { assert.equal(path.startsWith(folder.uri.fsPath), false); } });
		correlator = new ActivityCorrelator(recording, writer, { approvedWorkspaces: () => [workspaceId], isExcludedPath });
		observer = writer.onDidWrite(event => correlator.observe(event));
		// Same registration order and drain operations as extension.ts; consent UI alone is injected.
		assessment = new AssessmentController(server, makeStore(), recording, {
			flushStopped: async id => { await drain(); await claude.finishRecording(); await correlator.finishSession(id); await writer.flush(); await writer.completeSession(id);
				if (writer.isDegraded) { throw new AssessmentApiError('storage'); } },
			getStatus: ids => queue.getSessionEvidenceStatus(ids), disableDevelopmentUploads: async () => { for (const uploader of uploaders) { await uploader.disable(); } }
		}, async host => { assert.equal(host, 'assessment.invalid'); uploadPrompts++; return confirmUpload(); }, view => views.push(view), 1000);
		await assessment.initialize();
	}
	async function drain(): Promise<void> {
		await bounded((async () => { await files.flush(); await diffs.flush(); await codex.flush(); await claude.flush(); await correlator.flush(); await writer.flush(); })());
	}
	async function close(): Promise<void> {
		for (const uploader of uploaders) { await uploader.dispose(); } uploaders = [];
		await assessment.dispose(); const id = recording.sessionId; recording.stop(); await capture.dispose();
		await drain(); await claude.finishRecording(); await correlator.finishSession(id); await writer.completeSession(id);
		observer.dispose(); files.dispose(); diffs.dispose(); codex.dispose(); claude.dispose(); correlator.dispose(); await writer.close(); recording.dispose();
	}
	async function start(): Promise<void> { await assessment.pair(code); await assessment.start(); await drain(); assert.equal(assessment.view.state, 'active'); }
	async function edit(text = 'export const sample = 1;\n', save = true): Promise<void> {
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, 'app.ts')); const change = new vscode.WorkspaceEdit();
		change.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
		assert.equal(await vscode.workspace.applyEdit(change), true); if (save) { assert.equal(await doc.save(), true); }
	}
	async function codexRecord(payload: Record<string, unknown>): Promise<void> {
		await codex.handle({ type: 'response_item', payload }, { sessionId: recording.sessionId!, sourceSessionId: source, workspaceId, sourceFileId: fileId,
			sourceFileReference: 'codex-file:' + fileId, recordIndex: ++sourceIndex, generation: 0, byteOffset: sourceIndex * 200, byteLength: 200 });
	}
	async function hook(kind: string, extra: Record<string, unknown> = {}): Promise<void> {
		await bounded(forwardClaudeHook(join(launch!.pluginDirectory, 'runtime.json'), Readable.from([JSON.stringify({ session_id: launch!.sourceSessionId,
			cwd: folder.uri.fsPath, hook_event_name: kind, ...extra })])));
	}
	async function collect(): Promise<void> {
		codex.grantContentConsent(recording.sessionId!);
		await codexRecord({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fixture prompt password="dummy-codex-secret"' }] });
		await codexRecord({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture response' }] });
		await codexRecord({ type: 'function_call', name: 'shell', call_id: 'codex-tool', arguments: JSON.stringify({ command: 'DO_NOT_EXECUTE_FIXTURE' }) });
		await codexRecord({ type: 'function_call_output', call_id: 'codex-tool', output: 'Fixture tool output' });
		// Explicit source-session approval is separate from assessment/recording/upload consent.
		launch = await capture.create(folder.uri.fsPath, workspaceId); await hook('SessionStart');
		await hook('UserPromptSubmit', { prompt_id: 'claude-prompt', prompt: 'Fixture prompt Authorization: Bearer dummy-claude-secret' });
		await hook('PreToolUse', { tool_use_id: 'claude-tool', tool_name: 'Edit', tool_input: { file_path: join(folder.uri.fsPath, 'app.ts'), old_string: '0', new_string: '1' } });
		await edit(); await hook('PostToolUse', { tool_use_id: 'claude-tool', tool_name: 'Edit', tool_response: { success: true } });
		await hook('Stop', { last_assistant_message: 'Fixture Claude response' }); await drain();
	}
	/** Test-only future delivery adapter. Production assessment delivery intentionally remains disconnected. */
	async function uploader(development = false): Promise<EventUploader> {
		const token = await makeStore().getCredential(saved().credentialId); assert.ok(token);
		const driver = new EventUploader(new EventBatchManager(queue), queue, { get: async () => token }, {
			endpoint: saved().connection.uploadEndpoint, baseDelayMs: 60000, maxDelayMs: 60000,
			confirmUpload: async () => assessment.view.uploadConsent,
			privacyContext: event => (development ? assessment.allowsDevelopmentUpload(event.sessionId) : assessment.isAssociatedSession(event.sessionId))
				? writer.getUploadPrivacyContext(event) : undefined
		}, { send: async (request: UploadHttpRequest) => {
			assert.equal(request.token, token); assert.equal(request.endpoint.href, saved().connection.uploadEndpoint);
			const body = JSON.parse(request.body) as BatchRequest; received.push(body); return response(body);
		} });
		uploaders.push(driver); assert.equal(await driver.enable(), assessment.view.uploadConsent); return driver;
	}
	async function deliver(development = false): Promise<UploadOutcome> { return bounded((await uploader(development)).uploadOnce()); }
	function retryNow(): void {
		// Advance only the test scheduler, never acknowledgment, ownership, evidence or privacy proofs.
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		try { db.exec('UPDATE upload_retry_state SET next_attempt_at = 0'); } finally { db.close(); }
	}

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'ai-assessment-e42-')); await mkdir(join(root, 'workspace')); await mkdir(join(root, 'transcripts'));
		await writeFile(join(root, 'workspace', 'app.ts'), 'export const sample = 0;\n');
		folder = { uri: vscode.Uri.file(join(root, 'workspace')), name: 'assessment-fixture', index: 0 };
		workspaceId = createHash('sha256').update(folder.uri.toString()).digest('hex'); metadata = new Map(); secrets = new Map(); views = []; diagnostics = [];
		recordingConsent = true; uploadConsent = true; recordingPrompts = 0; uploadPrompts = 0; startRequests = 0; submitRequests = 0; sourceIndex = 0;
		uploaders = []; received = []; accepted = new Set(); serverTime = Date.parse('2030-01-01T10:00:00.000Z'); confirmUpload = async () => uploadConsent;
		server = new MockAssessmentApiClient(() => new Date(serverTime)); server.seedInvitation(code, '42');
		const authorize = server.startOrResume.bind(server); server.startOrResume = async (...args) => {
			startRequests++; assert.equal(recording.isRecording, false); const result = await authorize(...args); authorized = true; return result;
		};
		const submit = server.submit.bind(server); server.submit = async (...args) => {
			submitRequests++; assert.equal(recording.isRecording, false);
			assert.equal((await queue.getSessionEvidenceStatus(saved().localRecordingSessionIds)).pendingEvents, 0); return submit(...args);
		};
		response = body => ack(body); await pipeline();
	});
	teardown(async () => { await close(); await rm(root, { recursive: true, force: true }); });

	test('pair -> independent consents -> Rails start -> real collectors -> encrypted SQLite -> explicit acknowledgments -> finalize', async () => {
		assert.equal(await queue.getPendingCount(), 0); await start(); assert.equal(authorized, true); const local = recording.sessionId!;
		assert.equal(assessment.view.remainingMsAtLastCheck, 3600000); // Server clock deliberately differs from the host clock.
		assert.equal(recordingPrompts, 1); assert.equal(uploadPrompts, 1); assert.notEqual(local, '42'); await collect();
		await assessment.stopAndSubmit(); assert.equal(assessment.view.state, 'submission_pending'); assert.equal(submitRequests, 0);
		const pending = await queue.getPending(100); const types = new Set(pending.map(event => event.eventType));
		for (const type of ['file.baseline', 'file.modified', 'file.saved', 'file.diff', 'ai.prompt.submitted', 'ai.response.completed', 'ai.tool.started', 'ai.tool.completed', 'ai.session.started']) { assert.ok(types.has(type as TrackerEvent['eventType'])); }
		for (const event of pending) { assert.equal(event.sessionId, local); assert.equal(validateEvent(event).valid, true); }
		assert.ok(pending.some(event => event.source === 'codex')); assert.ok(pending.some(event => event.source === 'claude'));
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME), { readOnly: true });
		try { for (const row of db.prepare('SELECT payload_format, event_json FROM queued_events').all()) {
			assert.equal(row.payload_format, 1); assert.equal(JSON.parse(String(row.event_json)).algorithm, 'AES-256-GCM'); assert.equal(String(row.event_json).includes('Fixture prompt'), false);
		} } finally { db.close(); }
		assert.equal(await deliver(), 'delivered'); assert.deepEqual(received[0].events, pending);
		assert.deepEqual(Object.keys(received[0]).sort(), ['batchId', 'contractVersion', 'events']);
		const transmitted = JSON.stringify(received); for (const secret of ['dummy-codex-secret', 'dummy-claude-secret', code]) { assert.equal(transmitted.includes(secret), false); }
		assert.equal(await queue.getPendingCount(), 0); await assessment.stopAndSubmit(); assert.equal(assessment.view.state, 'submitted'); assert.equal(submitRequests, 1);
		const safeLogs = await readFile(join(root, 'diagnostics', 'safe.jsonl'), 'utf8'); assert.equal(safeLogs.includes('Fixture prompt'), false); assert.equal(safeLogs.includes(root), false);
		assert.deepEqual(diagnostics, []);
	});

	test('partial acknowledgment preserves the remainder and blocks finalize until every event is durably accepted', async () => {
		await start(); await collect(); await assessment.stopAndSubmit(); const original = await queue.getPending(100);
		response = body => ack(body, [body.events[0].eventId]); const driver = await uploader(); assert.equal(await driver.uploadOnce(), 'retry');
		assert.deepEqual(await queue.getPending(100), original.slice(1)); await assessment.stopAndSubmit(); assert.equal(submitRequests, 0);
		response = body => ack(body); retryNow(); assert.equal(await driver.uploadOnce(), 'delivered');
		assert.deepEqual(received[1].events, original.slice(1)); await assessment.stopAndSubmit(); assert.equal(assessment.view.state, 'submitted');
	});

	for (const invalid of ['missing acknowledgment', 'Rails data envelope', 'wrong batch', 'unknown event ID']) {
		test(`contract rejects ${invalid} without acknowledging or finalizing`, async () => {
			await start(); await assessment.stopAndSubmit(); const pending = await queue.getPending(100);
			response = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(invalid === 'missing acknowledgment' ? { ok: true }
				: invalid === 'Rails data envelope' ? { data: { contractVersion: 1, batchId: body.batchId, durablyAcceptedEventIds: body.events.map(event => event.eventId) } }
					: { contractVersion: 1, batchId: invalid === 'wrong batch' ? randomUUID() : body.batchId, durablyAcceptedEventIds: [randomUUID()] }) });
			assert.equal(await deliver(), 'protocol'); assert.deepEqual(await queue.getPending(100), pending);
			await assessment.stopAndSubmit(); assert.equal(assessment.view.state, 'submission_pending'); assert.equal(submitRequests, 0);
		});
	}

	for (const failure of ['invalid', 'expired', 'reused']) {
		test(`${failure} pairing code creates no recording or persistent assessment identity`, async () => {
			if (failure === 'expired') { server.pair = async () => { throw new AssessmentApiError('session_ended'); }; }
			if (failure === 'reused') { await server.pair(code, new AbortController().signal); }
			await assessment.pair(failure === 'invalid' ? 'INVALID-CODE' : code); await assessment.start();
			assert.equal(recording.isRecording, false); assert.equal(await queue.getPendingCount(), 0); assert.equal(metadata.size, 0); assert.equal(startRequests, 0);
		});
	}

	for (const kind of ['recording', 'upload']) {
		test(`missing ${kind} consent never authorizes the start or captures collector events`, async () => {
			await assessment.pair(code); if (kind === 'recording') { recordingConsent = false; } else { uploadConsent = false; }
			await assessment.start(); await drain(); assert.equal(startRequests, 0); assert.equal(recording.isRecording, false);
			assert.equal(await queue.getPendingCount(), 0); assert.equal(received.length, 0);
		});
	}

	test('unauthorized or revoked credentials stop capture, retain evidence and cannot submit', async () => {
		await start(); await collect(); const pending = await queue.getPending(100); const key = assessmentCredentialKey(saved().credentialId);
		secrets.set(key, 'revoked-dummy-credential'); await assessment.showStatus();
		assert.equal(recording.isRecording, false); assert.equal(assessment.view.reason, 'authentication');
		assert.deepEqual(await queue.getPending(100), pending); await assessment.stopAndSubmit(); assert.notEqual(assessment.view.state, 'submitted'); assert.equal(submitRequests, 0);
		secrets.delete(key); await assessment.showStatus(); assert.equal(assessment.view.reason, 'authentication');
	});

	test('duplicate Starts share one authorization and one immutable server deadline', async () => {
		await assessment.pair(code); const first = assessment.start(); assert.equal(first, assessment.start()); await first; await assessment.start(); await drain();
		assert.equal(startRequests, 1); assert.equal(recordingPrompts, 1); assert.equal(uploadPrompts, 1);
		assert.equal(saved().localRecordingSessionIds.length, 1); assert.equal(assessment.view.deadline, '2030-01-01T11:00:00.000Z');
	});

	test('lost start response is recovered without capturing prematurely or resetting the timer', async () => {
		const authorize = server.startOrResume.bind(server); server.startOrResume = async (...args) => { await authorize(...args); throw new Error('PRIVATE_START_RESPONSE'); };
		await assessment.pair(code); await assessment.start(); await drain(); assert.equal(await queue.getPendingCount(), 0); assert.equal(recording.isRecording, false);
		server.startOrResume = authorize; serverTime += 60000; await assessment.start(); await drain();
		assert.equal(assessment.view.state, 'active'); assert.equal(assessment.view.deadline, '2030-01-01T11:00:00.000Z');
		assert.equal(JSON.stringify(views).includes('PRIVATE_START_RESPONSE'), false);
	});

	test('lost finalize response remains pending and server-status recovery cannot acknowledge additional evidence', async () => {
		await start(); await collect(); await assessment.stopAndSubmit(); assert.equal(await deliver(), 'delivered');
		const finalize = server.submit.bind(server); server.submit = async (...args) => { await finalize(...args); throw new Error('PRIVATE_FINALIZE_RESPONSE'); };
		const idempotencyKey = saved().submitRequestId; await assessment.stopAndSubmit(); assert.equal(assessment.view.state, 'submission_pending');
		server.submit = finalize; await assessment.showStatus(); assert.equal(assessment.view.state, 'submitted'); assert.equal(saved().submitRequestId, idempotencyKey);
		assert.equal(JSON.stringify(views).includes('PRIVATE_FINALIZE_RESPONSE'), false);
	});

	test('network failure before finalization commits preserves the stable retry key and all delivery bookkeeping', async () => {
		await start(); await collect(); await assessment.stopAndSubmit(); assert.equal(await deliver(), 'delivered');
		const finalize = server.submit.bind(server); const key = saved().submitRequestId; const delivery = await queue.getDeliveryStatus();
		server.submit = async () => { throw new Error('PRIVATE_OFFLINE_ERROR'); }; await assessment.stopAndSubmit();
		assert.equal(assessment.view.state, 'submission_pending'); assert.equal(recording.isRecording, false);
		assert.deepEqual(await queue.getDeliveryStatus(), delivery); server.submit = finalize; await assessment.stopAndSubmit();
		assert.equal(assessment.view.state, 'submitted'); assert.equal(saved().submitRequestId, key);
	});

	test('authentication rejection at event delivery retains every pending event and prevents finalization', async () => {
		await start(); await collect(); await assessment.stopAndSubmit(); const pending = await queue.getPending(100);
		response = () => ({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' });
		assert.equal(await deliver(), 'authentication'); assert.deepEqual(await queue.getPending(100), pending);
		await assessment.stopAndSubmit(); assert.equal(assessment.view.state, 'submission_pending'); assert.equal(submitRequests, 0);
	});

	test('deadline expiry stops/drains collectors and neither reconnect nor a changed deadline can restart the timer', async () => {
		await start(); await collect(); const deadline = assessment.view.deadline; const getStatus = server.getStatus.bind(server);
		server.getStatus = async (...args) => ({ ...await getStatus(...args), deadline: '2030-01-01T12:00:00.000Z' });
		await assessment.showStatus(); assert.equal(assessment.view.reason, 'protocol'); assert.equal(recording.isRecording, false); assert.equal(assessment.view.deadline, deadline);
		server.getStatus = getStatus; serverTime += 3600001; await assessment.start(); assert.equal(recording.isRecording, false); assert.equal(startRequests, 1);
		await assessment.stopAndSubmit(); assert.notEqual(assessment.view.state, 'submitted'); assert.equal(submitRequests, 0);
	});

	test('restart retains encrypted evidence and Rails identity but requires fresh capture consent and blocks historical upload proofs', async () => {
		await start(); await collect(); const retained = await queue.getPending(100); const deadline = assessment.view.deadline; const local = recording.sessionId;
		await close(); await pipeline(); assert.equal(recording.isRecording, false); assert.equal(assessment.view.state, 'recovery'); assert.equal(assessment.view.uploadConsent, false);
		assert.equal(saved().connection.codingSessionId, '42'); assert.equal(assessment.view.deadline, deadline);
		await assessment.start(); await drain(); assert.equal(recordingPrompts, 2); assert.equal(uploadPrompts, 2); assert.notEqual(recording.sessionId, local);
		assert.equal(writer.getUploadPrivacyContext(retained[0]), undefined); assert.equal(await deliver(), 'privacy'); assert.equal(received.length, 0);
		await assessment.stopAndSubmit(); assert.equal(assessment.view.state, 'submission_pending'); assert.equal(submitRequests, 0);
	});

	test('wrong Rails session association is rejected without releasing evidence to any transport', async () => {
		await start(); await collect(); const getStatus = server.getStatus.bind(server);
		server.getStatus = async (...args) => ({ ...await getStatus(...args), codingSessionId: '99' }); await assessment.showStatus();
		assert.equal(assessment.view.reason, 'protocol'); assert.equal(recording.isRecording, false); assert.equal(saved().connection.codingSessionId, '42');
		assert.equal(await deliver(true), 'disabled'); assert.equal(received.length, 0); assert.ok(await queue.getPendingCount());
	});

	test('another assessment with its own valid privacy approval cannot cross the current delivery boundary', async () => {
		await start(); await assessment.stopAndSubmit(); const otherId = randomUUID();
		const other = createFileEvent({ sessionId: otherId, source: 'vscode', workspaceId, eventType: 'file.saved', payload: { relativePath: 'other.ts' } });
		const otherWriter = new EventPersistence(queue, { write: async () => {}, flush: async () => {} }, () => {}, { context: () => ({ recordingActive: true,
			sessionId: otherId, approvedWorkspaceIds: [workspaceId], confirmedCodexSessions: [], codexContentConsent: false }) });
		await otherWriter.write(other); assert.ok(otherWriter.getUploadPrivacyContext(other));
		// Both proofs are real. The assessment/session check must reject the entire overlapping global batch.
		const token = await makeStore().getCredential(saved().credentialId);
		const driver = new EventUploader(new EventBatchManager(queue), queue, { get: async () => token }, { endpoint: saved().connection.uploadEndpoint,
			confirmUpload: async () => true, privacyContext: event => assessment.isAssociatedSession(event.sessionId)
				? writer.getUploadPrivacyContext(event) ?? otherWriter.getUploadPrivacyContext(event) : undefined },
		{ send: async () => { assert.fail('Cross-assessment batch reached transport.'); } });
		uploaders.push(driver); assert.equal(await driver.enable(), true); assert.equal(await driver.uploadOnce(), 'privacy');
		assert.ok((await queue.getPending(100)).some(event => event.eventId === other.eventId)); assert.equal(received.length, 0);
	});

	test('generic development uploader refuses assessment evidence while manual recording and both AI adapters still work independently', async () => {
		await start(); await collect(); await assessment.stopAndSubmit(); const original = await queue.getPending(100);
		assert.equal(await deliver(true), 'privacy'); assert.equal(received.length, 0); assert.deepEqual(await queue.getPending(100), original);
		await recording.start(); await collect(); const manual = recording.sessionId!; recording.stop(); await drain(); await writer.completeSession(manual);
		const manualEvents = (await queue.getPending(100)).filter(event => event.sessionId === manual);
		for (const source of ['vscode', 'codex', 'claude']) { assert.ok(manualEvents.some(event => event.source === source)); }
		assert.equal(assessment.isAssociatedSession(manual), false); assert.equal(assessment.allowsDevelopmentUpload(manual), true);
	});

	test('withdrawal while a finalize-consent dialog is open cannot be overwritten by a late approval', async () => {
		await start(); await assessment.stopAndSubmit(); assert.equal(await deliver(), 'delivered'); assessment.revokeUploadConsent();
		const opened = deferred<void>(); const approval = deferred<boolean>(); confirmUpload = () => { opened.resolve(); return approval.promise; };
		const submitting = assessment.stopAndSubmit(); await bounded(opened.promise); assessment.revokeUploadConsent(); approval.resolve(true); await bounded(submitting);
		assert.equal(submitRequests, 0); assert.notEqual(assessment.view.state, 'submitted'); assert.equal(assessment.view.uploadConsent, false);
	});

	test('server responses cannot silently remove a previously confirmed recording binding', async () => {
		await start(); const getStatus = server.getStatus.bind(server);
		server.getStatus = async (...args) => ({ ...await getStatus(...args), localRecordingSessionIds: [] });
		await assessment.showStatus(); assert.equal(assessment.view.reason, 'protocol'); assert.equal(recording.isRecording, false);
		assert.equal(saved().localRecordingSessionIds.length, 1); assert.equal(saved().serverStatus.localRecordingSessionIds.length, 1); assert.equal(received.length, 0);
	});
});

suite('Assessment proposed Rails contract examples', () => {
	test('documented batch contains valid normalized objects and its acknowledgment is flat and scoped to original event IDs', async () => {
		const document = await readFile(join(__dirname, '..', '..', 'docs', 'assessment-workflow.md'), 'utf8');
		const examples = [...document.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
		const request = examples.find(value => value.contractVersion === 1 && Array.isArray(value.events)) as BatchRequest;
		const acknowledgment = examples.find(value => value.contractVersion === 1 && Array.isArray(value.durablyAcceptedEventIds));
		assert.ok(request && acknowledgment); assert.deepEqual(Object.keys(acknowledgment).sort(), ['batchId', 'contractVersion', 'durablyAcceptedEventIds']);
		assert.equal(acknowledgment.batchId, request.batchId); assert.ok(request.events.length);
		for (const event of request.events) { assert.equal(typeof event, 'object'); assert.equal(validateEvent(event).valid, true); }
		for (const id of acknowledgment.durablyAcceptedEventIds) { assert.ok(request.events.some(event => event.eventId === id)); }
		const start = examples.find(value => value.data?.state === 'active');
		assert.ok(start.data.local_recording_session_ids.includes(request.events[0].sessionId));
	});
});
