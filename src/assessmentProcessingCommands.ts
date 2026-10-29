import * as vscode from 'vscode';
import { AssessmentApiError } from './assessmentApiClient';
import type { AssessmentController } from './assessmentController';
import type { DisclosureContext } from './assessmentDisclosureConsent';
import type { DisclosureChoiceUI } from './assessmentDisclosureChoices';
import { CATEGORY_CHOICES } from './assessmentDisclosureChoices';
import { AssessmentProcessingConsent, PROCESSOR_UNAVAILABLE } from './assessmentProcessingConsent';
import type { ProcessorScope, ProcessingSelection, ProcessingState } from './processingConsent';
import type { ProcessingAction } from './railsProcessingConsentClient';

export const CONFIGURE_PROCESSING_COMMAND = 'ai-developer-tracker.configureAssessmentAiProcessingConsent';
export const STATUS_PROCESSING_COMMAND = 'ai-developer-tracker.showAssessmentAiProcessingConsent';
export const REVOKE_PROCESSING_COMMAND = 'ai-developer-tracker.revokeAssessmentAiProcessingConsent';
export const PROCESSING_NOTICE = 'assessment-ai-processing.v1 — AI may analyze permitted assessment activity for performance evaluation, potentially through an external AI service. This is separate from recording, upload, AI content capture and recruiter disclosure consent. Only newly captured, independently authorized evidence can qualify; old evidence gains no permission. Rails currently permits preparation only: external processing is disabled and provider retention is not approved. Withdrawal blocks future preparation, including previously captured evidence under that receipt; it does not delete evidence or undo prior processing. The policy for any future reports remains unresolved; no reports are created in this release.';
const statusNotice = 'External AI processing is disabled by the current Rails policy. Consent does not start evaluation or change evidence, recording, upload or recruiter disclosure permissions.';
export interface ProcessingUI extends DisclosureChoiceUI {
	message(text: string): void;
	choose(states: ProcessingState[]): Promise<ProcessingState | undefined>;
}
export async function chooseProcessing(ui: DisclosureChoiceUI, processor: ProcessorScope,
	scope: Awaited<ReturnType<AssessmentProcessingConsent['choices']>>): Promise<ProcessingSelection | undefined> {
	const categories = await ui.select('Choose optional AI processing categories', CATEGORY_CHOICES.map(c => ({ ...c })));
	if (!categories?.length) { return undefined; }
	const workspaceIds = await ui.select('Choose approved assessment workspaces for AI processing', scope.workspaceIds.map((value, i) => ({ label: `Approved workspace ${i + 1}`, value, picked: false })));
	if (!workspaceIds?.length) { return undefined; }
	let sourceSessions: ProcessingSelection['sourceSessions'] = [];
	if (categories.some(c => c !== 'code_changes')) {
		const eligible = scope.sources.filter(s => workspaceIds.includes(s.workspaceId));
		if (!eligible.length) { throw new AssessmentApiError('consent_required'); }
		const selected = await ui.select('Choose confirmed, content-approved AI sessions for processing', eligible.map((s, i) => ({ label: `${s.session.source === 'codex' ? 'Codex' : 'Claude Code'} session ${i + 1}`, value: s.session, picked: false })));
		if (!selected?.length) { return undefined; } sourceSessions = selected;
	}
	if (!await ui.confirm(`${PROCESSING_NOTICE}\n\nTrusted processor configuration: ${processor.provider}; model: ${processor.model}; origin: ${processor.origin}. Purpose: assessment_performance_evaluation. The compatible adapter name alone does not identify or approve an external provider.`)) { return undefined; }
	return { categories, workspaceIds, sourceSessions };
}
/** Injectable command body: plaintext evidence never enters this control path. */
export async function performProcessingAction(action: ProcessingAction, context: DisclosureContext, consent: AssessmentProcessingConsent, ui: ProcessingUI, signal: AbortSignal): Promise<void> {
	if (action === 'grant') {
		const processor = await consent.processor(context);
		if (!processor) { ui.message(PROCESSOR_UNAVAILABLE); return; }
		const selected = await chooseProcessing(ui, processor, await consent.choices(context));
		if (!selected) { ui.message('No new AI processing consent granted. Existing choices are unchanged; use Revoke Assessment AI Processing Consent to withdraw a previous grant.'); return; }
		const state = await consent.grant(context, selected, processor, signal);
		ui.message(`AI processing consent registered: ${state.pendingAction ? 'server action unconfirmed' : state.receipt!.state}. ${statusNotice}`); return;
	}
	const states = await consent.list(context);
	if (!states.length) { ui.message(`No AI processing consent is recorded locally for this assessment. This is not a server-wide consent search. ${PROCESSOR_UNAVAILABLE}`); return; }
	const selected = states.length === 1 ? states[0] : await ui.choose(states); if (!selected) { return; }
	if (action === 'revoke' && !await ui.confirm('Withdraw AI processing consent? This blocks future preparation under this receipt, including previously captured evidence. It does not delete evidence or undo processing already performed. Local withdrawal intent is saved before contacting Rails; network failure leaves server revocation unconfirmed. Recording, upload and recruiter disclosure choices are unchanged.')) { return; }
	const state = await (action === 'revoke' ? consent.revoke(context, selected, signal) : consent.inspect(context, selected, signal));
	ui.message(`AI processing: ${state.locallyRevoked ? 'locally withdrawn; ' : ''}${state.pendingAction ? 'server action unconfirmed' : state.receipt?.state === 'revoked' ? 'revoked (server confirmed)' : state.receipt?.state ?? 'unconfirmed'}.
${state.receipt ? `Last confirmed capture window: ${state.receipt.consented_at} to ${state.receipt.capture_until}. Processing receipt expires: ${state.receipt.expires_at}. ` : ''}${statusNotice}`);
}
export function registerProcessingCommands(controller: Pick<AssessmentController, 'withDisclosureContext'>, consent?: AssessmentProcessingConsent): vscode.Disposable[] {
	const ui: ProcessingUI = {
		select: async (title, choices) => (await vscode.window.showQuickPick(choices, { title, canPickMany: true, ignoreFocusOut: true }))?.map(c => c.value),
		confirm: async detail => await vscode.window.showWarningMessage('Confirm AI processing consent choice', { modal: true, detail }, 'Confirm AI Processing Choice') === 'Confirm AI Processing Choice',
		message: text => { void vscode.window.showInformationMessage(text); },
		choose: async states => (await vscode.window.showQuickPick(states.map((state, i) => ({ label: `AI processing grant ${i + 1}`,
			description: state.pendingAction ? 'Server action unconfirmed' : state.receipt?.state ?? 'Unconfirmed', state })), { title: 'Choose AI processing grant', ignoreFocusOut: true }))?.state
	};
	const perform = async (action: ProcessingAction) => {
		try {
			if (!consent) { ui.message(PROCESSOR_UNAVAILABLE); return; }
			await controller.withDisclosureContext(action === 'grant', context => performProcessingAction(action, context, consent, ui, AbortSignal.timeout(10000)));
		} catch (error) {
			const code = error instanceof AssessmentApiError ? error.code : 'unavailable';
			void vscode.window.showWarningMessage(`AI processing consent action not confirmed (${code}). No processing permission is assumed. Pair the correct assessment; a grant also requires active recording, upload consent and a trusted server processor policy. Reconnect and explicitly retry a pending action. Do not replay a grant to discover an unknown receipt. Evidence and other consent choices are unchanged.`);
		}
	};
	return [vscode.commands.registerCommand(CONFIGURE_PROCESSING_COMMAND, () => perform('grant')),
		vscode.commands.registerCommand(STATUS_PROCESSING_COMMAND, () => perform('status')),
		vscode.commands.registerCommand(REVOKE_PROCESSING_COMMAND, () => perform('revoke'))];
}
