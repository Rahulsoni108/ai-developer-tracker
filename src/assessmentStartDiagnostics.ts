import type { AssessmentFailure } from './assessmentApiClient';
import type { WorkspaceFolder } from 'vscode';
import type { FileTracker } from './fileTracker';

/** Fixed codes only. No IDs, tokens, folder names, paths, responses or evidence. */
export type AssessmentStartStep = 'requested' | 'manual_recording_active' | 'recording_start_pending' | 'credential_check' | 'server_status' | 'recording_consent'
	| 'recording_consent_declined' | 'request_cancelled' | 'maintenance_active' | 'storage_unavailable' | 'workspace_required'
	| 'workspace_storage_overlap' | 'workspace_approval' | 'workspace_approved' | 'workspace_changed' | 'workspace_unavailable'
	| 'workspace_not_approved' | 'local_storage' | 'diff_baseline' | 'assessment_authorization' | 'upload_consent'
	| 'binding_write' | 'rails_start' | 'binding_validation' | 'evidence_consent' | 'recording_activation' | 'assessment_active';
export interface AssessmentStartDiagnostic { step: AssessmentStartStep; status: 'running' | 'failed' | 'active'; reason?: AssessmentFailure }
export function describeAssessmentStart(value: AssessmentStartDiagnostic): string {
	const actions: Partial<Record<AssessmentStartStep, string>> = {
		manual_recording_active: 'A separate manual recording is active. Run Stop Recording (Without Submitting), wait for local writes to drain, then run Start Assessment again. Existing evidence is retained and will not be attached to the assessment.',
		recording_start_pending: 'Another local recording is still being prepared. Finish or cancel its dialog, or run Stop Recording (Without Submitting), then retry Start Assessment. No existing recording will be adopted.',
		recording_consent_declined: 'Run Start Assessment again and approve recording only if you agree.',
		recording_consent: 'Complete the recording confirmation in this Extension Development Host.',
		request_cancelled: 'The recording request was cancelled. Check workspace changes or Stop/Disable actions, then retry.',
		maintenance_active: 'Wait for local data maintenance to finish, then retry.',
		storage_unavailable: 'Use Show Local Queue Health, resolve storage/key availability, then reload.',
		workspace_required: 'Open the approved local assessment folder in this host, then retry.',
		workspace_storage_overlap: 'Open an assessment folder outside the extension storage directory.',
		workspace_approval: 'Workspace indexing is still running. Check this host’s workspace and its read permissions.',
		workspace_unavailable: 'Check that every assessment folder exists locally and can be read, then retry.',
		workspace_not_approved: 'Workspace selection did not complete. Retry with the current approved local folders.',
		workspace_changed: 'Workspace folders changed during confirmation. Retry to approve the current folders.',
		local_storage: 'Use Show Local Queue Health to check storage, encryption keys and maintenance.',
		diff_baseline: 'Initial file baselines must finish before upload consent and Rails start. Check workspace size, exclusions and file access.',
		upload_consent: 'Approve the separate destination upload dialog only if you agree. Recording consent alone is insufficient.',
		credential_check: 'Check this host’s paired connection and SecretStorage access. Do not erase evidence or credentials.',
		server_status: 'Check the trusted HTTPS origin, connectivity and session eligibility; the server remains authoritative.',
		binding_write: 'Check local queue and connection storage. No binding or timer may be invented locally.',
		rails_start: 'Check HTTPS connectivity and session eligibility. Retry preserves the original binding and deadline.',
		binding_validation: 'The server response must match the authorized recording and original timing. No local timer fallback is allowed.',
		evidence_consent: 'Recording requires a valid scoped Rails evidence-consent receipt. Check authorization and connectivity.',
		recording_activation: 'Recording was cancelled during preparation. Review the preceding recording prerequisite messages and retry.'
	};
	return `Assessment start: ${value.status}; prerequisite: ${value.step}${value.reason ? `; code: ${value.reason}` : ''}.`
		+ (value.status !== 'active' && actions[value.step] ? ' ' + actions[value.step] : '');
}

/** The actual post-dialog production path, shared with integration tests. Approval is
 * valid only for the original request and exactly the still-open, selected folders. */
export async function approveRecordingWorkspaces(folders: readonly WorkspaceFolder[], tracker: Pick<FileTracker, 'selectWorkspaces' | 'getApprovedFolders'>,
	current: () => boolean, getFolders: () => readonly WorkspaceFolder[] | undefined, report: (step: AssessmentStartStep) => void): Promise<boolean> {
	if (!current()) { report('request_cancelled'); return false; }
	report('workspace_approval');
	try { await tracker.selectWorkspaces(folders); }
	catch (error) { report('workspace_unavailable'); throw error; }
	if (!current()) { report('request_cancelled'); return false; }
	const same = (other: readonly WorkspaceFolder[]) => other.length === folders.length
		&& folders.every(folder => other.some(candidate => candidate.uri.toString() === folder.uri.toString()));
	if (!same(getFolders() ?? [])) { report('workspace_changed'); return false; }
	if (!same(tracker.getApprovedFolders())) { report('workspace_not_approved'); return false; }
	report('workspace_approved'); return true;
}
