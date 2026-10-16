import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { LOCAL_QUEUE_FILENAME, LocalEventQueueError } from '../localEventQueue';
import { createFileEvent, createCodexEvent, type FileEventType } from '../eventSchema';
import { formatRecordedEventSummary, showRecordedEventSummary, RECORDED_EVENT_SUMMARY_TITLE, RECORDED_EVENT_SUMMARY_FAILURE } from '../recordedEventSummary';
import { openTestWorkerQueue } from './queueTestKeys';

suite('Safe recorded event summary', () => {
	let root: string; let queue: AsyncLocalEventQueue;
	const storage = () => ({ scheme: 'file', fsPath: root });
	const file = (sessionId: string, eventType: FileEventType = 'file.saved') => createFileEvent({ sessionId, source: 'vscode', workspaceId: 'dummy-private-workspace',
		eventType, payload: { relativePath: 'dummy-private-path.ts' } });
	const inspect = <T>(operation: (db: DatabaseSync) => T): T => {
		const db = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME)); try { return operation(db); } finally { db.close(); }
	};
	setup(async () => { root = await mkdtemp(join(tmpdir(), 'ai-event-summary-')); queue = await openTestWorkerQueue(storage(), []); });
	teardown(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });

	test('decrypts encrypted file and AI records in the worker and returns only type names and integer counts', async () => {
		const session = randomUUID(); await queue.beginSession(session);
		for (const type of ['file.saved', 'file.modified', 'file.saved'] as const) { await queue.enqueue(file(session, type)); }
		await queue.enqueue(createCodexEvent({ sessionId: session, workspaceId: 'dummy-private-workspace', sourceSessionId: 'dummy-private-source-session',
			eventType: 'ai.prompt.submitted', payload: { text: 'dummy-private-prompt-and-password', sourceRecord: { recordIndex: 1, generation: 0,
				byteOffset: 0, byteLength: 100, recordType: 'response_item', sourceFileReference: 'codex-file:' + 'a'.repeat(64) } } }));
		assert.deepEqual(inspect(db => db.prepare('SELECT DISTINCT payload_format FROM queued_events').all().map(row => row.payload_format)), [1]);
		const summary = await queue.getRecordedEventSummary();
		assert.deepEqual(summary, { total: 4, counts: { 'file.saved': 2, 'file.modified': 1, 'ai.prompt.submitted': 1 } });
		const rendered = formatRecordedEventSummary(summary);
		for (const value of [session, root, 'dummy-private-path', 'dummy-private-prompt', 'dummy-private-source', 'dummy-private-workspace']) {
			assert.equal(JSON.stringify(summary).includes(value), false); assert.equal(rendered.includes(value), false);
		}
	});

	test('selects latest session metadata, excluding cancelled sessions regardless of event timestamps or insert order', async () => {
		const old = randomUUID(); const latest = randomUUID(); const cancelled = randomUUID();
		await queue.beginSession(old); await queue.beginSession(latest); await queue.beginSession(cancelled);
		await queue.enqueue(file(latest, 'file.modified')); await queue.enqueue(file(cancelled, 'file.deleted'));
		const lateOld = file(old); lateOld.timestamp = '2099-01-01T00:00:00.000Z'; await queue.enqueue(lateOld);
		await queue.finishSession(old); await queue.finishSession(latest); await queue.finishSession(cancelled, 'cancelled');
		inspect(db => {
			const set = db.prepare('UPDATE recording_sessions SET started_at = ? WHERE session_id = ?');
			set.run('2001-01-01T00:00:00.000Z', old); set.run('2002-01-01T00:00:00.000Z', latest); set.run('2003-01-01T00:00:00.000Z', cancelled);
		});
		assert.deepEqual(await queue.getRecordedEventSummary(), { total: 1, counts: { 'file.modified': 1 } });
	});

	test('breaks same-millisecond session start ties by most recent metadata insertion', async () => {
		const first = randomUUID(); const second = randomUUID(); await queue.beginSession(first); await queue.beginSession(second);
		await queue.enqueue(file(second, 'file.created')); await queue.enqueue(file(first, 'file.deleted'));
		inspect(db => db.exec("UPDATE recording_sessions SET started_at = '2001-01-01T00:00:00.000Z'"));
		assert.deepEqual(await queue.getRecordedEventSummary(), { total: 1, counts: { 'file.created': 1 } });
	});

	test('returns zero for an empty latest session instead of older retained events', async () => {
		await queue.enqueue(file(randomUUID())); await queue.beginSession(randomUUID());
		assert.deepEqual(await queue.getRecordedEventSummary(), { total: 0, counts: {} });
	});

	test('handles no sessions, exclusively cancelled sessions and acknowledged-only sessions', async () => {
		assert.deepEqual(await queue.getRecordedEventSummary(), { total: 0, counts: {} });
		const cancelled = randomUUID(); await queue.beginSession(cancelled); await queue.finishSession(cancelled, 'cancelled');
		assert.deepEqual(await queue.getRecordedEventSummary(), { total: 0, counts: {} });
		const input = file(randomUUID()); await queue.enqueue(input); await queue.markAcknowledged([input.eventId]);
		assert.deepEqual(await queue.getRecordedEventSummary(), { total: 0, counts: {} });
	});

	test('counts claimed pending events but excludes acknowledged payload tombstones without modifying delivery state', async () => {
		const session = randomUUID(); const pending = file(session); const acknowledged = file(session, 'file.modified');
		await queue.enqueue(pending); await queue.enqueue(acknowledged); await queue.markAcknowledged([acknowledged.eventId]);
		await queue.prepareBatch(1, 10000);
		const db = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME));
		try {
			const state = () => ['queued_events', 'recording_sessions', 'delivery_batches', 'delivery_members', 'queue_health', 'queue_owners', 'upload_retry_state']
				.map(table => db.prepare(`SELECT * FROM ${table}`).all());
			const before = state(); const version = db.prepare('PRAGMA data_version').get()!.data_version;
			assert.deepEqual(await queue.getRecordedEventSummary(), { total: 1, counts: { 'file.saved': 1 } });
			assert.deepEqual(state(), before); assert.equal(db.prepare('PRAGMA data_version').get()!.data_version, version);
		} finally { db.close(); }
	});

	test('counts all retained records without the getPending 1000-event cap', async () => {
		const session = randomUUID(); for (let index = 0; index < 1002; index++) { await queue.enqueue(file(session)); }
		assert.deepEqual(await queue.getRecordedEventSummary(), { total: 1002, counts: { 'file.saved': 1002 } });
	});

	test('authentication failure returns no partial summary or sensitive exception and leaves the worker usable', async () => {
		const session = randomUUID(); const first = file(session); const second = file(session); await queue.enqueue(first); await queue.enqueue(second);
		const encrypted = inspect(db => String(db.prepare('SELECT event_json FROM queued_events WHERE event_id = ?').get(second.eventId)!.event_json));
		const tampered = JSON.parse(encrypted); tampered.tag = (tampered.tag[0] === 'A' ? 'B' : 'A') + tampered.tag.slice(1);
		inspect(db => db.prepare('UPDATE queued_events SET event_json = ? WHERE event_id = ?').run(JSON.stringify(tampered), second.eventId));
		try {
			await assert.rejects(queue.getRecordedEventSummary(), error => {
				assert.ok(error instanceof LocalEventQueueError); assert.equal(error.code, 'authentication_failed');
				assert.equal(error.message, 'Local event queue operation failed.'); assert.equal(error.cause, undefined); return true;
			});
		} finally { inspect(db => db.prepare('UPDATE queued_events SET event_json = ? WHERE event_id = ?').run(encrypted, second.eventId)); }
		assert.deepEqual(await queue.getRecordedEventSummary(), { total: 2, counts: { 'file.saved': 2 } });
	});

	test('invalid stored event types are rejected rather than exposed as diagnostic strings', async () => {
		const input = file(randomUUID()); await queue.enqueue(input);
		inspect(db => db.prepare('UPDATE queued_events SET payload_format = 0, event_json = ?').run(JSON.stringify({ ...input, eventType: 'dummy-private-credential' })));
		await assert.rejects(queue.getRecordedEventSummary(), error => {
			assert.ok(error instanceof LocalEventQueueError); assert.equal(error.code, 'corrupt'); assert.equal(error.message.includes('dummy-private'), false); return true;
		});
	});

	test('summary works after reopening with existing encrypted pending records', async () => {
		const session = randomUUID(); await queue.enqueue(file(session)); await queue.enqueue(file(session, 'file.modified'));
		await queue.close(); queue = await openTestWorkerQueue(storage(), []);
		assert.deepEqual(await queue.getRecordedEventSummary(), { total: 2, counts: { 'file.saved': 1, 'file.modified': 1 } });
	});

	test('formats safe totals and fixed empty/failure messages without interpolating exceptions', async () => {
		let text = ''; const output = { clear: () => { text = ''; }, appendLine: (value: string) => { text += value; }, show: () => {} };
		await showRecordedEventSummary(queue, output); assert.ok(text.startsWith(RECORDED_EVENT_SUMMARY_TITLE));
		assert.ok(text.includes('Total retained pending events: 0')); assert.ok(text.includes('No retained pending events'));
		await showRecordedEventSummary({ getRecordedEventSummary: async () => { throw new Error('dummy-private-token-path-prompt'); } }, output);
		assert.ok(text.includes(RECORDED_EVENT_SUMMARY_FAILURE)); assert.equal(text.includes('dummy-private'), false);
		await showRecordedEventSummary(undefined, output); assert.ok(text.includes(RECORDED_EVENT_SUMMARY_FAILURE));
		assert.throws(() => formatRecordedEventSummary({ total: 1, counts: { 'dummy-secret': 1 } } as never), /Invalid event summary/);
		assert.throws(() => formatRecordedEventSummary({ total: 2, counts: { 'file.saved': 1 } }), /Invalid event summary/);
		assert.throws(() => formatRecordedEventSummary({ total: 0, counts: { 'file.saved': -1 } }), /Invalid event summary/);
		const formatted = formatRecordedEventSummary({ total: 3, counts: { 'file.saved': 2, 'file.modified': 1 } });
		assert.ok(formatted.includes('file.modified: 1')); assert.ok(formatted.includes('file.saved: 2'));
	});
});
