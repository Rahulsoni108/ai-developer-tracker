import * as assert from 'node:assert/strict';
import { RecordingController } from '../recording';
import { startRecordingCommand, stopRecordingCommand, type RecordingStartChoice } from '../recordingCommands';
import type { AssessmentView } from '../assessmentController';

suite('Manual and assessment recording command routing', () => {
	let recording: RecordingController; let view: AssessmentView;
	let consent: boolean; let dialogs: number; let choices: number; let starts: number;
	let choice: RecordingStartChoice | undefined;
	const start = () => startRecordingCommand(recording, () => view, async () => { choices++; return choice; }, async () => { starts++; });
	setup(() => {
		view = { mode: 'rails', state: 'paired', uploadConsent: false };
		consent = true; dialogs = 0; choices = 0; starts = 0; choice = undefined;
		recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => { dialogs++; return consent; });
	});
	teardown(() => recording.dispose());
	test('paired status-bar/manual command offers an explicit assessment route without starting local capture itself', async () => {
		choice = 'Start Assessment'; await start();
		assert.equal(choices, 1); assert.equal(starts, 1); assert.equal(dialogs, 0); assert.equal(recording.isRecording, false);
	});
	test('cancelling workflow selection leaves paired state and recording untouched', async () => {
		await start(); assert.equal(choices, 1); assert.equal(starts, 0); assert.equal(dialogs, 0); assert.equal(recording.isRecording, false);
		assert.deepEqual(view, { mode: 'rails', state: 'paired', uploadConsent: false });
	});
	test('deliberate manual recording retains independent recording consent and never starts Rails', async () => {
		choice = 'Start Manual Recording'; consent = false; await start(); assert.equal(recording.isRecording, false);
		consent = true; await start(); assert.equal(recording.isRecording, true); assert.equal(dialogs, 2); assert.equal(starts, 0);
	});
	test('unpaired, archived-only, unavailable and mock development recording keep their original consent flow', async () => {
		for (const state of [{ mode: 'rails' as const, state: 'unpaired' as const, archivedCount: 1 },
			{ mode: 'mock' as const, state: 'paired' as const }, { state: 'unpaired' as const }]) {
			view = { ...state, uploadConsent: false }; await start(); assert.equal(recording.isRecording, true); recording.stop();
		}
		assert.equal(choices, 0); assert.equal(dialogs, 3); assert.equal(starts, 0);
	});
	test('recovery does not silently route into a new manual capture or reset the paired connection', async () => {
		view = { ...view, state: 'recovery', reason: 'authentication' }; await start();
		assert.equal(recording.isRecording, false); assert.equal(choices, 1); assert.equal(view.reason, 'authentication');
	});
	test('repeated clicks during manual preparation or active capture do not open extra workflow/consent dialogs', async () => {
		choice = 'Start Manual Recording'; let release!: () => void; let entered!: () => void;
		const visible = new Promise<void>(resolve => { entered = resolve; });
		recording.addLifecycleListener({ prepare: async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); }, started() {}, stopped() {}, cancelled() {} });
		const pending = start(); await visible; await start(); release(); await pending; await start();
		assert.equal(choices, 1); assert.equal(dialogs, 1); assert.equal(starts, 0);
	});
	test('Stop Recording cancels a pending manual start and drains without ever requesting assessment finalization', async () => {
		view.state = 'unpaired'; let release!: (yes: boolean) => void;
		recording.dispose(); recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} },
			() => new Promise(resolve => { release = resolve; }));
		const pending = start(); assert.equal(recording.isStarting, true); let drained = false;
		await stopRecordingCommand(recording, async id => { assert.equal(id, undefined); drained = true; });
		release(true); await pending; assert.equal(drained, true); assert.equal(recording.isRecording, false); assert.equal(starts, 0);
	});
	test('Stop Recording waits for the exact local recording drain without changing assessment metadata', async () => {
		choice = 'Start Manual Recording'; await start(); const id = recording.sessionId; const before = structuredClone(view);
		let release!: () => void; let entered!: () => void; let finished = false;
		const enteredDrain = new Promise<void>(resolve => { entered = resolve; });
		const stopping = stopRecordingCommand(recording, async stopped => { assert.equal(stopped, id); assert.equal(recording.isRecording, false);
			entered(); await new Promise<void>(resolve => { release = resolve; }); }).then(() => { finished = true; });
		await enteredDrain; assert.equal(finished, false); release(); await stopping;
		assert.deepEqual(view, before); assert.equal(starts, 0);
	});
	test('drain failure is propagated; no assessment start, finalization or evidence deletion is attempted', async () => {
		choice = 'Start Manual Recording'; await start(); const before = structuredClone(view);
		await assert.rejects(stopRecordingCommand(recording, async () => { throw new Error('dummy storage failure'); }));
		assert.equal(recording.isRecording, false); assert.deepEqual(view, before); assert.equal(starts, 0);
	});
});
