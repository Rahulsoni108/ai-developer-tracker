import type { DisclosureCategory, DisclosureSource } from './assessmentDisclosure';
import type { DisclosureSelection } from './assessmentDisclosureConsent';

export const DISCLOSURE_NOTICE = 'assessment-disclosure.v1 — Selected assessment evidence may be visible to the authorized recruiter who owns this job, solely for assessment review. Recording, upload and disclosure are separate choices. No training, scoring or blanket surveillance. Current Rails support registers scope only: raw content remains unavailable until a matching capture-time event contract is implemented. Existing events cannot acquire disclosure permission.';
export const CATEGORY_CHOICES: { label: string; value: DisclosureCategory; picked: false }[] = [
	{ label: 'AI prompts and relevant visible responses', value: 'ai_interactions', picked: false },
	{ label: 'Source-code changes and diffs', value: 'code_changes', picked: false },
	{ label: 'AI tool activity (potentially sensitive inputs and outputs)', value: 'tool_activity', picked: false }
];
export interface DisclosureChoiceUI {
	select<T>(title: string, choices: { label: string; value: T; picked: false }[]): Promise<T[] | undefined>;
	confirm(notice: string): Promise<boolean>;
}
/** Pure, injectable selection flow. All independent choices start unselected. No defaults on cancellation. */
export async function chooseDisclosure(ui: DisclosureChoiceUI, scope: { workspaceIds: string[]; sources: { workspaceId: string; session: DisclosureSource }[] }): Promise<DisclosureSelection | undefined> {
	const categories = await ui.select('Choose optional recruiter disclosure categories', CATEGORY_CHOICES);
	if (!categories?.length) { return undefined; }
	const workspaceIds = await ui.select('Choose approved assessment workspaces', scope.workspaceIds.map((value, i) => ({ label: `Approved workspace ${i + 1}`, value, picked: false })));
	if (!workspaceIds?.length) { return undefined; }
	let sourceSessions: DisclosureSource[] = [];
	if (categories.some(c => c !== 'code_changes')) {
		const eligible = scope.sources.filter(s => workspaceIds.includes(s.workspaceId));
		if (!eligible.length) { throw new Error('source_selection_required'); }
		const selected = await ui.select('Choose already confirmed, content-approved AI sessions', eligible.map((s, i) => ({ label: `${s.session.source === 'codex' ? 'Codex' : 'Claude Code'} session ${i + 1}`, value: s.session, picked: false })));
		if (!selected?.length) { return undefined; } sourceSessions = selected;
	}
	if (!await ui.confirm(DISCLOSURE_NOTICE)) { return undefined; }
	return { categories, workspaceIds, sourceSessions };
}
