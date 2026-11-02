import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RecordingController } from '../recording';
import { AssessmentNativeDiscovery, type AssessmentNativeDiscoveryConnector, type NativeSessionPickItem, formatUtcTime } from '../assessmentNativeDiscovery';
import type { CodexSessionRegistration } from '../codexSessionDiscovery';

// Minimal stub for RecordingController status bar
const stubStatusBar = () => ({ text: '', command: '', tooltip: '', show() {}, dispose() {} });

/** Build a minimal synthetic CodexSessionRegistration for testing */
function makeCandidate(overrides: Partial<CodexSessionRegistration> = {}): CodexSessionRegistration {
	const id = randomUUID();
	return {
		recordingSessionId: 'rec-' + id,
		sourceFileId: 'file-' + id,
		sourceFileReference: 'codex-file:' + id,
		sourceSessionId: id,
		workspaceId: 'ws-' + id,
		createdAt: new Date(Date.now() - 5000).toISOString(),
		status: 'eligible',
		reason: 'recent_workspace_match',
		...overrides
	};
}

/** Build a mock connector that records calls and resolves successfully by default */
function makeConnector(connected = true, resolvePathFn?: (id: string) => string | undefined, supportsNative = true): AssessmentNativeDiscoveryConnector & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		connect: async (filePath) => { calls.push(filePath); return connected; },
		sessionsDirectory: () => '/tmp/sessions',
		workspaces: () => [{ workspaceId: 'ws-1', path: '/tmp/ws' }],
		resolvePath: resolvePathFn,
		supportsNative: async () => supportsNative
	};
}

/** Waits for a condition with a timeout */
async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > end) { throw new Error('Timeout waiting for condition'); }
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

suite('AssessmentNativeDiscovery', function () {
	this.timeout(8000);

	let recording: RecordingController;
	let connector: ReturnType<typeof makeConnector>;
	let notifyResponses: (string | undefined)[];
	let pickerResponse: NativeSessionPickItem | undefined;
	let notifyCalls: { message: string; actions: string[] }[];
	let pickerCalls: NativeSessionPickItem[][];

	function makeDiscovery(customConnector?: typeof connector) {
		return new AssessmentNativeDiscovery(recording, customConnector ?? connector, {
			notification: async (message, ...actions) => {
				notifyCalls.push({ message, actions });
				return notifyResponses.shift();
			},
			picker: async (items) => {
				pickerCalls.push([...items]);
				return pickerResponse;
			}
		});
	}

	setup(async () => {
		recording = new RecordingController(stubStatusBar(), async () => true);
		connector = makeConnector();
		notifyResponses = [];
		pickerResponse = undefined;
		notifyCalls = [];
		pickerCalls = [];
		await recording.start();
	});

	teardown(() => {
		recording.dispose();
	});

	// --- Test 1: no-op when not recording ---
	test('notify does nothing when not recording', async () => {
		recording.stop();
		const discovery = makeDiscovery();
		const candidate = makeCandidate({ recordingSessionId: recording.sessionId ?? 'none' });
		notifyResponses.push('Connect & Allow');
		discovery.notify([candidate]);
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(notifyCalls.length, 0);
		discovery.dispose();
	});

	// --- Test 2: no-op when no candidates ---
	test('notify does nothing with empty candidates', async () => {
		const discovery = makeDiscovery();
		notifyResponses.push('Connect & Allow');
		discovery.notify([]);
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(notifyCalls.length, 0);
		discovery.dispose();
	});

	// --- Test 3: single candidate shows notification ---
	test('single candidate shows information notification with three actions', async () => {
		const candidate = makeCandidate({ recordingSessionId: recording.sessionId! });
		notifyResponses.push(undefined); // user dismissed
		const discovery = makeDiscovery();
		discovery.notify([candidate]);
		await until(() => notifyCalls.length >= 1);
		assert.equal(notifyCalls.length, 1);
		assert.ok(notifyCalls[0].message.includes('Codex session detected'));
		assert.ok(notifyCalls[0].actions.includes('Connect & Allow'));
		assert.ok(notifyCalls[0].actions.includes('Not Now'));
		assert.ok(notifyCalls[0].actions.includes("Don't Ask Again For This Assessment"));
		discovery.dispose();
	});

	// --- Test 4: "Connect & Allow" calls connector.connect ---
	test('"Connect & Allow" calls connector.connect with the resolved path', async () => {
		const candidate = makeCandidate({ recordingSessionId: recording.sessionId! });
		notifyResponses.push('Connect & Allow');
		const discovery = makeDiscovery();
		discovery.notify([candidate]);
		await until(() => connector.calls.length >= 1, 4000);
		assert.equal(connector.calls.length, 1);
		assert.ok(typeof connector.calls[0] === 'string' && connector.calls[0].length > 0);
		discovery.dispose();
	});

	// --- Test 5: "Not Now" adds to declined and doesn't call connect ---
	test('"Not Now" adds candidate to declined list and skips connect', async () => {
		const candidate = makeCandidate({ recordingSessionId: recording.sessionId! });
		notifyResponses.push('Not Now');
		const discovery = makeDiscovery();
		discovery.notify([candidate]);
		await until(() => notifyCalls.length >= 1);
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.equal(connector.calls.length, 0);
		// Second notify with same candidate should be suppressed
		notifyResponses.push('Connect & Allow');
		discovery.notify([candidate]);
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.equal(notifyCalls.length, 1); // no new dialog
		discovery.dispose();
	});

	// --- Test 6: "Don't Ask Again" quiets the recording ---
	test('"Don\'t Ask Again For This Assessment" quiets discovery for this recording', async () => {
		const candidate = makeCandidate({ recordingSessionId: recording.sessionId! });
		notifyResponses.push("Don't Ask Again For This Assessment");
		const discovery = makeDiscovery();
		discovery.notify([candidate]);
		await until(() => notifyCalls.length >= 1);
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.equal(discovery.isQuieted(recording.sessionId!), true);
		// A new candidate should be silently ignored
		const candidate2 = makeCandidate({ recordingSessionId: recording.sessionId! });
		notifyResponses.push('Connect & Allow');
		discovery.notify([candidate2]);
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.equal(notifyCalls.length, 1);
		discovery.dispose();
	});

	// --- Test 7: multiple candidates shows QuickPick ---
	test('multiple candidates shows QuickPick instead of notification', async () => {
		const candidates = [
			makeCandidate({ recordingSessionId: recording.sessionId! }),
			makeCandidate({ recordingSessionId: recording.sessionId! })
		];
		pickerResponse = undefined; // user cancelled
		const discovery = makeDiscovery();
		discovery.notify(candidates);
		await until(() => pickerCalls.length >= 1);
		assert.equal(pickerCalls.length, 1);
		assert.equal(notifyCalls.length, 0);
		assert.ok(pickerCalls[0].length >= 2);
		discovery.dispose();
	});

	// --- Test 8: QuickPick pick result calls connect ---
	test('QuickPick selection calls connector.connect', async () => {
		const candidates = [
			makeCandidate({ recordingSessionId: recording.sessionId! }),
			makeCandidate({ recordingSessionId: recording.sessionId! })
		];
		const discovery = makeDiscovery();
		pickerResponse = {
			label: 'Codex session …1234',
			description: 'Started now',
			detail: 'Workspace: test',
			sourceFileId: candidates[0].sourceFileId,
			resolvedPath: '/tmp/sessions/picked-exact.jsonl'
		};
		discovery.notify(candidates);
		await until(() => connector.calls.length >= 1, 4000);
		assert.equal(connector.calls.length, 1);
		assert.equal(connector.calls[0], '/tmp/sessions/picked-exact.jsonl');
		discovery.dispose();
	});

	// --- Test 9: QuickPick cancel adds all to declined ---
	test('QuickPick cancel (undefined) adds all shown candidates to declined', async () => {
		const candidates = [
			makeCandidate({ recordingSessionId: recording.sessionId! }),
			makeCandidate({ recordingSessionId: recording.sessionId! })
		];
		pickerResponse = undefined;
		const discovery = makeDiscovery();
		discovery.notify(candidates);
		await until(() => pickerCalls.length >= 1);
		await new Promise(resolve => setTimeout(resolve, 100));
		// All candidates declined; second call should not open picker
		discovery.notify(candidates);
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.equal(pickerCalls.length, 1); // no second picker
		assert.equal(connector.calls.length, 0);
		discovery.dispose();
	});

	// --- Test 10: isQuieted returns false for unquieted recordings ---
	test('isQuieted returns false for a recording that was never quieted', async () => {
		const discovery = makeDiscovery();
		assert.equal(discovery.isQuieted(recording.sessionId!), false);
		assert.equal(discovery.isQuieted('some-other-id'), false);
		discovery.dispose();
	});

	// --- Test 11: recordingStarted clears declined and quieted state ---
	test('recordingStarted clears declined and quieted state for that recording', async () => {
		const id = recording.sessionId!;
		const candidate = makeCandidate({ recordingSessionId: id });
		notifyResponses.push("Don't Ask Again For This Assessment");
		const discovery = makeDiscovery();
		discovery.notify([candidate]);
		await until(() => discovery.isQuieted(id));
		// Simulate new recording
		discovery.recordingStarted(id);
		assert.equal(discovery.isQuieted(id), false);
		discovery.dispose();
	});

	// --- Test 12: no concurrent connect calls (connecting flag) ---
	test('concurrent notify calls are serialized (connecting flag prevents double-connect)', async () => {
		let resolveConnect!: (v: boolean) => void;
		const slowConnector: AssessmentNativeDiscoveryConnector & { calls: string[] } = {
			calls: [],
			connect: async (filePath) => {
				slowConnector.calls.push(filePath);
				return new Promise(r => { resolveConnect = r; });
			},
			sessionsDirectory: () => '/tmp/sessions',
			workspaces: () => []
		};
		const candidate = makeCandidate({ recordingSessionId: recording.sessionId! });
		notifyResponses.push('Connect & Allow', 'Connect & Allow');
		const discovery = new AssessmentNativeDiscovery(recording, slowConnector, {
			notification: async (message, ...actions) => {
				notifyCalls.push({ message, actions });
				return notifyResponses.shift();
			}
		});
		discovery.notify([candidate]);
		await until(() => slowConnector.calls.length >= 1);
		// Second call while first is pending — should not call connect again
		discovery.notify([candidate]);
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.equal(slowConnector.calls.length, 1);
		resolveConnect(true);
		await new Promise(resolve => setTimeout(resolve, 50));
		discovery.dispose();
	});

	// --- Test 13: recording stopped mid-prompt prevents connect ---
	test('recording stopped before connect response cancels the action', async () => {
		const candidate = makeCandidate({ recordingSessionId: recording.sessionId! });
		// Notification resolves after recording stops
		const discovery = new AssessmentNativeDiscovery(recording, connector, {
			notification: async () => {
				recording.stop(); // stop before returning response
				return 'Connect & Allow';
			}
		});
		discovery.notify([candidate]);
		await new Promise(resolve => setTimeout(resolve, 200));
		assert.equal(connector.calls.length, 0); // connect must not be called after stop
		discovery.dispose();
	});

	// --- Test 14: declined state does not carry across separate recording IDs ---
	test('declined state is scoped to recording ID and does not bleed across recordings', async () => {
		const id1 = recording.sessionId!;
		const candidate = makeCandidate({ recordingSessionId: id1 });
		notifyResponses.push('Not Now');
		const discovery = makeDiscovery();
		discovery.notify([candidate]);
		await until(() => notifyCalls.length >= 1);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Start a new recording (different ID)
		recording.stop();
		await recording.start();
		const id2 = recording.sessionId!;
		assert.notEqual(id1, id2);

		const candidate2 = makeCandidate({ recordingSessionId: id2 });
		notifyResponses.push('Not Now');
		discovery.notify([candidate2]);
		await until(() => notifyCalls.length >= 2);
		assert.equal(notifyCalls.length, 2);
		discovery.dispose();
	});

	// --- Test 15: dispose removes lifecycle listener without errors ---
	test('dispose removes lifecycle listener without errors', async () => {
		const discovery = makeDiscovery();
		assert.doesNotThrow(() => discovery.dispose());
		assert.doesNotThrow(() => discovery.dispose());
	});

	// --- Test 16: connector.resolvePath is preferred when available ---
	test('uses connector.resolvePath when provided to resolve candidate file', async () => {
		const candidate = makeCandidate({ recordingSessionId: recording.sessionId! });
		const customConnector = makeConnector(true, id => id === candidate.sourceFileId ? '/custom/exact/path.jsonl' : undefined);
		notifyResponses.push('Connect & Allow');
		const discovery = makeDiscovery(customConnector);
		discovery.notify([candidate]);
		await until(() => customConnector.calls.length >= 1, 4000);
		assert.equal(customConnector.calls[0], '/custom/exact/path.jsonl');
		discovery.dispose();
	});

	// --- Test 17: supportsNative false suppresses discovery notification ---
	test('suppresses discovery notification when native capability is unsupported', async () => {
		const candidate = makeCandidate({ recordingSessionId: recording.sessionId! });
		const unsupportedConnector = makeConnector(true, undefined, false);
		const discovery = makeDiscovery(unsupportedConnector);
		discovery.notify([candidate]);
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.equal(notifyCalls.length, 0);
		discovery.dispose();
	});

	// --- Test 18: human-readable labels never display raw filesystem paths ---
	test('candidate pick items never expose raw file paths in user-facing labels', () => {
		const discovery = makeDiscovery();
		const candidate = makeCandidate({
			recordingSessionId: recording.sessionId!,
			sourceSessionId: '12345678-abcd-1234-cdef-123456789abc',
			workspaceRelativeCwd: 'src/components',
			createdAt: '2026-11-02T12:00:00.000Z'
		});
		const items = discovery.buildPickItems([candidate], '/home/user/.codex/sessions');
		assert.equal(items.length, 1);
		assert.ok(items[0].label.includes('56789abc'));
		assert.ok(!items[0].label.includes('/home/user'));
		assert.ok(!items[0].description.includes('/home/user'));
		assert.ok(items[0].detail.includes('src/components'));
		assert.ok(!items[0].detail.includes('/home/user'));
		discovery.dispose();
	});
});
