import * as vscode from 'vscode';
import { AssessmentApiError } from './assessmentApiClient';
import type { AssessmentController } from './assessmentController';
import type { AssessmentDisclosureConsent } from './assessmentDisclosureConsent';
import { chooseDisclosure } from './assessmentDisclosureChoices';

export const GRANT_DISCLOSURE_COMMAND = 'ai-developer-tracker.configureAssessmentDisclosure';
export const STATUS_DISCLOSURE_COMMAND = 'ai-developer-tracker.showAssessmentDisclosure';
export const REVOKE_DISCLOSURE_COMMAND = 'ai-developer-tracker.revokeAssessmentDisclosure';
const blockedNotice = 'Raw recruiter disclosure remains disabled. Only new, freshly authorized captures may use protocol 2; existing protocol-1 evidence stays restricted.';
/** Only fixed messages/category counts/server times. Never show/log receipt bodies or private source identifiers. */
export function registerDisclosureCommands(controller: AssessmentController, consent?: AssessmentDisclosureConsent): vscode.Disposable[] {
	const perform = async (action: 'grant' | 'status' | 'revoke') => {
		try {
			if (!consent) { throw new AssessmentApiError('unavailable'); }
			await controller.withDisclosureContext(action === 'grant', async context => {
				if (action === 'grant') {
					const selected = await chooseDisclosure({
						select: async (title, choices) => (await vscode.window.showQuickPick(choices, { title, canPickMany: true, ignoreFocusOut: true }))?.map(c => c.value),
						confirm: async detail => await vscode.window.showWarningMessage('Approve selected recruiter disclosure scope?', { modal: true, detail }, 'Approve Selected Disclosure') === 'Approve Selected Disclosure'
					}, await consent.choices(context));
					if (!selected) { void vscode.window.showInformationMessage('No new disclosure consent granted. Existing choices are unchanged; use Revoke Assessment Disclosure Consent to withdraw them.'); return; }
					const state = await consent.grant(context, selected, AbortSignal.timeout(10000));
					void vscode.window.showInformationMessage(`Disclosure scope registered: ${state.receipt!.state}. ${blockedNotice}`); return;
				}
				const states = await consent.list(context);
				if (!states.length) { void vscode.window.showInformationMessage(`No disclosure consent registered for this assessment. ${blockedNotice}`); return; }
				const choice = states.length === 1 ? { state: states[0] } : await vscode.window.showQuickPick(states.map((state, i) => ({ label: `Disclosure grant ${i + 1}`,
					description: state.locallyRevoked ? 'Locally withdrawn' : state.receipt?.state ?? 'Unconfirmed', state })), { title: 'Choose disclosure grant', ignoreFocusOut: true });
				if (!choice) { return; }
				if (action === 'revoke' && await vscode.window.showWarningMessage('Withdraw future disclosure consent?', { modal: true,
					detail: 'Withdraws this grant locally before contacting Rails. Network failure leaves server revocation unconfirmed. Does not stop recording, revoke upload consent, delete evidence or change historical records.' }, 'Withdraw Disclosure') !== 'Withdraw Disclosure') { return; }
				const state = await (action === 'revoke' ? consent.revoke(context, choice.state, AbortSignal.timeout(10000)) : consent.inspect(context, choice.state, AbortSignal.timeout(10000)));
				void vscode.window.showInformationMessage(`Disclosure: ${state.locallyRevoked ? 'locally withdrawn; ' : ''}${state.pendingAction ? 'server action unconfirmed' : state.receipt?.state ?? 'unconfirmed'}. ${state.receipt ? `Upload scope: ${state.receipt.upload_scope_state}. Last server time: ${state.receipt.server_time}. Expires: ${state.receipt.expires_at}. ` : ''}${blockedNotice}`);
			});
		} catch (error) {
			const code = error instanceof AssessmentApiError ? error.code : 'scope_or_storage_unavailable';
			void vscode.window.showWarningMessage(`Disclosure action not confirmed (${code}). Recording and upload choices are unchanged. For a grant, start the assessment and explicitly select approved workspaces and already confirmed, content-approved AI sessions; for a pending revoke, retry after connectivity returns. Unknown grant outcomes require recovery; they are never replayed after withdrawal. ${blockedNotice}`);
		}
	};
	return [vscode.commands.registerCommand(GRANT_DISCLOSURE_COMMAND, () => perform('grant')),
		vscode.commands.registerCommand(STATUS_DISCLOSURE_COMMAND, () => perform('status')),
		vscode.commands.registerCommand(REVOKE_DISCLOSURE_COMMAND, () => perform('revoke'))];
}
