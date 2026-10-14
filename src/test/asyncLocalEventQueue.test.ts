import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import type { Worker } from 'node:worker_threads';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { LOCAL_QUEUE_FILENAME, LocalEventQueueError } from '../localEventQueue';
import { createFileEvent } from '../eventSchema';

const event = () => createFileEvent({ sessionId: randomUUID(), workspaceId: 'workspace', source: 'vscode',
	eventType: 'file.saved', payload: { relativePath: 'example.ts' } });

suite('Async SQLite storage thread', () => {
	let root: string;
	let queue: AsyncLocalEventQueue;
	const storage = () => ({ scheme: 'file', fsPath: root });
	setup(async () => { root = await mkdtemp(join(tmpdir(), 'ai-queue-thread-')); queue = await AsyncLocalEventQueue.open(storage(), []); });
	teardown(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });

	test('reuses SQLite insertion, FIFO, deduplication, acknowledgment and reopening', async () => {
		const inputs = [event(), event()];
		await Promise.all([queue.enqueue(inputs[0]), queue.enqueue(inputs[1]), queue.enqueue(inputs[0])]);
		assert.deepEqual(await queue.getPending(10), inputs); assert.equal(await queue.getPendingCount(), 2);
		await queue.markAcknowledged([inputs[0].eventId]); await queue.close();
		queue = await AsyncLocalEventQueue.open(storage(), []); await queue.enqueue(inputs[0]);
		assert.deepEqual(await queue.getPending(10), [inputs[1]]);
	});

	test('drains accepted requests before closing and rejects subsequent writes', async () => {
		const input = event(); const writing = queue.enqueue(input); const closing = queue.close();
		assert.equal(queue.close(), closing); await assert.rejects(queue.enqueue(event()), LocalEventQueueError);
		await Promise.all([writing, closing]); queue = await AsyncLocalEventQueue.open(storage(), []);
		assert.deepEqual(await queue.getPending(10), [input]);
	});

	test('keeps the host event loop responsive while SQLite waits for a competing transaction', async () => {
		const database = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME)); database.exec('BEGIN IMMEDIATE');
		let completed = false;
		const writing = queue.enqueue(event()).finally(() => { completed = true; });
		try {
			await setTimeout(50); assert.equal(completed, false);
		} finally { database.exec('COMMIT'); database.close(); }
		await writing; assert.equal(await queue.getPendingCount(), 1);
	});

	test('rejects invalid input and startup paths without leaking values or paths', async () => {
		await assert.rejects(queue.enqueue({ private: 'dummy-secret' }), error => {
			assert.ok(error instanceof LocalEventQueueError); assert.equal(error.cause, undefined);
			assert.equal(error.message, 'Local event queue operation failed.'); return true;
		});
		await assert.rejects(AsyncLocalEventQueue.open(storage(), [{ uri: storage() }]), /Unable to open local event queue/);
		await queue.enqueue(event()); assert.equal(await queue.getPendingCount(), 1);
	});

	test('handles storage-thread termination gracefully', async () => {
		// Inject thread failure, without adding a production fault-injection API.
		await (queue as unknown as { worker: Worker }).worker.terminate();
		await assert.rejects(queue.enqueue(event()), /unavailable/); await queue.close();
		queue = await AsyncLocalEventQueue.open(storage(), []); assert.equal(await queue.getPendingCount(), 0);
	});
});
