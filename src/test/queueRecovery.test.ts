import { openTestQueue, openTestWorkerQueue, testSecrets, EVIDENCE_KEY_SECRET } from './queueTestKeys';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import { setTimeout as pause } from 'node:timers/promises';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { createFileEvent } from '../eventSchema';
import { EventPersistence } from '../eventPersistence';
import { JsonlWriter } from '../jsonlWriter';
import { LOCAL_QUEUE_FILENAME, LocalEventQueue, LocalEventQueueError, QUEUE_DATABASE_VERSION } from '../localEventQueue';
import { RecordingController } from '../recording';

const event = (sessionId: string = randomUUID()) => createFileEvent({ sessionId, workspaceId: 'workspace', source: 'vscode',
	eventType: 'file.modified', payload: { relativePath: 'example.ts' } });

suite('Queue crash recovery', () => {
	let root: string;
	let queue: LocalEventQueue;
	const storage = () => ({ scheme: 'file', fsPath: root });
	setup(async () => { root = await mkdtemp(join(tmpdir(), 'ai-recovery-')); queue = await openTestQueue(storage(), []); });
	teardown(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });

	test('preserves pending events and IDs after reopening and rejects duplicate replay', async () => {
		const input = event(); await queue.enqueue(input); await queue.close();
		queue = await openTestQueue(storage(), []); await queue.enqueue(input);
		assert.deepEqual(await queue.getPending(10), [input]);
		assert.equal((await queue.getHealth()).pendingCount, 1);
	});

	test('records completed sessions only after the persistence lifecycle drains', async () => {
		const recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true);
		const writer = new EventPersistence(queue, new JsonlWriter(join(root, 'mirror.jsonl')));
		const subscription = writer.attachRecording(recording, () => ({ approvedWorkspaceIds: ['workspace'], confirmedCodexSessions: [], codexContentConsent: false }));
		await recording.start(); const session = recording.sessionId!; const input = event(session);
		await writer.write(input); recording.stop();
		assert.equal((await queue.getRecordingSessions())[0].status, 'active');
		await writer.completeSession(session); await writer.close(); subscription.dispose(); recording.dispose();
		queue = await openTestQueue(storage(), []);
		assert.equal((await queue.getRecordingSessions())[0].status, 'completed');
		assert.deepEqual(await queue.getPending(10), [input]);
	});

	test('cancels prepared sessions without collecting data or resuming recording', async () => {
		const recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true);
		const writer = new EventPersistence(queue, new JsonlWriter(join(root, 'mirror.jsonl')));
		const subscription = writer.attachRecording(recording, () => ({ approvedWorkspaceIds: ['workspace'], confirmedCodexSessions: [], codexContentConsent: false }));
		const cancel = recording.addLifecycleListener({ prepare: async () => { recording.stop(); }, started() {}, stopped() {}, cancelled() {} });
		await recording.start(); await writer.flush(); await writer.close();
		assert.equal(recording.isRecording, false); assert.equal(recording.sessionId, undefined);
		subscription.dispose(); cancel.dispose(); recording.dispose();
		queue = await openTestQueue(storage(), []);
		assert.equal((await queue.getRecordingSessions())[0].status, 'cancelled'); assert.equal(await queue.getPendingCount(), 0);
	});

	test('does not mark a live connection recording as interrupted when another connection opens', async () => {
		const session = randomUUID(); await queue.beginSession(session); await queue.enqueue(event(session));
		const other = await openTestQueue(storage(), []);
		try { assert.equal((await other.getRecordingSessions())[0].status, 'active'); assert.equal((await other.getHealth()).recoveredSessionCount, 0); }
		finally { await other.close(); }
		await queue.finishSession(session);
	});

	test('worker interruption preserves committed data, marks the abandoned session and never resumes consent', async () => {
		await queue.close(); const workerQueue = await openTestWorkerQueue(storage(), []);
		const session = randomUUID(); const input = event(session);
		await workerQueue.beginSession(session); await workerQueue.enqueue(input);
		let failures = 0; workerQueue.onDidFail(() => { failures++; });
		await (workerQueue as unknown as { worker: Worker }).worker.terminate(); await workerQueue.close();
		assert.equal(failures, 1);
		const recovered = await openTestWorkerQueue(storage(), []);
		try {
			assert.deepEqual(await recovered.getPending(10), [input]); await recovered.enqueue(input);
			assert.equal(await recovered.getPendingCount(), 1);
			assert.equal((await recovered.getRecordingSessions())[0].status, 'interrupted');
			assert.equal((await recovered.getHealth()).recoveredSessionCount, 1);
			let consent = false; let requests = 0;
			const recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => { requests++; return consent; });
			const writer = new EventPersistence(recovered, new JsonlWriter(join(root, 'mirror.jsonl')));
			const subscription = writer.attachRecording(recording, () => ({ approvedWorkspaceIds: ['workspace'], confirmedCodexSessions: [], codexContentConsent: false }));
			assert.equal(recording.isRecording, false); assert.equal(requests, 0);
			await recording.start(); assert.equal(recording.isRecording, false);
			consent = true; await recording.start(); assert.notEqual(recording.sessionId, session);
			assert.equal(requests, 2); recording.stop(); await writer.close(); subscription.dispose(); recording.dispose();
		} finally { await recovered.close(); }
	});

	test('crashed process WAL recovery retains committed events and rolls back an interrupted transaction', async function () {
		this.timeout(15000); await queue.close();
		const session = randomUUID(); const committed = event(session); const uncommitted = event(session);
		const program = `const { openTestQueue, testSecrets, EVIDENCE_KEY_SECRET } = require(process.argv[1]);
			(async () => {
				let secret = ''; for await (const chunk of process.stdin) secret += chunk.toString();
				await testSecrets.store(EVIDENCE_KEY_SECRET, secret);
				const queue = await openTestQueue(JSON.parse(process.argv[2]), []);
				await queue.beginSession(process.argv[3]); await queue.enqueue(JSON.parse(process.argv[4]));
				queue.database.exec('BEGIN IMMEDIATE');
				queue.database.prepare('INSERT INTO queued_events(event_id, event_json, payload_format) VALUES (?, ?, 1)')
					.run(process.argv[5], JSON.stringify(queue.cipher.encrypt(process.argv[5], process.argv[6])));
				process.stdout.write('READY\\n'); setInterval(() => {}, 1000);
			})().catch(() => process.exit(1));`;
		const child = spawn(process.execPath, ['-e', program, require.resolve('./queueTestKeys'), JSON.stringify(storage()), session,
			JSON.stringify(committed), uncommitted.eventId, JSON.stringify(uncommitted)],
			{ env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
		child.stdin.end(await testSecrets.get(EVIDENCE_KEY_SECRET));
		const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('Crash fixture startup timeout.')), 8000);
				child.stdout.on('data', data => { if (String(data).includes('READY')) { clearTimeout(timer); resolve(); } });
				child.once('error', () => { clearTimeout(timer); reject(new Error('Crash fixture startup failed.')); });
				child.once('exit', () => { clearTimeout(timer); reject(new Error('Crash fixture exited too early.')); });
			});
			child.kill('SIGKILL'); await exited;
			queue = await openTestQueue(storage(), []);
			assert.deepEqual(await queue.getPending(10), [committed]);
			const status = (await queue.getRecordingSessions()).find(record => record.sessionId === session)!;
			assert.equal(status.status, 'interrupted'); assert.equal(status.reason, 'owner_lost');
			assert.equal((await queue.getHealth()).recoveredSessionCount, 1);
		} finally { child.kill('SIGKILL'); await exited; }
	});

	test('migrates schema-v1 queues without changing old events and marks unverifiable sessions incomplete', async () => {
		await queue.close(); const path = join(root, LOCAL_QUEUE_FILENAME); await rm(path);
		const input = event(); const database = new DatabaseSync(path);
		database.exec(`CREATE TABLE queued_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
			event_json TEXT, acknowledged INTEGER NOT NULL DEFAULT 0) STRICT;
			CREATE INDEX pending_events ON queued_events(sequence) WHERE acknowledged = 0; PRAGMA user_version = 1;`);
		database.prepare('INSERT INTO queued_events(event_id, event_json) VALUES (?, ?)').run(input.eventId, JSON.stringify(input)); database.close();
		queue = await openTestQueue(storage(), []);
		assert.deepEqual(await queue.getPending(10), [input]);
		assert.equal((await queue.getRecordingSessions())[0].status, 'incomplete');
		const inspect = new DatabaseSync(path);
		try { assert.equal(inspect.prepare('PRAGMA user_version').get()?.user_version, QUEUE_DATABASE_VERSION); }
		finally { inspect.close(); }
	});

	test('migrates schema-v2 queues without rewriting historical events or session identities', async () => {
		const input = event(); await queue.enqueue(input); await queue.close();
		const database = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME));
		// Construct a real old plaintext representation rather than downgrading encrypted data.
		database.prepare('UPDATE queued_events SET event_json = ?, payload_format = 0').run(JSON.stringify(input));
		database.exec('DROP TABLE upload_retry_state; DROP TABLE delivery_members; DROP TABLE delivery_batches; DROP INDEX retention_events; DROP TRIGGER count_event_delete; DROP TRIGGER count_session_delete; DROP TABLE queue_maintenance; ALTER TABLE queued_events DROP COLUMN session_id; ALTER TABLE queued_events DROP COLUMN acknowledged_at; ALTER TABLE queued_events DROP COLUMN payload_format; DROP TABLE queue_encryption_keys; DROP TABLE recording_privacy_health; PRAGMA user_version = 2;'); database.close();
		queue = await openTestQueue(storage(), []);
		assert.deepEqual(await queue.getPending(10), [input]);
		assert.deepEqual(await queue.getPrivacyHealth(input.sessionId), { rejectedCount: 0, reasonCounts: {} });
		assert.equal((await queue.getRecordingSessions())[0].sessionId, input.sessionId);
	});

	test('validates rejection-health categories at startup without exposing tampered values', async () => {
		const session = randomUUID(); await queue.beginSession(session); await queue.recordPrivacyRejection(session, ['sensitive_file_path']); await queue.close();
		const database = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME));
		database.prepare('UPDATE recording_privacy_health SET reason_counts = ?').run('{"PRIVATE_DUMMY_TEXT":1}'); database.close();
		await assert.rejects(openTestQueue(storage(), []), error => {
			assert.ok(error instanceof LocalEventQueueError); assert.equal(error.code, 'corrupt'); assert.ok(!error.message.includes('PRIVATE_DUMMY_TEXT')); return true;
		});
	});

	test('detects corrupt database bytes without recreating or replacing the file', async () => {
		await queue.close(); const path = join(root, LOCAL_QUEUE_FILENAME); const invalid = Buffer.from('INVALID PRIVATE DATABASE PLACEHOLDER');
		await writeFile(path, invalid);
		await assert.rejects(openTestQueue(storage(), []), error => {
			assert.ok(error instanceof LocalEventQueueError); assert.equal(error.code, 'corrupt');
			assert.ok(!error.message.includes('PRIVATE')); assert.equal(error.cause, undefined); return true;
		});
		assert.deepEqual(await readFile(path), invalid);
	});

	test('detects malformed stored normalized events during startup', async () => {
		await queue.enqueue(event()); await queue.close();
		const database = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME));
		database.prepare('UPDATE queued_events SET event_json = ?').run('{"private":"dummy"}'); database.close();
		await assert.rejects(openTestQueue(storage(), []), error => error instanceof LocalEventQueueError && error.code === 'authentication_failed');
	});

	test('detects tampered counters and missing schema triggers at startup', async () => {
		await queue.close(); const database = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME));
		database.exec('UPDATE queue_health SET pending_count = 123'); database.close();
		await assert.rejects(openTestQueue(storage(), []), error => error instanceof LocalEventQueueError && error.code === 'corrupt');
		const repair = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME)); repair.exec('UPDATE queue_health SET pending_count = 0; DROP TRIGGER count_event_insert'); repair.close();
		await assert.rejects(openTestQueue(storage(), []), error => error instanceof LocalEventQueueError && error.code === 'corrupt');
	});

	test('an interrupted worker request rejects safely and recovers committed rows without duplicate replay', async function () {
		this.timeout(10000); await queue.close(); const threaded = await openTestWorkerQueue(storage(), []);
		const session = randomUUID(); const first = event(session); const second = event(session);
		await threaded.beginSession(session); await threaded.enqueue(first);
		const lock = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME)); lock.exec('BEGIN IMMEDIATE');
		const pending = threaded.enqueue(second).then(() => 'committed', () => 'rejected');
		try {
			await pause(20); await (threaded as unknown as { worker: Worker }).worker.terminate();
			assert.equal(await pending, 'rejected');
		} finally { lock.exec('ROLLBACK'); lock.close(); await threaded.close(); }
		queue = await openTestQueue(storage(), []);
		assert.deepEqual(await queue.getPending(10), [first]); await queue.enqueue(first);
		assert.equal(await queue.getPendingCount(), 1);
		assert.equal((await queue.getRecordingSessions())[0].status, 'interrupted');
	});

	test('corrupt database startup errors cross the worker boundary without exposing contents', async () => {
		await queue.close(); await writeFile(join(root, LOCAL_QUEUE_FILENAME), 'PRIVATE INVALID DATABASE');
		await assert.rejects(openTestWorkerQueue(storage(), []), error => {
			assert.ok(error instanceof LocalEventQueueError); assert.equal(error.code, 'corrupt');
			assert.equal(error.message, 'Unable to open local event queue.'); assert.equal(error.cause, undefined); return true;
		});
	});

	test('startup checks remain consistent while another live storage worker commits events', async () => {
		const first = await openTestWorkerQueue(storage(), []); const session = randomUUID();
		let second: AsyncLocalEventQueue | undefined;
		try {
			await first.beginSession(session); const inputs = Array.from({ length: 50 }, () => event(session));
			const writing = Promise.all(inputs.map(input => first.enqueue(input)));
			second = await openTestWorkerQueue(storage(), []); await writing;
			assert.deepEqual(await second.getPending(100), inputs);
			assert.equal((await second.getRecordingSessions())[0].status, 'active');
			await first.finishSession(session);
		} finally { await second?.close(); await first.close(); }
	});
});
