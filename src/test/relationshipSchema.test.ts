import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCodexEvent, createRelationshipEvent, validateEvent, type CodexSourceRecord } from '../eventSchema';

function relationship() {
	const source = randomUUID(); const target = randomUUID();
	return createRelationshipEvent({ sessionId: randomUUID(), workspaceId: 'approved', sourceSessionId: randomUUID(),
		eventType: 'activity.relationship.created', payload: { relationshipId: 'a'.repeat(64), sourceEventId: source, targetEventId: target,
			relationshipType: 'tool_file_change', relativePath: 'src/app.ts', confidence: 'possible', explanationCode: 'timestamp_only',
			revision: 1, evidence: [{ eventId: source, kind: 'tool_start' }, { eventId: target, kind: 'time_window' }] } });
}
const reference: CodexSourceRecord = { sourceFileReference: 'codex-file:' + 'b'.repeat(64), generation: 0,
	recordIndex: 2, byteOffset: 100, byteLength: 100, recordType: 'event_msg' };
suite('Relationship event schema', () => {
	test('validates created/updated events and links revisions without altering attribution', () => {
		const event = relationship(); assert.equal(validateEvent(event).valid, true); assert.equal(event.attribution, 'unknown');
		assert.equal(validateEvent({ ...event, eventType: 'activity.relationship.updated',
			payload: { ...event.payload, revision: 2, previousRelationshipEventId: event.eventId } }).valid, true);
		assert.equal(validateEvent({ ...event, attribution: 'ai_confirmed' }).valid, false);
	});
	test('rejects confirmed claims based only on timestamps and requires direct evidence', () => {
		const event = relationship();
		assert.equal(validateEvent({ ...event, payload: { ...event.payload, confidence: 'confirmed' } }).valid, false);
		const payload = { ...event.payload, confidence: 'confirmed', explanationCode: 'applied_change_matches_diff',
			evidence: [...event.payload.evidence, { eventId: event.payload.sourceEventId, kind: 'tool_result' },
				{ eventId: event.payload.sourceEventId, kind: 'applied_change' }, { eventId: event.payload.targetEventId, kind: 'change_hash_match' }] };
		assert.equal(validateEvent({ ...event, payload }).valid, true);
		assert.equal(validateEvent({ ...event, payload: { ...payload, evidence: [...payload.evidence, { eventId: randomUUID(), kind: 'competing_tool' }] } }).valid, false);
	});
	test('rejects malformed references, revision chains, path escapes, raw content and unknown explanation codes', () => {
		const event = relationship();
		for (const change of [{ sourceEventId: 'invalid' }, { targetEventId: event.payload.sourceEventId }, { relativePath: '../private.ts' },
			{ revision: 2 }, { explanationCode: 'guess' }, { rawToolInput: 'PRIVATE_CODE' }, { evidence: [] }]) {
			assert.equal(validateEvent({ ...event, payload: { ...event.payload, ...change } }).valid, false);
		}
		assert.equal(validateEvent({ ...event, eventType: 'activity.relationship.updated' }).valid, false);
	});
	test('validates source evidence metadata without executing nested getters', () => {
		const event = relationship(); let accessed = false;
		const evidence = [{ eventId: event.payload.sourceEventId, kind: 'tool_start', sourceRecord: reference },
			{ eventId: event.payload.targetEventId, kind: 'time_window' }];
		assert.equal(validateEvent({ ...event, payload: { ...event.payload, evidence } }).valid, true);
		const bad = { ...reference };
		Object.defineProperty(bad, 'recordIndex', { enumerable: true, get: () => { accessed = true; return 1; } });
		assert.equal(validateEvent({ ...event, payload: { ...event.payload, evidence: [{ ...evidence[0], sourceRecord: bad }, evidence[1]] } }).valid, false);
		assert.equal(accessed, false);
	});
	test('validates structured tool paths/hash metadata while rejecting unsound applied evidence', () => {
		const event = createCodexEvent({ sessionId: randomUUID(), workspaceId: 'approved', sourceSessionId: randomUUID(),
			eventType: 'ai.tool.completed', payload: { toolName: 'apply_patch', status: 'succeeded', matched: true, sourceRecord: reference,
				timestampOrigin: 'source', fileEvidence: [{ relativePath: 'src/a.ts', operation: 'edit', origin: 'patch_apply', kind: 'applied', changeHash: 'a'.repeat(64) }] } });
		assert.equal(validateEvent(event).valid, true);
		for (const change of [{ relativePath: '/private/file.ts' }, { changeHash: 'invalid' }, { origin: 'structured_arguments' }, { code: 'PRIVATE' }]) {
			assert.equal(validateEvent({ ...event, payload: { ...event.payload,
				fileEvidence: [{ relativePath: 'src/a.ts', operation: 'edit', origin: 'patch_apply', kind: 'applied', changeHash: 'a'.repeat(64), ...change }] } }).valid, false);
		}
	});
});
