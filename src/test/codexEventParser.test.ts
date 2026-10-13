import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexEventParser, type CodexParserDiagnostic, type CodexParserOptions } from '../codexEventParser';
import type { CodexRecordContext } from '../codexJsonlReader';
import type { CodexSessionRegistration } from '../codexSessionDiscovery';
import { RecordingController } from '../recording';
import { JsonlWriter, type ActivityWriter } from '../jsonlWriter';
import { isExcludedPath } from '../fileTracker';
import { MAX_CODEX_CONTENT_BYTES, validateEvent, type CodexActivityEvent, type CodexMessagePayload, type CodexToolPayload } from '../eventSchema';

suite('Codex conversation and tool parser', () => {
	let recording: RecordingController;
	let parser: CodexEventParser;
	let registration: CodexSessionRegistration;
	let events: CodexActivityEvent[];
	let issues: CodexParserDiagnostic[];
	let writer: ActivityWriter;
	let index: number;
	const timestamp = '2026-10-13T10:00:00.000Z';
	const registry = () => ({
		getRegistry: () => [{ ...registration }],
		isConfirmed: (file: string, session: string, source: string) => recording.isRecording && recording.sessionId === session
			&& registration.recordingSessionId === session && registration.sourceSessionId === source
			&& registration.sourceFileId === file && registration.status === 'confirmed' && registration.reason === 'user_confirmed'
	});
	function context(overrides: Partial<CodexRecordContext> = {}): CodexRecordContext {
		return { sessionId: recording.sessionId!, sourceSessionId: registration.sourceSessionId!, workspaceId: registration.workspaceId!,
			sourceFileId: registration.sourceFileId, sourceFileReference: registration.sourceFileReference,
			recordIndex: ++index, generation: 0, byteOffset: index * 200, byteLength: 200, timestamp, ...overrides };
	}
	function message(role: string, text: string, extra: Record<string, unknown> = {}) {
		return { type: 'response_item', payload: { type: 'message', role,
			content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }], ...extra } };
	}
	function legacy(role: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}) {
		return { type: 'event_msg', payload: { type: role === 'user' ? 'user_message' : 'agent_message', message: text, ...extra } };
	}
	async function call(id = 'call-1', extra: Record<string, unknown> = {}) {
		await parser.handle({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command',
			call_id: id, arguments: '{"cmd":"echo hello"}', ...extra } }, context());
	}
	async function output(id = 'call-1', extra: Record<string, unknown> = {}) {
		await parser.handle({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: 'hello', ...extra } }, context());
	}
	function configure(options: CodexParserOptions = {}, target = writer): void {
		parser?.dispose();
		parser = new CodexEventParser(recording, registry(), target, {
			now: () => new Date(timestamp), isExcludedPath, onDiagnostic: reason => issues.push(reason), ...options
		});
		parser.grantContentConsent(recording.sessionId!);
	}
	setup(async () => {
		events = []; issues = []; index = 0;
		recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true);
		await recording.start();
		registration = { recordingSessionId: recording.sessionId!, sourceSessionId: randomUUID(), workspaceId: 'approved-workspace',
			sourceFileId: 'a'.repeat(64), sourceFileReference: 'codex-file:' + 'a'.repeat(64), status: 'confirmed', reason: 'user_confirmed' };
		writer = { write: async event => { assert.equal(validateEvent(event).valid, true); events.push(event as CodexActivityEvent); }, flush: async () => {} };
		configure();
	});
	teardown(async () => { recording.stop(); parser.dispose(); await parser.flush(); recording.dispose(); });

	test('captures the actual user prompt in the shared event envelope with source traceability', async () => {
		const reference = context();
		await parser.handle(message('user', '  Fix the sorting bug.\nKeep stable ordering.  ', { id: 'message-1', turn_id: 'turn-1' }), reference);
		assert.equal(events.length, 1);
		const event = events[0];
		assert.equal(event.eventType, 'ai.prompt.submitted'); assert.equal(event.source, 'codex'); assert.equal(event.schemaVersion, 1);
		assert.match(event.eventId, /^[a-f0-9-]{36}$/);
		assert.equal(event.sessionId, recording.sessionId); assert.equal(event.sourceSessionId, registration.sourceSessionId);
		assert.equal(event.workspaceId, registration.workspaceId); assert.equal(event.timestamp, timestamp);
		assert.equal(event.correlationId, 'turn-1');
		assert.equal((event.payload as CodexMessagePayload).text, '  Fix the sorting bug.\nKeep stable ordering.  ');
		assert.equal(event.payload.sourceRecord.byteOffset, reference.byteOffset);
		assert.equal(event.payload.sourceRecord.sourceFileReference, registration.sourceFileReference);
		assert.ok(!JSON.stringify(event).includes('"raw"'));
	});
	test('captures visible assistant responses in source order', async () => {
		await parser.handle(message('user', 'Fix it'), context());
		await parser.handle(message('assistant', 'I will inspect it.', { phase: 'commentary' }), context());
		await parser.handle(message('assistant', 'The bug is fixed.', { phase: 'final_answer' }), context());
		assert.deepEqual(events.map(event => event.eventType), ['ai.prompt.submitted', 'ai.response.completed', 'ai.response.completed']);
		assert.deepEqual(events.map(event => (event.payload as CodexMessagePayload).text), ['Fix it', 'I will inspect it.', 'The bug is fixed.']);
		assert.equal((events[2].payload as CodexMessagePayload).phase, 'final_answer');
	});
	test('preserves multipart text boundaries without duplicating text fields or capturing images/reasoning', async () => {
		await parser.handle({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [
			{ type: 'output_text', text: 'First part' }, { type: 'reasoning_text', text: 'PRIVATE_REASONING' },
			{ type: 'input_image', image_url: 'PRIVATE_IMAGE' }, { type: 'output_text', text: 'Second part' }
		] } }, context());
		const payload = events[0].payload as CodexMessagePayload;
		assert.equal(payload.text, 'First part\nSecond part'); assert.deepEqual(payload.partLengths, [10, 11]);
		assert.ok(!JSON.stringify(events).includes('PRIVATE_'));
	});
	test('deduplicates mirrored prompts in either record order', async () => {
		await parser.handle(message('user', 'First prompt'), context());
		await parser.handle(legacy('user', 'First prompt'), context());
		await parser.handle(legacy('user', 'Second prompt'), context());
		await parser.handle(message('user', 'Second prompt'), context());
		assert.deepEqual(events.map(event => (event.payload as CodexMessagePayload).text), ['First prompt', 'Second prompt']);
	});
	test('deduplicates multipart messages mirrored as a flat string or separate visible parts', async () => {
		const multipart = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [
			{ type: 'output_text', text: 'A' }, { type: 'output_text', text: 'B' }
		] } };
		await parser.handle(multipart, context());
		await parser.handle(legacy('assistant', 'A\nB'), context());
		assert.equal(events.length, 1);
		await parser.handle({ ...multipart, payload: { ...multipart.payload, content: [
			{ type: 'output_text', text: 'C' }, { type: 'output_text', text: 'D' }
		] } }, context());
		await parser.handle(legacy('assistant', 'C'), context());
		await parser.handle(legacy('assistant', 'D'), context());
		assert.equal(events.length, 2);
		await parser.handle(legacy('assistant', 'E'), context());
		await parser.handle(legacy('assistant', 'F'), context());
		await parser.handle({ ...multipart, payload: { ...multipart.payload, content: [
			{ type: 'output_text', text: 'E' }, { type: 'output_text', text: 'F' }
		] } }, context());
		assert.equal(events.length, 4);
	});
	test('preserves legitimate repeated prompts and distinct turns while deduplicating stable IDs', async () => {
		await parser.handle(message('user', 'Try again', { id: 'm1', turn_id: 't1' }), context());
		await parser.handle(message('user', 'Try again', { id: 'm1', turn_id: 't1' }), context());
		await parser.handle(message('user', 'Try again', { id: 'm2', turn_id: 't2' }), context());
		await parser.handle(legacy('user', 'Try again', { turn_id: 't3' }), context());
		assert.equal(events.length, 3);
	});
	test('deduplicates replayed record references even when message IDs are absent', async () => {
		const reference = context(); const value = message('user', 'One prompt');
		await parser.handle(value, reference); await parser.handle(value, reference);
		assert.equal(events.length, 1);
	});
	test('excludes system/developer roles, reasoning, analysis channels and incomplete assistant messages', async () => {
		for (const role of ['system', 'developer', 'tool']) { await parser.handle(message(role, 'PRIVATE_INSTRUCTIONS'), context()); }
		await parser.handle(message('assistant', 'PRIVATE_REASONING', { channel: 'analysis' }), context());
		await parser.handle(message('assistant', 'PRIVATE_REASONING', { phase: 'analysis' }), context());
		await parser.handle(message('assistant', 'PRIVATE_REASONING', { recipient: 'functions.exec' }), context());
		await parser.handle(message('assistant', 'partial response', { status: 'in_progress' }), context());
		for (const type of ['reasoning', 'agent_reasoning', 'agent_reasoning_raw_content', 'agent_reasoning_delta']) {
			await parser.handle({ type: type === 'reasoning' ? 'response_item' : 'event_msg', payload: {
				type, text: 'PRIVATE_REASONING', summary: [{ text: 'PRIVATE_REASONING' }], encrypted_content: 'PRIVATE_REASONING'
			} }, context());
		}
		assert.equal(events.length, 0);
	});
	test('filters injected instruction/context blocks from user-role content', async () => {
		await parser.handle(message('user', '<environment_context>PRIVATE_PATHS</environment_context>'), context());
		await parser.handle(message('user', '# AGENTS.md instructions for /private\nPRIVATE_RULES'), context());
		await parser.handle(message('user', '<user_instructions>PRIVATE_RULES</user_instructions>\nFix the test.'), context());
		await parser.handle(message('user', '# Context from my IDE:\nPRIVATE_PATHS\n## My request for Codex:\nFix the bug.'), context());
		assert.deepEqual(events.map(event => (event.payload as CodexMessagePayload).text), ['Fix the test.', 'Fix the bug.']);
		assert.ok(!JSON.stringify(events).includes('PRIVATE_'));
	});
	test('captures tool inputs once and matches tool output by call ID without repeating input', async () => {
		await call(); await output();
		assert.deepEqual(events.map(event => event.eventType), ['ai.tool.started', 'ai.tool.completed']);
		const start = events[0].payload as CodexToolPayload; const end = events[1].payload as CodexToolPayload;
		assert.equal(start.input, '{"cmd":"echo hello"}'); assert.equal(end.output, 'hello'); assert.equal(end.input, undefined);
		assert.equal(end.startedEventId, events[0].eventId); assert.equal(end.callId, 'call-1'); assert.equal(end.matched, true);
		assert.equal(events[0].correlationId, events[1].correlationId); assert.equal(end.status, 'unknown');
	});
	test('matches interleaved call IDs and preserves result ordering', async () => {
		await call('A'); await call('B'); await output('B', { output: 'B result' }); await output('A', { output: 'A result' });
		assert.deepEqual(events.map(event => event.correlationId), ['A', 'B', 'B', 'A']);
		assert.equal((events[2].payload as CodexToolPayload).startedEventId, events[1].eventId);
		assert.equal((events[3].payload as CodexToolPayload).startedEventId, events[0].eventId);
	});
	test('captures custom tools and structured text output while ignoring image data', async () => {
		await parser.handle({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch',
			input: '*** Update File: src/app.ts\n+const value = 2;' } }, context());
		await parser.handle({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'patch', output: [
			{ type: 'input_text', text: 'Applied' }, { type: 'image', data: 'PRIVATE_IMAGE' }, { type: 'text', text: 'successfully' }
		], success: true } }, context());
		assert.equal((events[1].payload as CodexToolPayload).output, 'Applied\nsuccessfully');
		assert.equal((events[1].payload as CodexToolPayload).status, 'succeeded');
		assert.ok(!JSON.stringify(events).includes('PRIVATE_IMAGE'));
	});
	test('records execution failures and available exit codes, including structured output status', async () => {
		await call('failed'); await output('failed', { exit_code: 2, output: 'Build failed' });
		await call('json'); await output('json', { output: '{"exit_code":1,"stdout":"failed"}' });
		assert.deepEqual(events.filter(event => event.eventType === 'ai.tool.failed').map(event => (event.payload as CodexToolPayload).exitCode), [2, 1]);
	});
	test('deduplicates overlapping tool starts/results and emits later status metadata without duplicate output', async () => {
		await call();
		await parser.handle({ type: 'event_msg', payload: { type: 'exec_command_begin', call_id: 'call-1', command: ['echo', 'hello'] } }, context());
		await output();
		await parser.handle({ type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'call-1', aggregated_output: 'hello',
			exit_code: 0, status: 'completed' } }, context());
		await output();
		assert.equal(events.length, 3);
		assert.equal((events[2].payload as CodexToolPayload).statusUpdate, true);
		assert.equal((events[2].payload as CodexToolPayload).output, undefined);
	});
	test('captures unmatched output safely without inventing a start or success', async () => {
		await output('missing');
		const payload = events[0].payload as CodexToolPayload;
		assert.equal(payload.matched, false); assert.equal(payload.toolName, 'unknown'); assert.equal(payload.status, 'unknown');
		assert.equal(payload.startedEventId, undefined);
	});
	test('handles missing call IDs as explicitly unmatched activity', async () => {
		await call('ignored', { call_id: undefined });
		await output('ignored', { call_id: undefined });
		assert.ok(events.every(event => event.correlationId === undefined && (event.payload as CodexToolPayload).matched === false));
	});
	test('marks still-open calls incomplete at Stop without claiming execution failure', async () => {
		await call();
		const originalSession = recording.sessionId;
		recording.stop(); await parser.flush();
		assert.equal(events[1].eventType, 'ai.tool.incomplete'); assert.equal(events[1].sessionId, originalSession);
		assert.equal((events[1].payload as CodexToolPayload).incompleteReason, 'recording_stopped');
		assert.equal((events[1].payload as CodexToolPayload).output, undefined);
	});
	test('marks aborted turns and stream resets incomplete', async () => {
		await call('A');
		await parser.handle({ type: 'event_msg', payload: { type: 'turn_aborted' } }, context());
		await call('B');
		await parser.handle(message('user', 'After reset'), context({ generation: 1 }));
		assert.deepEqual(events.filter(event => event.eventType === 'ai.tool.incomplete')
			.map(event => (event.payload as CodexToolPayload).incompleteReason), ['turn_aborted', 'stream_reset']);
	});
	test('does not capture without explicit content consent, and never reuses consent on a new recording', async () => {
		parser.dispose(); await parser.flush();
		parser = new CodexEventParser(recording, registry(), writer);
		await parser.handle(message('user', 'No content consent'), context());
		assert.equal(events.length, 0);
		parser.grantContentConsent(recording.sessionId!);
		await parser.handle(message('user', 'Consented'), context());
		recording.stop(); await recording.start(); registration.recordingSessionId = recording.sessionId!;
		await parser.handle(message('user', 'New session without consent'), context());
		assert.equal(events.length, 1);
	});
	test('never captures unconfirmed, rejected, ambiguous or unrelated sessions despite content consent', async () => {
		for (const status of ['eligible', 'rejected', 'ambiguous'] as const) {
			registration.status = status; await parser.handle(message('user', 'PRIVATE_UNCONFIRMED'), context());
		}
		registration.status = 'confirmed';
		await parser.handle(message('user', 'PRIVATE_UNRELATED'), context({ sourceSessionId: randomUUID() }));
		await parser.handle(message('user', 'PRIVATE_UNRELATED'), context({ workspaceId: 'unrelated' }));
		assert.equal(events.length, 0);
	});
	test('ignores new records after Stop and ignores consent granted to an old recording', async () => {
		const reference = context(); recording.stop();
		parser.grantContentConsent(reference.sessionId);
		await parser.handle(message('user', 'PRIVATE_AFTER_STOP'), reference);
		assert.equal(events.length, 0);
		assert.equal(parser.hasContentConsent(reference.sessionId), false);
	});
	test('omits excluded tool input/output content while retaining call lifecycle metadata', async () => {
		await call('secret', { arguments: '{"cmd":"cat .env"}' });
		await output('secret', { output: 'PRIVATE_CREDENTIAL=secret', exit_code: 0 });
		assert.ok(events.every(event => (event.payload as CodexToolPayload).contentOmitted === 'privacy_filter'));
		assert.ok(!JSON.stringify(events).includes('PRIVATE_CREDENTIAL'));
		assert.ok(!JSON.stringify(events).includes('cat .env'));
		assert.ok(issues.includes('privacy_filtered'));
	});
	test('applies path exclusions to explicit path fields without removing ordinary build command text', async () => {
		await call('build', { arguments: '{"cmd":"npm run build"}' }); await output('build', { output: 'Build passed', exit_code: 0 });
		assert.equal((events[0].payload as CodexToolPayload).input, '{"cmd":"npm run build"}');
		assert.equal((events[1].payload as CodexToolPayload).output, 'Build passed');
		await call('path', { arguments: '{"path":"build","operation":"read"}' });
		assert.equal((events[2].payload as CodexToolPayload).contentOmitted, 'privacy_filter');
	});
	test('handles unknown and malformed records without executing getters or printing submitted values', async () => {
		for (const value of [undefined, null, [], { type: 'unknown', payload: { type: 'message', text: 'PRIVATE_RAW' } },
			{ type: 'response_item', payload: { type: 'message', role: 'user', content: 'wrong' } }]) {
			await parser.handle(value, context());
		}
		let accessed = false;
		const bad = { type: 'response_item' };
		Object.defineProperty(bad, 'payload', { get: () => { accessed = true; throw new Error('PRIVATE_GETTER'); } });
		await parser.handle(bad, context());
		assert.equal(accessed, false); assert.equal(events.length, 0);
		assert.ok(!JSON.stringify(issues).includes('PRIVATE'));
	});
	test('rejects oversized message text without writing a truncated prompt', async () => {
		await parser.handle(message('user', 'x'.repeat(MAX_CODEX_CONTENT_BYTES + 1)), context());
		assert.equal(events.length, 0); assert.ok(issues.includes('content_limit'));
	});
	test('bounds call history and emits an explicit incomplete event for evicted open calls', async () => {
		configure({ maxOpenCalls: 1 });
		await call('A'); await call('B');
		assert.ok(events.some(event => event.eventType === 'ai.tool.incomplete' && (event.payload as CodexToolPayload).callId === 'A'
			&& (event.payload as CodexToolPayload).incompleteReason === 'capacity_limit'));
		assert.ok(issues.includes('state_limit'));
	});
	test('writer failures disable capture for this recording and emit only a static reason', async () => {
		configure({}, { write: async () => { throw new Error('PRIVATE_CONTENT failed path /private/credentials'); }, flush: async () => {} });
		await parser.handle(message('user', 'PRIVATE_PROMPT'), context());
		await parser.handle(message('user', 'Another prompt'), context());
		assert.equal(parser.hasContentConsent(recording.sessionId), false);
		assert.deepEqual(issues, ['write_failed']);
	});
	test('persists validated conversation events locally with restrictive log permissions', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'codex-capture-writer-'));
		try {
			const log = new JsonlWriter(join(directory, 'events.v1.jsonl'));
			configure({}, log);
			await parser.handle(message('user', 'Dummy prompt'), context());
			await parser.handle(message('assistant', 'Dummy response'), context());
			const stored = (await readFile(log.filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
			assert.deepEqual(stored.map(event => event.eventType), ['ai.prompt.submitted', 'ai.response.completed']);
			assert.ok(stored.every(event => validateEvent(event).valid));
			if (process.platform !== 'win32') { assert.equal((await stat(log.filePath)).mode & 0o777, 0o600); }
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
});
