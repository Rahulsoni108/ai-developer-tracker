import * as assert from 'assert';
import { RecordingController, START_RECORDING_COMMAND, STOP_RECORDING_COMMAND } from '../recording';
import { isUuid } from '../eventSchema';

suite('Recording controls', () => {
	let statusBar: {
		text: string;
		tooltip: string | undefined;
		command: string | undefined;
		show(): void;
		dispose(): void;
	};
	let controller: RecordingController;
	let consent: boolean;
	let consentRequests: number;
	let shown: boolean;
	let disposals: number;

	setup(() => {
		consent = true;
		consentRequests = 0;
		shown = false;
		disposals = 0;
		statusBar = {
			text: '', tooltip: undefined, command: undefined,
			show: () => { shown = true; },
			dispose: () => { disposals++; }
		};
		controller = new RecordingController(statusBar, async () => {
			consentRequests++;
			return consent;
		});
	});

	teardown(() => controller.dispose());

	test('starts inactive and shows the start command in the status bar', () => {
		assert.strictEqual(controller.isRecording, false);
		assert.strictEqual(statusBar.text, 'Not Recording');
		assert.strictEqual(statusBar.command, START_RECORDING_COMMAND);
		assert.strictEqual(shown, true);
	});

	test('requires consent, then starts and stops with the matching status bar commands', async () => {
		const starting = controller.start();
		assert.strictEqual(controller.isRecording, false);
		await starting;
		assert.strictEqual(consentRequests, 1);
		assert.strictEqual(controller.isRecording, true);
		assert.strictEqual(statusBar.text, 'Recording');
		assert.strictEqual(statusBar.command, STOP_RECORDING_COMMAND);
		controller.stop();
		assert.strictEqual(controller.isRecording, false);
		assert.strictEqual(statusBar.text, 'Not Recording');
		assert.strictEqual(statusBar.command, START_RECORDING_COMMAND);
	});

	test('cancelled consent leaves recording stopped and allows retry', async () => {
		consent = false;
		await controller.start();
		assert.strictEqual(controller.isRecording, false);
		assert.strictEqual(statusBar.text, 'Not Recording');
		consent = true;
		await controller.start();
		assert.strictEqual(controller.isRecording, true);
		assert.strictEqual(consentRequests, 2);
	});

	test('ignores repeated starts, including while consent is pending', async () => {
		await Promise.all([controller.start(), controller.start()]);
		await controller.start();
		assert.strictEqual(consentRequests, 1);
		assert.strictEqual(controller.isRecording, true);
	});

	test('ignores repeated stops and permits a new recording session', async () => {
		controller.stop();
		assert.strictEqual(controller.isRecording, false);
		await controller.start();
		controller.stop();
		controller.stop();
		assert.strictEqual(controller.isRecording, false);
		await controller.start();
		assert.strictEqual(controller.isRecording, true);
		assert.strictEqual(consentRequests, 2);
	});

	test('stopping while consent is pending prevents a late start', async () => {
		const starting = controller.start();
		controller.stop();
		await starting;
		assert.strictEqual(controller.isRecording, false);
		assert.strictEqual(statusBar.text, 'Not Recording');
	});

	test('disposes once and prevents pending consent from restarting recording', async () => {
		const starting = controller.start();
		controller.dispose();
		controller.dispose();
		await starting;
		await controller.start();
		controller.stop();
		assert.strictEqual(disposals, 1);
		assert.strictEqual(controller.isRecording, false);
		assert.strictEqual(consentRequests, 1);
	});

	test('a failed consent prompt can be retried', async () => {
		controller.dispose();
		let attempts = 0;
		controller = new RecordingController(statusBar, async () => {
			if (++attempts === 1) {
				throw new Error('Consent prompt failed');
			}
			return true;
		});
		await assert.rejects(controller.start(), /Consent prompt failed/);
		assert.strictEqual(controller.isRecording, false);
		await controller.start();
		assert.strictEqual(controller.isRecording, true);
	});

	test('consent callbacks can detect that stop invalidated their request', async () => {
		controller.dispose();
		let currentRequest: () => boolean = () => false;
		let accept: (value: boolean) => void = () => {};
		controller = new RecordingController(statusBar, isCurrentRequest => {
			currentRequest = isCurrentRequest;
			return new Promise(resolve => { accept = resolve; });
		});
		const starting = controller.start();
		assert.strictEqual(currentRequest(), true);
		controller.stop();
		assert.strictEqual(currentRequest(), false);
		accept(true);
		await starting;
		assert.strictEqual(controller.isRecording, false);
	});

	test('creates one session UUID per accepted recording and clears it on stop', async () => {
		assert.strictEqual(controller.sessionId, undefined);
		const starting = controller.start();
		assert.strictEqual(controller.sessionId, undefined);
		await starting;
		const firstSession = controller.sessionId;
		assert.ok(isUuid(firstSession));
		await controller.start();
		assert.strictEqual(controller.sessionId, firstSession);
		controller.stop();
		assert.strictEqual(controller.sessionId, undefined);
		controller.stop();
		await controller.start();
		assert.ok(isUuid(controller.sessionId));
		assert.notStrictEqual(controller.sessionId, firstSession);
		controller.dispose();
		assert.strictEqual(controller.sessionId, undefined);
	});

	test('cancelled and invalidated consent never creates a recording session', async () => {
		consent = false;
		await controller.start();
		assert.strictEqual(controller.sessionId, undefined);
		consent = true;
		const starting = controller.start();
		controller.stop();
		await starting;
		assert.strictEqual(controller.sessionId, undefined);
		assert.strictEqual(controller.isRecording, false);
	});
});
