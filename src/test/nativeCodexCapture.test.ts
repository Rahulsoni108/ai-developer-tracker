import * as assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RecordingController } from '../recording';
import { NativeCodexCapture } from '../nativeCodexCapture';
import type { TrackerEvent } from '../eventSchema';

suite('Explicit prospective native Codex connection', function () {
	this.timeout(12000);
	let root: string; let workspace: string; let sessions: string; let recording: RecordingController; let capture: NativeCodexCapture;
	let events: TrackerEvent[]; let notices: string[]; let allowed: boolean; let supported: boolean; let grants: number; let dialogs: number;
	const W = 'a'.repeat(64);
	const record = (text: string, type = 'user_message') => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, message: text } }) + '\n';
	async function session(cwd = workspace, body = '') {
		const id = randomUUID(); const path = join(sessions, id + '.jsonl');
		const timestamp = new Date(Date.now() - 86400000).toISOString();
		await writeFile(path, JSON.stringify({ type: 'session_meta', timestamp, payload: { id, cwd, timestamp } }) + '\n' + body);
		return { id, path };
	}
	async function connect(path: string, accepted = true) {
		return capture.connect(path, sessions, [{ workspaceId: W, path: workspace }], async () => { dialogs++; return accepted; });
	}
	async function until(check: () => boolean) {
		const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) { assert.fail('Synthetic native capture timeout'); } await new Promise(resolve => setTimeout(resolve, 20)); }
	}
	setup(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), 'native-codex-'))); workspace = join(root, 'workspace'); sessions = join(root, 'sessions'); await mkdir(workspace); await mkdir(sessions);
		events = []; notices = []; allowed = true; supported = true; grants = 0; dialogs = 0;
		recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => true);
		capture = new NativeCodexCapture(recording, { write: async event => { events.push(event); }, flush: async () => {} }, {
			permits: id => allowed && recording.isRecording && recording.sessionId === id,
			supportsNative: async () => supported,
			enrollNative: async (_identity, confirm) => { if (!await confirm('Synthetic exact-source consent')) { return undefined; } grants++; return new Date().toISOString(); }
		}, notice => notices.push(notice));
		await recording.start();
	});
	teardown(async () => { recording.stop(); await capture.dispose(); recording.dispose(); await rm(root, { recursive: true, force: true }); });
	test('connects an already-open exact session without CLI, history backfill or duplicate consent', async () => {
		const source = await session(workspace, record('OLD PRIVATE history'));
		assert.equal(await connect(source.path), true); assert.equal(grants, 1); assert.equal(dialogs, 1); assert.equal(events.length, 0);
		assert.ok(notices.includes('ready')); assert.equal(capture.getApprovals(recording.sessionId!).length, 1);
		await appendFile(source.path, record('Synthetic NEW prompt')); await until(() => events.length === 1);
		assert.equal(events[0].eventType, 'ai.prompt.submitted'); assert.equal(JSON.stringify(events).includes('OLD PRIVATE'), false);
		assert.equal(await connect(source.path), true); assert.equal(grants, 1); assert.equal(dialogs, 1);
	});
	test('skips the completion of a line that started before approval', async () => {
		const historical = record('PRIVATE earlier partial'); const source = await session(workspace, historical.slice(0, -6));
		assert.equal(await connect(source.path), true); await appendFile(source.path, historical.slice(-6) + record('Synthetic new message'));
		await until(() => events.length === 1); assert.equal(JSON.stringify(events).includes('PRIVATE earlier'), false);
	});
	test('denial, missing capability and wrong workspace never read content or create grants', async () => {
		const source = await session(workspace, record('PRIVATE denied'));
		assert.equal(await connect(source.path, false), false); assert.equal(grants, 0); assert.equal(events.length, 0); assert.ok(notices.includes('declined'));
		supported = false; assert.equal(await connect(source.path), false); assert.equal(dialogs, 1);
		supported = true; const outside = join(root, 'outside'); await mkdir(outside); const other = await session(outside);
		assert.equal(await connect(other.path), false); assert.equal(grants, 0); assert.equal(events.length, 0);
	});
	test('rejects provider files outside the selected root and symlinks without bypassing scope', async () => {
		const source = await session(); const alias = join(sessions, 'alias.jsonl'); await symlink(source.path, alias);
		assert.equal(await connect(alias), false);
		const outside = join(root, 'foreign.jsonl'); await writeFile(outside, record('PRIVATE unrelated'));
		assert.equal(await connect(outside), false); assert.equal(grants, 0); assert.equal(events.length, 0);
	});
	test('malformed session metadata cannot be overridden by candidate confirmation', async () => {
		const path = join(sessions, 'invalid.jsonl'); await writeFile(path, record('PRIVATE malformed'));
		assert.equal(await connect(path), false); assert.equal(dialogs, 0); assert.equal(grants, 0); assert.equal(events.length, 0);
	});
	test('multiple approved sources stay isolated and interruption requires a fresh prospective boundary', async () => {
		const first = await session(); const second = await session(); assert.equal(await connect(first.path), true); assert.equal(await connect(second.path), true);
		assert.equal(capture.getApprovals(recording.sessionId!).length, 2);
		await appendFile(first.path, record('Synthetic first')); await appendFile(second.path, record('Synthetic second')); await until(() => events.length === 2);
		await writeFile(first.path, ''); await until(() => notices.includes('interrupted'));
		assert.equal(capture.getApprovals(recording.sessionId!).length, 1); assert.equal(events.length, 2);
	});
	test('recording stop, withdrawal and another recording cannot restore the old source or count', async () => {
		const source = await session(); assert.equal(await connect(source.path), true);
		allowed = false; await appendFile(source.path, record('PRIVATE revoked')); await new Promise(resolve => setTimeout(resolve, 1200)); assert.equal(events.length, 0);
		recording.stop(); await appendFile(source.path, record('PRIVATE stopped')); await capture.flush();
		allowed = true; await recording.start(); assert.equal(capture.getApprovals(recording.sessionId!).length, 0); assert.equal(events.length, 0);
	});
	test('diagnostics contain fixed states only, never session IDs, paths or conversation text', async () => {
		const source = await session(); assert.equal(await connect(source.path), true); await rm(source.path); await until(() => notices.includes('interrupted'));
		for (const value of [source.id, source.path, workspace, 'PRIVATE']) { assert.equal(JSON.stringify(notices).includes(value), false); }
	});
});
