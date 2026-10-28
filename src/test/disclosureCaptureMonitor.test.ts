import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DisclosureCaptureMonitor } from '../disclosureCaptureMonitor';
import { RecordingController } from '../recording';
import { freshDisclosureConfirmation, DISCLOSURE_CONFIRMATION_MS } from '../disclosureCapture';
import type { DisclosureState } from '../assessmentDisclosure';
import type { DisclosureContext } from '../assessmentDisclosureConsent';

suite('Disclosure capture refresh lifecycle', () => {
	let recording: RecordingController; let monitor: DisclosureCaptureMonitor | undefined;
	setup(() => { recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => true); });
	teardown(() => { monitor?.dispose(); recording.dispose(); });
	test('freshness expires at the exact monotonic boundary independently of wall-clock changes', () => {
		const now = process.hrtime.bigint();
		const confirmation = { requestedAt: now, state: {} as DisclosureState };
		assert.equal(freshDisclosureConfirmation(confirmation, now - 1n), false);
		assert.equal(freshDisclosureConfirmation(confirmation, now + BigInt(DISCLOSURE_CONFIRMATION_MS) * 1000000n - 1n), true);
		assert.equal(freshDisclosureConfirmation(confirmation, now + BigInt(DISCLOSURE_CONFIRMATION_MS) * 1000000n), false);
	});
	test('offline refresh suspends disclosure permission, while recording remains active', async () => {
		await recording.start(); let paused = 0; let notices = 0;
		monitor = new DisclosureCaptureMonitor(recording, { withDisclosureContext: async () => { throw new Error('offline'); } },
			{ list: async () => [], inspect: async (_context, state) => state }, { suspendDisclosureCapture: async () => { paused++; } },
			status => { assert.equal(status, 'upload_only'); notices++; }, 60000);
		await monitor.refresh(); assert.equal(paused, 1); assert.equal(notices, 1); assert.equal(recording.isRecording, true);
	});
	test('stop aborts an in-flight refresh and seals that recording without restoring it', async () => {
		await recording.start(); const id = recording.sessionId!; let signal: AbortSignal | undefined; let finish!: () => void;
		const suspended: unknown[][] = []; let calls = 0;
		const scope = { request: { local_recording_session_id: id }, receipt: { state: 'active' } } as DisclosureState;
		const context = { current: () => recording.isRecording, currentRecording: id } as DisclosureContext;
		monitor = new DisclosureCaptureMonitor(recording, { withDisclosureContext: async (_active, work) => work(context) }, {
			list: async () => [scope], inspect: async (_context, state, requestSignal) => { calls++; signal = requestSignal;
				await new Promise<void>(resolve => { finish = resolve; }); return state; }
		}, { suspendDisclosureCapture: async (...args) => { suspended.push(args); } }, () => {}, 60000);
		const pending = monitor.refresh(); while (!signal) { await new Promise(resolve => setImmediate(resolve)); }
		recording.stop(); assert.equal(signal.aborted, true); assert.deepEqual(suspended[0], [id, undefined, true]);
		finish(); await pending; await monitor.refresh(); assert.equal(calls, 1); assert.equal(recording.isRecording, false);
	});
	test('missing disclosure intent never registers a grant or initiates network capture authorization', async () => {
		await recording.start(); let inspected = false;
		const context = { current: () => true, currentRecording: randomUUID() } as DisclosureContext;
		monitor = new DisclosureCaptureMonitor(recording, { withDisclosureContext: async (_active, work) => work(context) }, {
			list: async () => [], inspect: async (_context, state) => { inspected = true; return state; }
		}, { suspendDisclosureCapture: async () => {} }, () => {}, 60000);
		await monitor.refresh(); assert.equal(inspected, false);
	});
});
