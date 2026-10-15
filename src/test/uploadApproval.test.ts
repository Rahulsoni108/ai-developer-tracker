import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventPersistence } from '../eventPersistence';
import { EventBatchManager } from '../eventBatchManager';
import { EventUploader } from '../eventUploader';
import { createFileEvent, createCodexEvent, type TrackerEvent } from '../eventSchema';
import type { UploadTransport } from '../httpsEventTransport';
import { openTestWorkerQueue } from './queueTestKeys';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { RecordingController } from '../recording';

suite('Verified queued upload privacy admission', () => {
	let root: string; let queue: AsyncLocalEventQueue; let persistence: EventPersistence;
	let sessionId: string; let committed: TrackerEvent[];
	const privacy = () => ({ recordingActive: true, sessionId, approvedWorkspaceIds: ['workspace'],
		confirmedCodexSessions: [{ sourceSessionId: 'codex-session', workspaceId: 'workspace' }], codexContentConsent: true,
		resolveToolPath: (path: string) => path === '/approved/project/app.ts' ? 'app.ts' : undefined });
	const event = () => createFileEvent({ source: 'vscode', sessionId, workspaceId: 'workspace', eventType: 'file.saved', payload: { relativePath: 'app.ts' } });
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'ai-upload-admission-')); queue = await openTestWorkerQueue({ scheme: 'file', fsPath: root }, []);
		sessionId = randomUUID(); committed = [];
		persistence = new EventPersistence(queue, { write: async () => {}, flush: async () => {} }, undefined, { context: privacy });
		persistence.onDidWrite(input => committed.push(input as TrackerEvent));
	});
	teardown(async () => { await persistence.close(); await queue.close(); await rm(root, { recursive: true, force: true }); });

	test('only successful filtered commits receive exact-content upload approvals', async () => {
		const input = event(); assert.equal(persistence.getUploadPrivacyContext(input), undefined);
		await persistence.write(input); const queued = (await queue.getPending(1))[0];
		assert.ok(persistence.getUploadPrivacyContext(queued));
		const altered = structuredClone(queued); altered.payload = { relativePath: 'other.ts' };
		assert.equal(persistence.getUploadPrivacyContext(altered), undefined);
		const copy = persistence.getUploadPrivacyContext(queued)!; copy.approvedWorkspaceIds = [];
		assert.deepEqual(persistence.getUploadPrivacyContext(queued)?.approvedWorkspaceIds, ['workspace']);
	});
	test('queue-write failure and privacy rejection do not create upload approval', async () => {
		const rejected = event(); rejected.payload.relativePath = '.env'; await assert.rejects(persistence.write(rejected));
		assert.equal(persistence.getUploadPrivacyContext(rejected), undefined);
		const failing = new EventPersistence({ enqueue: async () => { throw new Error('dummy-private-value'); }, close: async () => {} },
			{ write: async () => {}, flush: async () => {} }, undefined, { context: privacy });
		const input = event(); await assert.rejects(failing.write(input)); assert.equal(failing.getUploadPrivacyContext(input), undefined); await failing.close();
	});
	test('historical pending records never acquire approval merely by sharing session/workspace fields', async () => {
		const historical = event(); await queue.enqueue(historical); await persistence.write(event());
		assert.equal(persistence.getUploadPrivacyContext(historical), undefined);
	});
	test('sanitized Codex tool content and verified absolute paths can upload without executing commands', async () => {
		const input = createCodexEvent({ sessionId, workspaceId: 'workspace', sourceSessionId: 'codex-session', eventType: 'ai.tool.started',
			payload: { toolName: 'dummy-tool', callId: 'dummy-call', input: '{"path":"/approved/project/app.ts","password":"dummy-password"}',
				status: 'running', matched: false, sourceRecord: { sourceFileReference: 'codex-file:' + 'a'.repeat(64), recordIndex: 1,
					generation: 0, byteOffset: 0, byteLength: 100, recordType: 'response_item' } } });
		await persistence.write(input); const queued = (await queue.getPending(1))[0];
		assert.equal(JSON.stringify(queued).includes('dummy-password'), false);
		assert.deepEqual(persistence.getUploadPrivacyContext(queued)?.verifiedToolPaths, [{ path: '/approved/project/app.ts', workspaceId: 'workspace', relativePath: 'app.ts' }]);
		let body = ''; const transport: UploadTransport = { send: async request => {
			body = request.body; const batch = JSON.parse(body);
			return { status: 200, contentType: 'application/json', body: JSON.stringify({ contractVersion: 1, batchId: batch.batchId, durablyAcceptedEventIds: batch.events.map((input: TrackerEvent) => input.eventId) }) };
		} };
		const uploader = new EventUploader(new EventBatchManager(queue), queue, { get: async () => 'dummy-token' },
			{ endpoint: 'https://example.test/events', confirmUpload: async () => true, privacyContext: event => persistence.getUploadPrivacyContext(event) }, transport);
		try { await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'delivered'); assert.equal(body.includes('dummy-password'), false); }
		finally { await uploader.dispose(); }
	});
	test('a stalled upload cannot block new event persistence or recording state', async () => {
		await persistence.write(event()); let started!: () => void; const sending = new Promise<void>(resolve => { started = resolve; });
		const transport: UploadTransport = { send: async () => { started(); return new Promise(() => {}); } };
		const uploader = new EventUploader(new EventBatchManager(queue), queue, { get: async () => 'dummy-token' },
			{ endpoint: 'https://example.test/events', confirmUpload: async () => true, privacyContext: event => persistence.getUploadPrivacyContext(event) }, transport);
		try {
			await uploader.enable(); const uploading = uploader.uploadOnce(); await sending;
			const second = event(); await persistence.write(second);
			assert.equal(await queue.getPendingCount(), 2); assert.ok(persistence.getUploadPrivacyContext(second));
			await uploader.disable(); assert.equal(await uploading, 'cancelled');
		} finally { await uploader.dispose(); }
	});

	test('approval remains valid after Stop and session completion, then cleanup clears it', async () => {
		const recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => true);
		persistence.attachRecording(recording, privacy);
		await recording.start(); sessionId = recording.sessionId!; const input = event(); await persistence.write(input);
		recording.stop(); await persistence.completeSession(sessionId);
		assert.ok(persistence.getUploadPrivacyContext(input)); persistence.resetAfterCleanup();
		assert.equal(persistence.getUploadPrivacyContext(input), undefined); recording.dispose();
	});
	test('extension restart preserves queued evidence but does not invent historical consent', async () => {
		const input = event(); await persistence.write(input); await persistence.close();
		queue = await openTestWorkerQueue({ scheme: 'file', fsPath: root }, []);
		persistence = new EventPersistence(queue, { write: async () => {}, flush: async () => {} }, undefined, { context: privacy });
		assert.deepEqual(await queue.getPending(1), [input]); assert.equal(persistence.getUploadPrivacyContext(input), undefined);
	});
});
