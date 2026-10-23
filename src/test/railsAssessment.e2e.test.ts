import { canonicalSha256 } from '../canonicalJson';
import { validFinalizationRequest, type AssessmentFinalizationRequest, type AssessmentSubmissionReceipt } from '../assessmentFinalization';
import * as assert from 'node:assert/strict';
import { createServer, type Server } from 'node:https';
import type { ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RailsAssessmentApiClient } from '../railsAssessmentApiClient';
import { HttpsEventTransport } from '../httpsEventTransport';
import { AssessmentController } from '../assessmentController';
import { AssessmentConnectionStore, ASSESSMENT_METADATA_KEY, assessmentCredentialKey, type AssessmentMetadata } from '../assessmentStorage';
import { AssessmentApiError, type AssessmentAuthentication } from '../assessmentApiClient';
import { AssessmentEventDelivery } from '../assessmentEventDelivery';
import { AssessmentEvidenceConsent } from '../assessmentEvidenceConsent';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { EventPersistence } from '../eventPersistence';
import { JsonlWriter } from '../jsonlWriter';
import { RecordingController } from '../recording';
import { createFileEvent, type TrackerEvent } from '../eventSchema';
import { validAssessmentEventApproval, type AssessmentEventApproval } from '../assessmentEventApproval';
import { parseRailsControlResponse } from '../railsControlResponse';
import { LOCAL_QUEUE_FILENAME } from '../localEventQueue';
import { EventBatchManager } from '../eventBatchManager';
import { EventUploader } from '../eventUploader';

const BASE = '/api/v2/coding_session/extension';
const WORKSPACE = 'a'.repeat(64);
const PAIR_CODE = 'ABCD-EFGH-JKLM-NPQR';
const TOKEN = 'adt_ext_' + 'a'.repeat(43);
const stamp = () => new Date().toISOString();
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const end = Date.now() + 5000;
	while (!await check()) { if (Date.now() > end) { throw new Error('Mock Rails timeout: ' + label); } await wait(10); }
}
interface UploadBody { contractVersion: number; batchId: string; events: TrackerEvent[]; eventApprovals: AssessmentEventApproval[] }

suite('Real Rails adapter and scoped assessment HTTPS pipeline', function () {
	this.timeout(20000);
	let certificates: string; let cert: string; let key: string; let fixture: Record<string, Record<string, unknown>>;
	let root: string; let server: Server; let origin: string; let api: RailsAssessmentApiClient;
	let queue: AsyncLocalEventQueue; let persistence: EventPersistence; let recording: RecordingController;
	let controller: AssessmentController; let delivery: AssessmentEventDelivery; let store: AssessmentConnectionStore;
	let secrets: Map<string, string>; let state: Map<string, unknown>; let uploadConsent: boolean; let recordingConsent: boolean;
	let receipts: Map<string, Record<string, unknown>>; let requests: { path: string; method: string; body: Record<string, unknown>; authenticated: boolean }[];
	let received: UploadBody[]; let accepted: Set<string>; let serverBindings: string[]; let starts: Map<string, string>; let startedAt: string | undefined; let deadline: string | undefined;
	let revoked: boolean; let codeUsed: boolean; let failStart: boolean; let uploadMode: string; let controlMutation: ((path: string, data: unknown) => unknown) | undefined;
	let holdUpload: (() => void) | undefined; let failRegistration: boolean;
	let submission: AssessmentSubmissionReceipt | undefined; let finalized: AssessmentFinalizationRequest | undefined; let finalizeMode: string;
	const storage = () => ({ scheme: 'file', fsPath: join(root, 'queue') });
	const metadata = () => state.get(ASSESSMENT_METADATA_KEY) as AssessmentMetadata;
	const identity = async (): Promise<AssessmentAuthentication> => ({ connection: metadata().connection, credential: (await store.getCredential(metadata().credentialId))! });
	const status = () => ({ ...fixture.status, server_time: stamp(), state: submission ? 'submitted' : startedAt ? 'active' : 'paired', ...(submission ? { submission } : {}),
		local_recording_session_ids: [...serverBindings], ...(startedAt ? { started_at: startedAt, deadline } : {}) });
	function json(response: ServerResponse, data: unknown, statusCode = 200): void {
		response.writeHead(statusCode, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data));
	}
	async function makePipeline(): Promise<void> {
		queue = await AsyncLocalEventQueue.open(storage(), [], {}, { get: async name => secrets.get(name), store: async (name, value) => { secrets.set(name, value); } });
		recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => recordingConsent);
		persistence = new EventPersistence(queue, new JsonlWriter(join(root, 'diagnostics.jsonl')));
		persistence.attachRecording(recording, () => ({ approvedWorkspaceIds: [WORKSPACE],
			confirmedCodexSessions: [{ sourceSessionId: 'dummy-codex', workspaceId: WORKSPACE }], codexContentConsent: true,
			confirmedClaudeSessions: [{ sourceSessionId: 'dummy-claude', workspaceId: WORKSPACE }], claudeContentConsent: true }));
		store = new AssessmentConnectionStore({ get: <T>(name: string, fallback?: T) => (state.get(name) ?? fallback) as T,
			update: async (name, value) => { state.set(name, structuredClone(value)); } }, {
			get: async name => secrets.get(name), store: async (name, value) => { secrets.set(name, value); }, delete: async name => { secrets.delete(name); }
		});
		delivery = new AssessmentEventDelivery(queue, store, api, () => {}, () => new HttpsEventTransport(cert),
			{ baseDelayMs: 100, maxDelayMs: 200, timeoutMs: 500, maxBytes: 16384 });
		controller = new AssessmentController(api, store, recording, {
			flushStopped: async id => { await persistence.flush(); await persistence.completeSession(id); },
			freezeFinalization: (scope, existingOnly) => queue.freezeFinalization(scope, existingOnly),
			getStatus: ids => queue.getSessionEvidenceStatus(ids), disableDevelopmentUploads: async () => {}
		}, async hostname => { assert.equal(hostname, '127.0.0.1'); return uploadConsent; }, () => {}, 1500,
		new AssessmentEvidenceConsent(queue, api, () => ({ workspaceIds: [WORKSPACE], eventTypes: ['file.modified', 'ai.prompt.submitted', 'ai.response.completed'] })), delivery);
		await controller.initialize();
	}
	async function captureFile(): Promise<TrackerEvent> {
		const event = createFileEvent({ sessionId: recording.sessionId!, workspaceId: WORKSPACE, source: 'vscode', eventType: 'file.modified', payload: { relativePath: 'src/example.ts' } });
		await persistence.write(event); await persistence.flush(); return event;
	}
	async function pairStart(): Promise<void> {
		await controller.pair(PAIR_CODE); assert.equal(controller.view.state, 'paired');
		await controller.start(); assert.equal(controller.view.state, 'active'); assert.equal(recording.isRecording, true);
	}
	async function stopPipeline(): Promise<void> {
		await controller?.dispose(); await delivery?.disable(); recording?.dispose(); await persistence?.flush(); await queue?.close();
	}
	suiteSetup(async () => {
		fixture = JSON.parse(await readFile(join(__dirname, '../../src/test/fixtures/rails-assessment-control.v1.json'), 'utf8'));
		certificates = await mkdtemp(join(tmpdir(), 'rails-adapter-tls-'));
		await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(certificates, 'key.pem'),
			'-out', join(certificates, 'cert.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
		cert = await readFile(join(certificates, 'cert.pem'), 'utf8'); key = await readFile(join(certificates, 'key.pem'), 'utf8');
	});
	suiteTeardown(async () => { await rm(certificates, { recursive: true, force: true }); });
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'rails-assessment-')); state = new Map(); secrets = new Map();
		receipts = new Map(); requests = []; received = []; accepted = new Set(); serverBindings = []; starts = new Map();
		startedAt = undefined; deadline = undefined; revoked = false; codeUsed = false; failStart = false; uploadMode = 'success'; controlMutation = undefined;
		uploadConsent = true; recordingConsent = true; holdUpload = undefined; failRegistration = false;
		submission = undefined; finalized = undefined; finalizeMode = 'success';
		server = createServer({ key, cert }, (request, response) => { void (async () => {
			const chunks: Buffer[] = []; for await (const chunk of request) { chunks.push(Buffer.from(chunk)); }
			const path = request.url!; const body = Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
			const authenticated = request.headers.authorization === 'Bearer ' + TOKEN;
			requests.push({ path, method: request.method!, body, authenticated });
			const control = (data: unknown) => json(response, { data: controlMutation ? controlMutation(path, data) : data });
			if (path === BASE + '/pair') {
				if (body.pairing_code !== PAIR_CODE || codeUsed) { json(response, { error: 'Pairing rejected.' }, 401); return; }
				assert.equal(request.headers.authorization, undefined); codeUsed = true;
				control({ ...fixture.pair, api_origin: origin, upload_endpoint: origin + BASE + '/events', credential: TOKEN,
					credential_expires_at: new Date(Date.now() + 7200000).toISOString(), status: status() }); return;
			}
			if (!authenticated || revoked) { json(response, { error: 'Unauthorized.' }, 401); return; }
			if (path === BASE + '/status') { assert.equal(request.method, 'GET'); assert.deepEqual(body, {}); control(status()); return; }
			if (path === BASE + '/finalize') {
				assert.equal(request.method, 'POST');
				if (!validFinalizationRequest(body)) { json(response, { error: 'Invalid finalization.' }, 422); return; }
				if (finalizeMode === 'offline') { request.socket.destroy(); return; }
				if (finalizeMode === 'unavailable') { json(response, { error: 'Unavailable.' }, 503); return; }
				if (finalized && JSON.stringify(finalized) !== JSON.stringify(body)) { json(response, { error: 'Conflict.' }, 409); return; }
				if (!submission) {
					if (Date.parse(deadline!) <= Date.now()) { json(response, { error: 'Expired.' }, 401); return; }
					assert.deepEqual(body.recordings.map(row => row.local_recording_session_id).sort(), [...serverBindings].sort());
					for (const row of body.recordings) {
						const receipt = receipts.get(row.local_recording_session_id); assert.equal(receipt?.state, 'stopped');
						const ids = [...accepted].filter(id => received.some(batch => batch.events.some(event => event.eventId === id && event.sessionId === row.local_recording_session_id))).sort();
						if (row.event_count !== ids.length || row.event_ids_sha256 !== canonicalSha256(ids)) { json(response, { error: 'Evidence pending.' }, 409); return; }
					}
					finalized = structuredClone(body); submission = { contract_version: 1, request_id: body.request_id, submitted_at: stamp(),
						event_count: body.recordings.reduce((sum, row) => sum + row.event_count, 0), recording_count: body.recordings.length };
				}
				if (finalizeMode === 'lost') { request.socket.destroy(); return; }
				control(status()); return;
			}
			if (submission && path !== BASE + '/credential') { json(response, { error: 'Submitted.' }, 401); return; }
			if (path === BASE + '/start') {
				assert.deepEqual(Object.keys(body).sort(), ['local_recording_session_id', 'request_id']);
				if (failStart) { json(response, { error: 'Temporarily unavailable.' }, 503); return; }
				if (starts.has(body.request_id) && starts.get(body.request_id) !== body.local_recording_session_id) { json(response, { error: 'Conflict.' }, 409); return; }
				starts.set(body.request_id, body.local_recording_session_id);
				if (!startedAt) { startedAt = stamp(); deadline = new Date(Date.now() + 3600000).toISOString(); }
				if (!serverBindings.includes(body.local_recording_session_id)) { serverBindings.push(body.local_recording_session_id); }
				control(status()); return;
			}
			if (path.startsWith(BASE + '/evidence_consents')) {
				if (failRegistration) { json(response, { error: 'Temporarily unavailable.' }, 503); return; }
				let receipt = receipts.get(body.local_recording_session_id);
				if (request.method === 'POST' && path.endsWith('/evidence_consents')) {
					assert.equal(body.approval_action, 'approve_upload'); assert.equal(body.consent_version, 'assessment-evidence.v1');
					if (!serverBindings.includes(body.local_recording_session_id)) { json(response, { error: 'Forbidden.' }, 403); return; }
					if (!receipt) { const now = stamp(); receipt = { ...fixture.receipt, consent_id: randomUUID(), local_recording_session_id: body.local_recording_session_id,
						approved_workspace_ids: body.approved_workspace_ids, event_types: body.event_types, destination_origin: origin,
						consented_at: now, expires_at: deadline, server_time: now, evidence_window: { starts_at: now, ends_at: deadline } }; receipts.set(body.local_recording_session_id, receipt); }
				} else {
					if (!receipt || receipt.consent_id !== body.consent_id) { json(response, { error: 'Forbidden.' }, 403); return; }
					if (request.method === 'DELETE') { receipt.state = 'revoked'; receipt.revoked_at ??= stamp(); }
					else if (receipt.state !== 'revoked') { receipt.state = 'stopped'; const window = receipt.evidence_window as Record<string, unknown>;
						window.stopped_at ??= stamp(); window.ends_at = window.stopped_at; }
				}
				receipt!.server_time = stamp(); control(receipt); return;
			}
			if (path === BASE + '/credential') { assert.equal(request.method, 'DELETE'); assert.deepEqual(body, {}); revoked = true; control({ revoked: true }); return; }
			if (path !== BASE + '/events') { json(response, { error: 'Unsupported endpoint.' }, 404); return; }
			assert.deepEqual(Object.keys(body).sort(), ['batchId', 'contractVersion', 'eventApprovals', 'events']);
			assert.equal(body.eventApprovals.length, body.events.length);
			for (let index = 0; index < body.events.length; index++) {
				const event = body.events[index] as TrackerEvent; const proof = body.eventApprovals[index]; const receipt = receipts.get(event.sessionId);
				if (!receipt || receipt.state === 'revoked' || !validAssessmentEventApproval(proof, event, { consentReceiptId: receipt.consent_id as string })
					|| !(receipt.approved_workspace_ids as string[]).includes(event.workspaceId!) || !(receipt.event_types as string[]).includes(event.eventType)) {
					json(response, { error: 'Authorization rejected.' }, 403); return;
				}
			}
			received.push(body);
			if (uploadMode === 'hold') { await new Promise<void>(resolve => { holdUpload = resolve; }); }
			if (uploadMode === 'disconnect') { request.socket.destroy(); return; }
			if (uploadMode === 'timeout') { return; }
			if (uploadMode === 'auth') { json(response, { error: 'Authorization rejected.' }, 403); return; }
			if (uploadMode === '429' || uploadMode === '503') { response.setHeader('Retry-After', '0'); json(response, { error: 'Retry.' }, Number(uploadMode)); return; }
			if (uploadMode === 'malformed') { json(response, { data: { accepted: true } }); return; }
			const ids = body.events.map((event: TrackerEvent) => event.eventId) as string[];
			const acknowledge = uploadMode === 'partial' ? ids.slice(0, 1) : ids;
			for (const id of acknowledge) { accepted.add(id); }
			const journal = await open(join(root, 'accepted-event-ids.json'), 'w', 0o600);
			try { await journal.writeFile(JSON.stringify([...accepted])); await journal.sync(); } finally { await journal.close(); }
			json(response, { contractVersion: 1, batchId: body.batchId, durablyAcceptedEventIds: acknowledge });
		})().catch(() => { json(response, { error: 'Mock contract validation failed.' }, 422); }); });
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		origin = 'https://127.0.0.1:' + (server.address() as { port: number }).port;
		api = new RailsAssessmentApiClient(origin, new HttpsEventTransport(cert), 1000); await makePipeline();
	});
	teardown(async () => {
		holdUpload?.(); await stopPipeline(); api.dispose(); server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
	});

	test('pairs, binds, registers consent, filters and encrypts sources, uploads approval sidecars and acknowledges exact IDs', async () => {
		await pairStart(); const event = await captureFile();
		const raw = 'sk-proj-' + 'z'.repeat(48);
		await persistence.write({ schemaVersion: 1, eventId: randomUUID(), sessionId: recording.sessionId!, source: 'codex', sourceSessionId: 'dummy-codex',
			eventType: 'ai.prompt.submitted', timestamp: stamp(), workspaceId: WORKSPACE, payload: { text: 'Explain API_KEY=' + raw,
				sourceRecord: { sourceFileReference: 'codex-file:' + 'a'.repeat(64), recordIndex: 1, generation: 0, byteOffset: 0, byteLength: 10, recordType: 'response_item' } } });
		await persistence.write({ schemaVersion: 1, eventId: randomUUID(), sessionId: recording.sessionId!, source: 'claude', sourceSessionId: 'dummy-claude',
			eventType: 'ai.response.completed', timestamp: stamp(), workspaceId: WORKSPACE, payload: { text: 'Updated the example.',
				sourceRecord: { sourceFileReference: 'claude-file:' + 'b'.repeat(64), recordIndex: 1, generation: 0, byteOffset: 0, byteLength: 10, recordType: 'claude_hook' } } });
		await until(async () => await queue.getPendingCount() === 0, 'durable upload');
		assert.ok(accepted.has(event.eventId)); assert.equal(accepted.size, 3);
		assert.equal(JSON.stringify(received).includes(raw), false); assert.ok(JSON.stringify(received).includes('[REDACTED]'));
		assert.equal(JSON.stringify([...state.values()]).includes(TOKEN), false); assert.equal(await store.getCredential(metadata().credentialId), TOKEN);
		const database = await readFile(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		assert.equal(database.includes(Buffer.from(raw)), false); assert.equal(database.includes(Buffer.from('Updated the example.')), false);
		assert.equal(requests.some(item => item.path.includes('submit') || item.path.includes('finaliz')), false);
	});

	test('recording and upload consent are separate and no recording starts when either is absent', async () => {
		await controller.pair(PAIR_CODE); recordingConsent = false; await controller.start();
		assert.equal(recording.isRecording, false); assert.equal(starts.size, 0);
		recordingConsent = true; uploadConsent = false; await controller.start();
		assert.equal(recording.isRecording, false); assert.equal(starts.size, 0); assert.equal(received.length, 0);
	});

	test('registration failure prevents capture and never fabricates a receipt or approval', async () => {
		await controller.pair(PAIR_CODE); failRegistration = true; await controller.start();
		assert.equal(recording.isRecording, false); assert.equal(received.length, 0);
		const id = metadata().localRecordingSessionIds[0]; const consent = await queue.getEvidenceConsent(id);
		assert.equal(consent?.receipt, undefined); assert.equal(await queue.getPendingCount(), 0);
	});

	test('rejects bad pairing, untrusted origin/endpoint, malformed control envelopes, duplicates and expired credentials', async () => {
		await assert.rejects(api.pair('WRONG', AbortSignal.timeout(1000)), AssessmentApiError);
		for (const mutation of [(value: Record<string, unknown>) => ({ ...value, api_origin: 'https://untrusted.invalid' }),
			(value: Record<string, unknown>) => ({ ...value, upload_endpoint: origin + '/wrong' }),
			(value: Record<string, unknown>) => ({ ...value, credential_expires_at: '2000-01-01T00:00:00.000Z' }),
			(value: Record<string, unknown>) => ({ ...value, unexpected: true })]) {
			codeUsed = false; controlMutation = (_path, value) => mutation(value as Record<string, unknown>);
			await assert.rejects(api.pair(PAIR_CODE, AbortSignal.timeout(1000)), AssessmentApiError);
		}
		assert.throws(() => parseRailsControlResponse(String.raw`{"data":{},"d\u0061ta":{}}`), AssessmentApiError);
		assert.throws(() => parseRailsControlResponse('{"data":{"a":1,"a":2}}'), AssessmentApiError);
		assert.throws(() => parseRailsControlResponse('x'.repeat(32769)), AssessmentApiError);
	});

	test('start retries preserve request/binding and original server deadline, with no ownership fields', async () => {
		await controller.pair(PAIR_CODE); const auth = await identity(); const request = { requestId: randomUUID(), localRecordingSessionId: randomUUID() };
		const first = await api.startOrResume(auth, request, AbortSignal.timeout(1000));
		const again = await api.startOrResume(auth, request, AbortSignal.timeout(1000));
		assert.equal(again.startedAt, first.startedAt); assert.equal(again.deadline, first.deadline); assert.equal(serverBindings.length, 1);
		assert.deepEqual(again.localRecordingSessionIds, [request.localRecordingSessionId]);
		await assert.rejects(api.startOrResume(auth, { ...request, localRecordingSessionId: randomUUID() }, AbortSignal.timeout(1000)), AssessmentApiError);
	});

	test('network loss during start never starts local recording or invents a server session', async () => {
		await controller.pair(PAIR_CODE); failStart = true; await controller.start();
		assert.equal(recording.isRecording, false); assert.equal(serverBindings.length, 0); assert.equal(controller.view.state, 'recovery');
	});

	for (const failure of ['malformed', 'auth', '429', '503', 'disconnect', 'timeout']) {
		test('keeps evidence pending on ' + failure + ' without blocking independent recording', async () => {
			uploadMode = failure; await pairStart(); await captureFile();
			await until(() => received.length > 0, 'failed upload');
			await until(async () => !(await queue.getUploadRetryState())?.busy, 'failed attempt drain');
			assert.equal(await queue.getPendingCount(), 1); assert.equal(accepted.size, 0); assert.equal(recording.isRecording, true);
			if (['429', '503', 'disconnect', 'timeout'].includes(failure)) {
				uploadMode = 'success'; await until(async () => await queue.getPendingCount() === 0, 'network recovery');
			}
		});
	}

	test('partial acknowledgment retains the remainder and retries the same event IDs/capture references', async () => {
		uploadMode = 'hold'; await pairStart(); const first = await captureFile(); await until(() => !!holdUpload, 'held first batch');
		const second = await captureFile(); const third = await captureFile(); uploadMode = 'success'; holdUpload!();
		await until(() => accepted.has(first.eventId), 'first acknowledgment'); uploadMode = 'partial';
		await until(() => received.some(batch => batch.events.some(event => event.eventId === second.eventId)), 'partial batch');
		const original = received.find(batch => batch.events.some(event => event.eventId === third.eventId))?.eventApprovals.find(proof => proof.eventId === third.eventId);
		assert.ok(original); uploadMode = 'success'; await until(async () => await queue.getPendingCount() === 0, 'partial retry');
		const copies = received.flatMap(batch => batch.eventApprovals).filter(proof => proof.eventId === third.eventId);
		assert.ok(copies.every(proof => proof.captureApprovalReference === original.captureApprovalReference)); assert.equal(accepted.size, 3);
	});

	test('revoking consent cancels in-flight delivery, tombstones approvals and never resumes after restart', async () => {
		uploadMode = 'hold'; await pairStart(); await captureFile(); await until(() => !!holdUpload, 'upload before revoke');
		await controller.revokeUploadConsent(); uploadMode = 'success'; holdUpload!();
		assert.equal(await queue.getPendingCount(), 1); assert.equal(controller.view.uploadConsent, false); assert.equal(delivery.status, 'disabled');
		assert.equal((await queue.getEvidenceConsent(metadata().localRecordingSessionIds[0]))?.locallyRevoked, true);
		assert.equal(recording.isRecording, true); await stopPipeline(); await makePipeline();
		assert.equal(recording.isRecording, false); assert.equal(controller.view.uploadConsent, false);
		await controller.enableUploads(); await wait(50); assert.equal(await queue.getPendingCount(), 1);
	});

	test('restart restores exact approvals/bindings but requires fresh upload consent and preserves the deadline', async () => {
		uploadMode = 'auth'; await pairStart(); const event = await captureFile(); await until(() => received.length > 0, 'pending evidence');
		const originalDeadline = metadata().serverStatus.deadline; const originalId = event.sessionId;
		await stopPipeline(); received = []; uploadMode = 'success'; await makePipeline();
		assert.equal(recording.isRecording, false); assert.equal(controller.view.uploadConsent, false); assert.equal(received.length, 0);
		assert.equal(metadata().serverStatus.deadline, originalDeadline); assert.ok(metadata().localRecordingSessionIds.includes(originalId));
		await controller.enableUploads(); await until(async () => await queue.getPendingCount() === 0, 'approved restart delivery');
		assert.equal(received[0].events[0].eventId, event.eventId); assert.equal(received[0].events[0].sessionId, originalId);
	});

	test('scoped selection excludes manual/unrelated recordings, and legacy assessment rows remain blocked', async () => {
		const manual = createFileEvent({ sessionId: randomUUID(), workspaceId: WORKSPACE, source: 'vscode', eventType: 'file.modified', payload: { relativePath: 'manual.ts' } });
		await queue.enqueue(manual); uploadMode = 'success'; await pairStart(); const event = await captureFile();
		await until(async () => accepted.has(event.eventId) && await queue.getPendingCount() === 1, 'scoped upload and local acknowledgment');
		assert.equal(await queue.getPendingCount(), 1); assert.equal(received.some(batch => batch.events.some(row => row.eventId === manual.eventId)), false);
		const legacy = createFileEvent({ sessionId: recording.sessionId!, workspaceId: WORKSPACE, source: 'vscode', eventType: 'file.modified', payload: { relativePath: 'old.ts' } });
		await queue.enqueue(legacy); await until(() => delivery.status === 'privacy', 'legacy block');
		assert.equal(accepted.has(legacy.eventId), false); assert.equal(await queue.getPendingCount(), 2);
	});

	test('Stop and Submit closes capture, freezes all IDs including acknowledged events, and verifies durable Rails finalization', async () => {
		await pairStart(); const first = await captureFile(); await until(() => accepted.has(first.eventId), 'early acknowledgment');
		const last = await captureFile(); await controller.stopAndSubmit();
		if (controller.view.state !== 'submitted') { await until(async () => await queue.getPendingCount() === 0, 'remaining uploads'); await controller.stopAndSubmit(); }
		assert.equal(recording.isRecording, false); assert.equal(controller.view.state, 'submitted');
		assert.equal([...receipts.values()][0].state, 'stopped'); assert.equal(delivery.status, 'disabled'); assert.equal(controller.view.uploadConsent, false);
		assert.equal(finalized!.recordings[0].event_count, 2); assert.equal(finalized!.recordings[0].event_ids_sha256, canonicalSha256([first.eventId, last.eventId].sort()));
		assert.equal(metadata().serverStatus.submission?.request_id, metadata().submitRequestId);
		const calls = requests.filter(request => request.path.endsWith('/finalize')).length;
		await controller.stopAndSubmit(); await controller.enableUploads(); await controller.start();
		assert.equal(recording.isRecording, false); assert.equal(delivery.status, 'disabled');
		assert.equal(requests.filter(request => request.path.endsWith('/finalize')).length, calls);
	});

	test('Stop drains a final producer checkpoint before capture closure and freezes every event', async () => {
		await pairStart(); const captured = await captureFile(); let checkpoint: TrackerEvent | undefined;
		const listener = recording.addLifecycleListener({ prepare: async () => {}, started: () => {}, cancelled: () => {}, stopped: id => {
			checkpoint = createFileEvent({ sessionId: id, workspaceId: WORKSPACE, source: 'vscode', eventType: 'file.modified', payload: { relativePath: 'src/final.ts' } });
			void persistence.write(checkpoint);
		} });
		try {
			await controller.stopAndSubmit();
			if (controller.view.state !== 'submitted') { await until(async () => await queue.getPendingCount() === 0, 'final checkpoint'); await controller.stopAndSubmit(); }
			assert.equal(controller.view.state, 'submitted'); assert.ok(checkpoint); assert.equal(accepted.has(checkpoint.eventId), true);
			assert.equal(finalized!.recordings[0].event_ids_sha256, canonicalSha256([captured.eventId, checkpoint.eventId].sort()));
		} finally { listener.dispose(); }
	});

	test('server reconciliation failure preserves the identical manifest rather than shrinking it to accepted evidence', async () => {
		await pairStart(); const captured = await captureFile(); await until(async () => accepted.has(captured.eventId) && await queue.getPendingCount() === 0, 'accepted event'); accepted.delete(captured.eventId);
		await controller.stopAndSubmit(); assert.equal(controller.view.state, 'submission_pending'); assert.equal(controller.view.reason, 'evidence_pending');
		const attempted = requests.find(request => request.path.endsWith('/finalize'))!.body;
		assert.equal((attempted.recordings as { event_count: number }[])[0].event_count, 1);
		accepted.add(captured.eventId); await controller.stopAndSubmit(); assert.equal(controller.view.state, 'submitted'); assert.deepEqual(finalized, attempted);
	});

	test('already-submitted status without a frozen local manifest never establishes success or creates approval', async () => {
		await pairStart(); recording.stop(); await persistence.flush();
		submission = { contract_version: 1, request_id: metadata().submitRequestId, submitted_at: stamp(), event_count: 0, recording_count: 1 };
		await controller.showStatus(); assert.notEqual(controller.view.state, 'submitted'); assert.equal(controller.view.reason, 'recovery_required');
		const scope = { codingSessionId: '42', origin, requestId: metadata().submitRequestId, localRecordingSessionIds: metadata().localRecordingSessionIds };
		await assert.rejects(queue.freezeFinalization(scope, true));
	});

	test('revocation during submission upload cancels finalization and preserves unacknowledged evidence', async () => {
		uploadMode = 'auth'; await pairStart(); await captureFile(); await until(() => received.length > 0, 'initial failed upload');
		await delivery.disable(); uploadMode = 'hold';
		const stopping = controller.stopAndSubmit(); await until(() => !!holdUpload, 'submission delivery');
		await controller.revokeUploadConsent(); holdUpload!(); await stopping;
		assert.equal(controller.view.uploadConsent, false); assert.equal(submission, undefined); assert.equal(recording.isRecording, false);
		assert.equal(await queue.getPendingCount(), 1); assert.equal(requests.some(request => request.path.endsWith('/finalize')), false);
	});

	test('empty approved recording finalizes with the exact empty-array digest', async () => {
		await pairStart(); await controller.stopAndSubmit(); assert.equal(controller.view.state, 'submitted');
		assert.equal(finalized!.recordings[0].event_count, 0);
		assert.equal(finalized!.recordings[0].event_ids_sha256, '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
	});

	for (const mode of ['offline', 'unavailable', 'lost']) {
		test('durable finalization survives ' + mode + ' and restart without changing the request or manifest', async () => {
			await pairStart(); await captureFile(); await until(async () => await queue.getPendingCount() === 0, 'acknowledgment');
			finalizeMode = mode; await controller.stopAndSubmit(); assert.equal(controller.view.state, 'submission_pending');
			const attempted = requests.find(request => request.path.endsWith('/finalize'))!.body;
			const originalDeadline = metadata().serverStatus.deadline;
			await stopPipeline(); finalizeMode = 'success'; await makePipeline();
			if (mode !== 'lost') { assert.equal(controller.view.state, 'submission_pending'); await controller.stopAndSubmit(); }
			assert.equal(controller.view.state, 'submitted'); assert.equal(recording.isRecording, false);
			assert.deepEqual(finalized, attempted); assert.equal(metadata().serverStatus.deadline, originalDeadline);
			assert.equal(controller.view.uploadConsent, false);
			const before = requests.length; await controller.showStatus();
			assert.equal(requests.slice(before).some(request => request.path.includes('/evidence_consents')), false);
		});
	}

	test('partial/failed uploads cannot finalize and retries keep the frozen manifest and original IDs', async () => {
		uploadMode = 'auth'; await pairStart(); const events = [await captureFile(), await captureFile()];
		await until(() => received.length > 0, 'failed upload'); await controller.stopAndSubmit();
		assert.equal(controller.view.state, 'submission_pending'); assert.equal(submission, undefined); assert.equal(await queue.getPendingCount(), 2);
		const scope = { codingSessionId: '42', origin, requestId: metadata().submitRequestId, localRecordingSessionIds: metadata().localRecordingSessionIds };
		const snapshot = await queue.freezeFinalization(scope, true);
		uploadMode = 'partial'; await controller.enableUploads(); await until(async () => await queue.getPendingCount() < 2, 'partial acknowledgment');
		uploadMode = 'success'; await until(async () => await queue.getPendingCount() === 0, 'full acknowledgment'); await controller.stopAndSubmit();
		assert.equal(controller.view.state, 'submitted'); assert.deepEqual(finalized, snapshot);
		assert.equal(finalized!.recordings[0].event_ids_sha256, canonicalSha256(events.map(event => event.eventId).sort()));
	});

	for (const field of ['request_id', 'event_count', 'recording_count', 'submitted_at', 'contract_version']) {
		test('rejects invalid submission receipt ' + field + ' without claiming success', async () => {
			await pairStart();
			controlMutation = (path, data) => {
				if (!path.endsWith('/finalize') && !path.endsWith('/status') || !(data as Record<string, unknown>).submission) { return data; }
				return { ...(data as object), submission: { ...submission!, [field]: field === 'request_id' ? randomUUID() : field === 'submitted_at' ? '2099-01-01T00:00:00.000Z' : 999 } };
			};
			await controller.stopAndSubmit(); assert.equal(controller.view.state, 'submission_pending'); assert.equal(controller.view.reason, 'protocol');
			controlMutation = undefined; await controller.showStatus(); assert.equal(controller.view.state, 'submitted');
		});
	}

	test('an invalid status receipt cannot poison the accepted metadata or prevent later valid recovery', async () => {
		await pairStart(); finalizeMode = 'lost'; await controller.stopAndSubmit(); assert.equal(controller.view.state, 'submission_pending');
		controlMutation = (path, data) => path.endsWith('/status') ? { ...(data as object), submission: { ...submission!, event_count: 999 } } : data;
		await controller.showStatus(); assert.equal(controller.view.reason, 'protocol'); assert.equal(metadata().serverStatus.submission, undefined);
		controlMutation = undefined; await controller.showStatus(); assert.equal(controller.view.state, 'submitted');
	});

	test('missing runtime upload consent after restart cannot submit or upload, and expired/revoked credentials stay pending', async () => {
		uploadMode = 'auth'; await pairStart(); await captureFile(); await until(() => received.length > 0, 'pending event');
		await controller.stopAndSubmit(); await stopPipeline(); uploadConsent = false; uploadMode = 'success'; await makePipeline();
		const before = received.length; await controller.stopAndSubmit();
		assert.equal(controller.view.reason, 'consent_required'); assert.equal(received.length, before); assert.equal(submission, undefined);
		uploadConsent = true; revoked = true; await controller.stopAndSubmit(); assert.equal(controller.view.reason, 'authentication');
		assert.equal(await queue.getPendingCount(), 1); assert.equal(submission, undefined);
	});

	test('exact duplicate finalization and submitted status recover after the original deadline without uploads', async () => {
		await pairStart(); await controller.stopAndSubmit(); assert.equal(controller.view.state, 'submitted');
		const frozen = finalized!; const receipt = structuredClone(submission!); const auth = await identity(); const original = deadline!;
		controlMutation = (_path, data) => ({ ...(data as object), server_time: new Date(Date.parse(original) + 1000).toISOString(),
			submission: Object.fromEntries(Object.entries(receipt).reverse()) });
		const result = await api.submit(auth, { requestId: frozen.request_id, localRecordingSessionIds: serverBindings, retainedEventCount: 0, finalization: frozen }, AbortSignal.timeout(1000));
		assert.deepEqual(result.submission, receipt); await controller.showStatus(); assert.equal(controller.view.state, 'submitted');
		await assert.rejects(api.submit(auth, { requestId: randomUUID(), localRecordingSessionIds: serverBindings, retainedEventCount: 0,
			finalization: { ...frozen, request_id: randomUUID() } }, AbortSignal.timeout(1000)), AssessmentApiError);
		assert.equal(received.length, 0); assert.equal(metadata().serverStatus.deadline, original);
	});

	test('deadline expiry never resets timing or reports successful submission', async () => {
		await pairStart(); const originalDeadline = metadata().serverStatus.deadline;
		controlMutation = (path, data) => path.endsWith('/status') ? { ...(data as object), server_time: originalDeadline } : data;
		await controller.stopAndSubmit(); assert.equal(recording.isRecording, false); assert.notEqual(controller.view.state, 'submitted');
		assert.equal(submission, undefined); assert.equal(metadata().serverStatus.deadline, originalDeadline);
	});

	test('safe credential revocation stops assessment capture/uploads and removes only its SecretStorage token', async () => {
		await pairStart(); const credentialId = metadata().credentialId; await controller.revokeCredential();
		assert.equal(revoked, true); assert.equal(recording.isRecording, false); assert.equal(delivery.status, 'disabled');
		assert.equal(secrets.has(assessmentCredentialKey(credentialId)), false);
		assert.equal(controller.view.reason, 'authentication');
	});

	test('credential revocation interrupts an in-progress Start instead of sharing and losing the revocation request', async () => {
		await controller.pair(PAIR_CODE);
		const original = api.startOrResume.bind(api);
		api.startOrResume = async (...args) => { await wait(150); return original(...args); };
		const starting = controller.start(); await until(() => recording.isStarting, 'pending start');
		const revoking = controller.revokeCredential(); await Promise.all([starting, revoking]);
		assert.equal(recording.isRecording, false); assert.equal(revoked, true); assert.equal(controller.view.uploadConsent, false);
		assert.equal(await store.getCredential(metadata().credentialId), undefined);
	});

	test('new origin/unknown bindings/changed deadlines and unavailable TLS trust fail closed', async () => {
		const untrusted = new RailsAssessmentApiClient(origin); await assert.rejects(untrusted.pair(PAIR_CODE, AbortSignal.timeout(1500)), AssessmentApiError); untrusted.dispose();
		await pairStart(); const original = metadata().serverStatus.deadline;
		controlMutation = (path, value) => path.endsWith('/status') ? { ...(value as object), deadline: new Date(Date.parse(original!) + 60000).toISOString() } : value;
		await controller.showStatus(); assert.equal(recording.isRecording, false); assert.equal(controller.view.reason, 'protocol');
		assert.equal(metadata().serverStatus.deadline, original);
	});

	test('credential-generation mismatches and historical missing generation evidence fail before any request', async () => {
		uploadMode = 'auth'; await pairStart(); const event = await captureFile(); await until(() => received.length > 0, 'retained evidence');
		await delivery.disable(); const scope = (await queue.getEvidenceConsent(event.sessionId))!; const auth = await identity();
		const batch = { batchId: randomUUID(), createdAt: stamp(), byteSize: 1, events: [event] };
		const count = requests.length;
		await assert.rejects(api.authorizeUpload(auth, { ...scope, credentialDigest: undefined }, batch, AbortSignal.timeout(1000)), AssessmentApiError);
		await assert.rejects(api.authorizeUpload({ ...auth, credential: 'adt_ext_' + 'b'.repeat(43) }, scope, batch, AbortSignal.timeout(1000)), AssessmentApiError);
		assert.equal(requests.length, count);
		await assert.rejects(queue.setEvidenceConsent({ ...scope, credentialDigest: undefined }));
		await assert.rejects(queue.setEvidenceConsent({ ...scope, credentialDigest: 'b'.repeat(64) }));
		assert.equal(await queue.getPendingCount(), 1);
	});

	test('incorrect receipt association fails against the encrypted proof before posting evidence', async () => {
		uploadMode = 'auth'; await pairStart(); await captureFile(); await until(() => received.length > 0, 'retained evidence');
		await delivery.disable(); const before = received.length; const original = queue.getEvidenceConsent.bind(queue);
		queue.getEvidenceConsent = async id => { const scope = await original(id); return scope?.receipt ? { ...scope,
			receipt: { ...scope.receipt, consent_id: randomUUID() } } : scope; };
		try { await controller.enableUploads(); await until(() => delivery.status === 'privacy', 'incorrect receipt rejection'); }
		finally { queue.getEvidenceConsent = original; }
		assert.equal(received.length, before); assert.equal(await queue.getPendingCount(), 1);
	});

	test('missing SecretStorage credentials and refused fresh upload consent leave evidence pending', async () => {
		uploadMode = 'auth'; await pairStart(); await captureFile(); await until(() => received.length > 0, 'retained evidence');
		await delivery.disable(); uploadConsent = false; await controller.enableUploads();
		assert.equal(controller.view.uploadConsent, false); assert.equal(recording.isRecording, true);
		uploadConsent = true; secrets.delete(assessmentCredentialKey(metadata().credentialId));
		const before = received.length; await controller.enableUploads(); await wait(30);
		assert.equal(received.length, before); assert.equal(await queue.getPendingCount(), 1); assert.equal(controller.view.reason, 'authentication');
	});

	test('origin changes cannot redirect the stored credential, and malformed/redirected control responses fail safely', async () => {
		await controller.pair(PAIR_CODE); let sent = false; const auth = await identity();
		const changed = new RailsAssessmentApiClient('https://other.invalid', { send: async () => { sent = true; throw new Error('Unexpected request'); } });
		await assert.rejects(changed.getStatus(auth, AbortSignal.timeout(1000)), AssessmentApiError); assert.equal(sent, false);
		for (const response of [{ status: 302, contentType: 'application/json', body: '{}' },
			{ status: 200, contentType: 'text/plain', body: '{}' }, { status: 200, contentType: 'application/json', body: '{"data":{},"data":{}}' }]) {
			const client = new RailsAssessmentApiClient(origin, { send: async () => response });
			await assert.rejects(client.getStatus(auth, AbortSignal.timeout(1000)), (error: unknown) => error instanceof AssessmentApiError && error.code === 'protocol');
		}
	});

	test('non-assessment uploader still cannot transmit assessment envelopes or fabricate a permit', async () => {
		uploadMode = 'auth'; await pairStart(); const event = await captureFile(); await until(() => received.length > 0, 'pending assessment'); await delivery.disable();
		const scoped = await queue.getEvidenceConsent(event.sessionId); const currentStatus = await api.getStatus(await identity(), AbortSignal.timeout(1000));
		const binding = { codingSessionId: '42', origin, consentReceiptId: scoped!.receipt!.consent_id, serverTime: currentStatus.serverTime };
		let transmitted = false;
		const uploader = new EventUploader(new EventBatchManager(queue), queue, { get: async () => TOKEN }, { endpoint: origin + BASE + '/events',
			confirmUpload: async () => true, privacyContext: row => queue.getAssessmentUploadContext(row, binding), baseDelayMs: 100, maxDelayMs: 100,
			assessmentPermit: async () => ({ contract: 'rails-assessment-events.v1' }), assessmentStillApproved: async () => true
		}, { send: async () => { transmitted = true; throw new Error('No transport expected'); } });
		assert.equal(await uploader.enable(), true); await wait(250); assert.equal(await uploader.uploadOnce(), 'privacy');
		assert.equal(transmitted, false); assert.equal(await queue.getPendingCount(), 1); await uploader.dispose();
	});
});
