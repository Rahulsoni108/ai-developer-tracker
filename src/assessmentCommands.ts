import { describeAssessmentStart } from './assessmentStartDiagnostics';
import * as vscode from 'vscode';
import type { AssessmentController, AssessmentView } from './assessmentController';

export const ARCHIVE_ASSESSMENT_COMMAND = 'ai-developer-tracker.archiveAssessmentConnection';
export const PAIR_ASSESSMENT_COMMAND = 'ai-developer-tracker.pairAssessment';
export const START_ASSESSMENT_COMMAND = 'ai-developer-tracker.startAssessment';
export const SUBMIT_ASSESSMENT_COMMAND = 'ai-developer-tracker.stopAndSubmitAssessment';
export const ENABLE_ASSESSMENT_UPLOADS_COMMAND = 'ai-developer-tracker.enableAssessmentUploads';
export const REVOKE_ASSESSMENT_CREDENTIAL_COMMAND = 'ai-developer-tracker.revokeAssessmentCredential';
export const ASSESSMENT_STATUS_COMMAND = 'ai-developer-tracker.showAssessmentStatus';

export function formatAssessmentStatus(view: AssessmentView): string {
	const backendStatus = view.mode === 'mock' ? 'LOCAL MOCK ONLY — no Rails backend connected.'
		: view.mode === 'rails' ? view.state === 'unpaired' ? 'Rails assessment API configured. Use Pair Assessment to connect.'
			: 'Rails assessment connected. Submission requires durable evidence reconciliation and a verified server receipt.'
			: 'Configure assessment.apiOrigin in user settings and reload to pair with Rails.';
	const lines = [`Assessment: ${view.archiving ? 'archiving connection' : view.state.replace(/_/g, ' ')}`, backendStatus];
	if (view.state === 'recovery') { lines.push('Recovery required. Authentication failure does not prove the server assessment was deleted.'); }
	if (view.archivedCount) {
		lines.push(`Archived assessments retained locally: ${view.archivedCount}. Archiving does not submit an assessment.`);
		if (view.archivedUnconfirmedCount) { lines.push(`Archived assessment (submission unconfirmed): ${view.archivedUnconfirmedCount}.`); }
		if (view.state === 'unpaired' && !view.archiving) { lines.push('Ready to pair a new assessment. Archived evidence remains isolated.'); }
	}
	if (view.lastStart) { lines.push('Last start attempt: ' + describeAssessmentStart(view.lastStart)); }
	if (view.uploadStatus) { lines.push(`Assessment delivery: ${view.uploadStatus}`); }
	if (view.reason) { lines.push(`Status code: ${view.reason}`); }
	if (view.deadline) { lines.push(`Server deadline: ${view.deadline}`, `Last server time: ${view.serverTime}`, 'Timing is the last server snapshot; offline time is unverified.'); }
	if (view.pendingEvents !== undefined) { lines.push(`Pending assessment events: ${view.pendingEvents}`); }
	lines.push(`Assessment upload consent: ${view.uploadConsent ? 'granted for this run' : 'required'}`);
	if (view.state === 'submission_pending') { lines.push(view.reason ? 'Submission is not complete and requires recovery. Use Stop & Submit again to retry the same submission; pending evidence remains encrypted.' : 'Submission is not complete; submission is in progress. Success requires a verified Rails receipt.'); }
	if (view.state === 'submitted') { lines.push(view.mode === 'mock' ? 'Local mock submission completed (simulation).' : 'Assessment successfully submitted to the server. Assessment capture and uploads are stopped.'); }
	return lines.join('\n');
}

export function registerAssessmentCommands(controller: AssessmentController, mockEnabled: boolean): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(ARCHIVE_ASSESSMENT_COMMAND, async () => {
			let accepted = false;
			await controller.archive(async summary => { accepted = (await vscode.window.showWarningMessage('Archive this assessment connection?', { modal: true,
				detail: `${summary.submissionConfirmed ? 'A server submission receipt was previously verified.' : 'Submission is UNCONFIRMED. This does not submit or finalize the assessment.'}\n\nStops and drains associated capture and disables delivery. Retains the complete connection, encrypted evidence, recording metadata, manifests, request IDs, receipts and SecretStorage credential locally. The server may still consider the assessment active; archiving does not revoke credentials, close server windows or prove deletion. Archived evidence cannot upload or move to a new assessment. There is no restore/purge command in this release. Only after durable archival succeeds can you pair another assessment.` }, 'Archive Connection')) === 'Archive Connection'; return accepted; });
			if (accepted && controller.view.state === 'unpaired' && controller.view.archivedCount) { void vscode.window.showInformationMessage('Assessment connection archived locally. Submission is not implied. Ready to pair a new assessment; old evidence and credentials were retained.'); }
			else if (accepted) { void vscode.window.showWarningMessage('Archive could not be confirmed. The connection remains blocked for recovery; evidence and credentials were preserved. Check Assessment Status, resolve local storage or active operations, and retry or reload.'); }
		}),
		vscode.commands.registerCommand(PAIR_ASSESSMENT_COMMAND, async () => {
			if (controller.mode === 'unavailable') {
				void vscode.window.showWarningMessage('Configure a trusted HTTPS assessment.apiOrigin in user settings and reload. No mock fallback is used.'); return;
			}
			if (mockEnabled && (await vscode.window.showWarningMessage('Pair a local mock assessment?', { modal: true,
				detail: 'This is a development simulation, not a real interview. No Rails service or event uploader is connected. Do not enter a real invitation or pairing code. Restarting VS Code loses the mock server; recovery fails closed. Use DEMO-ASSESSMENT as the dummy pairing code.' }, 'Use Local Mock')) !== 'Use Local Mock') { return; }
			const code = await vscode.window.showInputBox({ title: mockEnabled ? 'Pair Assessment (local mock)' : 'Pair Assessment (Rails)', password: true,
				prompt: mockEnabled ? 'Dummy pairing code: DEMO-ASSESSMENT. Never enter real credentials.' : 'Enter the short-lived pairing code from your OTP-verified assessment page.', ignoreFocusOut: true });
			if (code !== undefined) { await controller.pair(code.trim()); }
		}),
		vscode.commands.registerCommand(ENABLE_ASSESSMENT_UPLOADS_COMMAND, () => controller.enableUploads()),
		vscode.commands.registerCommand(REVOKE_ASSESSMENT_CREDENTIAL_COMMAND, async () => {
			if (await vscode.window.showWarningMessage('Revoke this assessment extension credential?', { modal: true,
				detail: 'Stops local assessment recording and uploads, revokes evidence consent and the current Rails credential. Pending evidence stays encrypted and unacknowledged. This does not submit or finalize the assessment.' }, 'Revoke Credential') === 'Revoke Credential') { await controller.revokeCredential(); }
		}),
		vscode.commands.registerCommand(START_ASSESSMENT_COMMAND, async () => {
			await controller.start(); const diagnostic = controller.view.lastStart;
			if (diagnostic?.status === 'failed') { void vscode.window.showWarningMessage(describeAssessmentStart(diagnostic) + ' See Output → AI Developer Tracker for the prerequisite sequence.'); }
		}),
		vscode.commands.registerCommand(SUBMIT_ASSESSMENT_COMMAND, () => controller.stopAndSubmit()),
		vscode.commands.registerCommand(ASSESSMENT_STATUS_COMMAND, async () => {
			await controller.showStatus(); const view = controller.view;
			void vscode.window.showInformationMessage(formatAssessmentStatus(view)); return view;
		})
	];
}
