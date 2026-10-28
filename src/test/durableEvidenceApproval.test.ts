import { createTwoFilesPatch } from 'diff';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openTestWorkerQueue } from './queueTestKeys';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { EventPersistence } from '../eventPersistence';
import { createFileEvent, createCodexEvent, createClaudeEvent, createChangeEvent, validateEvent, type TrackerEvent } from '../eventSchema';
import { LOCAL_QUEUE_FILENAME } from '../localEventQueue';
import { eventDigest } from '../evidenceApproval';
import type { UploadPrivacyContext } from '../uploadPrivacyContext';
import { EventBatchManager } from '../eventBatchManager';
import { EventUploader, UPLOAD_TOKEN_SECRET } from '../eventUploader';

const workspaceId = 'a'.repeat(64);
const sourceSessionId = 'approved-source';
const sourceRecord = { sourceFileReference: 'codex-file:' + 'b'.repeat(64), recordIndex: 1, generation: 0,
	byteOffset: 0, byteLength: 200, recordType: 'event_msg' as const };
const dummySecret = 'sk-proj-' + 'DummySecret987654321'.repeat(3);
suite('Durable exact-event evidence approvals', function () {
	this.timeout(15000);
	let root: string; let queue: AsyncLocalEventQueue; let writer: EventPersistence; let sessionId: string;
	let context: UploadPrivacyContext;
	const storage = () => ({ scheme: 'file', fsPath: join(root, 'queue') });
	const file = (path = 'src/app.ts') => createFileEvent({ sessionId, workspaceId, eventType: 'file.modified', source: 'vscode', payload: { relativePath: path } });
	const openWriter = () => new EventPersistence(queue, { write: async () => {}, flush: async () => {} }, undefined, { context: () => context });
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'durable-approval-')); sessionId = randomUUID(); queue = await openTestWorkerQueue(storage(), []);
		context = { recordingActive: true, sessionId, approvedWorkspaceIds: [workspaceId], confirmedCodexSessions: [{ sourceSessionId, workspaceId }],
			codexContentConsent: true, confirmedClaudeSessions: [{ sourceSessionId, workspaceId }], claudeContentConsent: true };
		writer = openWriter();
	});
	teardown(async () => { await writer.close(); await queue.close(); await rm(root, { recursive: true, force: true }); });

	test('commits encrypted approvals atomically and restores exact verified events after worker restart', async () => {
		const event = file(); await writer.write(event);
		assert.equal((await writer.resolveUploadPrivacyContext(event))?.exactEventDigest, eventDigest(event));
		await writer.close(); queue = await openTestWorkerQueue(storage(), []); writer = openWriter();
		assert.deepEqual(await queue.getPending(10), [event]);
		assert.equal((await writer.resolveUploadPrivacyContext(event))?.exactEventDigest, eventDigest(event));
		const bytes = await readFile(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		assert.equal(bytes.includes(Buffer.from('src/app.ts')), false);
		assert.equal(bytes.includes(Buffer.from('confirmedCodexSessions')), false);
	});
	test('does not approve historical rows through a retry, restart, or another event in the same session', async () => {
		const historical = file(); await queue.enqueue(historical); await writer.write(historical);
		const approved = file('src/new.ts'); await writer.write(approved);
		await writer.close(); queue = await openTestWorkerQueue(storage(), []); writer = openWriter();
		assert.equal(await writer.resolveUploadPrivacyContext(historical), undefined);
		assert.ok(await writer.resolveUploadPrivacyContext(approved));
	});
	test('binds redacted Codex and Claude content only; rejected paths have no event or proof', async () => {
		const codex = createCodexEvent({ sessionId, workspaceId, sourceSessionId, eventType: 'ai.prompt.submitted', payload: { text: 'Use ' + dummySecret, sourceRecord } });
		const claude = createClaudeEvent({ sessionId, workspaceId, sourceSessionId, eventType: 'ai.response.completed',
			payload: { text: 'password="dummyPasswordValue"', sourceRecord: { ...sourceRecord, sourceFileReference: 'claude-file:' + 'c'.repeat(64), recordType: 'claude_hook' } } });
		await writer.write(codex); await writer.write(claude); await assert.rejects(writer.write(file('.env')));
		const events = await queue.getPending(10); assert.equal(events.length, 2);
		assert.equal(JSON.stringify(events).includes(dummySecret), false); assert.equal(JSON.stringify(events).includes('dummyPasswordValue'), false);
		for (const event of events) { assert.equal((await writer.resolveUploadPrivacyContext(event))?.exactEventDigest, eventDigest(event)); }
		assert.equal(await writer.resolveUploadPrivacyContext(codex), undefined);
	});
	test('redacted diffs approve a reconstruction gap and never the original patch', async () => {
		const event = createChangeEvent({ sessionId, workspaceId, eventType: 'file.diff', payload: { relativePath: 'app.ts', changeReason: 'edit',
			beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64), diff: createTwoFilesPatch('before', 'after', 'const a = 1;\n', 'const api_key = "' + dummySecret + '";\n') } });
		await writer.write(event); const [stored] = await queue.getPending(1);
		assert.equal(stored.eventType, 'file.gap'); assert.ok(await writer.resolveUploadPrivacyContext(stored));
		assert.equal(await writer.resolveUploadPrivacyContext(event), undefined);
	});
	test('rejects modified snapshots and cross-session/workspace reuse; stored approved events stay immutable', async () => {
		const event = file(); await writer.write(event);
		for (const modified of [{ ...event, sessionId: randomUUID() }, { ...event, workspaceId: 'd'.repeat(64) },
			{ ...event, payload: { relativePath: 'other.ts' } }] as TrackerEvent[]) {
			assert.equal(await writer.resolveUploadPrivacyContext(modified), undefined);
			await assert.rejects(queue.enqueueApproved(modified, { ...context, sessionId: modified.sessionId, approvedWorkspaceIds: [modified.workspaceId!] }));
		}
		assert.deepEqual(await queue.getPending(1), [event]);
	});
	test('tampering and swapping authenticated approval ciphertext fails closed without raw diagnostics', async () => {
		const events = [file(), file('src/second.ts')]; for (const event of events) { await writer.write(event); }
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		try {
			const proof = db.prepare('SELECT approval_json FROM event_approvals WHERE event_id = ?').get(events[0].eventId)!.approval_json;
			db.prepare('UPDATE event_approvals SET approval_json = ? WHERE event_id = ?').run(proof!, events[1].eventId);
			assert.equal(await writer.resolveUploadPrivacyContext(events[1]), undefined);
			const envelope = JSON.parse(String(proof)); envelope.tag = Buffer.alloc(16).toString('base64');
			db.prepare('UPDATE event_approvals SET approval_json = ? WHERE event_id = ?').run(JSON.stringify(envelope), events[0].eventId);
			await assert.rejects(queue.getUploadPrivacyContext(events[0]), error => { assert.ok(error instanceof Error); assert.equal(error.message.includes('src/'), false); return true; });
		} finally { db.close(); }
	});
	test('rollback never leaves an event without its approval on a failed atomic approval write', async () => {
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		db.exec("CREATE TRIGGER fail_approval BEFORE INSERT ON event_approvals BEGIN SELECT RAISE(ABORT, 'private dummy detail'); END;");
		try { await assert.rejects(writer.write(file())); assert.equal(await queue.getPendingCount(), 0); }
		finally { db.exec('DROP TRIGGER fail_approval'); db.close(); }
	});


	test('oversized capture-path proofs fail visibly instead of committing silently unapproved evidence', async () => {
		context.resolveToolPath = path => path.replace('/approved/', '');
		const event = createCodexEvent({ sessionId, workspaceId, sourceSessionId, eventType: 'ai.tool.started',
			payload: { toolName: 'write_files', callId: 'dummy-call', status: 'running', matched: true, sourceRecord,
				input: JSON.stringify({ paths: Array.from({ length: 129 }, (_, index) => '/approved/src/file' + index + '.ts') }) } });
		assert.equal(validateEvent(event).valid, true);
		await assert.rejects(writer.write(event)); assert.equal(await queue.getPendingCount(), 0);
		assert.equal(await writer.resolveUploadPrivacyContext(event), undefined);
	});
	test('migrates version-7 queues without manufacturing approvals for existing encrypted evidence', async () => {
		const historical = file(); await queue.enqueue(historical); await writer.close();
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		db.exec('DROP TABLE disclosure_consents; DROP TABLE assessment_archive_recordings; DROP TABLE assessment_archives; DROP TABLE finalization_recordings; DROP TABLE assessment_finalizations; DROP TABLE event_approvals; DROP TABLE evidence_consents; DROP TABLE approval_revocations; PRAGMA user_version = 7;'); db.close();
		queue = await openTestWorkerQueue(storage(), []); writer = openWriter(); await writer.write(historical);
		assert.equal(await writer.resolveUploadPrivacyContext(historical), undefined); assert.deepEqual(await queue.getPending(10), [historical]);
	});
	test('revocation survives restart without deleting evidence or reviving permission on retries', async () => {
		const event = file(); await writer.write(event); await writer.revokeEvidenceApprovals(sessionId);
		assert.equal(await writer.resolveUploadPrivacyContext(event), undefined);
		await writer.close(); queue = await openTestWorkerQueue(storage(), []); writer = openWriter();
		await writer.write(event); await writer.write(file('new.ts'));
		for (const stored of await queue.getPending(10)) { assert.equal(await writer.resolveUploadPrivacyContext(stored), undefined); }
		assert.equal(await queue.getPendingCount(), 2);
	});
	test('restored exact approvals still require fresh upload consent and token; retries preserve original IDs', async () => {
		const event = file(); await writer.write(event); await writer.close(); queue = await openTestWorkerQueue(storage(), []); writer = openWriter();
		let sent = 0;
		const uploader = new EventUploader(new EventBatchManager(queue), queue, { get: async key => key === UPLOAD_TOKEN_SECRET ? 'dummy-token' : undefined }, {
			endpoint: 'https://assessment.invalid/events', confirmUpload: async () => true, privacyContext: input => writer.resolveUploadPrivacyContext(input),
		}, { send: async input => { sent++; const body = JSON.parse(input.body); assert.deepEqual(body.events, [event]);
				return { status: 200, contentType: 'application/json', body: JSON.stringify({ contractVersion: 1, batchId: body.batchId, durablyAcceptedEventIds: [event.eventId] }) }; }
		});
		try {
			await uploader.uploadOnce(); assert.equal(sent, 0); assert.equal(await queue.getPendingCount(), 1);
			await uploader.enable(); await uploader.uploadOnce(); assert.equal(sent, 1); assert.equal(await queue.getPendingCount(), 0);
		} finally { await uploader.dispose(); }
	});
});
