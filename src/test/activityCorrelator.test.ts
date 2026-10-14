import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { ActivityCorrelator, type ActivityCorrelatorOptions, type CorrelatorDiagnostic } from '../activityCorrelator';
import { RecordingController } from '../recording';
import { createChangeEvent, createCodexEvent, validateEvent, type CodexActivityEvent, type CodexFileEvidence,
	type CodexToolPayload, type DiffEvent, type RelationshipEvent, type TrackerEvent } from '../eventSchema';
import { contentHash, patchChangeHash } from '../toolFileEvidence';

suite('Activity correlation', () => {
	let recording: RecordingController;
	let correlator: ActivityCorrelator;
	let written: RelationshipEvent[];
	let diagnostics: CorrelatorDiagnostic[];
	let clock: number;
	let sourceId: string;
	let index: number;
	const base = Date.parse('2026-10-13T10:00:00.000Z');
	const workspaceId = 'approved-workspace';
	const before = 'const value = 1;\n';
	const after = 'const value = 2;\n';
	const timestamp = (offset: number) => new Date(base + offset);

	function configure(options: Partial<ActivityCorrelatorOptions> = {}): void {
		correlator?.dispose();
		correlator = new ActivityCorrelator(recording, {
			write: async event => { assert.equal(validateEvent(event).valid, true); written.push(event as RelationshipEvent); },
			flush: async () => {}
		}, { approvedWorkspaces: () => [workspaceId, 'second-workspace'], now: () => new Date(clock),
			isExcludedPath: path => path.includes('.env') || path.startsWith('node_modules/'),
			onDiagnostic: reason => diagnostics.push(reason), ...options });
	}
	function evidence(path = 'src/app.ts', kind: 'declared' | 'applied' = 'applied'): CodexFileEvidence {
		return { relativePath: path, kind, origin: 'patch_apply', operation: 'edit',
			changeHash: patchChangeHash(createTwoFilesPatch('before', 'after', before, after))! };
	}
	function start(effects: CodexFileEvidence[] = [], overrides: Partial<Omit<CodexActivityEvent, 'timestamp'>> = {}) {
		return createCodexEvent({ sessionId: recording.sessionId!, workspaceId, sourceSessionId: sourceId,
			eventType: 'ai.tool.started', timestamp: timestamp(1000),
			payload: { toolName: 'apply_patch', callId: 'call-1', input: 'DO_NOT_RETAIN_TOOL_INPUT', status: 'running', matched: true,
				sourceRecord: { sourceFileReference: 'codex-file:' + 'a'.repeat(64), generation: 0, recordIndex: ++index,
					byteOffset: index * 200, byteLength: 200, recordType: 'event_msg' },
				fileEvidence: effects, timestampOrigin: 'source' }, ...overrides });
	}
	function result(tool: CodexActivityEvent, effects: CodexFileEvidence[] = [], overrides: Partial<CodexToolPayload> = {}, time = 3000) {
		const payload = tool.payload as CodexToolPayload;
		return createCodexEvent({ sessionId: tool.sessionId, workspaceId: tool.workspaceId, sourceSessionId: tool.sourceSessionId,
			eventType: overrides.status === 'failed' ? 'ai.tool.failed' : overrides.status === 'incomplete' ? 'ai.tool.incomplete' : 'ai.tool.completed',
			timestamp: timestamp(time), payload: { toolName: payload.toolName, callId: payload.callId,
				status: 'succeeded', matched: true, startedEventId: tool.eventId,
				output: 'DO_NOT_RETAIN_TOOL_OUTPUT', sourceRecord: { ...payload.sourceRecord, recordIndex: ++index },
				fileEvidence: effects, timestampOrigin: 'source', ...overrides } });
	}
	function diff(path = 'src/app.ts', time = 2000, reason: DiffEvent['payload']['changeReason'] = 'external', overrides: Partial<Omit<DiffEvent, 'timestamp'>> = {}): DiffEvent {
		return createChangeEvent({ sessionId: recording.sessionId!, workspaceId, timestamp: timestamp(time), eventType: 'file.diff',
			payload: { relativePath: path, changeReason: reason, diff: createTwoFilesPatch('before', 'after', before, after),
				beforeHash: contentHash(before), afterHash: contentHash(after) }, ...overrides }) as DiffEvent;
	}
	async function put(...events: TrackerEvent[]): Promise<void> {
		for (const event of events) { correlator.observe(event); }
		await correlator.flush();
	}
	const latest = (target?: string) => written.filter(event => !target || event.payload.targetEventId === target).at(-1)!;
	setup(async () => {
		written = []; diagnostics = []; index = 0; sourceId = randomUUID(); clock = base + 10000;
		recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true, () => timestamp(0));
		configure(); await recording.start();
	});
	teardown(async () => { recording.stop(); await correlator.flush(); correlator.dispose(); recording.dispose(); });

	test('confirms a successful applied patch with matching file path and exact edit signature', async () => {
		const tool = start([evidence('src/app.ts', 'declared')]); const change = diff();
		await put(tool, change, result(tool, [evidence()]));
		const relationship = latest();
		assert.equal(relationship.payload.confidence, 'confirmed');
		assert.equal(relationship.payload.explanationCode, 'applied_change_matches_diff');
		assert.equal(relationship.payload.sourceEventId, tool.eventId); assert.equal(relationship.payload.targetEventId, change.eventId);
		assert.equal(relationship.sessionId, recording.sessionId); assert.equal(relationship.sourceSessionId, sourceId);
		assert.equal(relationship.payload.callId, 'call-1'); assert.equal(relationship.attribution, 'unknown');
		assert.ok(relationship.payload.evidence.some(item => item.kind === 'applied_change'));
		assert.ok(relationship.payload.evidence.some(item => item.sourceRecord?.sourceFileReference === 'codex-file:' + 'a'.repeat(64)));
	});
	test('explicit path and successful execution without a matching change remain possible', async () => {
		const tool = start([{ relativePath: 'src/app.ts', operation: 'edit', kind: 'declared', origin: 'structured_arguments' }]);
		await put(tool, diff(), result(tool));
		assert.equal(latest().payload.confidence, 'possible'); assert.equal(latest().payload.explanationCode, 'explicit_path_window');
	});
	test('timestamp-only overlap is possible and does not infer authorship or parse command text', async () => {
		const tool = start(); const change = diff();
		(tool.payload as CodexToolPayload).input = '{"cmd":"touch src/app.ts; echo DO_NOT_EXECUTE"}';
		await put(tool, change, result(tool));
		assert.equal(latest().payload.confidence, 'possible'); assert.equal(latest().payload.explanationCode, 'timestamp_only');
		assert.equal(change.attribution, 'unknown');
		assert.ok(!JSON.stringify(written).includes('DO_NOT_EXECUTE'));
		assert.ok(!JSON.stringify(written).includes('DO_NOT_RETAIN'));
	});
	test('manual editor/save checkpoints during an applied patch remain possible', async () => {
		const tool = start([evidence('src/app.ts', 'declared')]);
		const edit = diff('src/app.ts', 2000, 'edit'); const save = diff('src/app.ts', 2500, 'save');
		await put(tool, result(tool, [evidence()]), edit, save);
		for (const change of [edit, save]) {
			assert.equal(latest(change.eventId).payload.confidence, 'possible');
			assert.equal(latest(change.eventId).payload.explanationCode, 'editor_checkpoint');
			assert.equal(change.attribution, 'unknown');
		}
	});
	test('missing tool results are explicitly unknown instead of assigning file ownership', async () => {
		await put(start([evidence('src/app.ts', 'declared')]), diff());
		assert.equal(latest().payload.confidence, 'unknown'); assert.equal(latest().payload.explanationCode, 'missing_tool_result');
	});
	test('late results upgrade a stable relationship and link update revisions', async () => {
		const tool = start([evidence('src/app.ts', 'declared')]); const change = diff();
		await put(tool, change);
		const initial = latest();
		await put(result(tool, [evidence()]));
		const update = latest();
		assert.equal(update.eventType, 'activity.relationship.updated');
		assert.equal(update.payload.relationshipId, initial.payload.relationshipId);
		assert.equal(update.payload.previousRelationshipEventId, initial.eventId);
		assert.equal(update.payload.revision, initial.payload.revision + 1);
		assert.equal(update.payload.confidence, 'confirmed');
	});
	test('supports a diff arriving before both tool events', async () => {
		const tool = start([evidence('src/app.ts', 'declared')]);
		await put(diff(), result(tool, [evidence()]));
		assert.equal(latest().payload.explanationCode, 'missing_tool_start');
		await put(tool);
		assert.equal(latest().payload.confidence, 'confirmed');
	});
	test('supports result before start without merging a different call ID or source', async () => {
		const tool = start([evidence('src/app.ts', 'declared')]);
		await put(result(tool, [evidence()]), diff());
		assert.equal(latest().payload.confidence, 'unknown');
		await put(tool);
		assert.equal(latest().payload.confidence, 'confirmed');
	});
	test('one tool can relate to multiple changed files', async () => {
		const tool = start([evidence('src/a.ts', 'declared'), evidence('src/b.ts', 'declared')]);
		const first = diff('src/a.ts'); const second = diff('src/b.ts');
		await put(tool, result(tool, [evidence('src/a.ts'), evidence('src/b.ts')]), first, second);
		assert.equal(latest(first.eventId).payload.confidence, 'confirmed'); assert.equal(latest(second.eventId).payload.confidence, 'confirmed');
		assert.notEqual(latest(first.eventId).payload.relationshipId, latest(second.eventId).payload.relationshipId);
	});
	test('overlapping tools for the same path downgrade prior certainty instead of arbitrarily choosing one', async () => {
		const first = start([evidence('src/app.ts', 'declared')]);
		const change = diff(); await put(first, result(first, [evidence()]), change);
		assert.equal(latest().payload.confidence, 'confirmed');
		const second = start([evidence('src/app.ts', 'declared')]);
		(second.payload as CodexToolPayload).callId = 'call-2';
		await put(second, result(second, [evidence()]));
		const firstRelationship = written.filter(event => event.payload.sourceEventId === first.eventId).at(-1)!;
		assert.equal(firstRelationship.payload.confidence, 'possible');
		assert.equal(firstRelationship.payload.explanationCode, 'overlapping_tools');
		assert.equal(latest().payload.confidence, 'possible');
	});
	test('unstructured overlapping commands also preserve ambiguity', async () => {
		const tool = start([evidence('src/app.ts', 'declared')]);
		await put(tool, result(tool, [evidence()]), diff());
		const command = start(); (command.payload as CodexToolPayload).callId = 'shell';
		await put(command);
		assert.equal(written.filter(event => event.payload.sourceEventId === tool.eventId).at(-1)!.payload.confidence, 'possible');
	});
	test('overlapping tools with different explicit paths do not create ambiguity for unrelated files', async () => {
		const first = start([evidence('src/app.ts', 'declared')]);
		const other = start([evidence('src/other.ts', 'declared')]); (other.payload as CodexToolPayload).callId = 'other';
		await put(first, result(first, [evidence()]), other, result(other, [evidence('src/other.ts')]), diff());
		assert.equal(latest().payload.confidence, 'confirmed');
		assert.ok(written.every(event => event.payload.sourceEventId === first.eventId));
	});
	test('read-only overlapping calls do not obscure reliable write evidence', async () => {
		const write = start([evidence('src/app.ts', 'declared')]);
		const read = start([{ relativePath: 'src/app.ts', operation: 'read', kind: 'declared', origin: 'structured_arguments' }]);
		(read.payload as CodexToolPayload).callId = 'read';
		const change = diff();
		await put(write, result(write, [evidence()]), read, result(read), change);
		assert.equal(written.filter(event => event.payload.sourceEventId === write.eventId).at(-1)!.payload.confidence, 'confirmed');
	});
	test('preserves late structured metadata when an earlier canonical start arrives afterward', async () => {
		const canonical = start();
		const metadata = start([evidence('src/app.ts', 'declared')]);
		metadata.timestamp = timestamp(1500).toISOString();
		(metadata.payload as CodexToolPayload).statusUpdate = true;
		(metadata.payload as CodexToolPayload).startedEventId = canonical.eventId;
		await put(metadata, result(canonical), diff(), canonical);
		assert.equal(latest().payload.confidence, 'possible');
		assert.equal(latest().payload.explanationCode, 'explicit_path_window');
		assert.ok(latest().payload.evidence.some(item => item.kind === 'explicit_path' && item.eventId === metadata.eventId));
	});
	test('late completion that excludes a formerly open window updates the relationship to unknown', async () => {
		const tool = start([evidence('src/app.ts', 'declared')]);
		await put(tool, diff('src/app.ts', 8000));
		await put(result(tool, [evidence()], {}, 3000));
		assert.equal(latest().payload.confidence, 'unknown'); assert.equal(latest().payload.explanationCode, 'outside_execution_window');
	});
	test('failed/incomplete calls and read-only tools cannot confirm a code change', async () => {
		const failed = start([evidence('src/app.ts', 'declared')]);
		await put(failed, result(failed, [], { status: 'failed' }), diff());
		assert.equal(latest().payload.confidence, 'unknown');
		await correlator.finishSession(recording.sessionId); configure();
		const read = start([{ relativePath: 'src/app.ts', operation: 'read', kind: 'declared', origin: 'structured_arguments' }]);
		await put(read, result(read), diff());
		assert.equal(latest().payload.explanationCode, 'read_only_tool');
	});
	test('capture-time timestamps and mismatched patch evidence do not produce confirmed relationships', async () => {
		const tool = start([evidence('src/app.ts', 'declared')]);
		(tool.payload as CodexToolPayload).timestampOrigin = 'capture';
		await put(tool, result(tool, [evidence()]), diff());
		assert.equal(latest().payload.explanationCode, 'unverified_timestamps');
	});
	test('duplicate processing does not create or update duplicate relationships', async () => {
		const tool = start([evidence('src/app.ts', 'declared')]); const end = result(tool, [evidence()]); const change = diff();
		await put(tool, end, change);
		const count = written.length;
		await put(tool, end, change, change);
		assert.equal(written.length, count);
		assert.equal(correlator.getStats().seenEvents, 3);
	});
	test('preserves input events and ignores prompts, initial baselines, and its own relationship records', async () => {
		const tool = start([evidence('src/app.ts', 'declared')]); const change = diff(); const snapshot = JSON.stringify([tool, change]);
		await put(tool, result(tool, [evidence()]), change);
		assert.equal(JSON.stringify([tool, change]), snapshot);
		const count = written.length;
		await put(latest());
		assert.equal(written.length, count);
	});
	test('never connects different recording sessions or workspaces', async () => {
		const tool = start([evidence('src/app.ts', 'declared')]);
		await put(tool, result(tool, [evidence()]), diff('src/app.ts', 2000, 'external', { workspaceId: 'second-workspace' }),
			diff('src/app.ts', 2000, 'external', { sessionId: randomUUID() }),
			diff('src/app.ts', 2000, 'external', { workspaceId: 'unapproved-workspace' }));
		assert.equal(written.length, 0);
	});
	test('same call IDs from different Codex sessions cannot share starts or results', async () => {
		const first = start([evidence('src/app.ts', 'declared')]);
		const second = start([evidence('src/app.ts', 'declared')], { sourceSessionId: randomUUID() });
		const change = diff('src/app.ts', 2000, 'external', { sourceSessionId: first.sourceSessionId });
		await put(first, result(second, [evidence()]), change);
		assert.equal(latest().sourceSessionId, first.sourceSessionId); assert.equal(latest().payload.explanationCode, 'missing_tool_result');
	});
	test('rejects excluded file paths and malformed normalized events', async () => {
		const tool = start([evidence('src/.env', 'declared')]);
		await put(tool, result(tool, [evidence('src/.env')]), diff('src/.env'));
		assert.equal(written.length, 0);
		const malformed = { ...diff(), payload: { ...diff().payload, relativePath: '../outside.ts' } };
		correlator.observe(malformed); await correlator.flush();
		assert.ok(diagnostics.includes('invalid_event')); assert.equal(written.length, 0);
	});
	test('drains pre-Stop events, rejects post-Stop data, and seals a completed recording', async () => {
		const tool = start([evidence('src/app.ts', 'declared')]);
		correlator.observe(tool); correlator.observe(result(tool, [evidence()]));
		const session = recording.sessionId; recording.stop();
		await put(diff('src/app.ts', 2000, 'external', { sessionId: session! }));
		assert.equal(latest().payload.confidence, 'confirmed');
		const count = written.length;
		await put(diff('src/app.ts', 11000, 'external', { sessionId: session! }));
		assert.equal(written.length, count);
		await correlator.finishSession(session);
		await put(diff('src/app.ts', 2000, 'external', { sessionId: session! }));
		assert.equal(written.length, count); assert.equal(correlator.getStats().runs, 0);
	});
	test('bounds queued work and state without silently recreating evicted relationships', async () => {
		configure({ maxQueued: 2, maxTools: 1, maxDiffs: 1, maxRelationships: 1, maxSeenEvents: 5 });
		const first = start(); const second = start(); (second.payload as CodexToolPayload).callId = 'second';
		correlator.observe(first); correlator.observe(second); correlator.observe(diff());
		await correlator.flush();
		assert.ok(diagnostics.includes('queue_limit'));
		assert.ok(correlator.getStats().tools <= 1); assert.ok(correlator.getStats().diffs <= 1);
		await put(first, diff(), diff());
		assert.ok(correlator.getStats().seenEvents <= 5); assert.ok(correlator.getStats().relationships <= 1);
	});
	test('rejects impossible limits before registering a listener', () => {
		assert.throws(() => new ActivityCorrelator(recording, { write: async () => {}, flush: async () => {} }, {
			approvedWorkspaces: () => [], maxQueued: 10000
		}));
	});
});
