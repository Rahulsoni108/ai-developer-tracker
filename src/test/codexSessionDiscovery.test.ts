import * as assert from 'assert';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RecordingController } from '../recording';
import { CodexSessionDiscovery, codexSessionsDirectory, type DiscoveryOptions, type DiscoveryDiagnostic } from '../codexSessionDiscovery';

suite('Codex session discovery', () => {
	let temporary: string;
	let root: string;
	let workspace: string;
	let startMs: number;
	let clockMs: number;
	let recording: RecordingController;
	let discovery: CodexSessionDiscovery;
	let diagnostics: DiscoveryDiagnostic[];
	let created: (file: string) => void;
	let changed: (file: string) => void;
	let watcherDisposed: boolean;
	const workspaceId = 'approved-workspace-id';

	function configure(options: DiscoveryOptions = {}): void {
		discovery?.dispose();
		discovery = new CodexSessionDiscovery(recording, () => [{ path: workspace, workspaceId }], {
			sessionsDirectory: root, pollIntervalMs: 0, now: () => new Date(clockMs),
			onDiagnostic: issue => diagnostics.push(issue),
			watch: (_root, onCreate, onChange) => {
				created = onCreate; changed = onChange; watcherDisposed = false;
				return { dispose: () => { watcherDisposed = true; } };
			}, ...options
		});
	}
	function meta(values: Record<string, unknown> = {}): Record<string, unknown> {
		return { id: randomUUID(), cwd: workspace, timestamp: new Date(startMs + 100).toISOString(), cli_version: '0.162.1', ...values };
	}
	async function session(values = meta(), name = 'candidate-' + randomUUID() + '.jsonl', dayOffset = 0): Promise<string> {
		const day = new Date(startMs + dayOffset * 86400000).toISOString().slice(0, 10).replace(/-/g, '/');
		const path = join(root, day, name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify({ timestamp: values.timestamp, type: 'session_meta', payload: values })
			+ '\n' + JSON.stringify({ type: 'response_item', payload: { text: 'private conversation must never be collected' } }) + '\n');
		return path;
	}
	async function start(): Promise<void> { await recording.start(); await discovery.flush(); }

	setup(async () => {
		temporary = await realpath(await mkdtemp(join(tmpdir(), 'codex-discovery-test-')));
		root = join(temporary, 'sessions'); workspace = join(temporary, 'approved');
		await mkdir(root); await mkdir(workspace);
		startMs = Date.now() - 1000; clockMs = startMs + 10000;
		diagnostics = []; watcherDisposed = false;
		created = () => {}; changed = () => {};
		recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true, () => new Date(startMs));
		configure();
	});
	teardown(async () => {
		recording.stop(); discovery.dispose(); await discovery.flush(); recording.dispose();
		await rm(temporary, { recursive: true, force: true });
	});

	test('computes default and configured paths without opening any real session directory', () => {
		assert.strictEqual(codexSessionsDirectory(), join(homedir(), '.codex', 'sessions'));
		assert.strictEqual(codexSessionsDirectory(root), root);
		assert.strictEqual(codexSessionsDirectory('~/.codex/sessions'), join(homedir(), '.codex', 'sessions'));
		assert.throws(() => codexSessionsDirectory('relative/path'));
	});

	test('discovers ordinal metadata, requires confirmation, and returns only safe reason counts', async () => {
		const values = meta(); const file = await session(values);
		await writeFile(file, JSON.stringify({ timestamp: values.timestamp, ordinal: 0, type: 'session_meta', payload: values }) + '\n');
		await start(); const before = discovery.getDiagnostics();
		assert.equal(before.directoryStatus, 'ready'); assert.equal(before.candidateCount, 1); assert.equal(before.confirmedCount, 0);
		assert.equal(before.approvedWorkspaceCount, 1); assert.equal(before.reasons.recent_workspace_match, 1);
		const candidate = discovery.getConfirmationCandidates()[0]; assert.ok(await discovery.confirm(candidate.sourceFileId));
		const after = discovery.getDiagnostics(); assert.equal(after.candidateCount, 0); assert.equal(after.confirmedCount, 1); assert.equal(after.reasons.user_confirmed, 1);
		for (const forbidden of [root, workspace, String(values.id), candidate.sourceFileId, 'cwd', 'sourceSessionId', 'private conversation']) {
			assert.equal(JSON.stringify(after).includes(forbidden), false);
		}
		recording.stop(); assert.equal(discovery.getDiagnostics().recordingActive, false); assert.equal(discovery.getDiagnostics().confirmedCount, 0);
	});
	test('reports historical, out-of-workspace and unsupported metadata separately without exposing them', async () => {
		await session(meta({ timestamp: new Date(startMs - 100).toISOString() }));
		await session(meta({ cwd: temporary })); const file = await session(); await writeFile(file, '{"type":"response_item","payload":{"text":"dummy-private"}}\n');
		await start(); const summary = discovery.getDiagnostics();
		assert.equal(summary.reasons.historical, 1); assert.equal(summary.reasons.outside_workspace, 1); assert.equal(summary.reasons.missing_metadata, 1);
		assert.equal(summary.candidateCount, 0); assert.equal(JSON.stringify(summary).includes(temporary), false);
	});
	test('reports missing roots and CODEX_HOME mismatch without searching or printing the alternate home', async () => {
		const previous = process.env.CODEX_HOME;
		try {
			process.env.CODEX_HOME = join(temporary, 'dummy-other-home'); configure({ sessionsDirectory: join(temporary, 'missing') });
			await start(); const summary = discovery.getDiagnostics(); assert.equal(summary.directoryStatus, 'missing'); assert.equal(summary.codexHome, 'differs');
			assert.equal(summary.directorySource, 'user_setting'); assert.equal(JSON.stringify(summary).includes(temporary), false);
			process.env.CODEX_HOME = temporary; assert.equal(discovery.getDiagnostics().codexHome, 'differs');
		} finally { if (previous === undefined) { delete process.env.CODEX_HOME; } else { process.env.CODEX_HOME = previous; } }
	});
	test('discovers valid metadata as eligible, and confirms only on an explicit call', async () => {
		const metadata = meta(); await session(metadata); await start();
		const entry = discovery.getRegistry()[0];
		assert.strictEqual(entry.status, 'eligible');
		assert.strictEqual(entry.recordingSessionId, recording.sessionId);
		assert.strictEqual(entry.sourceSessionId, metadata.id);
		assert.strictEqual(entry.workspaceId, workspaceId);
		assert.strictEqual(entry.workspaceRelativeCwd, '.');
		assert.strictEqual(entry.codexVersion, '0.162.1');
		assert.match(entry.sourceFileReference, /^codex-file:[a-f0-9]{64}$/);
		assert.strictEqual(await discovery.confirm(entry.sourceFileId), true);
		assert.strictEqual(discovery.getRegistry()[0].status, 'confirmed');
	});

	test('matches nested cwd but rejects outside and sibling-prefix workspaces', async () => {
		const nested = join(workspace, 'src'); await mkdir(nested);
		await session(meta({ cwd: nested }));
		await session(meta({ cwd: workspace + '-other' }));
		await session(meta({ cwd: join(temporary, 'private') }));
		await start();
		assert.strictEqual(discovery.getRegistry().filter(entry => entry.status === 'eligible').length, 1);
		assert.strictEqual(discovery.getRegistry().filter(entry => entry.reason === 'outside_workspace').length, 2);
		assert.strictEqual(discovery.getConfirmationCandidates()[0].workspaceRelativeCwd, 'src');
		assert.ok(discovery.getRegistry().filter(entry => entry.reason === 'outside_workspace').every(entry => entry.sourceSessionId === undefined));
	});

	test('marks multiple matches ambiguous and requires explicit selection', async () => {
		await session(); await session(); await start();
		const entries = discovery.getRegistry();
		assert.strictEqual(entries.length, 2);
		assert.ok(entries.every(entry => entry.status === 'ambiguous' && entry.reason === 'multiple_matches'));
		assert.strictEqual(await discovery.confirm(entries[0].sourceFileId), true);
		discovery.reject(entries[1].sourceFileId);
		assert.deepStrictEqual(discovery.getRegistry().map(entry => entry.status).sort(), ['confirmed', 'rejected']);
	});

	test('rejects old metadata copied into a new file with a matching cwd', async () => {
		await session(meta({ timestamp: new Date(startMs - 60000).toISOString() })); await start();
		assert.strictEqual(discovery.getRegistry()[0].reason, 'historical');
		assert.deepStrictEqual(discovery.getConfirmationCandidates(), []);
		assert.strictEqual(await discovery.confirm(discovery.getRegistry()[0].sourceFileId), false);
	});

	test('does not open files predating recording even when metadata claims a recent timestamp', async () => {
		await session(meta({ timestamp: new Date(Date.now() + 5000).toISOString() }));
		startMs = Date.now() + 100; clockMs = startMs + 10000;
		await start();
		assert.strictEqual(discovery.getRegistry()[0].reason, 'historical');
		assert.strictEqual(discovery.getRegistry()[0].createdAt, undefined);
	});

	test('does not traverse unrelated historical date folders', async () => {
		await session(meta({ timestamp: new Date(startMs - 60 * 86400000).toISOString() }), 'old.jsonl', -60);
		await start(); assert.deepStrictEqual(discovery.getRegistry(), []);
	});

	test('handles a missing directory and discovers it when it appears during recording', async () => {
		await rm(root, { recursive: true }); await start();
		assert.deepStrictEqual(discovery.getRegistry(), []);
		assert.ok(diagnostics.includes('missing_directory'));
		assert.strictEqual(recording.isRecording, true);
		await session(); await discovery.scanNow();
		assert.strictEqual(discovery.getRegistry()[0].status, 'eligible');
	});

	test('treats invalid, missing and incomplete metadata as unverified and unconfirmable', async () => {
		await session(meta({ id: 'invalid-id' }));
		const missing = await session(); await writeFile(missing, '{"type":"response_item","payload":{"text":"private"}}\n');
		const partial = await session(); await writeFile(partial, '{"type":"session_meta","payload":');
		await start();
		assert.ok(discovery.getRegistry().every(entry => entry.status === 'ambiguous'));
		assert.deepStrictEqual(discovery.getConfirmationCandidates(), []);
		assert.deepStrictEqual(discovery.getRegistry().map(entry => entry.reason).sort(), ['incomplete_metadata', 'invalid_metadata', 'missing_metadata']);
	});

	test('retries a partial header without reading subsequent conversation records', async () => {
		const path = await session(); await writeFile(path, ''); await start();
		assert.strictEqual(discovery.getRegistry()[0].reason, 'incomplete_metadata');
		const metadata = meta();
		await writeFile(path, JSON.stringify({ type: 'session_meta', payload: metadata }) + '\nprivate trailing content\n');
		changed(path); await discovery.flush();
		assert.strictEqual(discovery.getRegistry().length, 1);
		assert.strictEqual(discovery.getRegistry()[0].status, 'eligible');
		assert.strictEqual(discovery.getRegistry()[0].sourceSessionId, metadata.id);
	});

	test('handles new sessions through watcher callbacks and bounded polling', async () => {
		await start();
		const first = await session(); created(first); await discovery.flush();
		assert.strictEqual(discovery.getRegistry().length, 1);
		await session(); await discovery.scanNow(); assert.strictEqual(discovery.getRegistry().length, 2);
	});

	test('avoids duplicate notifications and duplicate source session registrations', async () => {
		const metadata = meta(); const path = await session(metadata); await start();
		created(path); created(path); changed(path); await discovery.scanNow();
		assert.strictEqual(discovery.getRegistry().length, 1);
		const duplicate = await session(metadata); created(duplicate); await discovery.flush();
		assert.strictEqual(discovery.getRegistry().length, 1);
		assert.strictEqual(discovery.getRegistry()[0].reason, 'duplicate_source_id');
		assert.deepStrictEqual(discovery.getConfirmationCandidates(), []);
	});

	test('does not discover or confirm sessions after recording stops', async () => {
		await session(); await start(); const original = discovery.getRegistry(); recording.stop();
		const path = await session(); created(path); changed(path); await discovery.scanNow();
		assert.deepStrictEqual(discovery.getRegistry(), original);
		assert.strictEqual(watcherDisposed, true);
		assert.strictEqual(await discovery.confirm(original[0].sourceFileId), false);
	});

	test('starts with an empty registry after restart and never resumes prior confirmation', async () => {
		await session(); await start(); await discovery.confirm(discovery.getRegistry()[0].sourceFileId);
		recording.stop(); discovery.dispose(); await discovery.flush(); configure();
		assert.deepStrictEqual(discovery.getRegistry(), []);
		assert.deepStrictEqual(discovery.getConfirmationCandidates(), []);
	});

	test('resets associations on a new recording and rejects prior-session files', async () => {
		await session(); await start(); const firstSessionId = recording.sessionId;
		recording.stop(); await discovery.flush(); startMs = Date.now() + 50; clockMs = startMs + 10000;
		await start();
		assert.notStrictEqual(recording.sessionId, firstSessionId);
		assert.ok(discovery.getRegistry().every(entry => entry.recordingSessionId === recording.sessionId && entry.status === 'rejected'));
	});

	test('revalidates metadata before confirmation and rejects changed identity or cwd', async () => {
		const path = await session(); await start(); const entry = discovery.getRegistry()[0];
		await writeFile(path, JSON.stringify({ type: 'session_meta', payload: meta({ cwd: join(temporary, 'private') }) }) + '\n');
		assert.strictEqual(await discovery.confirm(entry.sourceFileId), false);
		assert.strictEqual(discovery.getRegistry()[0].reason, 'metadata_changed');
	});

	test('rejects conflicting rollout filename IDs and future timestamps', async () => {
		await session(meta(), 'rollout-2026-10-13T01-00-00-' + randomUUID() + '.jsonl');
		await session(meta({ timestamp: new Date(clockMs + 10000).toISOString() })); await start();
		assert.deepStrictEqual(discovery.getRegistry().map(entry => entry.reason).sort(), ['filename_mismatch', 'future_timestamp']);
	});

	test('supports adjacent date folders used by local-time writers', async () => {
		await session(meta(), 'adjacent.jsonl', 1); await start();
		assert.strictEqual(discovery.getRegistry()[0].status, 'eligible');
	});

	test('ignores out-of-root callbacks, file links, directory links and cwd links', async function () {
		if (process.platform === 'win32') { this.skip(); }
		const privateDirectory = join(temporary, 'private'); await mkdir(privateDirectory);
		const outside = join(privateDirectory, 'outside.jsonl');
		await writeFile(outside, '{"type":"session_meta","payload":{"secret":"private"}}\n');
		await symlink(outside, join(root, 'linked.jsonl')); await link(outside, join(root, 'hard-linked.jsonl'));
		await symlink(privateDirectory, join(root, 'linked-directory'), 'dir');
		const cwdLink = join(workspace, 'private-link'); await symlink(privateDirectory, cwdLink, 'dir');
		await session(meta({ cwd: cwdLink })); await start(); created(outside); changed(outside); await discovery.flush();
		assert.strictEqual(discovery.getRegistry().length, 1);
		assert.strictEqual(discovery.getRegistry()[0].reason, 'working_directory_unverified');
	});

	test('rejects a symlinked sessions root without looking into it', async function () {
		if (process.platform === 'win32') { this.skip(); }
		const alias = join(temporary, 'alias'); await symlink(root, alias, 'dir'); configure({ sessionsDirectory: alias });
		await session(); await start(); assert.deepStrictEqual(discovery.getRegistry(), []);
		assert.ok(diagnostics.includes('unsafe_directory'));
	});

	test('bounds metadata and scans, and resumes directory cursors on later polls', async () => {
		configure({ maxEntriesPerScan: 1, maxMetadataBytes: 1024 });
		await session(meta({ base_instructions: { text: 'private'.repeat(1000) } }));
		await session(); await start();
		for (let i = 0; i < 10; i++) { await discovery.scanNow(); }
		assert.strictEqual(discovery.getRegistry().length, 2);
		assert.ok(discovery.getRegistry().some(entry => entry.reason === 'oversized_metadata'));
		assert.ok(discovery.getRegistry().some(entry => entry.status === 'eligible'));
		assert.ok(diagnostics.includes('scan_limit'));
	});

	test('sanitizes registry fields and diagnostics, and returns defensive copies', async () => {
		await session(meta({ account_id: 'private-account@example.test', base_instructions: { text: 'private source code' }, originator: 'private-user' }));
		await start(); const entries = discovery.getRegistry(); entries[0].status = 'confirmed';
		assert.strictEqual(discovery.getRegistry()[0].status, 'eligible');
		const serialized = JSON.stringify(discovery.getRegistry());
		assert.ok(!serialized.includes(temporary));
		assert.ok(!serialized.includes('private-account') && !serialized.includes('private source code') && !serialized.includes('private-user'));
		assert.ok(!JSON.stringify(diagnostics).includes(temporary));
	});
});
