import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, appendFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingController } from '../recording';
import { ClaudeEventParser } from '../claudeEventParser';
import { EventPersistence } from '../eventPersistence';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { openTestWorkerQueue } from './queueTestKeys';
import { createClaudeEvent, createCodexEvent, createChangeEvent, validateEvent, type TrackerEvent } from '../eventSchema';
import { PrivacyFilter } from '../privacyFilter';
import { ActivityCorrelator } from '../activityCorrelator';
import { createTwoFilesPatch } from 'diff';
import { contentHash } from '../toolFileEvidence';

suite('Consent-bound Claude capture integration', () => {
	let root: string; let workspace: string; let transcripts: string; let queue: AsyncLocalEventQueue;
	let writer: EventPersistence; let parser: ClaudeEventParser; let recording: RecordingController;
	let source: string; let issues: string[]; let captured: TrackerEvent[];
	const hook = (kind: string, extra: Record<string, unknown> = {}) => ({ session_id: source, cwd: workspace,
		hook_event_name: kind, transcript_path: join(transcripts, source + '.jsonl'), ...extra });
	const approve = async () => parser.approve({ sourceSessionId: source, workspaceId: 'workspace', root: workspace, recordingSessionId: recording.sessionId! });
	const send = (kind: string, extra: Record<string, unknown> = {}) => parser.handle(source, hook(kind, extra));
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'ai-claude-test-')); workspace = join(root, 'workspace'); transcripts = join(root, 'transcripts');
		await mkdir(workspace); await mkdir(transcripts); source = randomUUID(); issues = []; captured = [];
		queue = await openTestWorkerQueue({ scheme: 'file', fsPath: join(root, 'queue') }, [{ uri: { scheme: 'file', fsPath: workspace } }]);
		recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => true);
		writer = new EventPersistence(queue, { write: async () => {}, flush: async () => {} });
		writer.attachRecording(recording, id => ({ approvedWorkspaceIds: ['workspace'], confirmedCodexSessions: [], codexContentConsent: false,
			confirmedClaudeSessions: parser.getApprovals(id), claudeContentConsent: parser.getApprovals(id).length > 0,
			resolveToolPath: path => path === join(workspace, 'app.ts') ? 'app.ts' : undefined }));
		parser = new ClaudeEventParser(recording, writer, reason => issues.push(reason), transcripts);
		writer.onDidWrite(event => captured.push(event as TrackerEvent)); await recording.start();
	});
	teardown(async () => { recording.stop(); await parser.finishRecording(); parser.dispose(); await writer.close(); recording.dispose(); await rm(root, { recursive: true, force: true }); });

	test('never captures content before separate Claude approval, after revocation, or from unrelated sessions/workspaces/subagents', async () => {
		await send('UserPromptSubmit', { prompt: 'do not capture' }); assert.equal(await queue.getPendingCount(), 0);
		await approve();
		await send('UserPromptSubmit', { session_id: randomUUID(), prompt: 'unrelated' });
		await send('UserPromptSubmit', { cwd: root, prompt: 'outside' });
		await send('UserPromptSubmit', { agent_id: 'private-agent', prompt: 'private subagent' });
		assert.equal(await queue.getPendingCount(), 0);
		await send('UserPromptSubmit', { prompt_id: 'one', prompt: 'approved' }); parser.revoke();
		await send('UserPromptSubmit', { prompt_id: 'two', prompt: 'revoked' }); assert.equal(await queue.getPendingCount(), 1);
	});

	test('normalizes lifecycle, prompts, responses and matched tool completion through filtered encrypted storage', async () => {
		await approve(); await send('SessionStart', { source: 'startup' });
		await send('UserPromptSubmit', { prompt_id: 'prompt1', prompt: 'Fix password="dummy-password"' });
		await send('PreToolUse', { tool_use_id: 'call-1', tool_name: 'Write', tool_input: { file_path: join(workspace, 'app.ts'), content: 'token="dummy-secret"' } });
		await send('PostToolUse', { tool_use_id: 'call-1', tool_name: 'Write', tool_input: { file_path: join(workspace, 'app.ts') }, tool_response: { success: true } });
		await send('Stop', { last_assistant_message: 'Updated. Authorization: Bearer dummy-bearer-token' }); await send('SessionEnd');
		assert.deepEqual(captured.map(event => event.eventType), ['ai.session.started', 'ai.prompt.submitted', 'ai.tool.started', 'ai.tool.completed', 'ai.response.completed', 'ai.session.ended']);
		for (const event of captured) { assert.equal(validateEvent(event).valid, true); assert.equal(event.source, 'claude'); assert.equal(event.sourceSessionId, source); }
		assert.equal(captured[3].correlationId, 'call-1'); assert.ok('matched' in captured[3].payload && captured[3].payload.matched);
		const stored = JSON.stringify(await queue.getPending(100));
		for (const secret of ['dummy-password', 'dummy-secret', 'dummy-bearer-token']) { assert.equal(stored.includes(secret), false); }
		assert.ok(writer.getUploadPrivacyContext(captured[3])?.claudeContentConsent); assert.deepEqual(issues, []);
	});

	test('handles failures, unmatched calls, duplicate prompt/tool records and repeated stop responses', async () => {
		await approve(); await send('UserPromptSubmit', { prompt_id: 'same', prompt: 'Fix' }); await send('UserPromptSubmit', { prompt_id: 'same', prompt: 'Fix' });
		const call = { tool_use_id: 'one', tool_name: 'Bash', tool_input: { command: 'DO_NOT_EXECUTE' } };
		await send('PreToolUse', call); await send('PreToolUse', call); await send('PostToolUseFailure', { ...call, error: 'failed' });
		await send('PostToolUse', { tool_use_id: 'unmatched', tool_name: 'Read', tool_response: 'missing start' });
		await send('Stop', { last_assistant_message: 'Done' }); await send('Stop', { last_assistant_message: 'Done' });
		assert.equal(captured.filter(event => event.eventType === 'ai.prompt.submitted').length, 1);
		assert.equal(captured.filter(event => event.eventType === 'ai.tool.started').length, 1);
		assert.equal(captured.filter(event => event.eventType === 'ai.response.completed').length, 1);
		assert.ok(captured.some(event => event.eventType === 'ai.tool.failed'));
		assert.ok(captured.some(event => event.eventType === 'ai.tool.completed' && 'matched' in event.payload && !event.payload.matched));
	});

	test('multipart visible MessageDisplay hooks preserve text order and deduplicate Stop without capturing private hook metadata', async () => {
		await approve(); await send('UserPromptSubmit', { prompt_id: 'one', prompt: 'Explain' });
		await send('MessageDisplay', { message_id: 'message1', index: 0, final: false, delta: 'First\n', thinking: 'private reasoning' });
		await send('MessageDisplay', { message_id: 'message1', index: 0, final: false, delta: 'First\n' });
		await send('MessageDisplay', { message_id: 'message1', index: 1, final: true, delta: 'Second' });
		await send('Stop', { last_assistant_message: 'First\nSecond' });
		const messages = captured.filter(event => event.eventType === 'ai.response.completed'); assert.equal(messages.length, 1);
		assert.ok('text' in messages[0].payload && messages[0].payload.text === 'First\nSecond'); assert.equal(JSON.stringify(captured).includes('private reasoning'), false);
	});

	test('legacy prompts without stable IDs preserve legitimate repeated text while internal instruction hooks are ignored', async () => {
		await approve(); await send('UserPromptSubmit', { prompt: 'Again' }); await send('UserPromptSubmit', { prompt: 'Again' });
		await send('InstructionsLoaded', { file_path: '/private/instructions' });
		await send('UserPromptSubmit', { prompt: '<system-reminder>private instructions</system-reminder>' });
		assert.equal(captured.length, 2);
	});

	test('incremental transcript fallback retains incomplete lines and never switches back from hook responses', async () => {
		await approve(); await send('SessionStart'); const path = join(transcripts, source + '.jsonl');
		const row = JSON.stringify({ sessionId: source, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'new response' }] } });
		await writeFile(path, row.slice(0, 20)); await send('Stop'); assert.equal(captured.filter(event => event.eventType === 'ai.response.completed').length, 0);
		await appendFile(path, row.slice(20) + '\n'); await send('Stop'); await send('Stop');
		assert.equal(captured.filter(event => event.eventType === 'ai.response.completed').length, 1);
		await send('UserPromptSubmit', { prompt: 'next' }); await send('Stop', { last_assistant_message: 'hook response' });
		await appendFile(path, row + '\n'); await send('Stop'); assert.equal(captured.filter(event => event.eventType === 'ai.response.completed').length, 2);
	});

	test('a session restart records lifecycle and safely terminates in-flight calls without reusing generation', async () => {
		await approve(); await send('SessionStart'); await send('PreToolUse', { tool_use_id: 'one', tool_name: 'Bash', tool_input: { command: 'dummy' } });
		await send('SessionStart', { source: 'resume' });
		assert.ok(captured.some(event => event.eventType === 'ai.tool.incomplete'));
		const lifecycle = captured.filter(event => event.eventType === 'ai.session.started');
		assert.equal(lifecycle.length, 2); assert.ok('status' in lifecycle[1].payload && lifecycle[1].payload.status === 'resumed');
		await send('SessionStart', { session_id: randomUUID() }); assert.equal(captured.filter(event => event.eventType === 'ai.session.started').length, 2);
	});

	test('Stop flushes only synthetic incomplete metadata and never admits new content; next recording needs fresh approval', async () => {
		await approve(); await send('PreToolUse', { tool_use_id: 'one', tool_name: 'Bash', tool_input: { command: 'dummy' } });
		recording.stop(); await send('UserPromptSubmit', { prompt: 'after stop' }); await parser.finishRecording();
		assert.deepEqual(captured.map(event => event.eventType), ['ai.tool.started', 'ai.tool.incomplete']);
		await recording.start(); await send('UserPromptSubmit', { prompt: 'no renewed consent' }); assert.equal(captured.length, 2);
	});

	test('fallback reads only new assistant text from an approved transcript; excludes history, thinking and system data', async () => {
		await approve(); const path = join(transcripts, source + '.jsonl');
		const row = (text: string) => JSON.stringify({ sessionId: source, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'thinking', thinking: 'private reasoning' }] } }) + '\n';
		await writeFile(path, row('old private conversation')); await send('SessionStart');
		await appendFile(path, row('new visible response') + '{bad}\n' + JSON.stringify({ sessionId: randomUUID(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'unrelated' }] } }) + '\n');
		await send('Stop'); await send('Stop');
		const responses = captured.filter(event => event.eventType === 'ai.response.completed'); assert.equal(responses.length, 1);
		assert.ok('text' in responses[0].payload && responses[0].payload.text === 'new visible response');
		assert.equal(JSON.stringify(captured).includes('private reasoning'), false);
	});

	test('fallback never follows symlinks or accepts a different session transcript path', async () => {
		await approve(); const path = join(transcripts, source + '.jsonl'); const outside = join(root, 'private.jsonl');
		await writeFile(outside, JSON.stringify({ sessionId: source, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'private' }] } }) + '\n');
		await symlink(outside, path); await send('SessionStart'); await send('Stop'); assert.equal(captured.filter(event => event.eventType === 'ai.response.completed').length, 0);
	});

	test('malformed hooks and oversized content fail safely without logging values', async () => {
		await approve(); await parser.handle(source, null); await send('Unknown', { secret: 'private' }); await send('UserPromptSubmit', { prompt: 12 });
		await send('UserPromptSubmit', { prompt: 'x'.repeat(262145) }); assert.equal(captured.length, 0);
		assert.ok(issues.length > 0); assert.equal(JSON.stringify(issues).includes('private'), false);
	});

	test('Claude privacy approval cannot be substituted by Codex consent or mismatched provider references', async () => {
		const event = createClaudeEvent({ sessionId: recording.sessionId!, sourceSessionId: source, workspaceId: 'workspace',
			eventType: 'ai.prompt.submitted', payload: { text: 'dummy', sourceRecord: { sourceFileReference: 'claude-file:' + 'a'.repeat(64), recordIndex: 1,
				generation: 0, byteOffset: 0, byteLength: 12, recordType: 'claude_hook' } } });
		const context = { recordingActive: true, sessionId: recording.sessionId!, approvedWorkspaceIds: ['workspace'],
			confirmedCodexSessions: [{ sourceSessionId: source, workspaceId: 'workspace' }], codexContentConsent: true };
		assert.equal(new PrivacyFilter().filter(event, context).status, 'rejected');
		assert.equal(validateEvent({ ...event, source: 'codex' }).valid, false);
		assert.equal(new PrivacyFilter().filter(event, { ...context, confirmedClaudeSessions: [{ sourceSessionId: source, workspaceId: 'workspace' }], claudeContentConsent: true }).status, 'accepted');
		const codex = createCodexEvent({ sessionId: recording.sessionId!, sourceSessionId: source, workspaceId: 'workspace', eventType: 'ai.prompt.submitted',
			payload: { text: 'dummy', sourceRecord: { sourceFileReference: 'codex-file:' + 'a'.repeat(64), recordIndex: 1, generation: 0, byteOffset: 0, byteLength: 12, recordType: 'event_msg' } } });
		assert.equal(new PrivacyFilter().filter(codex, context).status, 'accepted');
	});

	test('structured Claude file evidence correlates with diffs while receipt timestamps never prove authorship', async () => {
		await approve(); const correlator = new ActivityCorrelator(recording, writer, { approvedWorkspaces: () => ['workspace'] });
		const observation = writer.onDidWrite(event => correlator.observe(event));
		try {
			await send('PreToolUse', { tool_use_id: 'one', tool_name: 'Write', tool_input: { file_path: join(workspace, 'app.ts'), content: 'new\n' } });
			await writer.write(createChangeEvent({ sessionId: recording.sessionId!, workspaceId: 'workspace', eventType: 'file.diff',
				payload: { relativePath: 'app.ts', diff: createTwoFilesPatch('before', 'after', 'old\n', 'new\n'), beforeHash: contentHash('old\n'), afterHash: contentHash('new\n'), changeReason: 'external' } }));
			await send('PostToolUse', { tool_use_id: 'one', tool_name: 'Write', tool_input: { file_path: join(workspace, 'app.ts') }, tool_response: { type: 'update' } });
			await correlator.flush(); const relationships = captured.filter(event => event.eventType.startsWith('activity.'));
			assert.ok(relationships.length > 0); for (const event of relationships) {
				assert.ok('confidence' in event.payload && event.payload.confidence !== 'confirmed'); assert.equal(event.attribution, 'unknown');
			}
		} finally { observation.dispose(); correlator.dispose(); await correlator.flush(); }
	});
});
