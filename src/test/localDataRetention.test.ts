import * as assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import { createTwoFilesPatch } from 'diff';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { LocalEventQueueError, LOCAL_QUEUE_FILENAME } from '../localEventQueue';
import { createChangeEvent, createCodexEvent, createFileEvent, type TrackerEvent } from '../eventSchema';
import { JsonlWriter, eventDiagnostic } from '../jsonlWriter';
import { LocalDataController, DEFAULT_RETENTION_DAYS, type LocalDataNotice } from '../localDataController';
import { RecordingController } from '../recording';
import { testSecrets } from './queueTestKeys';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const file = (sessionId: string = randomUUID()) => createFileEvent({ source: 'vscode', sessionId, workspaceId: 'workspace',
	eventType: 'file.modified', payload: { relativePath: 'src/app.ts' } });

suite('Safe metadata JSONL diagnostics', () => {
	test('never writes evidence, paths, IDs, prompts, responses, arguments, outputs or secrets for any collector', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ai-safe-diagnostics-'));
		try {
			const writer = new JsonlWriter(join(root, 'diagnostics.jsonl')); const sessionId = randomUUID();
			const secret = 'sk-proj-' + 'DummySecret123456789'.repeat(2);
			const record = { sourceFileReference: 'codex-file:' + 'a'.repeat(64), recordIndex: 1, generation: 0, byteOffset: 0, byteLength: 200, recordType: 'event_msg' as const };
			const before = 'const password = "dummyPassword";\n'; const after = `const api_key = "${secret}";\n`;
			const inputs: TrackerEvent[] = [file(sessionId), createChangeEvent({ sessionId, workspaceId: 'workspace', eventType: 'file.diff',
				payload: { relativePath: 'private-path/app.ts', diff: createTwoFilesPatch('before', 'after', before, after), beforeHash: hash(before), afterHash: hash(after), changeReason: 'edit' } })];
			for (const eventType of ['ai.prompt.submitted', 'ai.response.completed'] as const) {
				inputs.push(createCodexEvent({ sessionId, sourceSessionId: 'source-session', workspaceId: 'workspace', eventType,
					payload: { text: 'private prompt/response ' + secret, sourceRecord: record } }));
			}
			inputs.push(createCodexEvent({ sessionId, sourceSessionId: 'source-session', workspaceId: 'workspace', eventType: 'ai.tool.completed',
				payload: { toolName: 'exec_command', callId: 'private-call', matched: true, status: 'succeeded', input: 'private arguments ' + secret,
					output: 'private output ' + secret, sourceRecord: record } }));
			for (const event of inputs) { await writer.write(event); }
			const text = await readFile(writer.filePath, 'utf8'); const lines = text.trim().split('\n').map(line => JSON.parse(line));
			assert.deepEqual(lines, inputs.map(eventDiagnostic));
			for (const value of [secret, 'private', 'dummyPassword', 'src/app.ts', sessionId, 'source-session', 'const ', 'payload', 'callId']) { assert.equal(text.includes(value), false); }
			assert.ok(lines.every(line => Object.keys(line).sort().join(',') === 'diagnosticVersion,eventType,reasonCode,status,timestamp'));
		} finally { await rm(root, { recursive: true, force: true }); }
	});
	test('rotates destination snapshots without writing event content', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ai-diagnostic-rotation-'));
		try {
			let day = '2000-01-01'; const writer = new JsonlWriter(() => join(root, `diagnostics.v1.${day}.jsonl`));
			const first = writer.write(file()); day = '2000-01-02'; await writer.write(file()); await first;
			for (const date of ['2000-01-01', '2000-01-02']) { assert.equal(JSON.parse(await readFile(join(root, `diagnostics.v1.${date}.jsonl`), 'utf8')).status, 'captured'); }
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});

suite('User-controlled local cleanup and retention', () => {
	let root: string;
	let queue: AsyncLocalEventQueue;
	let recording: RecordingController;
	let manager: LocalDataController;
	let confirmed: boolean;
	let cleared: number;
	let notices: LocalDataNotice[];
	let days: number;
	let confirmHook: (() => Promise<boolean>) | undefined;
	const storage = () => ({ scheme: 'file', fsPath: join(root, 'global') });
	const diagnostics = () => join(root, 'global', 'diagnostics');
	const legacy = () => join(root, 'old-workspace-storage');
	const db = () => new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
	const open = () => AsyncLocalEventQueue.open(storage(), [], { diagnosticDirectories: { legacy: [storage().fsPath, legacy()], diagnostics: diagnostics() } }, testSecrets);
	async function capture(events: TrackerEvent[]) {
		await queue.beginSession(events[0].sessionId);
		for (const event of events) { await queue.enqueue(event); }
		await queue.finishSession(events[0].sessionId);
	}
	function old(sessionId: string) {
		const database = db();
		try {
			database.prepare("UPDATE recording_sessions SET ended_at = '2000-01-01T00:00:00.000Z' WHERE session_id = ?").run(sessionId);
			database.prepare("UPDATE queued_events SET acknowledged_at = '2000-01-01T00:00:00.000Z' WHERE session_id = ? AND acknowledged = 1").run(sessionId);
		} finally { database.close(); }
	}
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'ai-local-retention-')); queue = await open();
		recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true);
		confirmed = false; cleared = 0; notices = []; days = DEFAULT_RETENTION_DAYS; confirmHook = undefined;
		manager = new LocalDataController(recording, queue, {
			confirm: async () => confirmHook ? confirmHook() : confirmed, drain: async () => {}, cleared: async () => { cleared++; },
			notice: reason => notices.push(reason), retentionDays: () => days
		});
	});
	teardown(async () => { recording.dispose(); await manager.flush(); await queue.close(); await rm(root, { recursive: true, force: true }); });

	test('detects historical plaintext without reading/reporting content, and does not delete it automatically', async () => {
		const event = file(); await capture([event]);
		const database = db(); try { database.prepare('UPDATE queued_events SET payload_format = 0, event_json = ?').run(JSON.stringify(event)); } finally { database.close(); }
		await mkdir(legacy()); const log = join(legacy(), 'events.v1.jsonl'); await writeFile(log, 'PRIVATE_PROMPT_AND_SOURCE_CONTENT');
		await utimes(log, new Date('2000-01-01'), new Date('2000-01-01'));
		const summary = await queue.getLocalDataSummary();
		assert.deepEqual(summary, { pendingCount: 1, legacySqliteCount: 1, legacyPendingDeletionCount: 1, legacyLogCount: 1, diagnosticFileCount: 0 });
		assert.ok(!JSON.stringify(summary).includes('PRIVATE')); assert.ok(!JSON.stringify(summary).includes(root));
		await manager.automaticRetention(); assert.deepEqual(await queue.getPending(10), [event]); assert.equal((await stat(log)).size > 0, true);
	});
	test('cleanup cancellation preserves pending evidence, session history and legacy logs', async () => {
		const event = file(); await capture([event]); await mkdir(legacy()); await writeFile(join(legacy(), 'file-activity.jsonl'), 'PRIVATE CONTENT');
		assert.equal(await manager.cleanup('all'), undefined); assert.equal(cleared, 0);
		assert.deepEqual(await queue.getPending(10), [event]); assert.equal((await queue.getRecordingSessions()).length, 1);
		assert.equal((await queue.getLocalDataSummary()).legacyLogCount, 1); assert.deepEqual(notices, ['cancelled']);
	});
	test('confirmed deletion removes pending evidence, session/health metadata and known logs, preserving unrelated files and keys', async () => {
		const event = file(); await capture([event]); await mkdir(legacy()); await mkdir(diagnostics());
		await writeFile(join(legacy(), 'events.v1.jsonl'), 'PRIVATE'); await writeFile(join(legacy(), 'unrelated.jsonl'), 'KEEP');
		await writeFile(join(diagnostics(), 'diagnostics.v1.2000-01-01.jsonl'), '{}\n');
		confirmed = true; const result = await manager.cleanup('all');
		assert.equal(result?.deletedRecords, 1); assert.equal(result.filesFailed, false); assert.equal(cleared, 1);
		assert.equal(await queue.getPendingCount(), 0); assert.deepEqual(await queue.getRecordingSessions(), []);
		assert.equal(await readFile(join(legacy(), 'unrelated.jsonl'), 'utf8'), 'KEEP');
		await queue.close(); queue = await open(); const next = file(); await capture([next]); assert.deepEqual(await queue.getPending(10), [next]);
	});
	test('legacy cleanup deletes whole mixed sessions to preserve correlation consistency and leaves other encrypted sessions intact', async () => {
		const first = file(); const sameSession = file(first.sessionId); const keep = file(); await capture([first, sameSession]); await capture([keep]);
		const database = db(); try { database.prepare('UPDATE queued_events SET payload_format = 0, event_json = ? WHERE event_id = ?').run(JSON.stringify(first), first.eventId); } finally { database.close(); }
		const summary = await queue.getLocalDataSummary(); assert.equal(summary.legacyPendingDeletionCount, 2);
		confirmed = true; const result = await manager.cleanup('legacy'); assert.equal(result?.deletedRecords, 2);
		assert.deepEqual(await queue.getPending(10), [keep]); assert.deepEqual((await queue.getRecordingSessions()).map(session => session.sessionId), [keep.sessionId]);
	});
	test('automatic expiration never deletes pending evidence or acknowledged references in the same session', async () => {
		const first = file(); const pending = file(first.sessionId); await capture([first, pending]); await queue.markAcknowledged([first.eventId]); old(first.sessionId);
		assert.equal((await manager.automaticRetention())?.deletedRecords, 0); assert.deepEqual(await queue.getPending(10), [pending]);
		const database = db(); try { assert.equal(database.prepare('SELECT COUNT(*) AS count FROM queued_events').get()?.count, 2); } finally { database.close(); }
		await queue.markAcknowledged([pending.eventId]); old(first.sessionId); assert.equal((await manager.automaticRetention())?.deletedRecords, 2);
		assert.deepEqual(await queue.getRecordingSessions(), []); assert.equal((await queue.getHealth()).interruptedSessionCount, 0);
	});
	test('30-day default preserves recent acknowledgments and unknown historical tombstone ages; 0 disables expiration', async () => {
		assert.equal(DEFAULT_RETENTION_DAYS, 30); const event = file(); await capture([event]); await queue.markAcknowledged([event.eventId]);
		assert.equal((await manager.automaticRetention())?.deletedRecords, 0);
		old(event.sessionId); const database = db(); try { database.prepare('UPDATE queued_events SET acknowledged_at = NULL').run(); } finally { database.close(); }
		assert.equal((await manager.automaticRetention())?.deletedRecords, 0);
		days = 0; assert.equal(await manager.automaticRetention(), undefined);
	});
	test('expires old disposable diagnostics while preserving recent diagnostics and historical plaintext logs', async () => {
		await mkdir(diagnostics()); await mkdir(legacy());
		const oldLog = join(diagnostics(), 'diagnostics.v1.2000-01-01.jsonl'); const recent = join(diagnostics(), 'diagnostics.v1.2000-01-02.jsonl');
		await writeFile(oldLog, '{}\n'); await writeFile(recent, '{}\n'); await writeFile(join(legacy(), 'events.v1.jsonl'), 'PRIVATE');
		await utimes(oldLog, new Date('2000-01-01'), new Date('2000-01-01'));
		assert.equal((await manager.automaticRetention())?.deletedFiles, 1); await assert.rejects(stat(oldLog), { code: 'ENOENT' });
		assert.ok(await stat(recent)); assert.equal((await queue.getLocalDataSummary()).legacyLogCount, 1);
	});
	test('blocks cleanup and automatic retention during recording without bypassing consent', async () => {
		const event = file(); await capture([event]); await recording.start(); confirmed = true;
		assert.equal(await manager.cleanup('all'), undefined); assert.equal(await manager.automaticRetention(), undefined);
		assert.deepEqual(await queue.getPending(10), [event]); assert.deepEqual(notices, ['recording_active']);
	});
	test('rechecks recording state after confirmation and never deletes when recording starts during the dialog', async () => {
		const event = file(); await capture([event]);
		confirmHook = async () => { await recording.start(); return true; };
		assert.equal(await manager.cleanup('all'), undefined); assert.deepEqual(await queue.getPending(10), [event]);
		assert.deepEqual(notices, ['recording_active']); assert.equal(cleared, 0);
	});
	test('automatic retention does not invalidate pending recording consent; explicit cleanup does', async () => {
		recording.dispose(); let resolve!: (value: boolean) => void;
		recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, () => new Promise<boolean>(done => { resolve = done; }));
		manager = new LocalDataController(recording, queue, { confirm: async () => false, drain: async () => {}, cleared: async () => {}, notice: reason => notices.push(reason), retentionDays: () => 30 });
		const starting = recording.start(); assert.equal(await manager.automaticRetention(), undefined); assert.equal(recording.isStarting, true);
		await manager.cleanup('all'); resolve(true); await starting; assert.equal(recording.isRecording, false); assert.ok(notices.includes('cancelled'));
	});
	test('retention age follows the first acknowledgment and repeated acknowledgment does not extend it', async () => {
		const event = file(); await capture([event]); await queue.markAcknowledged([event.eventId]); old(event.sessionId);
		await queue.markAcknowledged([event.eventId]); assert.equal((await manager.automaticRetention())?.deletedRecords, 1);
	});
	test('cross-window lease blocks new recordings and acknowledgments and refuses cleanup while any recording is active', async () => {
		const other = await open(); const sessionId = randomUUID();
		try {
			await other.beginSession(sessionId); await assert.rejects(queue.acquireMaintenance(), error => error instanceof LocalEventQueueError && error.code === 'recording_active');
			await other.finishSession(sessionId); await queue.acquireMaintenance();
			await assert.rejects(other.beginSession(randomUUID()), error => error instanceof LocalEventQueueError && error.code === 'maintenance_active');
			await assert.rejects(other.markAcknowledged([]), error => error instanceof LocalEventQueueError && error.code === 'maintenance_active');
			await queue.releaseMaintenance(); await other.beginSession(randomUUID());
		} finally { await other.close(); }
	});
	test('cleanup rolls back SQLite deletion failures and reports only safe errors', async () => {
		const event = file(); await capture([event]); const database = db();
		try { database.exec("CREATE TRIGGER prevent_cleanup BEFORE DELETE ON queued_events BEGIN SELECT RAISE(ABORT, 'PRIVATE_SQL_CONTENT'); END"); } finally { database.close(); }
		confirmed = true; assert.equal(await manager.cleanup('all'), undefined); assert.deepEqual(await queue.getPending(10), [event]);
		assert.deepEqual(notices, ['cleanup_failed']); assert.equal(cleared, 0);
	});
	test('partial filesystem deletion fails safely, does not follow symlinks and reports committed SQLite deletion', async () => {
		const event = file(); await capture([event]); await mkdir(legacy()); const log = join(legacy(), 'events.v1.jsonl'); const external = join(root, 'source.ts');
		await writeFile(log, 'PRIVATE LOG'); await writeFile(external, 'KEEP SOURCE');
		confirmHook = async () => { await rm(log); await symlink(external, log); return true; };
		const result = await manager.cleanup('all'); assert.equal(result?.filesFailed, true); assert.equal(await queue.getPendingCount(), 0);
		assert.equal(await readFile(external, 'utf8'), 'KEEP SOURCE'); assert.ok(notices.includes('cleanup_partial'));
	});
	test('worker restart releases interrupted maintenance leases without removing pending evidence', async () => {
		const event = file(); await capture([event]); await queue.acquireMaintenance();
		await (queue as unknown as { worker: Worker }).worker.terminate(); await queue.close(); queue = await open();
		await queue.acquireMaintenance(); await queue.releaseMaintenance(); assert.deepEqual(await queue.getPending(10), [event]);
	});
	test('expired acknowledged sessions can restart cleanly without reviving IDs or removing encryption keys', async () => {
		const event = file(); await capture([event]); await queue.markAcknowledged([event.eventId]); old(event.sessionId); await manager.automaticRetention();
		await queue.close(); queue = await open(); assert.equal(await queue.getPendingCount(), 0); assert.deepEqual(await queue.getRecordingSessions(), []);
		const next = file(); await capture([next]); assert.deepEqual(await queue.getPending(10), [next]);
	});
	test('expiration removes old closed diagnostic-only session history and privacy-health metadata consistently', async () => {
		const sessionId = randomUUID(); await queue.beginSession(sessionId);
		await queue.recordPrivacyRejection(sessionId, ['incomplete_private_key']); await queue.finishSession(sessionId); old(sessionId);
		const result = await manager.automaticRetention(); assert.equal(result?.deletedSessions, 1); assert.equal(result.deletedRecords, 0);
		assert.deepEqual(await queue.getRecordingSessions(), []); assert.deepEqual(await queue.getPrivacyHealth(sessionId), { rejectedCount: 0, reasonCounts: {} });
	});
});
