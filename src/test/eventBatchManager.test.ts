import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { EventBatchManager, MAX_DELIVERY_BATCH_BYTES } from '../eventBatchManager';
import { createFileEvent } from '../eventSchema';
import { LOCAL_QUEUE_FILENAME } from '../localEventQueue';
import { openTestWorkerQueue } from './queueTestKeys';

suite('Event batch preparation and delivery', () => {
	let root: string; let queue: AsyncLocalEventQueue; let manager: EventBatchManager;
	const storage = () => ({ scheme: 'file', fsPath: root });
	const event = () => createFileEvent({ sessionId: randomUUID(), workspaceId: 'workspace', source: 'vscode',
		eventType: 'file.saved', payload: { relativePath: 'dummy-private-file.ts' } });
	const reopen = async () => { queue = await openTestWorkerQueue(storage(), []); manager = new EventBatchManager(queue); };
	setup(async () => { root = await mkdtemp(join(tmpdir(), 'ai-batches-')); await reopen(); });
	teardown(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });

	test('FIFO count limits preserve IDs, sessions and original events', async () => {
		const inputs = [event(), event(), event()]; for (const input of inputs) { await queue.enqueue(input); }
		const batch = await manager.prepareBatch(2, 10000); assert.ok(batch);
		assert.deepEqual(batch.events, inputs.slice(0, 2));
		assert.equal(batch.byteSize, Buffer.byteLength(JSON.stringify(batch.events)));
		assert.deepEqual((await manager.prepareBatch(2, 10000))?.events, inputs.slice(2));
		assert.equal(await manager.prepareBatch(2, 10000), null);
		assert.equal(await queue.getPendingCount(), 3);
	});

	test('exact UTF-8 byte limits include delimiters and do not skip oversized head', async () => {
		const first = event(); first.payload.relativePath = 'unicode-例.ts'; const second = event();
		await queue.enqueue(first); await queue.enqueue(second);
		const size = Buffer.byteLength(JSON.stringify([first]));
		await assert.rejects(manager.prepareBatch(10, size - 1));
		assert.equal((await manager.getDeliveryStatus()).claimedEvents, 0);
		assert.deepEqual((await manager.prepareBatch(10, size))?.events, [first]);
	});

	test('concurrent preparations across managers and workers have exclusive claims', async () => {
		const inputs = Array.from({ length: 8 }, event); for (const input of inputs) { await queue.enqueue(input); }
		const other = await openTestWorkerQueue(storage(), []);
		try {
			const second = new EventBatchManager(other);
			const batches = await Promise.all([manager.prepareBatch(2, 10000), second.prepareBatch(2, 10000),
				manager.prepareBatch(2, 10000), second.prepareBatch(2, 10000)]);
			const ids = batches.flatMap(batch => batch!.events.map(input => input.eventId));
			assert.equal(new Set(ids).size, 8); assert.equal((await manager.getDeliveryStatus()).claimedEvents, 8);
			await assert.rejects(second.markDelivered(batches[0]!.batchId, [inputs[0].eventId]));
		} finally { await other.close(); }
	});

	test('partial acknowledgment, duplicate acknowledgment and release retain all undelivered evidence', async () => {
		const inputs = [event(), event(), event()]; for (const input of inputs) { await queue.enqueue(input); }
		const batch = (await manager.prepareBatch(3, 10000))!;
		await assert.rejects(manager.markDelivered(batch.batchId, [inputs[0].eventId, randomUUID()]));
		assert.equal(await queue.getPendingCount(), 3);
		await assert.rejects(queue.markAcknowledged([inputs[0].eventId]));
		await manager.markDelivered(batch.batchId, [inputs[0].eventId, inputs[0].eventId]);
		await manager.markDelivered(batch.batchId, [inputs[0].eventId]);
		assert.equal(await queue.getPendingCount(), 2); assert.equal(await manager.prepareBatch(3, 10000), null);
		await manager.releaseBatch(batch.batchId); await manager.releaseBatch(batch.batchId);
		const retry = (await manager.prepareBatch(3, 10000))!;
		assert.deepEqual(retry.events, inputs.slice(1));
		await assert.rejects(manager.markDelivered(batch.batchId, [inputs[1].eventId]));
		await manager.markDelivered(retry.batchId, retry.events.map(input => input.eventId));
		await manager.markDelivered(retry.batchId, [inputs[1].eventId]);
		assert.equal((await manager.getDeliveryStatus()).deliveredBatches, 1);
		await queue.enqueue(inputs[0]); assert.equal(await queue.getPendingCount(), 0);
	});

	test('worker interruption recovers claims and preserves partial acknowledgments on restart', async () => {
		const inputs = [event(), event()]; for (const input of inputs) { await queue.enqueue(input); }
		const batch = (await manager.prepareBatch(2, 10000))!;
		await manager.markDelivered(batch.batchId, [inputs[0].eventId]);
		await (queue as unknown as { worker: Worker }).worker.terminate(); await queue.close(); await reopen();
		const status = await manager.getDeliveryStatus(); assert.equal(status.recoveredBatches, 1);
		assert.equal(status.claimedEvents, 0); assert.equal(status.pendingEvents, 1);
		await queue.enqueue(inputs[0]); assert.deepEqual((await manager.prepareBatch(2, 10000))?.events, [inputs[1]]);
		await assert.rejects(manager.markDelivered(batch.batchId, [inputs[1].eventId]));
	});

	test('clean close releases claims and live workers are not recovered by another opener', async () => {
		const input = event(); await queue.enqueue(input); await manager.prepareBatch(1, 10000);
		const other = await openTestWorkerQueue(storage(), []);
		try { assert.equal(await other.prepareBatch(1, 10000), null); } finally { await other.close(); }
		await queue.close(); await reopen(); assert.deepEqual((await manager.prepareBatch(1, 10000))?.events, [input]);
	});

	test('delivery tables contain only identifiers and bookkeeping, never decrypted payloads', async () => {
		const input = event(); await queue.enqueue(input); await manager.prepareBatch(1, 10000);
		const db = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME));
		try {
			const state = JSON.stringify([db.prepare('SELECT * FROM delivery_batches').all(), db.prepare('SELECT * FROM delivery_members').all()]);
			assert.equal(state.includes(input.payload.relativePath), false);
			assert.equal(String(db.prepare('SELECT event_json FROM queued_events').get()!.event_json).includes(input.payload.relativePath), false);
		} finally { db.close(); }
	});

	test('explicit cleanup removes batch references and allows restart', async () => {
		const input = event(); await queue.enqueue(input); await queue.finishSession(input.sessionId);
		await manager.prepareBatch(1, 10000); await queue.acquireMaintenance();
		await assert.rejects(manager.prepareBatch(1, 10000));
		await queue.deleteEvidence('all'); await queue.releaseMaintenance();
		assert.equal((await manager.getDeliveryStatus()).activeBatches, 0);
		await queue.close(); await reopen(); assert.equal(await queue.getPendingCount(), 0);
	});

	test('a failed SQLite claim transaction leaves every event available', async () => {
		const input = event(); await queue.enqueue(input);
		const db = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME));
		try {
			db.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON delivery_members BEGIN SELECT RAISE(ABORT, 'dummy-private-value'); END;");
			await assert.rejects(manager.prepareBatch(1, 10000), error => {
				assert.ok(error instanceof Error); assert.equal(error.message.includes('dummy-private-value'), false); return true;
			});
			assert.equal((await manager.getDeliveryStatus()).activeBatches, 0);
			db.exec('DROP TRIGGER fail_claim');
		} finally { db.close(); }
		assert.deepEqual((await manager.prepareBatch(1, 10000))?.events, [input]);
	});

	test('completed delivery survives restart and replay does not revive acknowledged IDs', async () => {
		const input = event(); await queue.enqueue(input); const batch = (await manager.prepareBatch(1, 10000))!;
		await manager.markDelivered(batch.batchId, [input.eventId]); await queue.close(); await reopen();
		assert.equal((await manager.getDeliveryStatus()).deliveredBatches, 1);
		await queue.enqueue(input); assert.equal(await manager.prepareBatch(1, 10000), null);
	});

	test('acknowledged retention prunes delivery references while pending batches survive', async () => {
		const acknowledged = event(); const pending = event();
		await queue.enqueue(acknowledged); await queue.enqueue(pending);
		await queue.finishSession(acknowledged.sessionId); await queue.finishSession(pending.sessionId);
		const batch = (await manager.prepareBatch(2, 10000))!;
		await manager.markDelivered(batch.batchId, [acknowledged.eventId]);
		const db = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME));
		try {
			db.prepare("UPDATE recording_sessions SET ended_at = '2020-01-01T00:00:00.000Z' WHERE session_id = ?").run(acknowledged.sessionId);
			db.prepare("UPDATE queued_events SET acknowledged_at = '2020-01-01T00:00:00.000Z' WHERE event_id = ?").run(acknowledged.eventId);
		} finally { db.close(); }
		await queue.acquireMaintenance(); await queue.expireAcknowledged('2021-01-01T00:00:00.000Z'); await queue.releaseMaintenance();
		assert.deepEqual((await manager.prepareBatch(1, 10000))?.events, [pending]);
		await queue.close(); await reopen(); assert.equal(await queue.getPendingCount(), 1);
	});

	test('invalid limits and batch identifiers fail safely', async () => {
		for (const [count, bytes] of [[0, 100], [1001, 100], [1, 1], [1, MAX_DELIVERY_BATCH_BYTES + 1], [1.5, 100]]) {
			await assert.rejects(manager.prepareBatch(count, bytes));
		}
		await assert.rejects(manager.releaseBatch('invalid')); await assert.rejects(manager.markDelivered(randomUUID(), []));
	});
});
