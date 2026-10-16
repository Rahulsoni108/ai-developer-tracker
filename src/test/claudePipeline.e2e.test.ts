import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { applyPatch } from 'diff';
import { RecordingController } from '../recording';
import { ClaudeCapture, type ClaudeLaunch } from '../claudeCapture';
import { ClaudeCaptureUi } from '../claudeCaptureUi';
import { ClaudeEventParser } from '../claudeEventParser';
import { forwardClaudeHook } from '../claudeHookBridge';
import { CodexEventParser } from '../codexEventParser';
import { FileTracker, isExcludedPath } from '../fileTracker';
import { DiffTracker } from '../diffTracker';
import { ActivityCorrelator } from '../activityCorrelator';
import { EventPersistence } from '../eventPersistence';
import { JsonlWriter } from '../jsonlWriter';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { LOCAL_QUEUE_FILENAME } from '../localEventQueue';
import { showRecordedEventSummary, RECORDED_EVENT_SUMMARY_TITLE } from '../recordedEventSummary';
import { validateEvent, type TrackerEvent } from '../eventSchema';

const WAIT_MS = 6000;
function bounded<T>(operation: Promise<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Claude fixture operation timed out.')), WAIT_MS);
		operation.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

/** Deterministic watcher delivery, using real disk reads and real VS Code editor events. */
class FixtureWatcher implements vscode.FileSystemWatcher {
	readonly creates = new vscode.EventEmitter<vscode.Uri>();
	readonly changes = new vscode.EventEmitter<vscode.Uri>();
	readonly deletes = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidCreate = this.creates.event;
	readonly onDidChange = this.changes.event;
	readonly onDidDelete = this.deletes.event;
	constructor(readonly ignoreCreateEvents = false, readonly ignoreChangeEvents = false, readonly ignoreDeleteEvents = false) {}
	dispose(): void { this.creates.dispose(); this.changes.dispose(); this.deletes.dispose(); }
}

suite('Claude hooks to encrypted evidence end-to-end', function () {
	this.timeout(20000);
	let root: string; let folder: vscode.WorkspaceFolder; let workspaceId: string; let transcripts: string;
	let queue: AsyncLocalEventQueue; let persistence: EventPersistence; let recording: RecordingController;
	let parser: ClaudeEventParser; let capture: ClaudeCapture; let ui: ClaudeCaptureUi; let codex: CodexEventParser;
	let files: FileTracker; let diffs: DiffTracker; let correlator: ActivityCorrelator;
	let consent: boolean; let available: boolean; let consentRequests: number; let launch: ClaudeLaunch | undefined;
	let watchers: FixtureWatcher[]; let issues: string[]; let secrets: Map<string, string>; let observer: { dispose(): void };
	const codexSource = 'fixture-confirmed-codex'; const codexFile = 'b'.repeat(64);
	const storage = () => vscode.Uri.file(join(root, 'queue'));
	const transcriptPath = () => join(transcripts, launch!.sourceSessionId + '.jsonl');
	const configPath = () => join(launch!.pluginDirectory, 'runtime.json');
	const payload = (kind: string, extra: Record<string, unknown> = {}) => ({ session_id: launch!.sourceSessionId,
		cwd: folder.uri.fsPath, transcript_path: transcriptPath(), hook_event_name: kind, ...extra });
	// Representative transcript shape; never contains any real conversations or credentials.
	const transcript = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ sessionId: launch!.sourceSessionId,
		type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'thinking', thinking: 'PRIVATE_REASONING_FIXTURE' }] }, ...extra }) + '\n';

	async function makePipeline(): Promise<void> {
		watchers = []; launch = undefined; consent = false; available = true;
		queue = await AsyncLocalEventQueue.open(storage(), [{ uri: folder.uri }], {}, {
			get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }
		});
		recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => true);
		persistence = new EventPersistence(queue, new JsonlWriter(join(root, 'diagnostics', 'safe.jsonl')), reason => issues.push(reason));
		// Match extension registration order: freeze admissions before producers revoke on Stop.
		persistence.attachRecording(recording, id => ({ approvedWorkspaceIds: [workspaceId],
			confirmedCodexSessions: [{ sourceSessionId: codexSource, workspaceId }], codexContentConsent: codex?.hasAdmittedContentConsent(id) ?? false,
			confirmedClaudeSessions: parser.getApprovals(id), claudeContentConsent: parser.getApprovals(id).length > 0,
			resolveToolPath: path => path === join(folder.uri.fsPath, 'app.ts') ? 'app.ts' : undefined }));
		const host = {
			onDidChangeTextDocument: vscode.workspace.onDidChangeTextDocument, onDidSaveTextDocument: vscode.workspace.onDidSaveTextDocument,
			getWorkspaceFolder: (uri: vscode.Uri) => uri.fsPath.startsWith(folder.uri.fsPath + '/') ? folder : undefined,
			fs: vscode.workspace.fs, textDocuments: vscode.workspace.textDocuments,
			createFileSystemWatcher: (_pattern: vscode.GlobPattern, create?: boolean, change?: boolean, remove?: boolean) => {
				const watcher = new FixtureWatcher(create, change, remove); watchers.push(watcher); return watcher;
			}
		};
		files = new FileTracker(recording, persistence, storage(), () => issues.push('file_error'), host);
		await files.selectWorkspace(folder);
		diffs = new DiffTracker(recording, files, persistence, () => issues.push('diff_error'), { debounceMs: 50, maxCheckpointMs: 100 }, host);
		parser = new ClaudeEventParser(recording, persistence, reason => issues.push(reason), transcripts);
		capture = new ClaudeCapture(recording, parser, { storageDirectory: join(root, 'runtime'), bridgePath: require.resolve('../claudeHookBridge'),
			nodeExecutable: process.execPath, assertOutsideWorkspaces: async path => { assert.equal(path.startsWith(folder.uri.fsPath), false); } });
		ui = new ClaudeCaptureUi(recording, files, () => capture, reason => issues.push(reason), {
			pick: async folders => folders[0], available: async () => available ? process.execPath : undefined,
			consent: async () => { consentRequests++; return consent; }, launch: value => { launch = value; }
		});
		codex = new CodexEventParser(recording, {
			getRegistry: () => [{ recordingSessionId: recording.sessionId!, sourceSessionId: codexSource, workspaceId, sourceFileId: codexFile,
				sourceFileReference: 'codex-file:' + codexFile, status: 'confirmed', reason: 'user_confirmed' }],
			isConfirmed: (file, session, source) => file === codexFile && session === recording.sessionId && source === codexSource
		}, persistence, { isExcludedPath });
		correlator = new ActivityCorrelator(recording, persistence, { approvedWorkspaces: () => [workspaceId], isExcludedPath });
		observer = persistence.onDidWrite(event => correlator.observe(event));
	}
	async function drain(): Promise<void> {
		await bounded((async () => {
			await files.flush(); await diffs.flush(); await parser.flush(); await codex.flush(); await persistence.flush();
			await correlator.flush(); await persistence.flush();
		})());
	}
	async function closePipeline(): Promise<void> {
		const session = recording.sessionId; recording.stop(); await ui.dispose(); await capture.dispose();
		await parser.finishRecording(); await drain(); await correlator.finishSession(session); await persistence.completeSession(session);
		observer.dispose(); files.dispose(); diffs.dispose(); parser.dispose(); codex.dispose(); correlator.dispose();
		await persistence.close(); recording.dispose();
	}
	async function approve(): Promise<void> { consent = true; await ui.start(); assert.ok(launch); }
	async function send(kind: string, extra: Record<string, unknown> = {}): Promise<void> {
		await bounded(forwardClaudeHook(configPath(), Readable.from([JSON.stringify(payload(kind, extra))]))); await drain();
	}
	async function events(): Promise<TrackerEvent[]> { await drain(); return queue.getPending(1000); }
	async function claudeEvents(): Promise<TrackerEvent[]> { return (await events()).filter(event => event.source === 'claude'); }
	async function summary(): Promise<void> {
		const pending = await events(); const expected: Record<string, number> = {};
		for (const event of pending.filter(event => event.sessionId === recording.sessionId)) { expected[event.eventType] = (expected[event.eventType] ?? 0) + 1; }
		let output = ''; const result = await showRecordedEventSummary(queue, { clear: () => { output = ''; }, appendLine: line => { output += line; }, show: () => {} });
		assert.deepEqual(result, { total: Object.values(expected).reduce((a, b) => a + b, 0), counts: expected });
		assert.ok(output.startsWith(RECORDED_EVENT_SUMMARY_TITLE));
		for (const privateValue of [root, workspaceId, recording.sessionId!, launch?.sourceSessionId, 'DUMMY_PRIVATE_PROMPT', 'PRIVATE_REASONING_FIXTURE']) {
			if (privateValue) { assert.equal(output.includes(privateValue), false); }
		}
	}
	async function external(text: string, name = 'app.ts', kind: 'changes' | 'creates' | 'deletes' = 'changes'): Promise<void> {
		const uri = vscode.Uri.joinPath(folder.uri, name);
		if (kind === 'deletes') { await rm(uri.fsPath); } else { await writeFile(uri.fsPath, text); }
		for (const watcher of watchers) {
			if (kind !== 'changes' || !watcher.ignoreChangeEvents) { watcher[kind].fire(uri); }
		}
		await drain();
	}
	async function edit(text: string, save = true): Promise<void> {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, 'app.ts'));
		const change = new vscode.WorkspaceEdit(); change.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
		assert.equal(await vscode.workspace.applyEdit(change), true); if (save) { assert.equal(await document.save(), true); }
	}
	async function codexRecord(value: unknown, index: number): Promise<void> {
		await codex.handle(value, { sessionId: recording.sessionId!, sourceSessionId: codexSource, workspaceId, sourceFileId: codexFile,
			sourceFileReference: 'codex-file:' + codexFile, recordIndex: index, generation: 0, byteOffset: index * 200, byteLength: 200,
			timestamp: new Date().toISOString() }); await drain();
	}

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'ai-claude-e2e-')); await mkdir(join(root, 'workspace'));
		transcripts = join(root, 'transcripts'); await mkdir(transcripts);
		await writeFile(join(root, 'workspace', 'app.ts'), 'export const sample = 0;\n');
		folder = { uri: vscode.Uri.file(join(root, 'workspace')), name: 'fixture-workspace', index: 0 };
		workspaceId = createHash('sha256').update(folder.uri.toString()).digest('hex'); secrets = new Map(); issues = []; consentRequests = 0;
		await makePipeline(); await recording.start(); await drain();
	});
	teardown(async () => { await closePipeline(); await rm(root, { recursive: true, force: true }); });

	test('generated command hook -> normalization -> privacy -> encrypted SQLite -> safe event summary', async () => {
		await approve();
		const hooks = JSON.parse(await readFile(join(launch!.pluginDirectory, 'hooks', 'hooks.json'), 'utf8')).hooks;
		const hook = hooks.SessionStart[0].hooks[0];
		const child = spawn(hook.command, hook.args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = ''; let stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
		try {
			const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
			child.stdin.end(JSON.stringify(payload('SessionStart', { source: 'startup' })));
			assert.equal(await bounded(exited), 0); assert.equal(stdout, ''); assert.equal(stderr, '');
		} finally { if (child.exitCode === null) { child.kill(); } }
		await send('UserPromptSubmit', { prompt_id: 'one', prompt: 'DUMMY_PRIVATE_PROMPT password="dummy-password"' });
		await send('PreToolUse', { tool_use_id: 'one', tool_name: 'Bash', tool_input: { command: 'echo fixture', token: 'dummy-tool-secret' } });
		await send('PostToolUse', { tool_use_id: 'one', tool_name: 'Bash', tool_response: { result: 'Authorization: Bearer dummy-output-secret' } });
		await send('PreToolUse', { tool_use_id: 'two', tool_name: 'Bash', tool_input: { command: 'fixture only' } });
		await send('PostToolUseFailure', { tool_use_id: 'two', tool_name: 'Bash', error: 'password="dummy-failure-secret"' });
		await send('Stop', { last_assistant_message: 'Done. api_key="sk-ant-api03-dummyResponse12345678901234567890"' });
		await send('SessionEnd');
		const captured = await claudeEvents();
		assert.deepEqual(captured.map(event => event.eventType), ['ai.session.started', 'ai.prompt.submitted', 'ai.tool.started', 'ai.tool.completed',
			'ai.tool.started', 'ai.tool.failed', 'ai.response.completed', 'ai.session.ended']);
		for (const event of captured) { assert.equal(validateEvent(event).valid, true); assert.equal(event.sessionId, recording.sessionId); assert.equal(event.sourceSessionId, launch!.sourceSessionId); }
		assert.ok('startedEventId' in captured[3].payload && captured[3].payload.startedEventId === captured[2].eventId);
		assert.ok('startedEventId' in captured[5].payload && captured[5].payload.startedEventId === captured[4].eventId);
		const serialized = JSON.stringify(captured);
		for (const value of ['dummy-password', 'dummy-tool-secret', 'dummy-output-secret', 'dummy-failure-secret', 'sk-ant-api03-dummyResponse12345678901234567890']) {
			assert.equal(serialized.includes(value), false);
		}
		assert.ok(serialized.includes('[REDACTED]'));
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME), { readOnly: true });
		try {
			const rows = db.prepare('SELECT event_json, payload_format FROM queued_events').all(); assert.equal(rows.length, (await events()).length);
			for (const row of rows) { assert.equal(row.payload_format, 1); assert.equal(JSON.parse(String(row.event_json)).algorithm, 'AES-256-GCM'); assert.equal(String(row.event_json).includes('DUMMY_PRIVATE_PROMPT'), false); }
		} finally { db.close(); }
		await summary();
		const diagnostics = await readFile(join(root, 'diagnostics', 'safe.jsonl'), 'utf8');
		for (const line of diagnostics.trim().split('\n')) { assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ['diagnosticVersion', 'eventType', 'reasonCode', 'status', 'timestamp']); }
		assert.equal(diagnostics.includes(root), false); assert.equal(diagnostics.includes('DUMMY_PRIVATE_PROMPT'), false); assert.deepEqual(issues, []);
	});

	test('multipart response hooks preserve visible order, omit reasoning and deduplicate repeated deliveries and Stop', async () => {
		await approve(); await send('SessionStart'); await send('UserPromptSubmit', { prompt_id: 'one', prompt: 'Explain' });
		const first = { message_id: 'visible', index: 0, final: false, delta: 'First\n', thinking: 'PRIVATE_REASONING_FIXTURE' };
		await send('MessageDisplay', first); await send('MessageDisplay', first);
		await send('MessageDisplay', { message_id: 'visible', index: 1, final: true, delta: 'Second' });
		await send('Stop', { last_assistant_message: 'First\nSecond' });
		const responses = (await claudeEvents()).filter(event => event.eventType === 'ai.response.completed');
		assert.equal(responses.length, 1); assert.ok('text' in responses[0].payload && responses[0].payload.text === 'First\nSecond');
		assert.equal(JSON.stringify(await events()).includes('PRIVATE_REASONING_FIXTURE'), false); await summary();
	});

	test('transcript fallback excludes history/internal/unrelated records and incrementally completes partial UTF-8 lines', async () => {
		await approve(); await writeFile(transcriptPath(), transcript('OLD_PRIVATE_HISTORY')); await send('SessionStart');
		const row = Buffer.from(transcript('Visible ✓ response', { uuid: 'assistant-one' }));
		const split = row.indexOf(Buffer.from('✓')) + 1;
		await appendFile(transcriptPath(), row.subarray(0, split)); await send('Stop');
		assert.equal((await claudeEvents()).filter(event => event.eventType === 'ai.response.completed').length, 0);
		await appendFile(transcriptPath(), Buffer.concat([row.subarray(split), Buffer.from('{bad}\n' +
			transcript('UNRELATED_PRIVATE', { sessionId: randomUUID() }) + transcript('SUBAGENT_PRIVATE', { isSidechain: true }) +
			JSON.stringify({ sessionId: launch!.sourceSessionId, type: 'system', message: { role: 'system', content: [{ type: 'text', text: 'SYSTEM_PRIVATE' }] } }) + '\n')]));
		await send('Stop'); await send('Stop');
		const responses = (await claudeEvents()).filter(event => event.eventType === 'ai.response.completed'); assert.equal(responses.length, 1);
		assert.ok('text' in responses[0].payload && responses[0].payload.text === 'Visible ✓ response');
		assert.ok('sourceRecord' in responses[0].payload && responses[0].payload.sourceRecord.recordType === 'claude_transcript');
		const stored = JSON.stringify(await events()); for (const text of ['OLD_PRIVATE_HISTORY', 'PRIVATE_REASONING_FIXTURE', 'UNRELATED_PRIVATE', 'SUBAGENT_PRIVATE', 'SYSTEM_PRIVATE']) { assert.equal(stored.includes(text), false); }
		await summary();
	});

	test('missing transcripts fail safely, later approved transcript creation recovers, and hooks take precedence', async () => {
		await approve(); await send('SessionStart'); await send('Stop');
		assert.equal((await claudeEvents()).filter(event => event.eventType === 'ai.response.completed').length, 0);
		assert.ok(issues.includes('unverified')); await writeFile(transcriptPath(), transcript('Recovered fixture response')); await send('Stop');
		await send('UserPromptSubmit', { prompt: 'Next' }); await send('Stop', { last_assistant_message: 'Hook response' });
		await appendFile(transcriptPath(), transcript('SHOULD_NOT_IMPORT')); await send('Stop');
		const responses = (await claudeEvents()).filter(event => event.eventType === 'ai.response.completed');
		assert.equal(responses.length, 2); assert.equal(JSON.stringify(responses).includes('SHOULD_NOT_IMPORT'), false); await summary();
	});

	test('recording consent alone and missing CLI availability never approve capture; explicit consent does', async () => {
		await ui.start(); assert.equal(launch, undefined); assert.equal(consentRequests, 1); assert.deepEqual(await claudeEvents(), []);
		available = false; consent = true; await ui.start(); assert.equal(launch, undefined); assert.equal(consentRequests, 1); assert.ok(issues.includes('unavailable'));
		available = true; await approve(); await send('UserPromptSubmit', { prompt_id: 'approved', prompt: 'Approved fixture' });
		assert.equal((await claudeEvents()).length, 1); assert.equal(recording.isRecording, true); await summary();
	});

	test('revocation closes incomplete tools, refuses to consume new hook content and leaves file recording active', async () => {
		await approve(); await send('PreToolUse', { tool_use_id: 'pending', tool_name: 'Bash', tool_input: { command: 'fixture only' } });
		const staleConfig = configPath(); await ui.revoke(); let read = false;
		await forwardClaudeHook(staleConfig, new Readable({ read() { read = true; this.push('PRIVATE_REVOKED'); this.push(null); } }));
		assert.equal(read, false); assert.equal(recording.isRecording, true);
		await edit('export const sample = 2;\n'); await drain();
		assert.deepEqual((await claudeEvents()).map(event => event.eventType), ['ai.tool.started', 'ai.tool.incomplete']);
		assert.ok((await events()).some(event => event.eventType === 'file.diff')); await summary();
	});

	test('unrelated sessions, outside workspaces, subagents and sensitive/symlink tool targets are excluded', async () => {
		await approve(); await send('UserPromptSubmit', { session_id: randomUUID(), prompt: 'UNRELATED_PRIVATE' });
		await send('UserPromptSubmit', { cwd: root, prompt: 'OUTSIDE_PRIVATE' });
		await send('UserPromptSubmit', { agent_id: 'unrelated-agent', prompt: 'SUBAGENT_PRIVATE' });
		await writeFile(join(root, 'outside.ts'), 'PRIVATE_OUTSIDE_FILE'); await symlink(join(root, 'outside.ts'), join(folder.uri.fsPath, 'link.ts'));
		for (const [index, path] of ['.env', '../outside.ts', 'link.ts'].entries()) {
			await send('PreToolUse', { tool_use_id: 'excluded-' + index, tool_name: 'Read', tool_input: { file_path: path } });
		}
		assert.deepEqual(await claudeEvents(), []); assert.ok(issues.includes('unverified')); await summary();
	});

	test('malformed/unknown hooks are passive and stable prompt/tool IDs prevent duplicate persisted events', async () => {
		await approve();
		for (const input of ['{invalid', 'null', '[]', JSON.stringify(payload('Unknown', { private: 'PRIVATE_MALFORMED' }))]) {
			await bounded(forwardClaudeHook(configPath(), Readable.from([input])));
		}
		await send('UserPromptSubmit', { prompt: 12 });
		for (let index = 0; index < 2; index++) {
			await send('UserPromptSubmit', { prompt_id: 'same', prompt: 'Fixture prompt' });
			await send('PreToolUse', { tool_use_id: 'same', tool_name: 'Bash', tool_input: { command: 'fixture' } });
			await send('PostToolUseFailure', { tool_use_id: 'same', tool_name: 'Bash', error: 'fixture failure' });
			await send('Stop', { last_assistant_message: 'Fixture response' });
		}
		const captured = await claudeEvents(); assert.deepEqual(captured.map(event => event.eventType), ['ai.prompt.submitted', 'ai.tool.started', 'ai.tool.failed', 'ai.response.completed']);
		assert.equal(new Set(captured.map(event => event.eventId)).size, captured.length);
		assert.equal(JSON.stringify(issues).includes('PRIVATE_MALFORMED'), false); await summary();
	});

	test('a malformed result with a conflicting tool name cannot close or deduplicate the actual in-flight call', async () => {
		await approve(); await send('PreToolUse', { tool_use_id: 'one', tool_name: 'Bash', tool_input: { command: 'fixture' } });
		await send('PostToolUseFailure', { tool_use_id: 'one', tool_name: 'Read', error: 'CONFLICTING_PRIVATE_RESULT' });
		assert.deepEqual((await claudeEvents()).map(event => event.eventType), ['ai.tool.started']);
		await send('PostToolUseFailure', { tool_use_id: 'one', tool_name: 'Bash', error: 'actual fixture failure' });
		await send('SessionEnd');
		const captured = await claudeEvents(); assert.deepEqual(captured.map(event => event.eventType), ['ai.tool.started', 'ai.tool.failed', 'ai.session.ended']);
		assert.ok('startedEventId' in captured[1].payload && captured[1].payload.startedEventId === captured[0].eventId);
		assert.equal(JSON.stringify(captured).includes('CONFLICTING_PRIVATE_RESULT'), false); assert.ok(issues.includes('unverified')); await summary();
	});

	test('transcript fallback cannot follow a symlink into private data outside the approved transcript root', async () => {
		await approve(); const outside = join(root, 'unrelated.jsonl'); await writeFile(outside, transcript('PRIVATE_TRANSCRIPT_OUTSIDE'));
		await symlink(outside, transcriptPath()); await send('SessionStart'); await send('Stop');
		assert.deepEqual((await claudeEvents()).map(event => event.eventType), ['ai.session.started']); await summary();
	});

	test('real editor and external file checkpoints reconstruct changes, while Claude correlation remains conservative', async () => {
		await approve(); await send('SessionStart');
		const tool = { tool_use_id: 'edit-one', tool_name: 'Edit', tool_input: { file_path: join(folder.uri.fsPath, 'app.ts'), old_string: '0', new_string: '1' } };
		await send('PreToolUse', tool); await external('export const sample = 1;\n'); await send('PostToolUse', { ...tool, tool_response: { success: true } });
		await edit('export const sample = 2;\n'); await drain();
		await external('export const created = true;\n', 'created.ts', 'creates'); await external('', 'created.ts', 'deletes');
		const captured = await events(); const patches = captured.filter(event => event.eventType === 'file.diff' && event.payload.relativePath === 'app.ts');
		assert.ok(patches.some(event => event.eventType === 'file.diff' && event.payload.changeReason === 'external'));
		assert.ok(patches.some(event => event.eventType === 'file.diff' && ['edit', 'save'].includes(event.payload.changeReason)));
		let reconstructed = 'export const sample = 0;\n';
		for (const event of patches) { if (event.eventType === 'file.diff') { const next = applyPatch(reconstructed, event.payload.diff); assert.notEqual(next, false); reconstructed = next as string; } }
		assert.equal(reconstructed, 'export const sample = 2;\n');
		assert.ok(captured.some(event => event.eventType === 'file.created')); assert.ok(captured.some(event => event.eventType === 'file.deleted'));
		const relationships = captured.filter(event => event.eventType.startsWith('activity.')); assert.ok(relationships.length > 0);
		for (const event of relationships) { assert.equal(event.attribution, 'unknown'); assert.ok('confidence' in event.payload && event.payload.confidence !== 'confirmed'); }
		assert.ok(relationships.some(event => 'evidence' in event.payload && event.payload.evidence.some(item => item.kind === 'explicit_path')));
		assert.deepEqual(issues, []); await summary();
	});

	test('credential-bearing diffs become reconstruction gaps and excluded files never enter storage or correlation', async () => {
		await approve(); await send('PreToolUse', { tool_use_id: 'sensitive', tool_name: 'Write', tool_input: { file_path: join(folder.uri.fsPath, 'app.ts') } });
		await external('export const password = "dummy-diff-secret";\n'); await external('SECRET_FIXTURE', '.env', 'creates');
		await send('PostToolUse', { tool_use_id: 'sensitive', tool_name: 'Write', tool_response: { success: true } });
		const captured = await events(); assert.ok(captured.some(event => event.eventType === 'file.gap' && event.payload.reason === 'privacy_filter'));
		assert.equal(captured.some(event => event.eventType === 'file.diff'), false);
		assert.equal(captured.some(event => event.eventType.startsWith('activity.')), false);
		const serialized = JSON.stringify(captured); for (const value of ['dummy-diff-secret', 'SECRET_FIXTURE', '.env']) { assert.equal(serialized.includes(value), false); }
		await summary();
	});

	test('same-session resume closes outstanding calls and distinguishes reused call IDs by generation', async () => {
		await approve(); await send('SessionStart'); const call = { tool_use_id: 'reused', tool_name: 'Bash', tool_input: { command: 'fixture' } };
		await send('PreToolUse', call); await send('SessionStart', { source: 'resume' }); await send('PreToolUse', call); await send('PostToolUse', { ...call, tool_response: 'done' });
		const captured = await claudeEvents(); assert.deepEqual(captured.map(event => event.eventType), ['ai.session.started', 'ai.tool.started', 'ai.tool.incomplete', 'ai.session.started', 'ai.tool.started', 'ai.tool.completed']);
		assert.ok('sourceRecord' in captured[1].payload && captured[1].payload.sourceRecord.generation === 0);
		assert.ok('sourceRecord' in captured[4].payload && captured[4].payload.sourceRecord.generation === 1);
		assert.ok('startedEventId' in captured[5].payload && captured[5].payload.startedEventId === captured[4].eventId); await summary();
	});

	test('stop drains unsaved editor checkpoints and incomplete tools; subsequent recording needs new Claude consent', async () => {
		await approve(); await send('PreToolUse', { tool_use_id: 'pending', tool_name: 'Bash', tool_input: { command: 'fixture' } });
		await edit('export const sample = 99;\n', false); const oldSession = recording.sessionId; const oldConfig = configPath();
		recording.stop(); await capture.revoke(); await drain();
		const captured = await events(); assert.ok(captured.some(event => event.eventType === 'file.diff' && event.sessionId === oldSession));
		assert.ok(captured.some(event => event.eventType === 'ai.tool.incomplete'));
		await forwardClaudeHook(oldConfig, Readable.from(['PRIVATE_AFTER_STOP'])); assert.deepEqual(await events(), captured);
		await persistence.completeSession(oldSession); await recording.start(); await drain();
		await forwardClaudeHook(oldConfig, Readable.from(['PRIVATE_WITHOUT_NEW_CONSENT']));
		assert.equal((await events()).filter(event => event.source === 'claude' && event.sessionId === recording.sessionId).length, 0);
		await summary();
	});

	test('reopening encrypted queue retains original evidence but restores neither recording nor Claude/upload approval', async () => {
		await approve(); await send('UserPromptSubmit', { prompt_id: 'persisted', prompt: 'DUMMY_PRIVATE_PROMPT' });
		const retained = await events(); const oldSource = launch!.sourceSessionId; const staleConfig = configPath();
		await closePipeline(); await makePipeline(); assert.equal(recording.isRecording, false); assert.deepEqual(await queue.getPending(1000), retained);
		for (const event of retained) { assert.equal(persistence.getUploadPrivacyContext(event), undefined); }
		await forwardClaudeHook(staleConfig, Readable.from(['PRIVATE_RESTART_CONTENT'])); assert.deepEqual(await queue.getPending(1000), retained);
		const counts = await queue.getRecordedEventSummary(); assert.equal(counts.total, retained.length);
		await recording.start(); await drain(); assert.equal(parser.canCapture(oldSource), false); assert.equal(launch, undefined);
		await approve(); assert.notEqual(launch!.sourceSessionId, oldSource); await send('UserPromptSubmit', { prompt_id: 'new', prompt: 'Fresh approval' });
		assert.equal((await claudeEvents()).filter(event => event.sessionId === recording.sessionId).length, 1); await summary();
	});

	test('Codex and Claude retain separate consent and tool identities when recording into the same queue', async () => {
		await approve();
		const message = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex fixture password="dummy-codex-secret"' }] } };
		await codexRecord(message, 1); assert.equal((await events()).some(event => event.source === 'codex'), false);
		codex.grantContentConsent(recording.sessionId!); await codexRecord(message, 2);
		await codexRecord({ type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'shared-id', arguments: JSON.stringify({ command: 'DO_NOT_EXECUTE_FIXTURE' }) } }, 3);
		await send('PreToolUse', { tool_use_id: 'shared-id', tool_name: 'Bash', tool_input: { command: 'DO_NOT_EXECUTE_FIXTURE' } });
		await external('export const sample = 3;\n');
		await send('PostToolUse', { tool_use_id: 'shared-id', tool_name: 'Bash', tool_response: 'Claude done' });
		await codexRecord({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'shared-id', output: 'Codex done' } }, 4);
		await codexRecord({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex response' }] } }, 5);
		const captured = await events();
		for (const source of ['codex', 'claude']) {
			const start = captured.find(event => event.source === source && event.eventType === 'ai.tool.started')!;
			const result = captured.find(event => event.source === source && event.eventType === 'ai.tool.completed')!;
			assert.ok(start && result); assert.ok('startedEventId' in result.payload && result.payload.startedEventId === start.eventId);
			assert.ok(!('fileEvidence' in start.payload) || !start.payload.fileEvidence?.length);
			assert.ok(captured.some(event => 'sourceEventId' in event.payload && event.payload.sourceEventId === start.eventId));
		}
		assert.ok(captured.some(event => event.source === 'codex' && event.eventType === 'ai.response.completed'));
		assert.equal(JSON.stringify(captured).includes('dummy-codex-secret'), false);
		for (const event of captured.filter(event => event.eventType.startsWith('activity.'))) { assert.ok('confidence' in event.payload && event.payload.confidence !== 'confirmed'); }
		await summary();
	});
});
