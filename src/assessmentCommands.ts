import * as vscode from 'vscode';
import type { AssessmentController, AssessmentView } from './assessmentController';

export const PAIR_ASSESSMENT_COMMAND = 'ai-developer-tracker.pairAssessment';
export const START_ASSESSMENT_COMMAND = 'ai-developer-tracker.startAssessment';
export const SUBMIT_ASSESSMENT_COMMAND = 'ai-developer-tracker.stopAndSubmitAssessment';
export const ASSESSMENT_STATUS_COMMAND = 'ai-developer-tracker.showAssessmentStatus';

export function formatAssessmentStatus(view: AssessmentView): string {
	const lines = [`Assessment: ${view.state.replace(/_/g, ' ')}`, view.mode === 'mock' ? 'LOCAL MOCK ONLY — no Rails backend connected.' : 'Rails assessment transport is not implemented.'];
	if (view.reason) { lines.push(`Status code: ${view.reason}`); }
	if (view.deadline) { lines.push(`Server deadline: ${view.deadline}`, `Last server time: ${view.serverTime}`, 'Timing is the last server snapshot; offline time is unverified.'); }
	if (view.pendingEvents !== undefined) { lines.push(`Pending assessment events: ${view.pendingEvents}`); }
	lines.push(`Assessment upload consent: ${view.uploadConsent ? 'granted for this run' : 'required'}`);
	if (view.state === 'submission_pending') { lines.push('Submission is not complete. Pending evidence stays in encrypted SQLite.'); }
	return lines.join('\n');
}

export function registerAssessmentCommands(controller: AssessmentController, mockEnabled: boolean): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(PAIR_ASSESSMENT_COMMAND, async () => {
			if (!mockEnabled) {
				void vscode.window.showWarningMessage('Rails assessment endpoints are not implemented. Pairing is unavailable. For synthetic development tests only, enable assessment.mock.enabled in user settings and reload.'); return;
			}
			if ((await vscode.window.showWarningMessage('Pair a local mock assessment?', { modal: true,
				detail: 'This is a development simulation, not a real interview. No Rails service or event uploader is connected. Do not enter a real invitation or pairing code. Restarting VS Code loses the mock server; recovery fails closed. Use DEMO-ASSESSMENT as the dummy pairing code.' }, 'Use Local Mock')) !== 'Use Local Mock') { return; }
			const code = await vscode.window.showInputBox({ title: 'Pair Assessment (local mock)', password: true,
				prompt: 'Dummy pairing code: DEMO-ASSESSMENT. Never enter real credentials.', ignoreFocusOut: true });
			if (code !== undefined) { await controller.pair(code.trim()); }
		}),
		vscode.commands.registerCommand(START_ASSESSMENT_COMMAND, () => controller.start()),
		vscode.commands.registerCommand(SUBMIT_ASSESSMENT_COMMAND, () => controller.stopAndSubmit()),
		vscode.commands.registerCommand(ASSESSMENT_STATUS_COMMAND, async () => {
			await controller.showStatus(); const view = controller.view;
			void vscode.window.showInformationMessage(formatAssessmentStatus(view)); return view;
		})
	];
}
