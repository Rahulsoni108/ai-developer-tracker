import * as assert from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTwoFilesPatch } from 'diff';
import { createChangeEvent, createFileEvent, EventValidationError } from '../eventSchema';
import { LOCAL_QUEUE_FILENAME, LocalEventQueue, LocalEventQueueError, MAX_QUEUE_BATCH, QUEUE_DATABASE_VERSION } from '../localEventQueue';

const uri = (path: string) => ({ scheme: 'file', fsPath: path });
const event = () => createFileEvent({ source: 'vscode', eventType: 'file.saved', sessionId: randomUUID(),
	workspaceId: 'workspace-test', payload: { relativePath: 'src/example.ts' } });

suite('Persistent local event queue', () => {
	let root: string;
	let storage: string;
	let queue: LocalEventQueue;
	let extra: LocalEventQueue | undefined;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'ai-queue-'));
		storage = join(root, 'global-storage');
		queue = await LocalEventQueue.open(uri(storage), [{ uri: uri(join(root, 'workspace')) }]);
	});

	teardown(async () => {
		await extra?.close();
		extra = undefined;
		await queue.close();
		await rm(root, { recursive: true, force: true });
	});

	test('inserts and reads a normalized event with all fields intact', async () => {
		const input = event();
		assert.strictEqual(await queue.getPendingCount(), 0);
		await queue.enqueue(input);
		assert.strictEqual(await queue.getPendingCount(), 1);
		assert.deepStrictEqual(await queue.getPending(10), [input]);
	});

	test('reads pending events in insertion order, with a limit, without consuming them', async () => {
		const inputs = [event(), event(), event()];
		inputs[0].timestamp = '2026-10-13T13:00:00.000Z';
		inputs[1].timestamp = '2026-10-12T13:00:00.000Z';
		await Promise.all(inputs.map(input => queue.enqueue(input)));
		assert.deepStrictEqual(await queue.getPending(2), inputs.slice(0, 2));
		assert.deepStrictEqual(await queue.getPending(3), inputs);
		assert.strictEqual(await queue.getPendingCount(), 3);
	});

	test('deduplicates by event ID and preserves the first payload', async () => {
		const input = event();
		await Promise.all([queue.enqueue(input), queue.enqueue(input),
			queue.enqueue({ ...input, payload: { relativePath: 'different.ts' } })]);
		assert.deepStrictEqual(await queue.getPending(10), [input]);
	});

	test('snapshots inputs and returns independent event objects', async () => {
		const input = event();
		const original = JSON.parse(JSON.stringify(input));
		const pending = queue.enqueue(input);
		input.payload.relativePath = 'changed.ts';
		await pending;
		const retrieved = await queue.getPending(10);
		assert.deepStrictEqual(retrieved, [original]);
		retrieved[0].timestamp = '2020-01-01T00:00:00.000Z';
		assert.deepStrictEqual(await queue.getPending(10), [original]);
	});

	test('acknowledges selected events atomically and tolerates duplicate or unknown IDs', async () => {
		const inputs = [event(), event(), event()];
		await Promise.all(inputs.map(input => queue.enqueue(input)));
		await queue.markAcknowledged([inputs[0].eventId, inputs[2].eventId, inputs[0].eventId, randomUUID()]);
		await queue.markAcknowledged([]);
		await queue.markAcknowledged([inputs[0].eventId]);
		assert.deepStrictEqual(await queue.getPending(10), [inputs[1]]);
		assert.strictEqual(await queue.getPendingCount(), 1);
	});

	test('reopens pending events and retains acknowledgment and deduplication state', async () => {
		const inputs = [event(), event()];
		await Promise.all(inputs.map(input => queue.enqueue(input)));
		await queue.markAcknowledged([inputs[0].eventId]);
		await queue.close();
		queue = await LocalEventQueue.open(uri(storage), []);
		await Promise.all(inputs.map(input => queue.enqueue(input)));
		assert.deepStrictEqual(await queue.getPending(10), [inputs[1]]);
		assert.strictEqual(await queue.getPendingCount(), 1);
	});

	test('commits are visible from another connection before closing', async () => {
		extra = await LocalEventQueue.open(uri(storage), []);
		const input = event();
		await queue.enqueue(input);
		assert.deepStrictEqual(await extra.getPending(10), [input]);
		await extra.enqueue(input);
		await extra.markAcknowledged([input.eventId]);
		assert.strictEqual(await queue.getPendingCount(), 0);
	});

	test('uses SQLite WAL, full synchronization, schema versioning and private storage', async () => {
		await queue.enqueue(event());
		const path = join(storage, LOCAL_QUEUE_FILENAME);
		assert.strictEqual((await readFile(path)).subarray(0, 16).toString(), 'SQLite format 3\u0000');
		const database = new DatabaseSync(path);
		try {
			assert.strictEqual(database.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
			assert.strictEqual(database.prepare('PRAGMA user_version').get()?.user_version, QUEUE_DATABASE_VERSION);
			// synchronous is connection-local; the default FULL on this fresh connection is also durable.
			assert.strictEqual(database.prepare('PRAGMA synchronous').get()?.synchronous, 2);
		} finally { database.close(); }
		if (process.platform !== 'win32') {
			assert.strictEqual((await stat(storage)).mode & 0o777, 0o700);
			for (const file of [path, `${path}-wal`, `${path}-shm`]) {
				assert.strictEqual((await stat(file)).mode & 0o777, 0o600);
			}
		}
	});

	test('acknowledgment drops payload content while retaining event ID tombstones', async () => {
		const input = event();
		await queue.enqueue(input);
		await queue.markAcknowledged([input.eventId]);
		const database = new DatabaseSync(join(storage, LOCAL_QUEUE_FILENAME));
		try {
			const row = database.prepare('SELECT event_id, event_json, acknowledged FROM queued_events').get();
			assert.strictEqual(row?.event_id, input.eventId);
			assert.strictEqual(row?.event_json, null);
			assert.strictEqual(row?.acknowledged, 1);
		} finally { database.close(); }
	});

	test('rejects invalid events and continues accepting valid ones', async () => {
		await assert.rejects(queue.enqueue({ ...event(), schemaVersion: 999 }), EventValidationError);
		await assert.rejects(queue.enqueue({ private: 'secret-placeholder' }), EventValidationError);
		await queue.enqueue(event());
		assert.strictEqual(await queue.getPendingCount(), 1);
	});

	test('round-trips code diffs with JSON escaping overhead above two MiB', async () => {
		const after = '\t'.repeat(1100000) + '\n';
		const input = createChangeEvent({ eventType: 'file.diff', sessionId: randomUUID(), workspaceId: 'workspace-test',
			payload: { relativePath: 'example.ts', diff: createTwoFilesPatch('before', 'after', '', after),
				beforeHash: createHash('sha256').update('').digest('hex'),
				afterHash: createHash('sha256').update(after).digest('hex'), changeReason: 'edit' } });
		assert.ok(Buffer.byteLength(JSON.stringify(input)) > 2 * 1024 * 1024);
		await queue.enqueue(input);
		assert.deepStrictEqual(await queue.getPending(1), [input]);
	});

	test('rolls back failed acknowledgment transactions and hides driver error details', async () => {
		const inputs = [event(), event()];
		await Promise.all(inputs.map(input => queue.enqueue(input)));
		const database = new DatabaseSync(join(storage, LOCAL_QUEUE_FILENAME));
		try {
			database.exec(`CREATE TRIGGER reject_ack BEFORE UPDATE ON queued_events WHEN OLD.sequence = 2
				BEGIN SELECT RAISE(ABORT, 'private-placeholder'); END`);
			await assert.rejects(queue.markAcknowledged(inputs.map(input => input.eventId)), error => {
				assert.ok(error instanceof LocalEventQueueError);
				assert.strictEqual(error.message, 'Local event queue operation failed.');
				assert.strictEqual(error.cause, undefined);
				return true;
			});
			assert.deepStrictEqual(await queue.getPending(10), inputs);
			database.exec('DROP TRIGGER reject_ack');
			await queue.markAcknowledged(inputs.map(input => input.eventId));
			assert.strictEqual(await queue.getPendingCount(), 0);
		} finally { database.close(); }
	});

	test('bounds reads and rejects invalid acknowledgment batches without partial updates', async () => {
		const input = event();
		await queue.enqueue(input);
		for (const limit of [0, -1, 1.5, NaN, Infinity, MAX_QUEUE_BATCH + 1]) {
			await assert.rejects(queue.getPending(limit), LocalEventQueueError);
		}
		await assert.rejects(queue.markAcknowledged([input.eventId, 'bad-id']), LocalEventQueueError);
		await assert.rejects(queue.markAcknowledged(Array(MAX_QUEUE_BATCH + 1).fill(input.eventId)), LocalEventQueueError);
		assert.strictEqual(await queue.getPendingCount(), 1);
	});

	test('close drains accepted operations, is idempotent and rejects further operations', async () => {
		const input = event();
		const inserted = queue.enqueue(input);
		const closing = queue.close();
		assert.strictEqual(queue.close(), closing);
		await assert.rejects(queue.enqueue(event()), /closed/);
		await assert.rejects(queue.getPendingCount(), /closed/);
		await assert.rejects(queue.getPending(1), /closed/);
		await assert.rejects(queue.markAcknowledged([]), /closed/);
		await Promise.all([inserted, closing]);
		queue = await LocalEventQueue.open(uri(storage), []);
		assert.deepStrictEqual(await queue.getPending(10), [input]);
	});

	test('rejects nonlocal storage and workspace-local storage', async () => {
		await assert.rejects(LocalEventQueue.open({ scheme: 'vscode-remote', fsPath: storage }, []), /local globalStorageUri/);
		await assert.rejects(LocalEventQueue.open(uri('relative-path'), []), /local globalStorageUri/);
		await assert.rejects(LocalEventQueue.open(uri(join(root, 'workspace', 'logs')), [{ uri: uri(join(root, 'workspace')) }]), /outside workspace/);
	});

	test('checks canonical workspace paths before creating storage through a symlink', async function () {
		if (process.platform === 'win32') { this.skip(); }
		const workspace = join(root, 'workspace');
		await mkdir(workspace);
		await symlink(workspace, join(root, 'alias'));
		await assert.rejects(LocalEventQueue.open(uri(join(root, 'alias', 'logs')), [{ uri: uri(workspace) }]), /outside workspace/);
		await assert.rejects(stat(join(workspace, 'logs')), { code: 'ENOENT' });
	});

	test('rejects symlinked database and WAL files without changing their targets', async function () {
		if (process.platform === 'win32') { this.skip(); }
		const otherStorage = join(root, 'unsafe-storage');
		const target = join(root, 'private-file');
		await mkdir(otherStorage);
		await writeFile(target, 'do not change');
		const path = join(otherStorage, LOCAL_QUEUE_FILENAME);
		await symlink(target, path);
		await assert.rejects(LocalEventQueue.open(uri(otherStorage), []), /Unsafe queue storage/);
		await rm(path);
		await symlink(target, `${path}-wal`);
		await assert.rejects(LocalEventQueue.open(uri(otherStorage), []), /Unsafe queue storage/);
		assert.strictEqual(await readFile(target, 'utf8'), 'do not change');
	});

	test('rejects a future database schema without changing its version', async () => {
		await queue.close();
		const path = join(storage, LOCAL_QUEUE_FILENAME);
		const database = new DatabaseSync(path);
		database.exec('PRAGMA user_version = 99');
		database.close();
		await assert.rejects(LocalEventQueue.open(uri(storage), []), /Unsupported queue/);
		const reopened = new DatabaseSync(path);
		try { assert.strictEqual(reopened.prepare('PRAGMA user_version').get()?.user_version, 99); }
		finally { reopened.close(); }
	});

	test('rejects corrupt stored events without exposing contents and recovers after repair', async () => {
		const input = event();
		await queue.enqueue(input);
		const database = new DatabaseSync(join(storage, LOCAL_QUEUE_FILENAME));
		try {
			database.prepare('UPDATE queued_events SET event_json = ?').run('private malformed contents');
			await assert.rejects(queue.getPending(10), error => {
				assert.ok(error instanceof LocalEventQueueError);
				assert.ok(!error.message.includes('private'));
				assert.strictEqual(error.cause, undefined);
				return true;
			});
			database.prepare('UPDATE queued_events SET event_json = ?').run(JSON.stringify(input));
			assert.deepStrictEqual(await queue.getPending(10), [input]);
		} finally { database.close(); }
	});
});
