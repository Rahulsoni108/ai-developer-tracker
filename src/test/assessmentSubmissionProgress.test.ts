import * as assert from 'node:assert/strict';
import type { AssessmentView } from '../assessmentController';
import { createSubmissionCommand, describeSubmission, formatAssessmentStatusBar, type SubmissionUi } from '../assessmentSubmissionProgress';

suite('Assessment submission progress UX', () => {
	const pending = (reason?: AssessmentView['reason']): AssessmentView => ({ state: 'submission_pending', mode: 'rails', uploadConsent: false,
		pendingEvents: 0, ...(reason ? { reason } : {}) });
	function harness(initial = pending()) {
		let view = initial; let calls = 0; let preparations = 0; let statusCalls = 0;
		const listeners = new Set<(value: AssessmentView) => void>();
		const progress: string[] = []; const warnings: { message: string; actions: readonly string[] }[] = []; const info: string[] = [];
		const choices: (string | undefined)[] = [];
		const emit = (value: AssessmentView) => { view = value; listeners.forEach(listener => listener(value)); };
		const controller = { get view() { return view; }, observeView(listener: (value: AssessmentView) => void) {
			listeners.add(listener); return { dispose: () => { listeners.delete(listener); } };
		}, stopAndSubmit: async () => { calls++; await work(); } };
		let work: () => Promise<void> = async () => {};
		const ui: SubmissionUi = { withProgress: async task => task(message => progress.push(message)),
			warn: async (message, actions) => { warnings.push({ message, actions }); return choices.shift(); },
			info: async message => { info.push(message); }, showStatus: async () => { statusCalls++; } };
		const command = createSubmissionCommand(controller, async () => { preparations++; }, ui);
		return { command, controller, ui, emit, progress, warnings, info, choices, listeners, setWork: (task: () => Promise<void>) => { work = task; },
			get calls() { return calls; }, get preparations() { return preparations; }, get statusCalls() { return statusCalls; } };
	}

	test('shows real steps, coalesces duplicate commands and confirms success only after the controller verifies submission', async () => {
		const h = harness(); let finish!: () => void;
		const gate = new Promise<void>(resolve => { finish = resolve; });
		h.setWork(async () => {
			for (const step of ['stop_capture', 'flush_capture', 'close_windows', 'freeze_manifest', 'drain_uploads', 'reconcile_evidence', 'finalize', 'validate_receipt'] as const) {
				h.emit({ ...pending(), submissionInProgress: true, lastSubmission: { step, status: 'running' } });
			}
			await gate;
			h.emit({ state: 'submitted', mode: 'rails', uploadConsent: false, lastSubmission: { step: 'save_receipt', status: 'submitted' } });
		});
		const first = h.command(); assert.equal(first, h.command()); await Promise.resolve(); await Promise.resolve();
		assert.equal(h.calls, 1); assert.equal(h.info.length, 0);
		assert.ok(h.progress.includes('Uploading approved evidence')); assert.ok(h.progress.includes('Verifying the server submission receipt'));
		finish(); await first;
		assert.equal(h.preparations, 1); assert.equal(h.info.length, 1); assert.match(h.info[0], /Rails receipt was verified/);
		assert.equal(h.listeners.size, 0); assert.equal(h.warnings.length, 0);
	});

	test('zero pending events without a confirmed receipt is recovery, never submission success or automatic retry', async () => {
		const h = harness(); await h.command();
		assert.equal(h.calls, 1); assert.equal(h.info.length, 0); assert.equal(h.listeners.size, 0);
		assert.match(h.warnings[0].message, /Submission is not confirmed/);
		assert.ok(h.warnings[0].actions.includes('Retry Stop & Submit'));
		assert.match(formatAssessmentStatusBar(pending()), /submission needs recovery/);
	});

	test('an explicit retry reuses the normal controller operation; dismissing a failure never retries', async () => {
		const h = harness(pending('unavailable')); h.choices.push('Retry Stop & Submit');
		h.setWork(async () => {
			if (h.calls === 2) { h.emit({ state: 'submitted', mode: 'rails', uploadConsent: false }); }
		});
		await h.command(); assert.equal(h.calls, 2); assert.equal(h.preparations, 2); assert.equal(h.info.length, 1);
		assert.match(h.warnings[0].message, /Check your connection/); assert.equal(h.listeners.size, 0);
	});
	test('an open recovery notification does not block a later explicit palette retry', async () => {
		const h = harness(pending('unavailable')); let dismiss!: (value: string | undefined) => void; let shown!: () => void;
		const visible = new Promise<void>(resolve => { shown = resolve; });
		h.ui.warn = async () => { shown(); return new Promise<string | undefined>(resolve => { dismiss = resolve; }); };
		const first = h.command(); await visible;
		h.setWork(async () => { h.emit({ state: 'submitted', mode: 'rails', uploadConsent: false }); });
		const second = h.command(); assert.notEqual(second, first); await second;
		assert.equal(h.calls, 2); assert.equal(h.info.length, 1); assert.equal(h.listeners.size, 0);
		dismiss(undefined); await first;
	});

	test('authentication failure offers status and access recovery, without encouraging reset, re-pairing or blind retries', async () => {
		const h = harness(pending('authentication')); h.choices.push('Show Assessment Status'); await h.command();
		assert.deepEqual(h.warnings[0].actions, ['Show Assessment Status']); assert.equal(h.statusCalls, 1); assert.equal(h.calls, 1);
		assert.match(h.warnings[0].message, /restore access/); assert.match(h.warnings[0].message, /does not prove the assessment was deleted/);
	});

	test('local storage and receipt failures give safe, prerequisite-specific instructions', () => {
		assert.match(describeSubmission(pending('storage')).message, /Check disk space/);
		assert.equal(describeSubmission(pending('storage')).canRetry, false);
		assert.match(describeSubmission(pending('protocol')).message, /receipt could not be verified/);
		assert.equal(describeSubmission(pending('protocol')).canRetry, false);
		assert.match(describeSubmission(pending('consent_required')).message, /review the upload permission dialog/);
		assert.match(describeSubmission(pending('evidence_pending')).message, /zero pending count alone does not confirm submission/);
		assert.match(describeSubmission(pending('session_ended')).message, /submitted late when Rails permits/);
		assert.match(describeSubmission(pending('recording_busy')).message, /Stop Recording \(Without Submitting\)/);
	});

	test('a retained or interrupted diagnostic after restart never claims a submission is still running', () => {
		const view = { ...pending(), lastSubmission: { step: 'finalize', status: 'running' } } as AssessmentView;
		assert.equal(describeSubmission(view).state, 'recovery');
		assert.match(describeSubmission(view).message, /Requesting Rails finalization/);
		assert.equal(describeSubmission({ ...view, submissionInProgress: true }).state, 'working');
		assert.match(formatAssessmentStatusBar({ ...view, submissionInProgress: true }), /submitting — requesting rails finalization/);
	});

	test('mock success, archived connections and prepared assessments cannot imply a real Rails submission', async () => {
		const mock = describeSubmission({ state: 'submitted', mode: 'mock', uploadConsent: false });
		assert.match(mock.message, /simulation/); assert.match(mock.message, /No Rails submission is implied/);
		const h = harness({ state: 'paired', mode: 'rails', uploadConsent: false }); await h.command();
		assert.match(h.info[0], /Use Start Assessment/); assert.equal(h.warnings.length, 0);
		assert.equal(formatAssessmentStatusBar({ state: 'unpaired', mode: 'rails', uploadConsent: false, archivedCount: 1 }), 'Assessment: ready to pair');
	});

	test('unexpected exceptions never expose their private text and always remove observers', async () => {
		const h = harness(); h.setWork(async () => { throw new Error('PRIVATE_TOKEN_PROMPT_PATH'); });
		await h.command(); assert.equal(h.listeners.size, 0); assert.equal(h.info.length, 0);
		assert.equal(JSON.stringify(h.warnings).includes('PRIVATE_TOKEN_PROMPT_PATH'), false);
		assert.deepEqual(h.warnings[0].actions, ['Show Assessment Status']);
		// Failed commands release the duplicate guard, allowing a later deliberate attempt.
		await h.command(); assert.equal(h.calls, 2);
	});
});
