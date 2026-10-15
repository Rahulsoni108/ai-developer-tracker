import { eventDiagnostic, type SafeEventDiagnostic } from '../jsonlWriter';
import { openTestQueue, openTestWorkerQueue } from './queueTestKeys';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTwoFilesPatch } from 'diff';
import { ActivityCorrelator } from '../activityCorrelator';
import { CodexEventParser } from '../codexEventParser';
import { DiffTracker } from '../diffTracker';
import { FileTracker, isExcludedPath } from '../fileTracker';
import { EventPersistence, type PersistenceDiagnostic } from '../eventPersistence';
import { JsonlWriter } from '../jsonlWriter';
import { LocalEventQueue } from '../localEventQueue';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { RecordingController } from '../recording';

class Watcher implements vscode.FileSystemWatcher {
	readonly creates = new vscode.EventEmitter<vscode.Uri>();
	readonly changes = new vscode.EventEmitter<vscode.Uri>();
	readonly deletes = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidCreate = this.creates.event;
	readonly onDidChange = this.changes.event;
	readonly onDidDelete = this.deletes.event;
	disposed = false;
	constructor(readonly ignoreCreateEvents: boolean, readonly ignoreChangeEvents: boolean, readonly ignoreDeleteEvents: boolean) { }
	dispose(): void { this.disposed = true; this.creates.dispose(); this.changes.dispose(); this.deletes.dispose(); }
}

suite('SQLite collector integration', () => {
	let root: string;
	let folder: vscode.WorkspaceFolder;
	let queue: AsyncLocalEventQueue;
	let writer: EventPersistence;
	let jsonl: JsonlWriter;
	let recording: RecordingController;
	let files: FileTracker;
	let diffs: DiffTracker;
	let parser: CodexEventParser;
	let correlator: ActivityCorrelator;
	let subscription: { dispose(): void };
	let changes: vscode.EventEmitter<vscode.TextDocumentChangeEvent>;
	let saves: vscode.EventEmitter<vscode.TextDocument>;
	let watchers: Watcher[];
	let mirrorFails: boolean;
	let queueFails: boolean;
	let confirmed: boolean;
	let issues: PersistenceDiagnostic[];
	let recordIndex: number;
	let registrySessionId: string | undefined;
	const base = Date.parse('2026-10-13T10:00:00.000Z');
	const before = 'const value = 1;\n';
	const after = 'const value = 2;\n';
	const sourceSessionId = randomUUID();
	const sourceFileId = 'a'.repeat(64);
	const storage = () => ({ scheme: 'file', fsPath: join(root, 'global-storage') });
	const uri = (path: string) => vscode.Uri.joinPath(folder.uri, path);
	const workspaceId = () => createHash('sha256').update(folder.uri.toString()).digest('hex');
	const context = (milliseconds = 1000) => ({ sessionId: recording.sessionId!, sourceSessionId,
		workspaceId: workspaceId(), sourceFileId, sourceFileReference: 'codex-file:' + sourceFileId,
		generation: 0, recordIndex: ++recordIndex, byteOffset: recordIndex * 200, byteLength: 200,
		timestamp: new Date(base + milliseconds).toISOString() });
	async function drain(): Promise<void> { await files.flush(); await diffs.flush(); await parser.flush(); await correlator.flush(); await writer.flush(); }
	function edit(path: string, content: string): void {
		const document = { uri: uri(path), version: 1, isDirty: true, lineCount: 2, offsetAt: () => content.length, getText: () => content } as unknown as vscode.TextDocument;
		changes.fire({ document, reason: undefined, contentChanges: [{ range: new vscode.Range(0, 0, 0, 0), rangeOffset: 0, rangeLength: 0, text: content }] });
		saves.fire(document);
	}
	async function patch(): Promise<void> {
		const changes = { 'app.ts': { type: 'update', unified_diff: createTwoFilesPatch('app.ts', 'app.ts', before, after) } };
		await parser.handle({ type: 'event_msg', payload: { type: 'patch_apply_begin', call_id: 'patch-1', changes } }, context(1000));
		await writeFile(uri('app.ts').fsPath, after);
		await utimes(uri('app.ts').fsPath, new Date(base + 1500), new Date(base + 1500));
		for (const watcher of watchers.filter(watcher => !watcher.disposed && !watcher.ignoreChangeEvents)) { watcher.changes.fire(uri('app.ts')); }
		await diffs.flush();
		await parser.handle({ type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'patch-1', success: true, changes } }, context(3000));
	}

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'ai-queued-collectors-'));
		folder = { uri: vscode.Uri.file(join(root, 'workspace')), name: 'workspace', index: 0 };
		await mkdir(folder.uri.fsPath); await writeFile(uri('app.ts').fsPath, before);
		mirrorFails = false; queueFails = false; confirmed = true; issues = []; recordIndex = 0; watchers = [];
		queue = await openTestWorkerQueue(storage(), [folder]);
		jsonl = new JsonlWriter(join(root, 'logs', 'events.v1.jsonl'));
		recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true, () => new Date(base));
		writer = new EventPersistence({ enqueue: input => queueFails ? Promise.reject(new Error('PRIVATE_DRIVER_DETAILS')) : queue.enqueue(input),
			beginSession: id => queue.beginSession(id), finishSession: (id, status) => queue.finishSession(id, status),
			recordPrivacyRejection: (id, reasons) => queue.recordPrivacyRejection(id, reasons), close: () => queue.close() }, { write: input => mirrorFails ? Promise.reject(new Error('PRIVATE_MIRROR_DETAILS')) : jsonl.write(input),
			flush: () => jsonl.flush() }, reason => { issues.push(reason); if (reason === 'queue_failed') { recording.stop(); } });
		writer.attachRecording(recording, sessionId => ({ approvedWorkspaceIds: [workspaceId()],
			confirmedCodexSessions: confirmed ? [{ sourceSessionId, workspaceId: workspaceId() }] : [],
			codexContentConsent: parser?.hasAdmittedContentConsent(sessionId) ?? false }));
		changes = new vscode.EventEmitter(); saves = new vscode.EventEmitter();
		const host = {
			textDocuments: [] as vscode.TextDocument[], onDidChangeTextDocument: changes.event, onDidSaveTextDocument: saves.event,
			getWorkspaceFolder: (file: vscode.Uri) => file.fsPath.startsWith(folder.uri.fsPath + '/') ? folder : undefined,
			fs: vscode.workspace.fs,
			createFileSystemWatcher: (_pattern: vscode.GlobPattern, create = false, change = false, remove = false) => {
				const watcher = new Watcher(create, change, remove); watchers.push(watcher); return watcher;
			}
		};
		files = new FileTracker(recording, writer, vscode.Uri.file(join(root, 'logs')), () => recording.stop(), host);
		await files.selectWorkspaces([folder]);
		diffs = new DiffTracker(recording, files, writer, () => recording.stop(), { debounceMs: 10, maxCheckpointMs: 50 }, host, () => new Date(base + 2000));
		correlator = new ActivityCorrelator(recording, writer, { approvedWorkspaces: () => [workspaceId()], isExcludedPath, now: () => new Date(base + 10000) });
		subscription = writer.onDidWrite(event => correlator.observe(event));
		parser = new CodexEventParser(recording, {
			getRegistry: () => {
				registrySessionId = recording.sessionId ?? registrySessionId;
				return [{ recordingSessionId: registrySessionId!, sourceSessionId, workspaceId: workspaceId(), sourceFileId,
					sourceFileReference: 'codex-file:' + sourceFileId, status: confirmed ? 'confirmed' : 'ambiguous', reason: 'user_confirmed' }];
			},
			isConfirmed: (file, session, source) => confirmed && recording.isRecording && session === recording.sessionId && file === sourceFileId && source === sourceSessionId
		}, writer, { isExcludedPath, now: () => new Date(base + 10000) });
		await recording.start(); parser.grantContentConsent(recording.sessionId!); await drain();
	});
	teardown(async () => {
		const session = recording.sessionId; recording.stop(); diffs.dispose();
		await drain(); await correlator.finishSession(session);
		files.dispose(); parser.dispose(); await parser.flush(); correlator.dispose(); await correlator.flush();
		subscription.dispose(); recording.dispose(); changes.dispose(); saves.dispose();
		await writer.close(); await queue.close(); await rm(root, { recursive: true, force: true });
	});

	test('queues file metadata, diffs, prompts, responses, tool calls/results and relationships through one writer', async () => {
		await parser.handle({ type: 'event_msg', payload: { type: 'user_message', message: 'Update the example' } }, context());
		await patch();
		await parser.handle({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer',
			content: [{ type: 'output_text', text: 'Updated the example' }] } }, context(4000));
		edit('app.ts', 'const value = 3;\n'); await drain();
		const events = await queue.getPending(100); const types = new Set<string>(events.map(event => event.eventType));
		for (const type of ['file.baseline', 'file.modified', 'file.saved', 'file.diff', 'ai.prompt.submitted', 'ai.response.completed',
			'ai.tool.started', 'ai.tool.completed', 'activity.relationship.created']) { assert.ok(types.has(type), type); }
		assert.ok(events.every(event => event.sessionId === recording.sessionId && event.workspaceId === workspaceId()));
		const lines = (await readFile(jsonl.filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
		assert.deepEqual(lines, events.map(eventDiagnostic)); assert.deepEqual(issues, []);
		await writer.write(events[0]); assert.equal(await queue.getPendingCount(), events.length);
	});

	test('queues file creation/deletion metadata and their diffs without watcher duplicates', async () => {
		const file = uri('created.ts'); await writeFile(file.fsPath, after);
		await utimes(file.fsPath, new Date(base + 1500), new Date(base + 1500));
		for (const watcher of watchers.filter(watcher => !watcher.disposed && !watcher.ignoreCreateEvents)) { watcher.creates.fire(file); }
		await drain(); await rm(file.fsPath);
		for (const watcher of watchers.filter(watcher => !watcher.disposed && !watcher.ignoreDeleteEvents)) { watcher.deletes.fire(file); }
		await drain(); const events = await queue.getPending(100);
		assert.equal(events.filter(event => event.eventType === 'file.created').length, 1);
		assert.equal(events.filter(event => event.eventType === 'file.deleted').length, 1);
		const changes = events.filter(event => event.eventType === 'file.diff' && event.payload.relativePath === 'created.ts');
		assert.equal(changes.length, 2);
	});

	test('correlation still persists when the JSONL mirror fails', async () => {
		mirrorFails = true; await patch(); await drain();
		const events = await queue.getPending(100);
		assert.ok(events.some(event => event.eventType === 'activity.relationship.created'));
		assert.ok(events.some(event => event.eventType === 'ai.tool.completed'));
		assert.equal(recording.isRecording, true); assert.ok(issues.every(reason => reason === 'jsonl_failed'));
		assert.ok(issues.length > 0);
	});

	test('a Codex queue write failure visibly signals degradation and stops the shared recording state', async () => {
		const count = await queue.getPendingCount(); queueFails = true;
		await parser.handle({ type: 'event_msg', payload: { type: 'user_message', message: 'dummy private prompt' } }, context());
		await drain(); assert.equal(recording.isRecording, false);
		assert.ok(issues.includes('queue_failed')); assert.equal(await queue.getPendingCount(), count);
	});

	test('preserves exclusions and confirmed-session consent gates', async () => {
		const count = await queue.getPendingCount();
		edit('.env', 'SECRET=dummy'); confirmed = false;
		await parser.handle({ type: 'event_msg', payload: { type: 'user_message', message: 'unconfirmed' } }, context());
		await drain(); assert.equal(await queue.getPendingCount(), count);
		confirmed = true; recording.stop(); await drain();
		await recording.start(); await drain(); // Consent expires on stop.
		const nextCount = await queue.getPendingCount();
		await parser.handle({ type: 'event_msg', payload: { type: 'user_message', message: 'not consented' } }, context());
		await drain(); assert.equal(await queue.getPendingCount(), nextCount);
	});

	test('flushes admitted unsaved edits on Stop, ignores later edits and survives closing/reopening', async () => {
		const document = { uri: uri('app.ts'), version: 1, isDirty: true, lineCount: 2, offsetAt: () => after.length, getText: () => after } as unknown as vscode.TextDocument;
		changes.fire({ document, reason: undefined, contentChanges: [{ range: new vscode.Range(0, 0, 0, 0), rangeOffset: 0, rangeLength: 0, text: after }] });
		const session = recording.sessionId; recording.stop(); await drain(); await correlator.finishSession(session);
		const events = await queue.getPending(100);
		assert.ok(events.some(event => event.eventType === 'file.diff'));
		assert.ok(events.every(event => event.sessionId === session));
		edit('app.ts', 'after Stop'); await drain(); assert.equal(await queue.getPendingCount(), events.length);
		await writer.close(); queue = await openTestWorkerQueue(storage(), [folder]);
		assert.deepEqual(await queue.getPending(100), events);
	});

	test('rejects global queue storage inside folders added after activation', async () => {
		await LocalEventQueue.assertStorageOutsideWorkspaces(storage(), [folder]);
		await assert.rejects(LocalEventQueue.assertStorageOutsideWorkspaces(storage(), [{ uri: vscode.Uri.file(root) }]), /outside workspace/);
	});

	test('filters real Codex prompts, responses, tool calls and outputs before both local sinks', async () => {
		const secret = 'sk-proj-' + 'DummySecret123456789'.repeat(2);
		await parser.handle({ type: 'event_msg', payload: { type: 'user_message', message: 'Use ' + secret } }, context());
		await parser.handle({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer',
			content: [{ type: 'output_text', text: 'Bearer dummyBearerSecret' }] } }, context(2000));
		await parser.handle({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'private-tool',
			arguments: '{"path":"app.ts","password":"dummyPassword"}' } }, context(2500));
		await parser.handle({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'private-tool',
			output: 'Authorization: Bearer dummyOutputSecret' } }, context(3000));
		await drain(); const events = await queue.getPending(100); const serialized = JSON.stringify(events);
		assert.ok(!/DummySecret|dummyBearerSecret|dummyPassword|dummyOutputSecret/.test(serialized));
		assert.ok(serialized.includes('[REDACTED]'));
		assert.deepEqual((await readFile(jsonl.filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), events.map(eventDiagnostic));
		assert.equal(recording.isRecording, true); assert.deepEqual(issues, []);
	});

	test('editor diffs containing secrets become gaps and cannot become correlation evidence', async () => {
		await parser.handle({ type: 'event_msg', payload: { type: 'exec_command_begin', call_id: 'tool', command: ['edit', 'app.ts'] } }, context());
		edit('app.ts', 'const api_key = "sk-proj-' + 'DummySecret123456789'.repeat(2) + '";\n'); await drain();
		await parser.handle({ type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'tool', exit_code: 0 } }, context(3000)); await drain();
		const events = await queue.getPending(100);
		assert.ok(events.some(event => event.eventType === 'file.modified')); assert.ok(events.some(event => event.eventType === 'file.saved'));
		assert.ok(events.some(event => event.eventType === 'file.gap' && event.payload.reason === 'privacy_filter'));
		assert.ok(!events.some(event => event.eventType === 'file.diff'));
		assert.ok(!events.some(event => event.eventType.startsWith('activity.relationship.')));
		assert.equal(correlator.getStats().diffs, 0); assert.ok(issues.includes('privacy_gap'));
		assert.ok(!JSON.stringify(events).includes('DummySecret'));
	});

	test('rejected Codex evidence visibly degrades recording with only safe health metadata', async () => {
		const count = await queue.getPendingCount(); const session = recording.sessionId!;
		await parser.handle({ type: 'event_msg', payload: { type: 'user_message', message: '-----BEGIN PRIVATE KEY-----\ndummySensitiveBlock' } }, context());
		await drain(); assert.equal(await queue.getPendingCount(), count); assert.ok(issues.includes('privacy_rejected'));
		assert.deepEqual(await queue.getPrivacyHealth(session), { rejectedCount: 1, reasonCounts: { incomplete_private_key: 1 } });
		assert.equal(parser.hasContentConsent(session), false); // Existing write-failure handling disables unsafe content capture.
		assert.equal(recording.isRecording, true);
	});

	test('filters admitted Codex calls drained after Stop without extending content consent', async () => {
		const captured = context();
		const handling = parser.handle({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'stop-tool',
			arguments: '{"password":"dummyPassword"}' } }, captured);
		const session = recording.sessionId; recording.stop(); await handling; await drain();
		const events = await queue.getPending(100);
		assert.ok(events.some(event => event.eventType === 'ai.tool.started'));
		assert.ok(events.some(event => event.eventType === 'ai.tool.incomplete'));
		assert.ok(events.every(event => event.sessionId === session)); assert.ok(!JSON.stringify(events).includes('dummyPassword'));
		assert.equal(parser.hasContentConsent(session), false); assert.ok(!issues.includes('privacy_rejected'));
	});

	test('filters the initial source baseline while retaining file activity and recording controls', async () => {
		const stopped = recording.sessionId; recording.stop(); await drain(); await correlator.finishSession(stopped); await writer.completeSession(stopped);
		await writeFile(uri('app.ts').fsPath, 'const password = "dummyBaselinePassword";\n');
		await recording.start(); await drain();
		const events = (await queue.getPending(100)).filter(event => event.sessionId === recording.sessionId);
		assert.ok(events.some(event => event.eventType === 'file.gap' && event.payload.reason === 'privacy_filter'));
		assert.ok(!events.some(event => event.eventType === 'file.baseline')); assert.ok(!JSON.stringify(events).includes('dummyBaselinePassword'));
		assert.equal(recording.isRecording, true); assert.equal(parser.hasContentConsent(recording.sessionId), false);
	});
});
