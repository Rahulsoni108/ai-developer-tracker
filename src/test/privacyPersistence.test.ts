import { eventDiagnostic, type SafeEventDiagnostic } from '../jsonlWriter';
import { openTestQueue, openTestWorkerQueue } from './queueTestKeys';
import * as assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTwoFilesPatch } from 'diff';
import { setImmediate } from 'node:timers/promises';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { EventPersistence, EventPersistenceError, type PersistenceDiagnostic } from '../eventPersistence';
import { createChangeEvent, createCodexEvent, createFileEvent, createRelationshipEvent, validateEvent,
	type CodexEventType, type TrackerEvent } from '../eventSchema';
import { JsonlWriter } from '../jsonlWriter';
import { PrivacyFilter, type PrivacyContext } from '../privacyFilter';
import { RecordingController } from '../recording';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const workspaceId = 'approved-workspace';
const sourceSessionId = 'confirmed-source';
const sourceRecord = { sourceFileReference: 'codex-file:' + 'a'.repeat(64), recordIndex: 1, generation: 0,
	byteOffset: 0, byteLength: 200, recordType: 'response_item' as const };
const dummySecret = 'sk-proj-' + 'DummySecret123456789'.repeat(2);

suite('Privacy-filtered event persistence', () => {
	let root: string;
	let queue: AsyncLocalEventQueue;
	let writer: EventPersistence;
	let jsonl: JsonlWriter;
	let recording: RecordingController;
	let confirmed: boolean;
	let contentConsent: boolean;
	let consent: boolean;
	let consentRequests: number;
	let diagnostics: PersistenceDiagnostic[];
	const storage = () => ({ scheme: 'file', fsPath: join(root, 'global-storage') });
	const file = (relativePath = 'src/app.ts') => createFileEvent({ eventType: 'file.modified', source: 'vscode',
		sessionId: recording.sessionId!, workspaceId, payload: { relativePath } });
	const message = (text: string, eventType: 'ai.prompt.submitted' | 'ai.response.completed' = 'ai.prompt.submitted') =>
		createCodexEvent({ sessionId: recording.sessionId!, sourceSessionId, workspaceId, correlationId: 'turn-1', eventType,
			payload: { text, sourceRecord } });
	const tool = (type: CodexEventType, input = '{"path":"src/app.ts"}', output = 'Done') => createCodexEvent({
		sessionId: recording.sessionId!, sourceSessionId, workspaceId, eventType: type, correlationId: 'call-1',
		payload: { toolName: 'apply_patch', callId: 'call-1', input, output, matched: true, sourceRecord,
			status: type === 'ai.tool.started' ? 'running' : type === 'ai.tool.failed' ? 'failed'
				: type === 'ai.tool.incomplete' ? 'incomplete' : 'succeeded',
			...(type === 'ai.tool.incomplete' ? { incompleteReason: 'recording_stopped' as const } : {}) } });
	const diff = (eventType: 'file.diff' | 'file.baseline' = 'file.diff', before = 'const value = 1;\n', after = 'const value = 2;\n') =>
		createChangeEvent({ sessionId: recording.sessionId!, workspaceId, eventType, correlationId: 'change-1',
			payload: { relativePath: 'src/app.ts', beforeHash: hash(before), afterHash: hash(after), changeReason: 'edit',
				diff: createTwoFilesPatch('before', 'after', before, after) } });
	const scopes = () => ({ approvedWorkspaceIds: [workspaceId],
		confirmedCodexSessions: confirmed ? [{ sourceSessionId, workspaceId }] : [], codexContentConsent: contentConsent });
	async function mirror(): Promise<SafeEventDiagnostic[]> {
		const text = await readFile(jsonl.filePath, 'utf8').catch(() => '');
		return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [];
	}
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'ai-privacy-persistence-'));
		queue = await openTestWorkerQueue(storage(), []);
		jsonl = new JsonlWriter(join(root, 'debug', 'events.v1.jsonl'));
		confirmed = true; contentConsent = true; consent = true; consentRequests = 0; diagnostics = [];
		recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} },
			async () => { consentRequests++; return consent; });
		writer = new EventPersistence(queue, jsonl, reason => diagnostics.push(reason));
		writer.attachRecording(recording, scopes);
		await recording.start();
	});
	teardown(async () => {
		const session = recording.sessionId; recording.stop(); await writer.completeSession(session); await writer.close();
		recording.dispose(); await queue.close(); await rm(root, { recursive: true, force: true });
	});

	test('stores every accepted collector event through the same sanitized queue and debug path', async () => {
		const inputs: TrackerEvent[] = ['file.created', 'file.modified', 'file.saved', 'file.deleted'].map(eventType => ({ ...file(), eventType } as TrackerEvent));
		inputs.push(diff(), diff('file.baseline'), createChangeEvent({ sessionId: recording.sessionId!, workspaceId, eventType: 'file.gap',
			payload: { relativePath: 'src/app.ts', reason: 'read_error', changeReason: 'external' } }), message('Please update app'),
		message('Updated app', 'ai.response.completed'), ...['ai.tool.started', 'ai.tool.completed', 'ai.tool.failed', 'ai.tool.incomplete'].map(type => tool(type as CodexEventType)));
		for (const eventType of ['activity.relationship.created', 'activity.relationship.updated'] as const) {
			inputs.push(createRelationshipEvent({ sessionId: recording.sessionId!, sourceSessionId, workspaceId, eventType, correlationId: 'call-1',
				payload: { relationshipId: 'b'.repeat(64), sourceEventId: inputs[9].eventId, targetEventId: inputs[4].eventId,
					relationshipType: 'tool_file_change', relativePath: 'src/app.ts', confidence: 'possible', explanationCode: 'timestamp_only',
					revision: eventType.endsWith('updated') ? 2 : 1, evidence: [{ eventId: inputs[9].eventId, kind: 'tool_start', sourceRecord },
						{ eventId: inputs[4].eventId, kind: 'time_window' }],
					...(eventType.endsWith('updated') ? { previousRelationshipEventId: inputs[inputs.length - 1].eventId } : {}) } }));
		}
		const observed: TrackerEvent[] = []; writer.onDidWrite(event => observed.push(event as TrackerEvent));
		for (const input of inputs) { assert.equal(validateEvent(input).valid, true, input.eventType); await writer.write(input); }
		assert.deepEqual(await queue.getPending(100), inputs); assert.deepEqual(await mirror(), inputs.map(eventDiagnostic)); assert.deepEqual(observed, inputs);
		assert.deepEqual(diagnostics, []);
	});

	test('only sanitized prompts, responses, tool inputs and outputs reach either sink or consumers', async () => {
		const inputs = [message('Use ' + dummySecret), message('Authorization: Bearer dummyBearerSecret', 'ai.response.completed'),
			tool('ai.tool.started', '{"password":"dummyPassword","path":"src/app.ts"}'),
			tool('ai.tool.completed', '{"path":"src/app.ts"}', '{"result":{"api_key":"dummyGenericSecret","ok":true}}')];
		const observed: TrackerEvent[] = []; writer.onDidWrite(event => observed.push(event as TrackerEvent));
		for (const input of inputs) { await writer.write(input); }
		const stored = await queue.getPending(100);
		assert.deepEqual(await mirror(), stored.map(eventDiagnostic)); assert.deepEqual(observed, stored);
		for (let index = 0; index < inputs.length; index++) {
			for (const key of ['eventId', 'sessionId', 'sourceSessionId', 'timestamp', 'source', 'correlationId'] as const) {
				assert.equal(stored[index][key], inputs[index][key]);
			}
		}
		const serialized = JSON.stringify(stored);
		assert.ok(serialized.includes('[REDACTED]')); assert.ok(!/DummySecret|dummyBearerSecret|dummyPassword|dummyGenericSecret/.test(serialized));
		assert.ok(JSON.stringify(inputs).includes(dummySecret)); // Caller data stays unchanged.
	});

	test('rejects sensitive file paths and records only fixed rejection health metadata', async () => {
		const input = file('.env'); let observed = 0; writer.onDidWrite(() => observed++);
		await assert.rejects(writer.write(input), EventPersistenceError);
		assert.equal(await queue.getPendingCount(), 0); assert.deepEqual(await mirror(), []); assert.equal(observed, 0);
		const health = await queue.getPrivacyHealth(recording.sessionId!);
		assert.deepEqual(health, { rejectedCount: 1, reasonCounts: { sensitive_file_path: 1 } });
		assert.ok(!JSON.stringify(health).includes(input.eventId)); assert.deepEqual(diagnostics, ['privacy_rejected']);
	});

	test('rejects sensitive structured tool paths and unsupported/malformed payloads without persisting content', async () => {
		const inputs = [tool('ai.tool.completed', '{"path":".env"}'), { ...file(), payload: { relativePath: 'src/app.ts', secret: dummySecret } },
			{ ...file(), eventType: 'unsupported', payload: { text: dummySecret } }, message('-----BEGIN PRIVATE KEY-----\n' + dummySecret)];
		for (const input of inputs) { await assert.rejects(writer.write(input), EventPersistenceError); }
		assert.equal(await queue.getPendingCount(), 0); assert.deepEqual(await mirror(), []);
		const health = await queue.getPrivacyHealth(recording.sessionId!);
		assert.equal(health.rejectedCount, inputs.length); assert.ok(!JSON.stringify(health).includes(dummySecret));
	});

	test('turns redacted diffs and baselines into schema-compatible gaps preserving identity and original hashes', async () => {
		const inputs = [diff('file.diff', 'const value = 1;\n', `const api_key = "${dummySecret}";\n`),
			diff('file.baseline', '', `const password = "dummyPassword";\n`)];
		const observed: TrackerEvent[] = []; writer.onDidWrite(event => observed.push(event as TrackerEvent));
		for (const input of inputs) { await writer.write(input); }
		const stored = await queue.getPending(100); assert.deepEqual(stored, observed); assert.deepEqual(stored.map(eventDiagnostic), await mirror());
		for (let index = 0; index < stored.length; index++) {
			const result = stored[index]; assert.equal(result.eventType, 'file.gap'); assert.equal(result.eventId, inputs[index].eventId);
			assert.equal(result.timestamp, inputs[index].timestamp); assert.equal(result.correlationId, inputs[index].correlationId);
			assert.ok('reason' in result.payload); assert.equal(result.payload.reason, 'privacy_filter');
			assert.equal(result.payload.beforeHash, inputs[index].payload.beforeHash);
			assert.equal(result.payload.afterHash, inputs[index].payload.afterHash); assert.ok(!('diff' in result.payload));
			assert.equal(validateEvent(result).valid, true);
		}
		assert.ok(!JSON.stringify(stored).includes(dummySecret)); assert.ok(diagnostics.every(reason => reason === 'privacy_gap'));
	});

	test('fails closed on filter exceptions, with safe durable health and no original-content fallback', async () => {
		const broken = new EventPersistence(queue, jsonl, reason => diagnostics.push(reason), {
			context: () => ({ recordingActive: true, sessionId: recording.sessionId!, ...scopes() }),
			filter: { filter: () => { throw new Error(dummySecret); } }
		});
		// Attach the queue lifecycle so safe health metadata belongs to the trusted session.
		const other = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true);
		const sub = broken.attachRecording(other, scopes); await other.start();
		try {
			await assert.rejects(broken.write({ ...message(dummySecret), sessionId: other.sessionId! }), error => {
				assert.ok(error instanceof EventPersistenceError); assert.equal(error.cause, undefined); assert.ok(!error.message.includes(dummySecret)); return true;
			});
			assert.deepEqual(await queue.getPrivacyHealth(other.sessionId!), { rejectedCount: 1, reasonCounts: { filter_failed: 1 } });
			assert.equal(await queue.getPendingCount(), 0); assert.deepEqual(await mirror(), []);
		} finally { const session = other.sessionId; other.stop(); await broken.completeSession(session); sub.dispose(); other.dispose(); }
	});

	test('requires trusted approvals; missing providers never bypass the filter', async () => {
		const unconfigured = new EventPersistence(queue, jsonl, reason => diagnostics.push(reason));
		await assert.rejects(unconfigured.write(message(dummySecret)), EventPersistenceError);
		assert.equal(await queue.getPendingCount(), 0); assert.deepEqual(await mirror(), []);
	});

	test('does not evaluate malformed payload getters before filtering', async () => {
		let evaluated = false; const input = file();
		Object.defineProperty(input, 'payload', { enumerable: true, get() { evaluated = true; throw new Error(dummySecret); } });
		await assert.rejects(writer.write(input), EventPersistenceError);
		assert.equal(evaluated, false); assert.equal(await queue.getPendingCount(), 0);
	});

	test('requires workspace approval, confirmation and unchanged separate content consent', async () => {
		await assert.rejects(writer.write({ ...file(), workspaceId: 'unapproved' }));
		await assert.rejects(writer.write({ ...file(), sessionId: randomUUID() }));
		confirmed = false; await assert.rejects(writer.write(message(dummySecret)));
		confirmed = true; contentConsent = false; await assert.rejects(writer.write(tool('ai.tool.completed')));
		assert.equal(await queue.getPendingCount(), 0); assert.equal(recording.isRecording, true); assert.equal(consentRequests, 1);
		contentConsent = true; await writer.write(message('Approved'));
		assert.equal(await queue.getPendingCount(), 1);
	});

	test('preserves Stop-time admission snapshots but seals them after producers finish', async () => {
		const input = message(dummySecret); const session = recording.sessionId!;
		recording.stop(); confirmed = false; contentConsent = false;
		await writer.write(input); await writer.completeSession(session);
		await assert.rejects(writer.write({ ...input, eventId: randomUUID() }));
		assert.equal(await queue.getPendingCount(), 1); assert.ok(!JSON.stringify(await mirror()).includes(dummySecret));
		consent = false; await recording.start(); assert.equal(recording.isRecording, false);
		consent = true; await recording.start(); assert.notEqual(recording.sessionId, session);
		await assert.rejects(writer.write(input)); assert.equal(consentRequests, 3);
	});

	test('bounds large-event filtering and reports processing limits without retaining oversized content', async () => {
		const input = diff('file.diff', '', 'x'.repeat(1024 * 1024 + 1) + '\n');
		const context = (): PrivacyContext => ({ recordingActive: true, sessionId: recording.sessionId!, ...scopes() });
		const bounded = new EventPersistence(queue, jsonl, reason => diagnostics.push(reason), { context, filter: new PrivacyFilter({ maxInputBytes: 1024 }) });
		await assert.rejects(bounded.write(input)); assert.equal(await queue.getPendingCount(), 0); assert.deepEqual(await mirror(), []);
	});

	test('SQLite receives only sanitized snapshots even when its write fails; JSONL never becomes a fallback', async () => {
		let enqueued: unknown; let mirrored = false;
		const failure = new EventPersistence({ enqueue: async input => { enqueued = input; throw new Error(dummySecret); }, close: async () => {} },
			{ write: async () => { mirrored = true; }, flush: async () => {} }, reason => diagnostics.push(reason),
			{ context: () => ({ recordingActive: true, sessionId: recording.sessionId!, ...scopes() }) });
		await assert.rejects(failure.write(message(dummySecret)), EventPersistenceError);
		assert.ok(JSON.stringify(enqueued).includes('[REDACTED]')); assert.ok(!JSON.stringify(enqueued).includes(dummySecret));
		assert.equal(mirrored, false); assert.ok(diagnostics.includes('queue_failed'));
	});

	test('sanitized content commits before debug output, consumer notification or capture success', async () => {
		let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
		const order: string[] = []; let sanitized: unknown;
		const gated = new EventPersistence({ enqueue: async input => {
			sanitized = input; order.push('enqueue'); await gate; await queue.enqueue(input); order.push('commit');
		}, close: async () => {} }, { write: async input => { order.push('jsonl'); await jsonl.write(input); }, flush: () => jsonl.flush() }, undefined,
		{ context: () => ({ recordingActive: true, sessionId: recording.sessionId!, ...scopes() }) });
		gated.onDidWrite(() => order.push('notify'));
		const writing = gated.write(message(dummySecret)).then(() => order.push('success'));
		await setImmediate(); await setImmediate();
		assert.deepEqual(order, ['enqueue']); assert.ok(!JSON.stringify(sanitized).includes(dummySecret));
		assert.deepEqual(await mirror(), []); assert.equal(await queue.getPendingCount(), 0);
		release(); await writing; assert.deepEqual(order, ['enqueue', 'commit', 'jsonl', 'notify', 'success']);
	});

	test('failure to persist rejection health reports queue degradation without storing rejected evidence', async () => {
		const other = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true);
		const failure = new EventPersistence({ enqueue: input => queue.enqueue(input), close: async () => {}, beginSession: id => queue.beginSession(id),
			recordPrivacyRejection: async () => { throw new Error(dummySecret); } }, jsonl,
			reason => { diagnostics.push(reason); if (reason === 'queue_failed') { other.stop(); } });
		const sub = failure.attachRecording(other, scopes); await other.start();
		try {
			await assert.rejects(failure.write({ ...file('.env'), sessionId: other.sessionId! }), EventPersistenceError);
			assert.equal(other.isRecording, false); assert.equal(await queue.getPendingCount(), 0); assert.deepEqual(await mirror(), []);
			assert.ok(diagnostics.includes('privacy_rejected')); assert.ok(diagnostics.includes('queue_failed'));
		} finally { sub.dispose(); other.dispose(); }
	});

	test('a failed debug mirror cannot duplicate sanitized SQLite events', async () => {
		const blocked = join(root, 'blocked'); await writeFile(blocked, 'blocked');
		const failure = new EventPersistence(queue, new JsonlWriter(join(blocked, 'events.v1.jsonl')), reason => diagnostics.push(reason),
			{ context: () => ({ recordingActive: true, sessionId: recording.sessionId!, ...scopes() }) });
		const input = message(dummySecret); await failure.write(input); await failure.write(input);
		assert.equal(await queue.getPendingCount(), 1); assert.ok(!JSON.stringify(await queue.getPending(10)).includes(dummySecret));
		assert.ok(diagnostics.includes('jsonl_failed'));
	});

	test('safe rejection counters and sanitized event identities survive storage-worker restart', async () => {
		const session = recording.sessionId!; const input = message(dummySecret);
		await writer.write(input); await assert.rejects(writer.write(file('.env')));
		recording.stop(); await writer.completeSession(session); await writer.close();
		queue = await openTestWorkerQueue(storage(), []);
		const stored = await queue.getPending(10); assert.equal(stored[0].eventId, input.eventId); assert.equal(stored[0].sessionId, session);
		assert.ok(!JSON.stringify(stored).includes(dummySecret));
		assert.deepEqual(await queue.getPrivacyHealth(session), { rejectedCount: 1, reasonCounts: { sensitive_file_path: 1 } });
		assert.equal(recording.isRecording, false);
	});
});
