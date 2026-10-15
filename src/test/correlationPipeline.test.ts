import { MemoryEventJournal } from './memoryEventJournal';
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { ActivityCorrelator } from '../activityCorrelator';
import { CodexEventParser } from '../codexEventParser';
import { JsonlWriter } from '../jsonlWriter';
import { RecordingController } from '../recording';
import { createChangeEvent, createFileEvent, validateEvent, type TrackerEvent, type CodexToolPayload } from '../eventSchema';
import { contentHash } from '../toolFileEvidence';

suite('Local correlation pipeline', () => {
	let recording: RecordingController;
	let writer: MemoryEventJournal;
	let correlator: ActivityCorrelator;
	let parser: CodexEventParser;
	let observer: { dispose(): void };
	let directory: string;
	let index: number;
	const base = Date.parse('2026-10-13T10:00:00.000Z');
	const sourceSessionId = randomUUID();
	const workspaceId = 'approved';
	const sourceFileId = 'a'.repeat(64);
	const sourceFileReference = 'codex-file:' + sourceFileId;
	const before = 'const value = 1;\n';
	const after = 'const value = 2;\n';
	const changes = { 'src/app.ts': { type: 'update', unified_diff: createTwoFilesPatch('src/app.ts', 'src/app.ts', before, after) } };
	const context = (milliseconds: number) => ({ sessionId: recording.sessionId!, sourceSessionId, workspaceId, sourceFileId, sourceFileReference,
		generation: 0, recordIndex: ++index, byteOffset: index * 200, byteLength: 200, timestamp: new Date(base + milliseconds).toISOString() });
	async function logged(): Promise<TrackerEvent[]> {
		return [...writer.captured];
	}
	setup(async () => {
		directory = await mkdtemp(join(tmpdir(), 'correlation-pipeline-')); index = 0;
		recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true, () => new Date(base));
		writer = new MemoryEventJournal(join(directory, 'events.v1.jsonl'));
		correlator = new ActivityCorrelator(recording, writer, { approvedWorkspaces: () => [workspaceId], now: () => new Date(base + 10000) });
		observer = writer.onDidWrite(event => correlator.observe(event));
		parser = new CodexEventParser(recording, {
			getRegistry: () => [{ recordingSessionId: recording.sessionId!, sourceSessionId, workspaceId, sourceFileId, sourceFileReference,
				status: 'confirmed', reason: 'user_confirmed', workspaceRelativeCwd: '.' }],
			isConfirmed: (file, session, source) => recording.isRecording && file === sourceFileId && session === recording.sessionId && source === sourceSessionId
		}, writer, { now: () => new Date(base + 10000), isExcludedPath: path => path.includes('.env') });
		await recording.start(); parser.grantContentConsent(recording.sessionId!);
	});
	teardown(async () => {
		const session = recording.sessionId;
		recording.stop(); await parser.flush(); await correlator.finishSession(session);
		observer.dispose(); parser.dispose(); correlator.dispose(); recording.dispose();
		await rm(directory, { recursive: true, force: true });
	});
	test('connects consented structured patch activity to persisted diffs with no recursive relationships', async () => {
		await parser.handle({ type: 'event_msg', payload: { type: 'patch_apply_begin', call_id: 'patch', changes } }, context(1000));
		const change = createChangeEvent({ sessionId: recording.sessionId!, workspaceId, eventType: 'file.diff', timestamp: new Date(base + 2000),
			payload: { relativePath: 'src/app.ts', diff: createTwoFilesPatch('before', 'after', before, after),
				beforeHash: contentHash(before), afterHash: contentHash(after), changeReason: 'external' } });
		await writer.write(change);
		await parser.handle({ type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'patch', success: true, status: 'completed',
			stdout: 'Applied', stderr: '', changes } }, context(3000));
		await correlator.flush();
		const events = await logged();
		assert.ok(events.every(event => validateEvent(event).valid));
		const relationships = events.filter(event => event.eventType.startsWith('activity.relationship.'));
		const latest = relationships.at(-1)!;
		assert.equal((latest.payload as { confidence: string }).confidence, 'confirmed');
		assert.equal((latest.payload as { targetEventId: string }).targetEventId, change.eventId);
		assert.equal(change.attribution, 'unknown');
		assert.ok(!JSON.stringify(relationships).includes('const value'));
		const end = events.find(event => event.eventType === 'ai.tool.completed')!;
		assert.equal((end.payload as CodexToolPayload).fileEvidence?.[0].kind, 'applied');
		const count = events.length; await correlator.flush(); assert.equal((await logged()).length, count);
		if (process.platform !== 'win32') { assert.equal((await stat(writer.filePath)).mode & 0o777, 0o600); }
	});
	test('does not create AI relationships without the existing content-consent gate', async () => {
		parser.dispose(); await parser.flush();
		parser = new CodexEventParser(recording, {
			getRegistry: () => [], isConfirmed: () => false
		}, writer);
		await parser.handle({ type: 'event_msg', payload: { type: 'patch_apply_begin', call_id: 'private', changes } }, context(1000));
		await writer.write(createChangeEvent({ sessionId: recording.sessionId!, workspaceId, eventType: 'file.diff', timestamp: new Date(base + 2000),
			payload: { relativePath: 'src/app.ts', diff: createTwoFilesPatch('before', 'after', before, after),
				beforeHash: contentHash(before), afterHash: contentHash(after), changeReason: 'external' } }));
		await correlator.flush();
		assert.equal((await logged()).length, 1);
	});
	test('retains structured path evidence when a canonical tool call precedes legacy patch metadata', async () => {
		await parser.handle({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch',
			input: 'unstructured patch text' } }, context(1000));
		await parser.handle({ type: 'event_msg', payload: { type: 'patch_apply_begin', call_id: 'patch', changes } }, context(1500));
		await writer.write(createChangeEvent({ sessionId: recording.sessionId!, workspaceId, eventType: 'file.diff', timestamp: new Date(base + 2000),
			payload: { relativePath: 'src/app.ts', diff: createTwoFilesPatch('before', 'after', before, after),
				beforeHash: contentHash(before), afterHash: contentHash(after), changeReason: 'external' } }));
		await parser.handle({ type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'patch', success: true, changes } }, context(3000));
		await correlator.flush();
		const events = await logged();
		assert.ok(events.some(event => event.eventType === 'ai.tool.started' && (event.payload as CodexToolPayload).statusUpdate));
		assert.equal((events.filter(event => event.eventType.startsWith('activity.relationship.')).at(-1)!.payload as { confidence: string }).confidence, 'confirmed');
	});
	test('writer observers see persisted snapshots, isolate failures, and dispose cleanly', async () => {
		const seen: TrackerEvent[] = [];
		const bad = writer.onDidWrite(() => { throw new Error('PRIVATE_OBSERVER_DATA'); });
		const good = writer.onDidWrite(event => seen.push(event as TrackerEvent));
		const event = createFileEvent({ sessionId: recording.sessionId!, workspaceId, source: 'vscode', eventType: 'file.saved', payload: { relativePath: 'src/app.ts' } });
		const writing = writer.write(event);
		event.payload.relativePath = 'mutated.ts';
		await writing;
		assert.equal((seen[0].payload as { relativePath: string }).relativePath, 'src/app.ts');
		good.dispose(); bad.dispose();
		await writer.write(event);
		assert.equal(seen.length, 1);
		await assert.rejects(writer.write({ invalid: 'PRIVATE_BAD_EVENT' }));
		assert.equal(seen.length, 1);
	});
	test('does not notify observers when the primary append fails', async () => {
		const blocked = join(directory, 'not-a-directory'); await writeFile(blocked, 'blocked');
		const failing = new JsonlWriter(join(blocked, 'events.jsonl')); let notified = false;
		failing.onDidWrite(() => { notified = true; });
		await assert.rejects(failing.write(createFileEvent({ sessionId: recording.sessionId!, workspaceId, source: 'vscode',
			eventType: 'file.saved', payload: { relativePath: 'src/app.ts' } })));
		assert.equal(notified, false);
	});
});
