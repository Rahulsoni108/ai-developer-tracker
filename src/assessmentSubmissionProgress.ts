import type { AssessmentFailure } from './assessmentApiClient';
import type { AssessmentController, AssessmentSubmissionDiagnostic, AssessmentView } from './assessmentController';

const steps: Record<AssessmentSubmissionDiagnostic['step'], string> = {
	stop_capture: 'Stopping assessment capture', save_intent: 'Saving submission recovery information',
	disable_delivery: 'Pausing uploads for safe reconciliation', flush_capture: 'Saving captured evidence locally',
	authentication: 'Checking assessment authentication', server_status: 'Checking Rails assessment status',
	close_windows: 'Closing recording windows', freeze_manifest: 'Freezing the evidence manifest',
	upload_consent: 'Waiting for your upload permission', enable_delivery: 'Preparing approved evidence uploads',
	drain_uploads: 'Uploading approved evidence', reconcile_evidence: 'Checking durable event acknowledgments',
	finalize: 'Requesting Rails finalization', validate_receipt: 'Verifying the server submission receipt',
	save_receipt: 'Saving the verified submission receipt'
};
const retry = 'Retry Stop & Submit';
const status = 'Show Assessment Status';
const guidance: Record<AssessmentFailure, { message: string; retry: boolean }> = {
	unavailable: { message: 'Rails could not be reached or did not respond in time. Check your connection and the configured HTTPS service, then retry Stop & Submit.', retry: true },
	evidence_pending: { message: 'Some evidence is still awaiting durable acknowledgment, or local evidence is missing. Wait for connectivity or upload backoff to recover, then retry. A zero pending count alone does not confirm submission.', retry: true },
	consent_required: { message: 'Upload permission is required or was withdrawn. Retry Stop & Submit and review the upload permission dialog. Declining keeps submission pending.', retry: true },
	authentication: { message: 'Rails did not accept the assessment credential. Ask your recruiter or support to restore access before retrying. Authentication failure does not prove the assessment was deleted.', retry: false },
	storage: { message: 'Local evidence or recovery information could not be saved. Check disk space and storage access; contact support if this persists. Keep the extension storage intact.', retry: false },
	protocol: { message: 'A server response or submission receipt could not be verified. Check Assessment Status and contact support before retrying; do not reset or alter the evidence.', retry: false },
	recovery_required: { message: 'Submission needs recovery. Retry Stop & Submit using this same connection. If the same step fails again, contact support with its step and error code; do not reset local storage.', retry: true },
	session_ended: { message: 'Capture has ended. Previously approved evidence can still be submitted late when Rails permits it. Retry Stop & Submit; revoked or otherwise ineligible assessments require support.', retry: true },
	recording_busy: { message: 'An unrelated manual recording is active. Use Stop Recording (Without Submitting), then retry Stop & Submit for this assessment. Its evidence will not be attached to this assessment.', retry: false },
	rejected: { message: 'Rails rejected the operation, or no eligible assessment is paired. Check Assessment Status and contact support if this assessment should be eligible.', retry: false },
	finalization_unavailable: { message: 'This server does not provide the supported finalization contract. Contact support; stopping local recording cannot finalize the assessment.', retry: false },
	cancelled: { message: 'The submission attempt was interrupted. Check Assessment Status, then retry Stop & Submit if submission remains unconfirmed.', retry: true }
};

export function describeSubmission(view: AssessmentView): { state: 'working' | 'recovery' | 'submitted' | 'idle'; label: string; message: string; canRetry: boolean } {
	if (view.state === 'submitted') {
		return { state: 'submitted', label: view.mode === 'mock' ? 'Mock submission completed' : 'Assessment submitted', canRetry: false,
			message: view.mode === 'mock' ? 'Local mock submission completed (simulation). No Rails submission is implied.'
				: 'Assessment successfully submitted. The Rails receipt was verified; assessment capture and uploads are stopped.' };
	}
	const diagnostic = view.lastSubmission;
	if (view.submissionInProgress && diagnostic?.status === 'running') {
		return { state: 'working', label: steps[diagnostic.step], canRetry: false,
			message: `${steps[diagnostic.step]}. Submission is not confirmed yet. Keep VS Code open until this attempt finishes.` };
	}
	if (['submission_pending', 'stopping', 'recovery', 'error'].includes(view.state) || diagnostic?.status === 'failed' || diagnostic?.status === 'pending') {
		const reason = view.reason ?? diagnostic?.reason ?? 'recovery_required';
		const action = guidance[reason];
		return { state: 'recovery', label: 'Submission requires recovery', canRetry: action.retry,
			message: `Submission is not confirmed.${diagnostic ? ' Last step: ' + steps[diagnostic.step] + '.' : ''} ${action.message} Existing encrypted evidence and submission recovery information are retained; retry uses the same submission request.` };
	}
	return { state: 'idle', label: 'Submission not started', canRetry: false,
		message: view.archiving ? 'Assessment archival is in progress. Check Assessment Status after it finishes. Archiving does not submit an assessment.'
			: 'No assessment submission is running. Use Start Assessment for a paired assessment, or check Assessment Status for the next step.' };
}

export function formatAssessmentStatusBar(view: AssessmentView): string {
	const submission = describeSubmission(view);
	const label = view.archiving ? 'archiving' : submission.state === 'working' ? `submitting — ${submission.label.toLowerCase()}`
		: ['submission_pending', 'stopping'].includes(view.state) ? 'submission needs recovery'
			: view.state === 'unpaired' && view.archivedCount ? 'ready to pair' : view.state.replace(/_/g, ' ');
	return `Assessment: ${label}${view.mode === 'mock' ? ' (mock)' : ''}`;
}

/** Presentation only: no authorization, evidence writes, automatic retries or new request IDs. */
export interface SubmissionUi {
	withProgress(task: (report: (message: string) => void) => Promise<void>): Promise<void>;
	warn(message: string, actions: readonly string[]): Promise<string | undefined>;
	info(message: string): Promise<void>;
	showStatus(): Promise<void>;
}
type SubmissionController = Pick<AssessmentController, 'view' | 'observeView' | 'stopAndSubmit'>;
export function createSubmissionCommand(controller: SubmissionController, beforeSubmit: () => Promise<void>, ui: SubmissionUi): () => Promise<void> {
	let inFlight: Promise<void> | undefined;
	const perform = async (): Promise<boolean> => {
		try {
			await ui.withProgress(async report => {
				report('Preparing Stop & Submit');
				const observer = controller.observeView(view => { report(describeSubmission(view).label); });
				try { await beforeSubmit(); await controller.stopAndSubmit(); }
				finally { observer.dispose(); }
			});
			return true;
		} catch { return false; }
	};
	const run = (): Promise<void> => {
		if (inFlight) { return inFlight; }
		const work: Promise<void> = perform().then(async completed => {
			// A finished attempt's notification must not block a later palette retry.
			if (inFlight === work) { inFlight = undefined; }
			if (!completed) {
				// Raw exceptions may contain transport paths, credentials or provider details.
				if (await ui.warn('The submission attempt could not finish. Check Assessment Status before retrying. No submission success is confirmed by this message; keep existing evidence and recovery information.', [status]) === status) { await ui.showStatus(); }
				return;
			}
			const result = describeSubmission(controller.view);
			if (result.state === 'submitted' || result.state === 'idle') { await ui.info(result.message); return; }
			const choice = await ui.warn(result.message, result.canRetry ? [retry, status] : [status]);
			if (choice === retry && result.canRetry) { await run(); }
			if (choice === status) { await ui.showStatus(); }
		});
		inFlight = work;
		return work;
	};
	return run;
}
