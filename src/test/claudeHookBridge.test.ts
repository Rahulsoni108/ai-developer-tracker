import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ClaudeCapture } from '../claudeCapture';
import { ClaudeEventParser } from '../claudeEventParser';
import { RecordingController } from '../recording';
import { forwardClaudeHook } from '../claudeHookBridge';
import type { TrackerEvent } from '../eventSchema';

suite('Claude command hook bridge and configuration isolation', () => {
	let root: string; let workspace: string; let recording: RecordingController; let parser: ClaudeEventParser;
	let capture: ClaudeCapture; let events: TrackerEvent[];
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'ai-claude-ipc-')); workspace = join(root, 'workspace'); await mkdir(workspace);
		events = []; recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => true);
		parser = new ClaudeEventParser(recording, { write: async event => { events.push(event); }, flush: async () => {} });
		capture = new ClaudeCapture(recording, parser, { storageDirectory: join(root, 'runtime'), bridgePath: require.resolve('../claudeHookBridge'),
			nodeExecutable: process.execPath, assertOutsideWorkspaces: async path => { assert.equal(path.startsWith(workspace), false); } });
		await recording.start();
	});
	teardown(async () => { await capture.dispose(); recording.stop(); await parser.finishRecording(); parser.dispose(); recording.dispose(); await rm(root, { recursive: true, force: true }); });

	test('creates an additive private plugin and captures through real command stdin and authenticated IPC without touching user hooks', async () => {
		const existing = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-hook"}]}]},"permissions":{"deny":["Read(.env)"]}}';
		await mkdir(join(workspace, '.claude')); await writeFile(join(workspace, '.claude', 'settings.json'), existing);
		const launch = await capture.create(workspace, 'workspace');
		const configPath = join(launch.pluginDirectory, 'runtime.json');
		const pluginHooks = JSON.parse(await readFile(join(launch.pluginDirectory, 'hooks', 'hooks.json'), 'utf8')).hooks;
		assert.deepEqual(Object.keys(pluginHooks), ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'MessageDisplay', 'Stop']);
		assert.equal(pluginHooks.PreToolUse[0].hooks[0].command, process.execPath);
		assert.deepEqual(pluginHooks.PreToolUse[0].hooks[0].args, [require.resolve('../claudeHookBridge'), configPath]);
		if (process.platform !== 'win32') { assert.equal((await stat(configPath)).mode & 0o777, 0o600); }
		const payload = { session_id: launch.sourceSessionId, cwd: workspace, hook_event_name: 'UserPromptSubmit', prompt: 'dummy approved prompt' };
		const child = spawn(process.execPath, [require.resolve('../claudeHookBridge'), configPath], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = ''; let stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
		child.stdin.end(JSON.stringify(payload)); const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
		assert.equal(code, 0); assert.equal(stdout, ''); assert.equal(stderr, '');
		assert.equal(events.length, 1); assert.equal(events[0].eventType, 'ai.prompt.submitted');
		assert.equal(await readFile(join(workspace, '.claude', 'settings.json'), 'utf8'), existing);
		assert.equal(JSON.stringify(pluginHooks).includes('dummy approved prompt'), false);
	});

	test('revocation removes runtime capabilities and refuses even to read new stdin', async () => {
		const launch = await capture.create(workspace, 'workspace'); const configPath = join(launch.pluginDirectory, 'runtime.json');
		await capture.revoke(); let read = false;
		const input = new Readable({ read() { read = true; this.push('private content'); this.push(null); } });
		await forwardClaudeHook(configPath, input); assert.equal(read, false); assert.equal(events.length, 0);
		assert.deepEqual(await readdir(join(root, 'runtime')), []);
	});

	test('wrong sessions and failed authentication cannot enter the parser', async () => {
		const launch = await capture.create(workspace, 'workspace'); const path = join(launch.pluginDirectory, 'runtime.json');
		await forwardClaudeHook(path, Readable.from([JSON.stringify({ session_id: 'unrelated', cwd: workspace, hook_event_name: 'UserPromptSubmit', prompt: 'private' })]));
		const config = JSON.parse(await readFile(path, 'utf8')); config.token = '0'.repeat(64);
		const wrong = join(root, 'wrong.json'); await writeFile(wrong, JSON.stringify(config), { mode: 0o600 }); let read = false;
		await forwardClaudeHook(wrong, new Readable({ read() { read = true; this.push(null); } }));
		assert.equal(read, false); assert.equal(events.length, 0);
	});

	test('stopped recordings cannot create new capture capabilities and expire existing ones', async () => {
		await capture.create(workspace, 'workspace'); recording.stop(); await capture.revoke();
		await assert.rejects(capture.create(workspace, 'workspace'), /unavailable/); assert.deepEqual(await readdir(join(root, 'runtime')), []);
	});
});
