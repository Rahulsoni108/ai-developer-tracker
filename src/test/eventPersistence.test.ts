import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { EventPersistence, EventPersistenceError, type PersistenceDiagnostic } from '../eventPersistence';
import { createFileEvent, type TrackerEvent } from '../eventSchema';
import { JsonlWriter } from '../jsonlWriter';
import { LocalEventQueue } from '../localEventQueue';

const event = () => createFileEvent({ sessionId: randomUUID(), workspaceId: 'workspace', source: 'vscode',
	eventType: 'file.modified', payload: { relativePath: 'app.ts' } });

suite('Queue-first event persistence', () => {
	let root: string;
	let queue: LocalEventQueue;
	let jsonl: JsonlWriter;
	let writer: EventPersistence;
	let issues: PersistenceDiagnostic[];
	const storage = () => ({ scheme: 'file', fsPath: join(root, 'global-storage') });
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'ai-persistence-'));
		queue = await LocalEventQueue.open(storage(), []);
		jsonl = new JsonlWriter(join(root, 'logs', 'events.v1.jsonl'));
		issues = [];
		writer = new EventPersistence(queue, jsonl, reason => issues.push(reason));
	});
	teardown(async () => {
		await writer.close(); await queue.close();
		await rm(root, { recursive: true, force: true });
	});

	test('preserves IDs and the same normalized content in SQLite and JSONL', async () => {
		const input = event();
		await writer.write(input);
		assert.deepEqual(await queue.getPending(10), [input]);
		assert.deepEqual(JSON.parse((await readFile(jsonl.filePath, 'utf8')).trim()), input);
		assert.deepEqual(issues, []);
	});

	test('waits for durable enqueue before the mirror, notification and successful capture', async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const order: string[] = [];
		writer = new EventPersistence({ enqueue: async input => { order.push('enqueue'); await gate; await queue.enqueue(input); order.push('commit'); },
			close: () => queue.close() }, { write: async input => { order.push('jsonl'); await jsonl.write(input); }, flush: () => jsonl.flush() });
		writer.onDidWrite(() => { order.push('notify'); });
		const input = event(); let resolved = false;
		const writing = writer.write(input).then(() => { resolved = true; });
		await setImmediate(); await setImmediate();
		assert.deepEqual(order, ['enqueue']); assert.equal(resolved, false);
		assert.equal(await queue.getPendingCount(), 0);
		release(); await writing;
		assert.deepEqual(order, ['enqueue', 'commit', 'jsonl', 'notify']);
	});

	test('deduplicates concurrent writes, mirrors and notifications without changing the first snapshot', async () => {
		const input = event(); const original = JSON.parse(JSON.stringify(input));
		let notified = 0; writer.onDidWrite(() => { notified++; });
		const first = writer.write(input); input.payload.relativePath = 'changed.ts';
		await Promise.all([first, writer.write(input), writer.write(input)]);
		assert.deepEqual(await queue.getPending(10), [original]);
		assert.equal((await readFile(jsonl.filePath, 'utf8')).trim().split('\n').length, 1);
		assert.equal(notified, 1);
	});

	test('JSONL failure resolves durable capture, notifies observers and cannot duplicate SQLite events', async () => {
		const blocked = join(root, 'blocked'); await writeFile(blocked, 'blocked');
		writer = new EventPersistence(queue, new JsonlWriter(join(blocked, 'events.jsonl')), reason => issues.push(reason));
		const input = event(); const seen: TrackerEvent[] = [];
		writer.onDidWrite(value => { seen.push(value as TrackerEvent); });
		await writer.write(input); await writer.write(input); await writer.flush();
		assert.deepEqual(await queue.getPending(10), [input]);
		assert.deepEqual(seen, [input]); assert.deepEqual(issues, ['jsonl_failed']);
	});

	test('queue failure rejects capture without mirroring or notifying and supports later successful writes', async () => {
		let fail = true; let notified = 0;
		writer = new EventPersistence({ enqueue: async input => {
			if (fail) { throw new Error('PRIVATE_SQL_VALUES_AND_PATH'); } await queue.enqueue(input);
		}, close: () => queue.close() }, jsonl, reason => issues.push(reason));
		writer.onDidWrite(() => { notified++; }); const input = event();
		await assert.rejects(writer.write(input), error => {
			assert.ok(error instanceof EventPersistenceError); assert.equal(error.cause, undefined);
			assert.equal(error.message, 'Durable event persistence failed.'); return true;
		});
		assert.equal(await queue.getPendingCount(), 0); assert.equal(notified, 0);
		await assert.rejects(readFile(jsonl.filePath), { code: 'ENOENT' });
		fail = false; await writer.write(input);
		assert.deepEqual(await queue.getPending(10), [input]); assert.equal(notified, 1);
		assert.deepEqual(issues, ['queue_failed']);
	});

	test('serializes writes, yields to the host and drains accepted work before closing', async () => {
		const inputs = [event(), event(), event()];
		const writing = inputs.map(input => writer.write(input));
		const closing = writer.close(); assert.equal(writer.close(), closing);
		await assert.rejects(writer.write(event()), EventPersistenceError);
		await Promise.all([...writing, closing]);
		queue = await LocalEventQueue.open(storage(), []);
		assert.deepEqual(await queue.getPending(10), inputs);
	});

	test('restart preserves pending IDs and acknowledged tombstones without replaying old events', async () => {
		const inputs = [event(), event()];
		await Promise.all(inputs.map(input => writer.write(input)));
		await queue.markAcknowledged([inputs[0].eventId]); await writer.close();
		queue = await LocalEventQueue.open(storage(), []);
		writer = new EventPersistence(queue, jsonl);
		assert.deepEqual(await queue.getPending(10), [inputs[1]]);
		await writer.write(inputs[0]); await writer.write(inputs[1]);
		assert.deepEqual(await queue.getPending(10), [inputs[1]]);
	});

	test('isolates observer mutations and failures and supports disposal', async () => {
		const input = event(); let last: TrackerEvent | undefined;
		writer.onDidWrite(value => { (value as TrackerEvent).timestamp = 'mutated'; throw new Error('PRIVATE_DATA'); });
		const listener = writer.onDidWrite(value => { last = value as TrackerEvent; });
		await writer.write(input); assert.deepEqual(last, input);
		assert.deepEqual(await queue.getPending(10), [input]);
		listener.dispose(); last = undefined;
		await writer.write(event()); assert.equal(last, undefined);
	});

	test('rejects invalid events before touching either sink', async () => {
		await assert.rejects(writer.write({ invalid: 'PRIVATE_DATA' }));
		assert.equal(await queue.getPendingCount(), 0);
		await assert.rejects(readFile(jsonl.filePath), { code: 'ENOENT' });
	});

	test('hides JSONL flush and close exceptions and isolates diagnostic callback failures', async () => {
		writer = new EventPersistence({ enqueue: input => queue.enqueue(input), close: async () => { await queue.close(); throw new Error('PRIVATE_CLOSE'); } },
			{ write: async () => {}, flush: async () => { throw new Error('PRIVATE_FLUSH'); } }, reason => { issues.push(reason); throw new Error('PRIVATE_DIAGNOSTIC'); });
		await writer.write(event()); await writer.flush();
		await assert.rejects(writer.close(), EventPersistenceError);
		assert.deepEqual(issues, ['jsonl_failed', 'jsonl_failed', 'queue_failed']);
		// Replace the intentionally failing instance for teardown.
		queue = await LocalEventQueue.open(storage(), []); writer = new EventPersistence(queue, jsonl);
	});
});
