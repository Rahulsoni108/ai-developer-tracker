import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { RecordingController } from '../recording';
import { FileTracker, isExcludedPath } from '../fileTracker';
import { DiffTracker } from '../diffTracker';
import { CodexEventParser } from '../codexEventParser';
import type { CodexRecordContext } from '../codexJsonlReader';
import { EventPersistence } from '../eventPersistence';
import { JsonlWriter } from '../jsonlWriter';
import { EventBatchManager } from '../eventBatchManager';
import { EventUploader, UPLOAD_TOKEN_SECRET, type UploadOutcome } from '../eventUploader';
import { HttpsEventTransport } from '../httpsEventTransport';
import { UploadController, type UploadSettings } from '../uploadController';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { LOCAL_QUEUE_FILENAME } from '../localEventQueue';
import { validateEvent, type TrackerEvent } from '../eventSchema';

interface RequestBody { contractVersion: number; batchId: string; events: TrackerEvent[] }
const WAIT_MS = 5000;
function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('E2E timeout: ' + label)), WAIT_MS);
		promise.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}
class IsolatedWatcher implements vscode.FileSystemWatcher {
	private readonly creates = new vscode.EventEmitter<vscode.Uri>();
	private readonly changes = new vscode.EventEmitter<vscode.Uri>();
	private readonly deletes = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidCreate = this.creates.event;
	readonly onDidChange = this.changes.event;
	readonly onDidDelete = this.deletes.event;
	constructor(readonly ignoreCreateEvents = false, readonly ignoreChangeEvents = false, readonly ignoreDeleteEvents = false) {}
	dispose(): void { this.creates.dispose(); this.changes.dispose(); this.deletes.dispose(); }
}

suite('Recording to HTTPS upload end-to-end', function () {
	this.timeout(15000);
	let fixture: string; let certificate: string; let privateKey: string;
	let root: string; let folder: vscode.WorkspaceFolder; let workspaceId: string; let server: Server;
	let queue: AsyncLocalEventQueue; let persistence: EventPersistence; let recording: RecordingController;
	let files: FileTracker; let diffs: DiffTracker; let parser: CodexEventParser;
	let controller: UploadController; let uploader: EventUploader; let firstAttempt: Promise<UploadOutcome> | undefined;
	let settings: UploadSettings; let consent: boolean; let consentRequests: number; let recordConsentRequests: number;
	let endpoint: string; let received: RequestBody[]; let destinations: string[];
	let accepted: Set<string>; let requests: EventEmitter; let errors: string[]; let editIndex: number; let recordIndex: number;
	let respond: (req: IncomingMessage, res: ServerResponse, body: RequestBody) => void | Promise<void>;
	let secrets: Map<string, string>;
	const storage = () => ({ scheme: 'file', fsPath: join(root, 'queue') });
	const sourceSessionId = 'dummy-confirmed-codex-session';
	const sourceReference = 'codex-file:' + 'a'.repeat(64);
	const sourceFileId = 'a'.repeat(64);

	async function durablyAccept(ids: string[]): Promise<void> {
		for (const id of ids) { accepted.add(id); }
		// Mock stores only original event IDs. Commit/fsync before advertising durable acceptance.
		const journal = await open(join(root, 'mock-accepted-ids.json'), 'w', 0o600);
		try { await journal.writeFile(JSON.stringify([...accepted])); await journal.sync(); } finally { await journal.close(); }
	}
	async function acknowledge(res: ServerResponse, body: RequestBody, ids = body.events.map(event => event.eventId)): Promise<void> {
		await durablyAccept(ids);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ contractVersion: 1, batchId: body.batchId, durablyAcceptedEventIds: ids }));
	}
	async function listen(port = 0): Promise<void> {
		await bounded(new Promise<void>((resolve, reject) => {
			server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
		}), 'mock server startup');
	}
	async function stopServer(): Promise<void> {
		server.closeAllConnections();
		if (server.listening) { await bounded(new Promise<void>(resolve => server.close(() => resolve())), 'mock server shutdown'); }
	}
	async function makePipeline(): Promise<void> {
		queue = await AsyncLocalEventQueue.open(storage(), [{ uri: folder.uri }], {}, {
			get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }
		});
		recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => { recordConsentRequests++; return true; });
		persistence = new EventPersistence(queue, new JsonlWriter(join(root, 'diagnostics', 'safe.jsonl')),
			reason => { if (reason === 'queue_failed') { errors.push(reason); } });
		persistence.attachRecording(recording, () => ({ approvedWorkspaceIds: [workspaceId],
			confirmedCodexSessions: [{ sourceSessionId, workspaceId }], codexContentConsent: parser?.hasAdmittedContentConsent(recording.sessionId ?? '') ?? false,
			resolveToolPath: path => path === join(folder.uri.fsPath, 'app.ts') ? 'app.ts' : undefined }));
		const workspace = {
			onDidChangeTextDocument: vscode.workspace.onDidChangeTextDocument,
			onDidSaveTextDocument: vscode.workspace.onDidSaveTextDocument,
			getWorkspaceFolder: (uri: vscode.Uri) => uri.fsPath.startsWith(folder.uri.fsPath + '/') ? folder : undefined,
			fs: vscode.workspace.fs, textDocuments: vscode.workspace.textDocuments,
			createFileSystemWatcher: (_pattern: vscode.GlobPattern, create?: boolean, change?: boolean, remove?: boolean) => new IsolatedWatcher(create, change, remove)
		};
		files = new FileTracker(recording, persistence, vscode.Uri.file(storage().fsPath), () => errors.push('file_error'), workspace);
		await files.selectWorkspace(folder);
		diffs = new DiffTracker(recording, files, persistence, () => errors.push('diff_error'), { debounceMs: 50, maxCheckpointMs: 100 }, workspace);
		parser = new CodexEventParser(recording, {
			getRegistry: () => [{ recordingSessionId: recording.sessionId!, sourceSessionId, workspaceId, sourceFileId,
				sourceFileReference: sourceReference, status: 'confirmed', reason: 'user_confirmed' }],
			isConfirmed: (file, session, source) => file === sourceFileId && session === recording.sessionId && source === sourceSessionId
		}, persistence, { isExcludedPath });
		controller = new UploadController(queue, {
			get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); }
		}, {
			readSettings: () => ({ ...settings }), writeEnabled: async enabled => { settings.enabled = enabled; },
			writeEndpoint: async endpoint => { settings.endpoint = endpoint; }, requestEndpoint: async () => undefined,
			requestAuthenticationAction: async () => undefined, requestToken: async () => undefined,
			confirmUpload: async hostname => { assert.equal(hostname, '127.0.0.1'); consentRequests++; return consent; }, notice: () => {}
		}, (config, hooks) => {
			uploader = new EventUploader(new EventBatchManager(queue), queue, { get: async key => secrets.get(key) },
				{ ...config, ...hooks, baseDelayMs: 60000, maxDelayMs: 60000, privacyContext: event => persistence.getUploadPrivacyContext(event) },
				new HttpsEventTransport(certificate)); // Trust only this test's private client agent.
			// Backoff is 30–60 seconds, beyond bounded test waits; advance attempts explicitly without sleeping.
			// Advance one real attempt per test step, avoiding wall-clock jitter/scheduler dependence.
			return { enable: () => uploader.enable(), start: () => { firstAttempt = uploader.uploadOnce(); }, dispose: () => uploader.dispose() };
		});
		await controller.initialize();
	}
	async function drainCapture(): Promise<void> { await files.flush(); await diffs.flush(); await parser.flush(); await persistence.flush(); }
	async function closePipeline(): Promise<void> {
		await controller?.dispose(); const session = recording?.sessionId; recording?.stop();
		files?.dispose(); diffs?.dispose(); parser?.dispose();
		if (persistence) { await drainCapture(); await persistence.completeSession(session); await persistence.close(); }
		recording?.dispose();
	}
	async function capture(text = `export const sample = ${++editIndex};\n`): Promise<TrackerEvent[]> {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, 'app.ts'));
		const edit = new vscode.WorkspaceEdit(); edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
		assert.equal(await vscode.workspace.applyEdit(edit), true); assert.equal(await document.save(), true);
		await bounded(drainCapture(), 'recording commit');
		assert.deepEqual(errors, []); return queue.getPending(100);
	}
	async function enableUpload(): Promise<UploadOutcome> {
		firstAttempt = undefined; assert.equal(await controller.enable(), true); assert.ok(firstAttempt);
		return bounded(firstAttempt, 'initial upload attempt');
	}
	function retryNow(): void {
		// Test-only scheduling control. Never changes ownership, payloads, acknowledgments or approval proofs.
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		try { db.exec('UPDATE upload_retry_state SET next_attempt_at = 0'); } finally { db.close(); }
	}
	function nextRequest(): Promise<RequestBody> {
		return bounded(new Promise(resolve => requests.once('received', resolve)), 'request arrival');
	}
	async function assertPending(expected: TrackerEvent[]): Promise<void> {
		assert.deepEqual(await queue.getPending(100), expected); assert.equal(await queue.getPendingCount(), expected.length);
		assert.equal((await queue.getDeliveryStatus()).claimedEvents, 0);
	}
	function sourceContext(): CodexRecordContext {
		return { sessionId: recording.sessionId!, sourceSessionId, workspaceId, sourceFileId, sourceFileReference: sourceReference,
			recordIndex: ++recordIndex, generation: 0, byteOffset: recordIndex * 200, byteLength: 200, timestamp: new Date().toISOString() };
	}

	suiteSetup(async () => {
		fixture = await mkdtemp(join(tmpdir(), 'ai-e2e-ca-'));
		await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
			'-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(fixture, 'key.pem'), '-out', join(fixture, 'cert.pem')], { timeout: WAIT_MS });
		certificate = await readFile(join(fixture, 'cert.pem'), 'utf8'); privateKey = await readFile(join(fixture, 'key.pem'), 'utf8');
	});
	suiteTeardown(async () => { await rm(fixture, { recursive: true, force: true }); });
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'ai-upload-e2e-')); await mkdir(join(root, 'workspace'));
		await writeFile(join(root, 'workspace', 'app.ts'), 'export const sample = 0;\n');
		folder = { uri: vscode.Uri.file(join(root, 'workspace')), name: 'isolated-workspace', index: 0 };
		workspaceId = createHash('sha256').update(folder.uri.toString()).digest('hex');
		received = []; destinations = []; accepted = new Set(); requests = new EventEmitter(); errors = [];
		editIndex = 0; recordIndex = 0; consent = true; consentRequests = 0; recordConsentRequests = 0; firstAttempt = undefined;
		secrets = new Map([[UPLOAD_TOKEN_SECRET, 'dummy-upload-auth-token']]);
		respond = (_req, res, body) => acknowledge(res, body);
		server = createServer({ key: privateKey, cert: certificate }, (req, res) => {
			const chunks: Buffer[] = []; let bytes = 0;
			req.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) { req.destroy(); } else { chunks.push(chunk); } });
			req.on('end', () => {
				try {
					assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, 'Bearer dummy-upload-auth-token');
					const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestBody;
					received.push(body); destinations.push(req.url ?? ''); requests.emit('received', body);
					void Promise.resolve(respond(req, res, body)).catch(() => { errors.push('mock_response_error'); res.destroy(); });
				} catch { errors.push('mock_request_error'); res.destroy(); }
			});
		});
		await listen(); endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
		settings = { endpoint, enabled: false, maxEvents: 100, maxBytes: 1048576, timeoutMs: 3000 };
		await makePipeline(); await recording.start(); parser.grantContentConsent(recording.sessionId!); await drainCapture();
	});
	teardown(async () => {
		await closePipeline(); await stopServer(); requests.removeAllListeners(); await rm(root, { recursive: true, force: true });
	});

	test('records real editor/save/diff events, encrypts SQLite, sends only normalized evidence and commits explicit delivery', async () => {
		const expected = await capture(); assert.ok(expected.some(event => event.eventType === 'file.saved'));
		assert.ok(expected.some(event => event.eventType === 'file.diff')); assert.ok(expected.some(event => event.eventType === 'file.baseline'));
		for (const event of expected) { assert.equal(validateEvent(event).valid, true); assert.equal(event.sessionId, recording.sessionId); }
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		try {
			for (const row of db.prepare('SELECT event_json, payload_format FROM queued_events WHERE acknowledged = 0').all()) {
				assert.equal(row.payload_format, 1); const envelope = JSON.parse(String(row.event_json));
				assert.equal(envelope.algorithm, 'AES-256-GCM'); assert.equal(String(row.event_json).includes('export const sample'), false);
			}
		} finally { db.close(); }
		assert.equal(consentRequests, 0); assert.equal(await enableUpload(), 'delivered');
		assert.deepEqual(received[0].events, expected); assert.equal(received[0].contractVersion, 1);
		assert.deepEqual(await queue.getDeliveryStatus(), { pendingEvents: 0, claimedEvents: 0, availableEvents: 0,
			activeBatches: 0, deliveredBatches: 1, releasedBatches: 0, recoveredBatches: 0 });
		assert.deepEqual(JSON.parse(await readFile(join(root, 'mock-accepted-ids.json'), 'utf8')), expected.map(event => event.eventId));
		assert.equal(recording.isRecording, true); assert.equal(recordConsentRequests, 1); assert.equal(consentRequests, 1);
	});

	test('partial durable acknowledgment preserves FIFO remainder and original event/session IDs on retry', async () => {
		const expected = await capture(); respond = (_req, res, body) => acknowledge(res, body, [body.events[0].eventId]);
		assert.equal(await enableUpload(), 'retry'); await assertPending(expected.slice(1));
		assert.equal(await uploader.uploadOnce(), 'waiting'); respond = (_req, res, body) => acknowledge(res, body);
		retryNow(); assert.equal(await uploader.uploadOnce(), 'delivered'); assert.deepEqual(received[1].events, expected.slice(1));
		assert.notEqual(received[0].batchId, received[1].batchId); await assertPending([]);
	});

	test('HTTP 200 without explicit durable IDs pauses without acknowledging any event', async () => {
		const expected = await capture(); respond = (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); };
		assert.equal(await enableUpload(), 'protocol'); await assertPending(expected);
		assert.equal((await controller.showStatus()).pauseReason, 'protocol'); assert.equal(accepted.size, 0);
	});
	for (const status of [429, 500, 503]) {
		test(`HTTP ${status} retains evidence, honors bounded Retry-After and recovers with explicit acknowledgment`, async () => {
			const expected = await capture(); respond = (_req, res) => { res.writeHead(status, { 'Retry-After': '60' }); res.end(); };
			const beforeAttempt = Date.now();
			assert.equal(await enableUpload(), 'retry'); await assertPending(expected);
			const state = (await queue.getUploadRetryState())!; assert.equal(state.attempts, 1); assert.ok(state.nextAttemptAt >= beforeAttempt + 60000);
			assert.ok(state.nextAttemptAt <= Date.now() + 60000);
			assert.equal(await uploader.uploadOnce(), 'waiting'); assert.equal(received.length, 1);
			respond = (_req, res, body) => acknowledge(res, body); retryNow(); assert.equal(await uploader.uploadOnce(), 'delivered');
			assert.deepEqual(received[1].events, expected); await assertPending([]);
		});
	}

	test('lost response after durable acceptance safely redelivers original IDs and mock deduplicates them', async () => {
		const expected = await capture(); respond = async (req, _res, body) => { await durablyAccept(body.events.map(event => event.eventId)); req.socket.destroy(); };
		assert.equal(await enableUpload(), 'retry'); await assertPending(expected); assert.equal(accepted.size, expected.length);
		respond = (_req, res, body) => acknowledge(res, body); retryNow(); assert.equal(await uploader.uploadOnce(), 'delivered');
		assert.deepEqual(received[0].events, received[1].events); assert.notEqual(received[0].batchId, received[1].batchId);
		assert.equal(accepted.size, expected.length); await assertPending([]);
		for (const event of expected) { await queue.enqueue(event); } await assertPending([]);
	});

	test('authentication rejection pauses safely while subsequent recording commits remain independent', async () => {
		await capture(); respond = (_req, res) => { res.writeHead(401); res.end(); };
		assert.equal(await enableUpload(), 'authentication'); const expected = await capture(); await assertPending(expected);
		assert.equal(recording.isRecording, true); assert.equal(await uploader.uploadOnce(), 'authentication'); assert.equal(received.length, 1);
	});

	test('upload consent revocation cancels a slow request, releases claims and never stops recording', async () => {
		const expected = await capture(); respond = () => { /* Slow/unresponsive server: held until cancellation. */ };
		const arriving = nextRequest(); const enabling = controller.enable(); assert.equal(await enabling, true); await arriving;
		const session = recording.sessionId; const afterEdit = await capture(); assert.ok(afterEdit.length > expected.length);
		await bounded(controller.disable(), 'consent revocation'); assert.equal(await firstAttempt, 'cancelled');
		await assertPending(afterEdit); assert.equal(recording.sessionId, session); assert.equal(recording.isRecording, true);
		assert.equal((await controller.showStatus()).consentGranted, false);
	});

	test('same-host endpoint changes revoke consent and cannot send until separately approved again', async () => {
		await capture(); assert.equal(await enableUpload(), 'delivered');
		settings.endpoint = endpoint + '/new'; await controller.settingsChanged(); await capture();
		assert.equal(controller.enabled, false); assert.equal(settings.enabled, false); assert.equal(received.length, 1);
		consent = false; assert.equal(await controller.enable(), false); assert.equal(received.length, 1);
		consent = true; assert.equal(await enableUpload(), 'delivered'); assert.equal(consentRequests, 3);
		assert.deepEqual(destinations, ['/events', '/events/new']); assert.equal(recordConsentRequests, 1);
	});

	test('extension restart retains encrypted pending events but blocks historical evidence without memory approval', async () => {
		const historical = await capture(); respond = (_req, res) => { res.writeHead(503); res.end(); };
		assert.equal(await enableUpload(), 'retry'); const deadline = (await queue.getUploadRetryState())!.nextAttemptAt;
		await closePipeline(); const requestCount = received.length; await makePipeline();
		assert.equal(recording.isRecording, false); assert.equal(controller.enabled, false); await assertPending(historical);
		for (const event of historical) { assert.equal(persistence.getUploadPrivacyContext(event), undefined); }
		assert.equal((await queue.getUploadRetryState())!.nextAttemptAt, deadline);
		await recording.start(); parser.grantContentConsent(recording.sessionId!); const all = await capture();
		assert.ok(all.length > historical.length); retryNow(); respond = (_req, res, body) => acknowledge(res, body);
		assert.equal(await enableUpload(), 'privacy'); assert.equal(received.length, requestCount); await assertPending(all);
	});

	test('fake credentials in code, prompts, responses and tool inputs/outputs never reach HTTPS or diagnostic JSONL', async () => {
		const dummySecrets = ['dummy-code-password', 'dummy-prompt-password', 'dummy-response-password', 'dummy-tool-password', 'dummy-bearer-token'];
		await capture('export const password = "dummy-code-password";\n');
		for (const [role, text] of [['user', 'password="dummy-prompt-password"'], ['assistant', 'password="dummy-response-password"']]) {
			await parser.handle({ type: 'response_item', payload: { type: 'message', role,
				content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }, sourceContext());
		}
		await parser.handle({ type: 'response_item', payload: { type: 'function_call', name: 'dummy_tool', call_id: 'dummy-call',
			arguments: '{"password":"dummy-tool-password"}' } }, sourceContext());
		await parser.handle({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'dummy-call', output: 'Bearer dummy-bearer-token' } }, sourceContext());
		await drainCapture(); const expected = await queue.getPending(100);
		assert.ok(expected.some(event => event.eventType === 'file.gap'));
		for (const type of ['ai.prompt.submitted', 'ai.response.completed', 'ai.tool.started', 'ai.tool.completed']) { assert.ok(expected.some(event => event.eventType === type)); }
		assert.equal(await enableUpload(), 'delivered'); const payload = JSON.stringify(received); const diagnostics = await readFile(join(root, 'diagnostics', 'safe.jsonl'), 'utf8');
		for (const secret of dummySecrets) { assert.equal(payload.includes(secret), false); assert.equal(diagnostics.includes(secret), false); }
		assert.equal(payload.includes('dummy-upload-auth-token'), false); assert.equal(diagnostics.includes('dummy-upload-auth-token'), false);
		assert.ok(payload.includes('[REDACTED]')); assert.deepEqual(received[0].events, expected);
	});

	test('unavailable server and recovery do not block real editor/save recording', async () => {
		await capture(); const port = (server.address() as AddressInfo).port; await stopServer();
		assert.equal(await enableUpload(), 'retry'); const expected = await capture(); assert.equal(recording.isRecording, true);
		await assertPending(expected); await listen(port); retryNow(); assert.equal(await uploader.uploadOnce(), 'delivered');
		assert.deepEqual(received[0].events, expected);
	});

	test('an ordinary client still rejects the mock self-signed certificate', async () => {
		const transport = new HttpsEventTransport();
		try {
			await assert.rejects(transport.send({ endpoint: new URL(endpoint), token: 'dummy-upload-auth-token', body: '{}', signal: AbortSignal.timeout(1000) }));
			assert.equal(received.length, 0);
		} finally { transport.dispose(); }
	});
});
