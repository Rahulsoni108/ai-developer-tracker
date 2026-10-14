import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCodexEvent, createFileEvent } from '../eventSchema';
import { EventPersistence } from '../eventPersistence';
import { JsonlWriter } from '../jsonlWriter';
import { DEFAULT_QUEUE_STORAGE_BYTES, LOCAL_QUEUE_FILENAME, LocalEventQueue, LocalEventQueueError, safeQueueError } from '../localEventQueue';
import { RecordingController } from '../recording';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';

const fileEvent = (sessionId: string = randomUUID()) => createFileEvent({ sessionId, workspaceId: 'workspace', source: 'vscode',
	eventType: 'file.saved', payload: { relativePath: 'example.ts' } });
function contentEvent(sessionId: string, bytes = 8000) {
	return createCodexEvent({ sessionId, sourceSessionId: 'codex-example', workspaceId: 'workspace', eventType: 'ai.prompt.submitted',
		payload: { text: 'x'.repeat(bytes), sourceRecord: { sourceFileReference: 'codex-file:' + 'a'.repeat(64), recordIndex: 1,
			generation: 0, byteOffset: 0, byteLength: 8000, recordType: 'event_msg' } } });
}

suite('Queue storage limits and health', () => {
	let root: string;
	let queue: LocalEventQueue;
	const storage = () => ({ scheme: 'file', fsPath: root });
	const database = () => (queue as unknown as { database: DatabaseSync }).database;
	setup(async () => { root = await mkdtemp(join(tmpdir(), 'ai-queue-limits-')); queue = await LocalEventQueue.open(storage(), []); });
	teardown(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });

	test('defaults to 100 MB and reports actual database/sidecar bytes and pending count', async () => {
		await queue.enqueue(fileEvent()); const health = await queue.getHealth();
		assert.equal(health.maxStorageBytes, DEFAULT_QUEUE_STORAGE_BYTES); assert.equal(health.pendingCount, 1);
		let bytes = 0;
		for (const suffix of ['', '-wal', '-shm', '-journal']) { bytes += await stat(join(root, LOCAL_QUEUE_FILENAME) + suffix).then(info => info.size, () => 0); }
		assert.equal(health.storageBytes, bytes); assert.equal(health.status, 'healthy');
	});

	test('warns at 80%, stops admission at capacity and never deletes or acknowledges pending records', async function () {
		this.timeout(15000); await queue.close(); queue = await LocalEventQueue.open(storage(), [], { maxStorageBytes: 2 * 1024 * 1024 });
		const session = randomUUID(); const accepted = []; let warned = false; let rejected = false;
		for (let index = 0; index < 500; index++) {
			const input = contentEvent(session);
			try { await queue.enqueue(input); accepted.push(input); }
			catch (error) { assert.ok(error instanceof LocalEventQueueError); assert.equal(error.code, 'storage_limit'); rejected = true; break; }
			const health = await queue.getHealth();
			if (health.status === 'warning') { assert.ok(health.usageRatio >= 0.8); warned = true; }
			assert.ok(health.storageBytes <= health.maxStorageBytes);
		}
		assert.ok(warned); assert.ok(rejected); assert.ok(accepted.length > 0);
		assert.equal((await queue.getHealth()).status, 'full');
		assert.deepEqual(await queue.getPending(1000), accepted);
		await queue.enqueue(accepted[0]); assert.equal(await queue.getPendingCount(), accepted.length);
		assert.equal(database().prepare('SELECT COUNT(*) AS count FROM queued_events WHERE acknowledged = 1').get()?.count, 0);
	});

	test('a larger configured limit admits new data after reopening without discarding old events', async () => {
		await queue.enqueue(fileEvent()); const original = await queue.getPending(10); await queue.close();
		queue = await LocalEventQueue.open(storage(), [], { maxStorageBytes: 3 * 1024 * 1024 });
		await queue.enqueue(contentEvent(randomUUID(), 128000));
		assert.deepEqual((await queue.getPending(10))[0], original[0]); assert.equal(await queue.getPendingCount(), 2);
		assert.equal((await queue.getHealth()).maxStorageBytes, 3 * 1024 * 1024);
	});

	test('explicit acknowledgment updates constant-time pending counters without automatically reclaiming storage', async () => {
		const inputs = [fileEvent(), fileEvent()]; await Promise.all(inputs.map(input => queue.enqueue(input)));
		await queue.markAcknowledged([inputs[0].eventId]); await queue.markAcknowledged([inputs[0].eventId]);
		assert.equal((await queue.getHealth()).pendingCount, 1); assert.deepEqual(await queue.getPending(10), [inputs[1]]);
	});

	test('handles a real SQLite FULL write failure without losing earlier committed events', async () => {
		const first = fileEvent(); await queue.enqueue(first); const db = database();
		const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count);
		db.exec(`PRAGMA max_page_count = ${pages}`);
		try {
			await assert.rejects(queue.enqueue(contentEvent(randomUUID(), 128000)), error => error instanceof LocalEventQueueError && error.code === 'disk_full');
			assert.deepEqual(await queue.getPending(10), [first]); assert.equal(await queue.getPendingCount(), 1);
		} finally { db.exec('PRAGMA max_page_count = 25600'); }
	});

	test('classifies SQLite READONLY errors and preserves committed events', async () => {
		const first = fileEvent(); await queue.enqueue(first); const db = database(); db.exec('PRAGMA query_only = ON');
		try {
			await assert.rejects(queue.enqueue(fileEvent()), error => error instanceof LocalEventQueueError && error.code === 'permission_denied');
			assert.deepEqual(await queue.getPending(10), [first]);
		} finally { db.exec('PRAGMA query_only = OFF'); }
	});

	test('classifies SQLite lock contention and can write after the lock is released', async () => {
		const db = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME)); database().exec('PRAGMA busy_timeout = 0'); db.exec('BEGIN IMMEDIATE');
		try { await assert.rejects(queue.enqueue(fileEvent()), error => error instanceof LocalEventQueueError && error.code === 'locked'); }
		finally { db.exec('ROLLBACK'); db.close(); }
		await queue.enqueue(fileEvent()); assert.equal(await queue.getPendingCount(), 1);
	});

	test('sanitizes platform disk-full, permission and SQLite errors without carrying causes', () => {
		for (const [details, expected] of [[{ code: 'ENOSPC' }, 'disk_full'], [{ code: 'EACCES' }, 'permission_denied'],
			[{ code: 'EPERM' }, 'permission_denied'], [{ errcode: 5 }, 'locked'], [{ errcode: 26 }, 'corrupt']] as const) {
			const error = safeQueueError(Object.assign(new Error('PRIVATE SQL AND PATH'), details));
			assert.equal(error.code, expected); assert.equal(error.cause, undefined); assert.ok(!error.message.includes('PRIVATE'));
		}
	});

	test('write failures stop recording and leave its session interrupted rather than falsely completed', async () => {
		const recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true);
		const issues: string[] = [];
		const writer = new EventPersistence(queue, new JsonlWriter(join(root, 'mirror.jsonl')),
			(reason, code) => { issues.push(code ?? reason); recording.stop(); });
		const subscription = writer.attachRecording(recording); await recording.start(); const session = recording.sessionId!;
		const input = fileEvent(session); await writer.write(input);
		database().exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON queued_events BEGIN SELECT RAISE(ABORT, 'PRIVATE WRITE FAILURE'); END`);
		await assert.rejects(writer.write(fileEvent(session))); assert.equal(recording.isRecording, false);
		await writer.completeSession(session); database().exec('DROP TRIGGER fail_insert'); await writer.close();
		subscription.dispose(); recording.dispose(); queue = await LocalEventQueue.open(storage(), []);
		assert.deepEqual(await queue.getPending(10), [input]);
		assert.equal((await queue.getRecordingSessions())[0].status, 'interrupted'); assert.deepEqual(issues, ['operation_failed']);
	});

	test('rejects invalid maximum storage values', async () => {
		for (const limit of [0, -1, 1.5, NaN, Infinity, 1024, 11 * 1024 * 1024 * 1024]) {
			await assert.rejects(LocalEventQueue.open(storage(), [], { maxStorageBytes: limit }), LocalEventQueueError);
		}
	});

	test('worker health notifications warn at 80%, signal capacity and throttle ordinary updates', async function () {
		this.timeout(15000); await queue.close();
		const threaded = await AsyncLocalEventQueue.open(storage(), [], { maxStorageBytes: 2 * 1024 * 1024 });
		const updates: string[] = []; const started = Date.now(); const session = randomUUID();
		const observer = threaded.onDidChangeHealth(health => { updates.push(health.status); });
		try {
			for (let index = 0; index < 500; index++) {
				try { await threaded.enqueue(contentEvent(session)); }
				catch (error) { assert.ok(error instanceof LocalEventQueueError); assert.equal(error.code, 'storage_limit'); break; }
			}
			assert.equal((await threaded.getHealth()).status, 'full');
			assert.ok(updates.includes('warning')); assert.ok(updates.includes('full'));
			assert.ok(updates.length <= Math.floor((Date.now() - started) / 1000) + 2);
		} finally { observer.dispose(); await threaded.close(); }
	});

	test('preserves an existing database larger than a lowered limit and blocks new collection', async () => {
		const session = randomUUID(); const inputs = Array.from({ length: 20 }, () => contentEvent(session, 128000));
		for (const input of inputs) { await queue.enqueue(input); }
		await queue.close(); queue = await LocalEventQueue.open(storage(), [], { maxStorageBytes: 1024 * 1024 });
		assert.equal((await queue.getHealth()).status, 'full');
		await assert.rejects(queue.enqueue(fileEvent()), error => error instanceof LocalEventQueueError && error.code === 'storage_limit');
		await queue.enqueue(inputs[0]); assert.deepEqual(await queue.getPending(100), inputs);
	});
});
