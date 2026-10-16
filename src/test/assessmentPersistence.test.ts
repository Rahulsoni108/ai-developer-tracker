import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { EventPersistence } from '../eventPersistence';
import { RecordingController } from '../recording';
import { AssessmentController } from '../assessmentController';
import { MockAssessmentApiClient } from '../assessmentApiClient';
import { AssessmentConnectionStore, ASSESSMENT_METADATA_KEY, type AssessmentMetadata } from '../assessmentStorage';
import { EventBatchManager } from '../eventBatchManager';
import { createFileEvent } from '../eventSchema';

suite('Assessment encrypted queue and restart boundaries', () => {
	let root: string; let queue: AsyncLocalEventQueue; let persistence: EventPersistence; let recording: RecordingController; let assessment: AssessmentController;
	let mock: MockAssessmentApiClient; let state: Map<string, unknown>; let secrets: Map<string, string>;
	const storage = () => ({ scheme: 'file', fsPath: root });
	async function openPipeline(): Promise<void> {
		queue = await AsyncLocalEventQueue.open(storage(), [], {}, { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); } });
		recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => true);
		persistence = new EventPersistence(queue, { write: async () => {}, flush: async () => {} });
		persistence.attachRecording(recording, () => ({ approvedWorkspaceIds: ['workspace'], confirmedCodexSessions: [], codexContentConsent: false }));
		assessment = new AssessmentController(mock, new AssessmentConnectionStore({ get: <T>(key: string, fallback?: T) => (state.get(key) ?? fallback) as T,
			update: async (key, value) => { state.set(key, structuredClone(value)); } }, { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); } }),
			recording, { flushStopped: async id => { await persistence.flush(); await persistence.completeSession(id); },
				getStatus: ids => queue.getSessionEvidenceStatus(ids), disableDevelopmentUploads: async () => {} }, async () => true);
		await assessment.initialize();
	}
	async function closePipeline(): Promise<void> { await assessment.dispose(); recording.stop(); await persistence.close(); recording.dispose(); }
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'ai-assessment-queue-')); state = new Map(); secrets = new Map();
		mock = new MockAssessmentApiClient(); mock.seedInvitation('FIXTURE-PAIR', '42'); await openPipeline();
	});
	teardown(async () => { await closePipeline(); await rm(root, { recursive: true, force: true }); });

	test('submission waits for actual durable acknowledgments and ignores unrelated pending recordings', async () => {
		await assessment.pair('FIXTURE-PAIR'); await assessment.start(); const local = recording.sessionId!;
		const input = createFileEvent({ sessionId: local, source: 'vscode', workspaceId: 'workspace', eventType: 'file.saved', payload: { relativePath: 'app.ts' } });
		await persistence.write(input); await assessment.stopAndSubmit();
		assert.equal(assessment.view.state, 'submission_pending');
		assert.deepEqual(await queue.getSessionEvidenceStatus([local]), { totalEvents: 1, pendingEvents: 1, missingSessions: 0 });
		assert.equal(assessment.allowsDevelopmentUpload(local), false);
		const batches = new EventBatchManager(queue); const batch = (await batches.prepareBatch(10, 1048576))!;
		assert.deepEqual(batch.events, [input]);
		// Simulated server durable acceptance, using unchanged queue delivery bookkeeping. Never done by the app's mock mode.
		mock.setAcceptedEventCount('42', 1); await batches.markDelivered(batch.batchId, [input.eventId]);
		const unrelated = createFileEvent({ sessionId: randomUUID(), source: 'vscode', workspaceId: 'workspace', eventType: 'file.saved', payload: { relativePath: 'other.ts' } });
		await queue.enqueue(unrelated); await assessment.stopAndSubmit();
		assert.equal(assessment.view.state, 'submitted'); assert.equal(await queue.getPendingCount(), 1);
		assert.deepEqual(await queue.getSessionEvidenceStatus([local]), { totalEvents: 1, pendingEvents: 0, missingSessions: 0 });
	});

	test('restart retains encrypted evidence/associations and blocks historical events without volatile upload proof', async () => {
		await assessment.pair('FIXTURE-PAIR'); await assessment.start(); const local = recording.sessionId!; const deadline = assessment.view.deadline;
		const input = createFileEvent({ sessionId: local, source: 'vscode', workspaceId: 'workspace', eventType: 'file.saved', payload: { relativePath: 'app.ts' } });
		await persistence.write(input); assert.ok(persistence.getUploadPrivacyContext(input)); await closePipeline(); await openPipeline();
		assert.equal(recording.isRecording, false); assert.equal(assessment.view.state, 'recovery'); assert.equal(assessment.view.deadline, deadline);
		assert.deepEqual(await queue.getPending(10), [input]); assert.equal(persistence.getUploadPrivacyContext(input), undefined);
		assert.equal(assessment.allowsDevelopmentUpload(local), false); await assessment.stopAndSubmit();
		assert.equal(assessment.view.state, 'submission_pending'); assert.equal(assessment.view.pendingEvents, 1);
		assert.equal((state.get(ASSESSMENT_METADATA_KEY) as AssessmentMetadata).connection.codingSessionId, '42');
	});

	test('metadata-only worker checks distinguish empty known sessions from missing/deleted sessions and reject invalid selections', async () => {
		const known = randomUUID(); const unknown = randomUUID(); await queue.beginSession(known); await queue.finishSession(known);
		assert.deepEqual(await queue.getSessionEvidenceStatus([known]), { totalEvents: 0, pendingEvents: 0, missingSessions: 0 });
		assert.deepEqual(await queue.getSessionEvidenceStatus([unknown]), { totalEvents: 0, pendingEvents: 0, missingSessions: 1 });
		await assert.rejects(queue.getSessionEvidenceStatus([known, known])); await assert.rejects(queue.getSessionEvidenceStatus(['not-an-id']));
	});
});
