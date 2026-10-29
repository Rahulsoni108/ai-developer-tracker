import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RecordingController } from '../recording';
import { AssessmentController, type AssessmentEvidence, type AssessmentView } from '../assessmentController';
import { AssessmentConnectionStore, ASSESSMENT_METADATA_KEY, type AssessmentStore, type AssessmentMetadata } from '../assessmentStorage';
import { AssessmentApiError, MockAssessmentApiClient, UnavailableAssessmentApiClient } from '../assessmentApiClient';
import { RailsAssessmentApiClient } from '../railsAssessmentApiClient';

suite('Assessment lifecycle foundation', () => {
	let controller: AssessmentController; let recording: RecordingController; let mock: MockAssessmentApiClient; let store: AssessmentStore;
	let state: Map<string, unknown>; let secrets: Map<string, string>; let views: AssessmentView[]; let serverTime: number;
	let recordingConsent: boolean; let uploadConsent: boolean; let recordingDialogs: number; let uploadDialogs: number;
	let starts: number; let submits: number; let flushes: number; let disables: number;
	let pending: number; let total: number; let missing: number; let failFlush: boolean; let evidence: AssessmentEvidence;
	function newRecording(): void {
		recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => { recordingDialogs++; return recordingConsent; });
	}
	function newController(): void {
		controller = new AssessmentController(mock, store, recording, evidence, async host => { assert.equal(host, 'assessment.invalid'); uploadDialogs++; return uploadConsent; },
			view => views.push(view), 100);
	}
	const metadata = () => state.get(ASSESSMENT_METADATA_KEY) as AssessmentMetadata;
	async function paired(): Promise<void> { await controller.pair('DUMMY-PAIR'); assert.equal(controller.view.state, 'paired'); }
	setup(async () => {
		state = new Map(); secrets = new Map(); views = []; serverTime = Date.parse('2030-01-01T00:00:00.000Z');
		recordingConsent = true; uploadConsent = true; recordingDialogs = 0; uploadDialogs = 0; starts = 0; submits = 0; flushes = 0; disables = 0;
		pending = 0; total = 0; missing = 0; failFlush = false;
		store = new AssessmentConnectionStore({ get: <T>(key: string, defaultValue?: T) => (state.get(key) ?? defaultValue) as T,
			update: async (key, value) => { state.set(key, structuredClone(value)); } }, {
			get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }
		});
		mock = new MockAssessmentApiClient(() => new Date(serverTime)); mock.seedInvitation('DUMMY-PAIR', '42');
		const start = mock.startOrResume.bind(mock); mock.startOrResume = async (...args) => {
			starts++; assert.equal(recording.isRecording, false); return start(...args);
		};
		const submit = mock.submit.bind(mock); mock.submit = async (...args) => { submits++; assert.equal(recording.isRecording, false); return submit(...args); };
		evidence = { flushStopped: async () => { flushes++; if (failFlush) { throw new AssessmentApiError('storage'); } },
			getStatus: async () => ({ totalEvents: total, pendingEvents: pending, missingSessions: missing }), disableDevelopmentUploads: async () => { disables++; } };
		newRecording(); newController(); await controller.initialize();
	});
	teardown(async () => { await controller.dispose(); recording.dispose(); });

	test('exposes the configured Rails mode before pairing without creating a connection or sending requests', async () => {
		await controller.dispose();
		let requests = 0;
		const api = new RailsAssessmentApiClient('https://assessment.invalid', { send: async () => { requests++; throw new Error('Unexpected request'); } });
		controller = new AssessmentController(api, store, recording, evidence, async () => true, view => views.push(view));
		try {
			await controller.initialize(); await controller.showStatus();
			assert.equal(controller.mode, 'rails'); assert.equal(controller.view.state, 'unpaired');
			assert.equal(controller.view.mode, 'rails'); assert.equal(views.at(-1)?.mode, 'rails');
			assert.equal(controller.view.uploadConsent, false); assert.equal(recording.isRecording, false);
			assert.equal(requests, 0); assert.equal(state.size, 0); assert.equal(secrets.size, 0);
		} finally { api.dispose(); }
	});

	test('pairing preserves Rails identity, writes only allowlisted metadata and stores credentials only in SecretStorage', async () => {
		await paired(); assert.equal(recording.isRecording, false); assert.equal(metadata().connection.codingSessionId, '42');
		assert.equal(secrets.size, 1); const serialized = JSON.stringify([...state]);
		assert.equal(serialized.includes('DUMMY-PAIR'), false); for (const value of secrets.values()) { assert.equal(serialized.includes(value), false); }
		assert.equal(JSON.stringify(controller.view).includes('42'), false); assert.equal(recordingDialogs, 0);
	});
	test('rejected/unclaimed pairing never creates context or starts recording', async () => {
		mock.seedInvitation('UNCLAIMED', '43', false); await controller.pair('UNCLAIMED');
		assert.equal(controller.view.reason, 'rejected'); assert.equal(state.size, 0); assert.equal(recording.isRecording, false);
		await controller.start(); assert.equal(starts, 0); assert.equal(recordingDialogs, 0);
	});
	test('unavailable backend fails closed and does not invent a session', async () => {
		await controller.dispose(); controller = new AssessmentController(new UnavailableAssessmentApiClient(), store, recording, evidence, async () => true);
		await controller.initialize(); await controller.pair('DUMMY-PAIR'); await controller.start();
		assert.equal(recording.isRecording, false); assert.equal(state.size, 0); assert.equal(secrets.size, 0);
	});
	test('recording refusal makes no start request; upload refusal also prevents authorization and capture', async () => {
		await paired(); recordingConsent = false; await controller.start(); assert.equal(starts, 0); assert.equal(uploadDialogs, 0);
		recordingConsent = true; uploadConsent = false; await controller.start();
		assert.equal(starts, 0); assert.equal(recording.isRecording, false); assert.equal(controller.view.reason, 'consent_required');
	});
	test('server authorizes and binds a different local UUID before collectors start; concurrent/repeated starts are idempotent', async () => {
		await paired(); const first = controller.start(); assert.equal(first, controller.start()); await first; await controller.start();
		assert.equal(starts, 1); assert.equal(recordingDialogs, 1); assert.equal(uploadDialogs, 1); assert.equal(disables, 1);
		assert.equal(controller.view.state, 'active'); assert.notEqual(recording.sessionId, '42');
		assert.deepEqual(metadata().localRecordingSessionIds, [recording.sessionId]);
		assert.deepEqual(metadata().serverStatus.localRecordingSessionIds, [recording.sessionId]);
		assert.ok(views.some(view => view.state === 'starting')); assert.equal(controller.allowsDevelopmentUpload(recording.sessionId!), false);
		assert.equal(controller.allowsDevelopmentUpload(randomUUID()), true);
	});
	test('network start failure and missing authentication never activate recording', async () => {
		await paired(); mock.startOrResume = async () => { throw new Error('PRIVATE_NETWORK_DETAIL'); }; await controller.start();
		assert.equal(recording.isRecording, false); assert.equal(controller.view.state, 'recovery');
		secrets.clear(); await controller.start(); assert.equal(controller.view.reason, 'authentication');
		assert.equal(JSON.stringify(views).includes('PRIVATE_NETWORK_DETAIL'), false);
	});
	test('stop drains before checking delivery; pending/missing evidence never calls finalize', async () => {
		await paired(); await controller.start(); pending = 2; total = 2; await controller.stopAndSubmit();
		assert.equal(recording.isRecording, false); assert.equal(controller.view.state, 'submission_pending'); assert.equal(submits, 0); assert.ok(flushes > 0);
		pending = 0; missing = 1; await controller.stopAndSubmit(); assert.equal(submits, 0);
		await controller.start(); assert.equal(recording.isRecording, false); assert.equal(starts, 1);
	});
	test('only acknowledged evidence plus explicit server finalization reaches submitted', async () => {
		await paired(); await controller.start(); total = 3; mock.setAcceptedEventCount('42', 3);
		await controller.stopAndSubmit(); assert.equal(controller.view.state, 'submitted'); assert.equal(submits, 1);
		assert.ok(views.some(view => view.state === 'stopping')); await controller.stopAndSubmit(); assert.equal(submits, 1);
	});
	test('local queue failure preserves pending submission and prevents finalization', async () => {
		await paired(); await controller.start(); failFlush = true; await controller.stopAndSubmit();
		assert.equal(controller.view.state, 'submission_pending'); assert.equal(controller.view.reason, 'storage'); assert.equal(submits, 0);
		assert.equal(recording.isRecording, false);
	});
	test('lost finalize response retries the same persisted request and never reports false success', async () => {
		await paired(); await controller.start(); const real = mock.submit.bind(mock); const requestId = metadata().submitRequestId;
		mock.submit = async (...args) => { await real(...args); throw new Error('lost response'); };
		await controller.stopAndSubmit(); assert.equal(controller.view.state, 'submission_pending');
		mock.submit = real; await controller.showStatus(); assert.equal(controller.view.state, 'submitted');
		assert.equal(metadata().submitRequestId, requestId);
	});
	test('server submitted status cannot hide unacknowledged or missing local evidence', async () => {
		await paired(); await controller.start(); const original = mock.getStatus.bind(mock);
		mock.getStatus = async (...args) => ({ ...await original(...args), state: 'submitted' }); pending = 1; total = 1;
		await controller.showStatus(); assert.equal(controller.view.state, 'submission_pending'); assert.equal(recording.isRecording, false);
	});
	test('restart resumes the same Rails attempt with fresh consent and an unchanged server deadline', async () => {
		await paired(); await controller.start(); const oldLocal = recording.sessionId; const deadline = controller.view.deadline;
		await controller.dispose(); recording.dispose(); serverTime += 60000; newRecording(); newController(); await controller.initialize();
		assert.equal(controller.view.state, 'recovery'); assert.equal(recording.isRecording, false); assert.equal(controller.view.uploadConsent, false);
		await controller.start(); assert.equal(controller.view.state, 'active'); assert.equal(metadata().connection.codingSessionId, '42');
		assert.equal(controller.view.deadline, deadline); assert.notEqual(recording.sessionId, oldLocal);
		assert.equal(recordingDialogs, 2); assert.equal(uploadDialogs, 2); assert.equal(metadata().localRecordingSessionIds.length, 2);
		assert.equal(controller.view.remainingMsAtLastCheck, 3540000);
	});
	test('restart with submission pending never restarts recording; failed status stays recoverable', async () => {
		await paired(); await controller.start(); pending = 1; total = 1; await controller.stopAndSubmit();
		await controller.dispose(); recording.dispose(); newRecording(); newController(); await controller.initialize();
		await controller.start(); assert.equal(recording.isRecording, false); assert.equal(starts, 1);
		mock.getStatus = async () => { throw new Error('offline'); }; await controller.showStatus(); assert.equal(controller.view.state, 'submission_pending');
	});
	test('server deadline changes or mismatched IDs are rejected; the local clock never extends the deadline', async () => {
		await paired(); await controller.start(); const deadline = controller.view.deadline; const original = mock.getStatus.bind(mock);
		mock.getStatus = async (...args) => ({ ...await original(...args), deadline: '2030-01-01T02:00:00.000Z' });
		await controller.showStatus(); assert.equal(controller.view.reason, 'protocol'); assert.equal(controller.view.deadline, deadline); assert.equal(recording.isRecording, false);
		mock.getStatus = async (...args) => ({ ...await original(...args), codingSessionId: '99' });
		await controller.start(); assert.equal(controller.view.reason, 'protocol'); assert.equal(recording.isRecording, false);
	});
	test('expired server state stops local capture and cannot reset the deadline', async () => {
		await paired(); await controller.start(); serverTime += 3600001; const deadline = controller.view.deadline;
		await controller.showStatus(); assert.equal(recording.isRecording, false); assert.equal(controller.view.reason, 'session_ended');
		await controller.start(); assert.equal(starts, 1); assert.equal(controller.view.deadline, deadline);
	});
	test('manual development recording remains independent and cannot be adopted as an assessment', async () => {
		await recording.start(); const local = recording.sessionId; await controller.pair('DUMMY-PAIR');
		assert.equal(controller.view.reason, 'recording_busy'); assert.equal(recording.sessionId, local);
		recording.stop(); await paired(); await recording.start(); await controller.start();
		assert.equal(controller.view.reason, 'recording_busy'); assert.equal(starts, 0); assert.equal(recording.isRecording, true);
	});
	test('a manual recording that starts during server-status lookup is rejected by the second guard without creating a binding', async () => {
		await paired(); const before = structuredClone(metadata()); const original = mock.getStatus.bind(mock);
		mock.getStatus = async (...args) => { await recording.start(); return original(...args); };
		await controller.start(); const manual = recording.sessionId!;
		assert.equal(controller.view.reason, 'recording_busy'); assert.equal(controller.view.lastStart?.step, 'manual_recording_active');
		assert.equal(controller.view.state, 'paired'); assert.equal(starts, 0); assert.equal(uploadDialogs, 0);
		assert.equal(controller.isAssociatedSession(manual), false); assert.deepEqual(metadata().localRecordingSessionIds, []);
		assert.equal(metadata().submitRequestId, before.submitRequestId); assert.equal(metadata().serverStatus.startedAt, undefined);
	});
	test('revocation invalidates delayed consent and never starts recording', async () => {
		await controller.dispose(); let approve!: (yes: boolean) => void; let opened!: () => void;
		const visible = new Promise<void>(resolve => { opened = resolve; });
		controller = new AssessmentController(mock, store, recording, evidence, () => { opened(); return new Promise(resolve => { approve = resolve; }); });
		await controller.initialize(); await paired(); const starting = controller.start(); await visible; controller.revokeUploadConsent(); approve(true); await starting;
		assert.equal(recording.isRecording, false); assert.equal(starts, 0); assert.equal(controller.view.uploadConsent, false);
	});
	test('bounded request timeout prevents a hung backend from activating recording', async () => {
		await paired(); mock.startOrResume = async () => new Promise(() => {}); await controller.start();
		assert.equal(recording.isRecording, false); assert.equal(controller.view.reason, 'unavailable');
	});

	test('Stop during delayed recording/upload consent cancels start without creating a timer or submission', async () => {
		await controller.dispose(); let accept!: (value: boolean) => void; let opened!: () => void;
		const visible = new Promise<void>(resolve => { opened = resolve; });
		controller = new AssessmentController(mock, store, recording, evidence, () => { opened(); return new Promise(resolve => { accept = resolve; }); });
		await controller.initialize(); await paired(); const starting = controller.start(); await visible;
		const stopping = controller.stopAndSubmit(); accept(true); await starting; await stopping;
		assert.equal(recording.isRecording, false); assert.equal(starts, 0); assert.equal(submits, 0);
		assert.equal(controller.view.state, 'paired'); assert.equal(controller.view.deadline, undefined);
	});

	test('a lost start response recovers its durable binding without resetting the server timer', async () => {
		await paired(); const actual = mock.startOrResume.bind(mock);
		mock.startOrResume = async (...args) => { await actual(...args); throw new Error('lost start response'); };
		await controller.start(); assert.equal(recording.isRecording, false); assert.equal(controller.view.state, 'recovery');
		await controller.dispose(); recording.dispose(); serverTime += 60000; mock.startOrResume = actual; newRecording(); newController(); await controller.initialize();
		assert.equal(controller.view.deadline, '2030-01-01T01:00:00.000Z');
		await controller.start(); assert.equal(controller.view.state, 'active'); assert.equal(controller.view.deadline, '2030-01-01T01:00:00.000Z');
		assert.equal(metadata().localRecordingSessionIds.length, 2);
	});
	test('storage failure before server binding aborts start without recording', async () => {
		await paired(); store.save = async () => { throw new Error('PRIVATE_STORAGE'); }; await controller.start();
		assert.equal(recording.isRecording, false); assert.equal(starts, 0); assert.equal(controller.view.reason, 'storage');
		assert.equal(JSON.stringify(views).includes('PRIVATE_STORAGE'), false);
	});
	test('malformed persisted connection metadata fails closed without leaking values', async () => {
		await controller.dispose(); state.set(ASSESSMENT_METADATA_KEY, { version: 1, connection: { apiOrigin: 'https://user:PRIVATE@host' } });
		newController(); await controller.initialize(); assert.equal(controller.view.reason, 'storage');
		assert.equal(controller.allowsDevelopmentUpload(randomUUID()), false); assert.equal(JSON.stringify(controller.view).includes('PRIVATE'), false);
	});
});
