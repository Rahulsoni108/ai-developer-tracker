import { validAssessmentEventApproval } from '../assessmentEventApproval';
import type { TrackerEvent } from '../eventSchema';
import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, canonicalSha256, CanonicalJsonError } from '../canonicalJson';

suite('RFC 8785 canonical assessment JSON', () => {
	test('matches shared TypeScript/Ruby UTF-8 bytes and SHA-256 vectors', async () => {
		const fixture = JSON.parse(await readFile(join(__dirname, '../../src/test/fixtures/assessment-approval-v1.json'), 'utf8'));
		for (const vector of fixture.vectors) {
			const value = JSON.parse(vector.inputJson);
			assert.equal(canonicalJson(value), vector.canonical, vector.id);
			assert.equal(canonicalSha256(value), vector.sha256, vector.id);
		}
	});
	test('matches shared Ruby approval/authority consistency cases without treating metadata as attestation', async () => {
		const fixture = JSON.parse(await readFile(join(__dirname, '../../src/test/fixtures/assessment-approval-v1.json'), 'utf8'));
		for (const item of fixture.approvalCases) {
			const authority = item.authority; const event = item.event as TrackerEvent;
			const valid = validAssessmentEventApproval(item.approval, event, authority)
				&& event.sessionId === authority.localRecordingSessionId && event.workspaceId === authority.workspaceId
				&& authority.state === 'active' && authority.eventTypes.includes(event.eventType)
				&& Date.parse(authority.serverTime) < Date.parse(authority.endsAt) && Date.parse(event.timestamp) >= Date.parse(authority.startsAt)
				&& Date.parse(event.timestamp) <= Date.parse(authority.serverTime);
			assert.equal(valid, item.valid, item.id);
		}
	});

	test('preserves field presence and array ordering without normalizing Unicode', () => {
		assert.notEqual(canonicalSha256({}), canonicalSha256({ present: null }));
		assert.notEqual(canonicalSha256([1, 2]), canonicalSha256([2, 1]));
		assert.notEqual(canonicalSha256({ text: 'é' }), canonicalSha256({ text: 'e\u0301' }));
		assert.equal(canonicalSha256({ b: 2, a: 1 }), canonicalSha256({ a: 1, b: 2 }));
	});
	test('rejects unsupported values and invalid Unicode instead of coercing or omitting them', () => {
		for (const value of [undefined, NaN, Infinity, -Infinity, 1n, new Date(), { a: undefined }, { a: () => {} },
			[undefined], Array(1), '\ud800', '\udfff', { '\ud800': 'value' }, new Number(1), Object.assign([], { extra: 1 })]) {
			assert.throws(() => canonicalJson(value), CanonicalJsonError);
		}
	});
	test('rejects accessors, proxies, symbols, cycles and excessive depth without invoking custom code', () => {
		let invoked = false;
		const getter = { get value() { invoked = true; return 1; } };
		const proxy = new Proxy({}, { ownKeys() { invoked = true; return []; } });
		const cycle: unknown[] = []; cycle.push(cycle);
		let deep: unknown = 1; for (let index = 0; index < 34; index++) { deep = [deep]; }
		for (const value of [getter, proxy, cycle, deep, { [Symbol('key')]: 1 }, { toJSON() { invoked = true; return {}; } }]) {
			assert.throws(() => canonicalJson(value), CanonicalJsonError);
		}
		assert.equal(invoked, false);
		assert.throws(() => canonicalJson(Array.from({ length: 20001 }, () => 0)), CanonicalJsonError);
	});
});
