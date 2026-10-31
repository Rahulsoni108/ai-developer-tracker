import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AssessmentAiCaptureHealth, NATIVE_CHAT_CONTRACT_BLOCKER, describeAiCaptureHealth, stopAssessmentCaptureForWorkspaceChange } from '../assessmentAiCaptureHealth';
import { RecordingController } from '../recording';
import { createCodexEvent, createClaudeEvent, type TrackerEvent } from '../eventSchema';

suite('Assessment AI capture observations', () => {
	let recording: RecordingController; let health: AssessmentAiCaptureHealth; let approved: boolean; let warnings: number;
	const source = randomUUID();
	function message(provider: 'codex' | 'claude' = 'codex', response = false, sourceId = source): TrackerEvent {
		const base = { sessionId: recording.sessionId!, workspaceId: 'a'.repeat(64), sourceSessionId: sourceId,
			eventType: response ? 'ai.response.completed' as const : 'ai.prompt.submitted' as const };
		return provider === 'codex' ? createCodexEvent({ ...base, payload: { text: 'Synthetic PRIVATE message — never in health output',
			sourceRecord: { sourceFileReference: 'codex-file:' + 'b'.repeat(64), recordIndex: 1, generation: 0, byteOffset: 0, byteLength: 1, recordType: 'event_msg' } } })
			: createClaudeEvent({ ...base, payload: { text: 'Synthetic PRIVATE response', sourceRecord: {
				sourceFileReference: 'claude-file:' + 'b'.repeat(64), recordIndex: 1, generation: 0, byteOffset: 0, byteLength: 1, recordType: 'claude_hook' } } });
	}
	setup(() => {
		approved = true; warnings = 0;
		recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => true);
		health = new AssessmentAiCaptureHealth(recording, () => approved, () => {}, () => { warnings++; });
	});
	teardown(() => { health.dispose(); recording.dispose(); });
	test('launch/selection alone remains initializing and never claims captured content', async () => {
		await recording.start(); health.initializing('codex');
		assert.equal(health.view.state, 'initializing'); assert.equal(health.view.connectedSessions, 0); assert.equal(health.view.prompts, 0);
	});
	test('verified reader initialization is distinct from actually observed prompt/response capture', async () => {
		await recording.start(); health.readerReady('codex', [source]);
		assert.equal(health.view.state, 'ready'); assert.equal(health.view.connectedSessions, 1);
		assert.match(describeAiCaptureHealth(health.view), /no prompt or response capture has been observed/);
		health.observe(message()); health.observe(message('codex', true));
		assert.equal(health.view.prompts, 1); assert.equal(health.view.responses, 1);
	});
	test('counts only successful persisted events supplied by the pipeline and deduplicates event IDs', async () => {
		await recording.start(); const event = message(); health.observe(event); health.observe(event);
		assert.equal(health.view.prompts, 1); assert.equal(health.view.connectedSessions, 1);
	});
	test('unrelated recording, missing source attribution and manual development recording stay excluded', async () => {
		approved = false; await recording.start(); health.observe(message()); assert.equal(health.view.prompts, 0);
		recording.stop(); approved = true; await recording.start();
		health.observe({ ...message(), sessionId: randomUUID() }); health.observe({ ...message(), sourceSessionId: undefined } as TrackerEvent);
		assert.equal(health.view.prompts, 0); assert.equal(health.view.connectedSessions, 0);
	});
	test('multiple providers and same UUID in different providers retain separate connections without claiming coordination', async () => {
		await recording.start(); health.observe(message()); health.observe(message('claude', true));
		assert.equal(health.view.connectedSessions, 2); assert.equal(health.view.prompts, 1); assert.equal(health.view.responses, 1);
		assert.doesNotMatch(describeAiCaptureHealth(health.view), /collaborated|authorship/);
	});
	test('reader interruption becomes visible without deleting captured counts or authorizing new capture', async () => {
		await recording.start(); health.observe(message()); health.interrupted('codex');
		assert.equal(health.view.state, 'interrupted'); assert.equal(health.view.connectedSessions, 0); assert.equal(health.view.prompts, 1);
		health.readerReady('codex', [randomUUID()]); assert.equal(health.view.state, 'ready'); assert.equal(recording.isRecording, true);
	});
	test('metadata invalidation is reflected without reading transcripts or inventing reconnection', async () => {
		await recording.start(); health.readerReady('codex', [source]); health.reconcile('codex', []);
		assert.equal(health.view.state, 'interrupted'); assert.equal(health.view.connectedSessions, 0);
		health.reconcile('codex', []); assert.equal(health.view.state, 'interrupted');
		health.reconcile('codex', [source]); assert.equal(health.view.state, 'ready'); assert.equal(health.view.prompts, 0);
	});
	test('workspace changes stop only the assessment recording without finalizing or affecting manual recording', async () => {
		await recording.start(); health.observe(message());
		assert.equal(stopAssessmentCaptureForWorkspaceChange(recording, () => true), true);
		assert.equal(health.view.state, 'stopped'); assert.equal(health.view.prompts, 1);
		approved = false; await recording.start(); assert.equal(stopAssessmentCaptureForWorkspaceChange(recording, () => false), false); assert.equal(recording.isRecording, true);
	});
	test('zero-event feedback is early, bounded and independent of actual provider usage', async () => {
		await recording.start(); health.checkMissingMessages(); health.checkMissingMessages(); assert.equal(warnings, 1);
		recording.stop(); health.checkMissingMessages(); assert.equal(warnings, 1);
		await recording.start(); health.observe(message()); health.checkMissingMessages(); assert.equal(warnings, 1);
	});
	test('stop/submit, consent withdrawal or scope loss cannot leave a ready connection', async () => {
		await recording.start(); health.observe(message()); approved = false;
		assert.equal(health.view.state, 'stopped'); assert.equal(health.view.connectedSessions, 0);
		approved = true; recording.stop(); assert.equal(health.view.state, 'stopped'); assert.equal(health.view.prompts, 1);
		health.clearStopped(); assert.equal(health.view.prompts, 0); assert.equal(health.view.state, 'not_connected');
	});
	test('restart and new recording never restore old readiness or counts', async () => {
		await recording.start(); const old = message(); health.observe(old); recording.stop(); await recording.start(); health.observe(old);
		assert.equal(health.view.state, 'not_connected'); assert.equal(health.view.prompts, 0);
		const fresh = new AssessmentAiCaptureHealth(recording, () => true);
		try { assert.equal(fresh.view.connectedSessions, 0); assert.equal(fresh.view.state, 'not_connected'); } finally { fresh.dispose(); }
	});
	test('health output contains no event IDs, source IDs, workspace identifiers or evidence', async () => {
		await recording.start(); const event = message(); health.observe(event); const text = JSON.stringify(health.view) + describeAiCaptureHealth(health.view);
		for (const value of [source, event.eventId, event.sessionId, event.workspaceId!, 'PRIVATE', 'codex-file:']) { assert.equal(text.includes(value), false); }
	});
	test('bounded counters explicitly become lower bounds rather than growing without limit', async () => {
		health.dispose(); health = new AssessmentAiCaptureHealth(recording, () => true, () => {}, () => {}, 2); await recording.start();
		health.observe(message()); health.observe(message()); health.observe(message());
		assert.equal(health.view.prompts, 2); assert.equal(health.view.countsLimited, true); assert.match(describeAiCaptureHealth(health.view), /lower bounds/);
	});
	test('native contract limitation is explicit and never presents a recording grant as native authorization', () => {
		assert.match(NATIVE_CHAT_CONTRACT_BLOCKER, /extension_launched_only/);
		assert.match(NATIVE_CHAT_CONTRACT_BLOCKER, /cannot authorize/); assert.match(NATIVE_CHAT_CONTRACT_BLOCKER, /optional/);
		assert.doesNotMatch(NATIVE_CHAT_CONTRACT_BLOCKER, /capture ready/i);
	});
});
