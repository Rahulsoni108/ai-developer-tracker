import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCodexEvent, MAX_CODEX_CONTENT_BYTES, validateEvent, type CodexSourceRecord } from '../eventSchema';

const reference: CodexSourceRecord = { sourceFileReference: 'codex-file:' + 'a'.repeat(64),
	recordIndex: 2, generation: 0, byteOffset: 100, byteLength: 150, recordType: 'response_item' };
const prompt = () => createCodexEvent({ sessionId: randomUUID(), workspaceId: 'approved', sourceSessionId: randomUUID(),
	eventType: 'ai.prompt.submitted', payload: { text: 'Dummy prompt', sourceRecord: { ...reference } } });

suite('Common Codex event schema', () => {
	test('validates prompt and response events with existing schema version and UUIDs', () => {
		const event = prompt();
		assert.equal(validateEvent(event).valid, true); assert.equal(event.schemaVersion, 1);
		assert.equal(validateEvent({ ...event, eventType: 'ai.response.completed' }).valid, true);
		assert.notEqual(event.eventId, prompt().eventId);
	});
	test('requires recording/source/workspace identifiers and source codex', () => {
		for (const field of ['eventId', 'schemaVersion', 'sessionId', 'sourceSessionId', 'workspaceId', 'timestamp', 'payload']) {
			const event: Record<string, unknown> = { ...prompt() }; delete event[field];
			assert.equal(validateEvent(event).valid, false, field);
		}
		assert.equal(validateEvent({ ...prompt(), source: 'vscode' }).valid, false);
	});
	test('validates bounded multipart text and rejects arbitrary sensitive metadata fields', () => {
		const event = prompt();
		assert.equal(validateEvent({ ...event, payload: { text: 'A\nB', partLengths: [1, 1], sourceRecord: reference } }).valid, true);
		for (const extra of [{ partLengths: [2, 2] }, { raw: 'PRIVATE_RAW' }, { reasoning: 'PRIVATE_REASONING' },
			{ text: 'x'.repeat(MAX_CODEX_CONTENT_BYTES + 1) }, { phase: 'analysis' }]) {
			assert.equal(validateEvent({ ...event, payload: { ...event.payload, ...extra } }).valid, false);
		}
	});
	test('requires valid opaque source references and bounded integer offsets', () => {
		for (const change of [{ sourceFileReference: '/private/session.jsonl' }, { recordIndex: 0 }, { generation: -1 },
			{ byteOffset: -1 }, { byteLength: 0 }, { recordType: 'reasoning' }, { contents: 'PRIVATE_RAW' }]) {
			const event = prompt();
			assert.equal(validateEvent({ ...event, payload: { ...event.payload, sourceRecord: { ...reference, ...change } } }).valid, false);
		}
	});
	test('validates tool kinds with consistent statuses and start/result links', () => {
		const base = prompt();
		for (const [eventType, status] of [['ai.tool.started', 'running'], ['ai.tool.completed', 'succeeded'],
			['ai.tool.failed', 'failed'], ['ai.tool.incomplete', 'incomplete']]) {
			const payload = { sourceRecord: reference, toolName: 'exec_command', callId: 'call-1', status,
				matched: true, ...(status === 'incomplete' ? { incompleteReason: 'recording_stopped' } : {}) };
			assert.equal(validateEvent({ ...base, eventType, correlationId: 'call-1', payload }).valid, true);
			assert.equal(validateEvent({ ...base, eventType, payload: { ...payload, status: 'invented' } }).valid, false);
		}
	});
	test('rejects inconsistent omissions, invalid call IDs, unknown tool fields and oversized content', () => {
		const base = prompt();
		const payload = { sourceRecord: reference, toolName: 'exec_command', status: 'succeeded', matched: true, output: 'hello' };
		for (const extra of [{ contentOmitted: 'privacy_filter' }, { callId: '' }, { startedEventId: 'invalid' },
			{ exitCode: 1.5 }, { output: 'x'.repeat(MAX_CODEX_CONTENT_BYTES + 1) }, { toolArguments: 'PRIVATE_RAW' }]) {
			assert.equal(validateEvent({ ...base, eventType: 'ai.tool.completed', payload: { ...payload, ...extra } }).valid, false);
		}
	});
	test('does not execute nested source-reference or multipart getters', () => {
		let accessed = false;
		const event = prompt(); const source = { ...reference };
		Object.defineProperty(source, 'recordIndex', { enumerable: true, get: () => { accessed = true; return 1; } });
		assert.equal(validateEvent({ ...event, payload: { ...event.payload, sourceRecord: source } }).valid, false);
		const lengths = [1, 1];
		Object.defineProperty(lengths, '0', { get: () => { accessed = true; return 1; } });
		assert.equal(validateEvent({ ...event, payload: { text: 'A\nB', sourceRecord: reference, partLengths: lengths } }).valid, false);
		assert.equal(accessed, false);
	});
});
