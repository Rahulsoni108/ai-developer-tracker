import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { openTestWorkerQueue } from './queueTestKeys';
import { AssessmentEvidenceConsent } from '../assessmentEvidenceConsent';
import { RailsEvidenceConsentClient } from '../railsEvidenceConsentClient';
import { AssessmentApiError, MockAssessmentApiClient, type AssessmentAuthentication, type AssessmentServerStatus } from '../assessmentApiClient';
import { consentCoversEvent, validConsentReceipt, type EvidenceConsentState, type EvidenceConsentReceipt } from '../evidenceConsent';
import { type UploadHttpRequest } from '../httpsEventTransport';
import { createFileEvent } from '../eventSchema';
import { EventPersistence } from '../eventPersistence';
import { AssessmentController } from '../assessmentController';
import { AssessmentConnectionStore } from '../assessmentStorage';
import { RecordingController } from '../recording';

const workspaceId = 'a'.repeat(64);
const now = '2030-01-01T10:00:01.000Z';
const deadline = '2030-01-01T11:00:00.000Z';
const auth: AssessmentAuthentication = { credential: 'dummy-session-scoped-secret', connection: { codingSessionId: '42', apiOrigin: 'https://assessment.invalid',
	uploadEndpoint: 'https://assessment.invalid/api/v2/coding_session/extension/events', mode: 'mock' } };

suite('Rails scoped evidence consent integration', function () {
	this.timeout(15000);
	let root: string; let queue: AsyncLocalEventQueue; let coordinator: AssessmentEvidenceConsent;
	let localId: string; let serverStatus: AssessmentServerStatus; let calls: UploadHttpRequest[];
	let expectedToken: string; let receipt: EvidenceConsentReceipt | undefined; let fail: boolean; let corrupt: (value: EvidenceConsentReceipt) => EvidenceConsentReceipt;
	const storage = () => ({ scheme: 'file', fsPath: join(root, 'queue') });
	const scope = () => ({ workspaceIds: [workspaceId], eventTypes: ['file.modified' as const] });
	const signal = () => AbortSignal.timeout(2000);
	const file = () => createFileEvent({ sessionId: localId, workspaceId, source: 'vscode', eventType: 'file.modified', timestamp: new Date(now), payload: { relativePath: 'app.ts' } });
	const client = () => new RailsEvidenceConsentClient({ send: async request => {
		calls.push(request); if (fail) { throw new Error('dummy private transport details'); }
		assert.equal(request.token, expectedToken); const body = JSON.parse(request.body);
		if (!receipt) {
			receipt = { consent_id: randomUUID(), local_recording_session_id: body.local_recording_session_id, consent_version: body.consent_version,
				scope: body.scope, approved_workspace_ids: body.approved_workspace_ids, event_types: body.event_types,
				destination_origin: auth.connection.apiOrigin, consented_at: now, expires_at: deadline, server_time: now, state: 'active',
				evidence_window: { starts_at: now, ends_at: deadline }, upload_authorized: false, privacy_authorization: 'unverified' };
		}
		if (request.method === 'DELETE') { receipt = { ...receipt, state: 'revoked', revoked_at: now }; }
		if (request.endpoint.pathname.endsWith('/stop')) { receipt = { ...receipt, state: receipt.state === 'revoked' ? 'revoked' : 'stopped',
			evidence_window: { ...receipt.evidence_window, ends_at: now, stopped_at: now } }; }
		return { status: 200, contentType: 'application/json', body: JSON.stringify({ data: corrupt(structuredClone(receipt)) }) };
	} });
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'rails-consent-')); queue = await openTestWorkerQueue(storage(), []); localId = randomUUID(); calls = [];
		expectedToken = auth.credential; receipt = undefined; fail = false; corrupt = value => value;
		serverStatus = { codingSessionId: '42', state: 'active', serverTime: now, startedAt: now, deadline, localRecordingSessionIds: [localId] };
		coordinator = new AssessmentEvidenceConsent(queue, client(), scope);
	});
	teardown(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });

	test('registers only the documented explicit scope and pins bearer, destination and Rails/local identities', async () => {
		await coordinator.approve(auth, localId, serverStatus, signal());
		assert.equal(calls.length, 1); assert.equal(calls[0].method, 'POST');
		assert.equal(calls[0].endpoint.href, auth.connection.apiOrigin + '/api/v2/coding_session/extension/evidence_consents');
		const body = JSON.parse(calls[0].body);
		assert.deepEqual(Object.keys(body).sort(), ['request_id', 'local_recording_session_id', 'approval_action', 'consent_version', 'scope', 'approved_workspace_ids', 'event_types'].sort());
		assert.equal(body.approval_action, 'approve_upload'); assert.equal(body.local_recording_session_id, localId);
		assert.equal(calls[0].body.includes('dummy-session-scoped-secret'), false); assert.equal(Object.hasOwn(body, 'coding_session_id'), false);
		const state = (await queue.getEvidenceConsent(localId))!; assert.equal(state.pendingAction, undefined);
		assert.equal(state.receipt!.upload_authorized, false); assert.equal(consentCoversEvent(state, file()), true);
	});
	test('duplicate registration retries preserve request key, server expiry and original receipt', async () => {
		await coordinator.approve(auth, localId, serverStatus, signal()); const first = await queue.getEvidenceConsent(localId);
		await Promise.all([coordinator.approve(auth, localId, serverStatus, signal()), coordinator.approve(auth, localId, serverStatus, signal())]);
		assert.equal(new Set(calls.map(call => JSON.parse(call.body).request_id)).size, 1);
		assert.deepEqual(await queue.getEvidenceConsent(localId), first);
	});
	test('an assessment receipt never grants event privacy approval or generic upload permission', async () => {
		await coordinator.approve(auth, localId, serverStatus, signal());
		const writer = new EventPersistence(queue, { write: async () => {}, flush: async () => {} }, undefined, { context: () => ({ recordingActive: true,
			sessionId: localId, approvedWorkspaceIds: [workspaceId], confirmedCodexSessions: [], codexContentConsent: false }) });
		const event = file(); await writer.write(event);
		assert.equal(await writer.resolveUploadPrivacyContext(event), undefined); assert.equal(await queue.getPendingCount(), 1);
		assert.equal(await writer.resolveUploadPrivacyContext({ ...event, sessionId: randomUUID() }), undefined);
		await writer.flush();
	});
	test('server-provided capture window and scope exclude wrong workspace, type, recording, and late evidence', async () => {
		await coordinator.approve(auth, localId, serverStatus, signal()); const state = (await queue.getEvidenceConsent(localId))!;
		for (const event of [{ ...file(), workspaceId: 'b'.repeat(64) }, { ...file(), sessionId: randomUUID() },
			{ ...file(), eventType: 'file.saved' as const }, { ...file(), timestamp: '2030-01-01T11:00:01.000Z' },
			{ ...file(), timestamp: '2030-01-01T10:00:00.000Z' }]) { assert.equal(consentCoversEvent(state, event), false); }
		assert.equal(consentCoversEvent({ ...state, captureClosed: true }, file()), false);
	});
	test('network failure retains the original registration intent for explicit retry after restart', async () => {
		fail = true; await assert.rejects(coordinator.approve(auth, localId, serverStatus, signal()), AssessmentApiError);
		const intent = (await queue.getEvidenceConsent(localId))!; assert.equal(intent.pendingAction, 'register'); assert.equal(intent.receipt, undefined);
		await queue.close(); queue = await openTestWorkerQueue(storage(), []); coordinator = new AssessmentEvidenceConsent(queue, client(), scope);
		assert.deepEqual(await queue.getEvidenceConsent(localId), intent); fail = false;
		await coordinator.approve(auth, localId, serverStatus, signal()); assert.equal(JSON.parse(calls[1].body).request_id, intent.request.request_id);
	});
	test('stop/revoke failures block locally, persist pending mutations, and retry the same receipt after restart', async () => {
		await coordinator.approve(auth, localId, serverStatus, signal()); const id = receipt!.consent_id;
		fail = true; await assert.rejects(coordinator.close(auth, localId, signal()));
		assert.equal((await queue.getEvidenceConsent(localId))!.captureClosed, true);
		assert.equal((await queue.getEvidenceConsent(localId))!.pendingAction, 'stop');
		await queue.close(); queue = await openTestWorkerQueue(storage(), []); coordinator = new AssessmentEvidenceConsent(queue, client(), scope);
		fail = false; await coordinator.close(auth, localId, signal());
		assert.equal((await queue.getEvidenceConsent(localId))!.receipt!.state, 'stopped');
		fail = true; await assert.rejects(coordinator.revoke(auth, localId, signal()));
		assert.equal((await queue.getEvidenceConsent(localId))!.locallyRevoked, true);
		fail = false; await coordinator.revoke(auth, localId, signal()); await coordinator.revoke(auth, localId, signal());
		assert.equal((await queue.getEvidenceConsent(localId))!.receipt!.state, 'revoked');
		for (const call of calls.filter(call => call.method === 'DELETE' || call.endpoint.pathname.endsWith('/stop'))) {
			assert.deepEqual(JSON.parse(call.body), { consent_id: id, local_recording_session_id: localId });
		}
		await assert.rejects(coordinator.approve(auth, localId, serverStatus, signal()));
	});

	test('withdrawal after a lost registration response never replays approval or fabricates a receipt', async () => {
		fail = true; await assert.rejects(coordinator.approve(auth, localId, serverStatus, signal()));
		assert.equal(calls.length, 1); fail = false;
		await assert.rejects(coordinator.revoke(auth, localId, signal()), error => error instanceof AssessmentApiError && error.code === 'recovery_required');
		assert.equal(calls.length, 1);
		const state = (await queue.getEvidenceConsent(localId))!;
		assert.equal(state.locallyRevoked, true); assert.equal(state.pendingAction, 'revoke'); assert.equal(state.receipt, undefined);
		await queue.close(); queue = await openTestWorkerQueue(storage(), []); coordinator = new AssessmentEvidenceConsent(queue, client(), scope);
		await assert.rejects(coordinator.approve(auth, localId, serverStatus, signal())); assert.equal(calls.length, 1);
	});
	test('cannot attach approval retroactively or change assessment, destination, scope, or request parameters', async () => {
		await coordinator.approve(auth, localId, serverStatus, signal()); const state = (await queue.getEvidenceConsent(localId))!;
		for (const changed of [{ ...state, codingSessionId: '43' }, { ...state, request: { ...state.request, request_id: randomUUID() } },
			{ ...state, origin: 'https://other.invalid', receipt: undefined }, { ...state, deadline: '2030-01-01T12:00:00.000Z' }]) { await assert.rejects(queue.setEvidenceConsent(changed)); }
		await assert.rejects(coordinator.close({ ...auth, connection: { ...auth.connection, codingSessionId: '43' } }, localId, signal()));
		const oldId = randomUUID(); await queue.enqueue({ ...file(), eventId: randomUUID(), sessionId: oldId });
		await assert.rejects(coordinator.approve(auth, oldId, { ...serverStatus, localRecordingSessionIds: [oldId] }, signal()));
	});
	test('rejects expired, forged, foreign, or extended receipts and never changes server timing to fit', async () => {
		for (const transform of [(value: EvidenceConsentReceipt) => ({ ...value, local_recording_session_id: randomUUID() }),
			(value: EvidenceConsentReceipt) => ({ ...value, expires_at: '2030-01-01T12:00:00.000Z' }),
			(value: EvidenceConsentReceipt) => ({ ...value, destination_origin: 'https://other.invalid' }),
			(value: EvidenceConsentReceipt) => ({ ...value, server_time: deadline }),
			(value: EvidenceConsentReceipt) => ({ ...value, upload_authorized: true } as unknown as EvidenceConsentReceipt)]) {
			corrupt = transform; await assert.rejects(coordinator.approve(auth, localId, serverStatus, signal()));
			assert.equal((await queue.getEvidenceConsent(localId))!.receipt, undefined);
		}
		corrupt = value => value; await coordinator.approve(auth, localId, serverStatus, signal());
		const state = (await queue.getEvidenceConsent(localId))!;
		assert.equal(validConsentReceipt({ ...state.receipt!, state: 'expired', server_time: deadline }, state), true);
		await assert.rejects(coordinator.approve(auth, localId, { ...serverStatus, serverTime: deadline }, signal()));
	});
	test('HTTP 403 remains a hard failure, never an opt-in bypass or acknowledgment', async () => {
		const denied = new AssessmentEvidenceConsent(queue, new RailsEvidenceConsentClient({ send: async () => ({ status: 403, contentType: 'application/json', body: '{"error":"private details"}' }) }), scope);
		await assert.rejects(denied.approve(auth, localId, serverStatus, signal()), error => {
			assert.ok(error instanceof AssessmentApiError); assert.equal(error.code, 'authentication'); assert.equal(error.message.includes('private details'), false); return true;
		});
		assert.equal((await queue.getEvidenceConsent(localId))!.pendingAction, 'register'); assert.equal(await queue.getPendingCount(), 0);
	});
	test('assessment lifecycle requires separate upload consent, registers before capture, and drains before window closure', async () => {
		const stateValues = new Map<string, unknown>(); const tokens = new Map<string, string>();
		const store = new AssessmentConnectionStore({ get: <T>(key: string, fallback?: T) => (stateValues.get(key) ?? fallback) as T,
			update: async (key, value) => { stateValues.set(key, structuredClone(value)); } }, { get: async key => tokens.get(key), store: async (key, value) => { tokens.set(key, value); } });
		const api = new MockAssessmentApiClient(() => new Date(now)); api.seedInvitation('DUMMY-PAIR', '42');
		const recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true);
		let uploadConsent = false; let flushed = false; const order: string[] = [];
		const lifecycle = new AssessmentEvidenceConsent(queue, { register: async (_auth, intent) => {
			order.push('register'); assert.equal(recording.isRecording, false);
			return { consent_id: randomUUID(), local_recording_session_id: intent.request.local_recording_session_id,
				consent_version: 'assessment-evidence.v1', scope: 'assessment_evidence', approved_workspace_ids: [workspaceId], event_types: ['file.modified'],
				destination_origin: auth.connection.apiOrigin, consented_at: now, expires_at: intent.deadline, server_time: now, state: 'active',
				evidence_window: { starts_at: now, ends_at: intent.deadline }, upload_authorized: false, privacy_authorization: 'unverified' };
		}, stop: async (_auth, intent) => { order.push('stop'); assert.equal(flushed, true); assert.equal(recording.isRecording, false);
			return { ...intent.receipt!, state: 'stopped', evidence_window: { starts_at: now, ends_at: now, stopped_at: now } }; },
			revoke: async (_auth, intent) => ({ ...intent.receipt!, state: 'revoked', revoked_at: now }) }, scope);
		const controller = new AssessmentController(api, store, recording, { flushStopped: async () => { flushed = true; }, getStatus: async () => ({ totalEvents: 1, pendingEvents: 1, missingSessions: 0 }),
			disableDevelopmentUploads: async () => {} }, async () => uploadConsent, undefined, 2000, lifecycle);
		try {
			await controller.initialize(); await controller.pair('DUMMY-PAIR'); await controller.start();
			assert.equal(recording.isRecording, false); assert.deepEqual(order, []);
			uploadConsent = true; await controller.start(); assert.equal(recording.isRecording, true); assert.deepEqual(order, ['register']);
			const local = recording.sessionId!; assert.equal((await queue.getEvidenceConsent(local))!.codingSessionId, '42');
			await controller.stopAndSubmit(); assert.deepEqual(order, ['register', 'stop']); assert.equal(controller.view.state, 'submission_pending');
			await controller.revokeUploadConsent(); assert.equal((await queue.getEvidenceConsent(local))!.locallyRevoked, true);
		} finally { await controller.dispose(); recording.dispose(); }
	});

	test('local-only mock keeps a blocked scope and shutdown closes capture without fabricating a server receipt', async () => {
		const values = new Map<string, unknown>(); const tokens = new Map<string, string>();
		const store = new AssessmentConnectionStore({ get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T,
			update: async (key, value) => { values.set(key, structuredClone(value)); } }, { get: async key => tokens.get(key), store: async (key, value) => { tokens.set(key, value); } });
		const api = new MockAssessmentApiClient(() => new Date(now)); api.seedInvitation('DUMMY-MOCK', '42');
		const recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true);
		const localOnly = new AssessmentEvidenceConsent(queue, undefined, scope);
		const controller = new AssessmentController(api, store, recording, { flushStopped: async () => {}, getStatus: async () => ({ totalEvents: 0, pendingEvents: 0, missingSessions: 0 }),
			disableDevelopmentUploads: async () => {} }, async () => true, undefined, 2000, localOnly);
		await controller.initialize(); await controller.pair('DUMMY-MOCK'); await controller.start(); const id = recording.sessionId!;
		assert.equal(recording.isRecording, true); assert.equal((await queue.getEvidenceConsent(id))!.receipt, undefined);
		await controller.dispose(); recording.dispose(); assert.equal(recording.isRecording, false);
		const state = (await queue.getEvidenceConsent(id))!; assert.equal(state.captureClosed, true); assert.equal(state.pendingAction, 'stop'); assert.equal(state.receipt, undefined);
		assert.deepEqual(calls, []);
	});
	test('restart closes a previously open server capture window without resuming recording or upload consent', async () => {
		const values = new Map<string, unknown>(); const tokens = new Map<string, string>();
		const store = new AssessmentConnectionStore({ get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T,
			update: async (key, value) => { values.set(key, structuredClone(value)); } }, { get: async key => tokens.get(key), store: async (key, value) => { tokens.set(key, value); } });
		const api = new MockAssessmentApiClient(() => new Date(now)); api.seedInvitation('DUMMY-RESTART', '42');
		const newRecording = () => new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true);
		const evidence = { flushStopped: async () => {}, getStatus: async () => ({ totalEvents: 0, pendingEvents: 0, missingSessions: 0 }), disableDevelopmentUploads: async () => {} };
		const firstRecording = newRecording();
		// Old controller has no consent-shutdown adapter, representing a crash before the close callback.
		const first = new AssessmentController(api, store, firstRecording, evidence, async () => true);
		await first.initialize(); await first.pair('DUMMY-RESTART'); await first.start();
		const metadata = (await store.load())!; const local = firstRecording.sessionId!;
		expectedToken = (await store.getCredential(metadata.credentialId))!;
		await coordinator.approve({ connection: metadata.connection, credential: expectedToken }, local, metadata.serverStatus, signal());
		assert.equal((await queue.getEvidenceConsent(local))!.captureClosed, false);
		await first.dispose(); firstRecording.dispose(); await queue.close(); queue = await openTestWorkerQueue(storage(), []);
		coordinator = new AssessmentEvidenceConsent(queue, client(), scope);
		const restoredRecording = newRecording(); const restored = new AssessmentController(api, store, restoredRecording, evidence, async () => false, undefined, 2000, coordinator);
		try {
			await restored.initialize(); assert.equal(restoredRecording.isRecording, false); assert.equal(restored.view.uploadConsent, false);
			const state = (await queue.getEvidenceConsent(local))!;
			assert.equal(state.captureClosed, true); assert.equal(state.receipt!.state, 'stopped');
			assert.equal((await store.load())!.serverStatus.deadline, metadata.serverStatus.deadline);
		} finally { await restored.dispose(); restoredRecording.dispose(); }
	});

});
