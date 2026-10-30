import { canonicalSha256 } from './canonicalJson';
import { isUuid } from './eventSchema';
import { validAssessmentProcessorPolicy, type AssessmentProcessorPolicy } from './processorPolicy';
import { exactObject } from './railsControlResponse';

/** Proposed capability. Existing Rails versions must never be treated as supporting it. */
export const WORKFLOW_CONSENT_VERSION = 'assessment-workflow.v1';
export const WORKFLOW_SOURCE_MODE = 'extension_launched_only';
export const WORKFLOW_PROVIDERS = ['claude', 'codex'] as const;
export type WorkflowProvider = typeof WORKFLOW_PROVIDERS[number];
export interface WorkflowPolicy {
	consent_version: typeof WORKFLOW_CONSENT_VERSION;
	source_mode: typeof WORKFLOW_SOURCE_MODE;
	providers: WorkflowProvider[];
	processor_policy: AssessmentProcessorPolicy;
}
export interface WorkflowStartRequest {
	request_id: string;
	local_recording_session_id: string;
	consent_version: typeof WORKFLOW_CONSENT_VERSION;
	approval_action: 'approve_assessment_workflow';
	approved_workspace_ids: string[];
	providers: WorkflowProvider[];
	processing_policy_digest: string;
}
export interface WorkflowSourceRequest {
	workflow_consent_id: string;
	request_id: string;
	workspace_id: string;
	source: WorkflowProvider;
	source_session_id: string;
}
const uuid = (value: unknown): value is string => isUuid(value) && value === value.toLowerCase();
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const providers = (value: unknown): value is WorkflowProvider[] => Array.isArray(value) && value.length > 0
	&& value.length <= WORKFLOW_PROVIDERS.length && new Set(value).size === value.length
	&& value.every(item => WORKFLOW_PROVIDERS.includes(item));

/** Authentication/TLS must establish the origin; a policy digest alone is not server authentication. */
export function validWorkflowPolicy(value: unknown, codingSessionId: string): value is WorkflowPolicy {
	return exactObject(value, ['consent_version', 'source_mode', 'providers', 'processor_policy'])
		&& value.consent_version === WORKFLOW_CONSENT_VERSION && value.source_mode === WORKFLOW_SOURCE_MODE
		&& providers(value.providers) && validAssessmentProcessorPolicy(value.processor_policy)
		&& value.processor_policy.coding_session_id === codingSessionId && value.processor_policy.evaluation_enabled;
}
export function validWorkflowStartRequest(value: unknown): value is WorkflowStartRequest {
	return exactObject(value, ['request_id', 'local_recording_session_id', 'consent_version', 'approval_action',
		'approved_workspace_ids', 'providers', 'processing_policy_digest'])
		&& uuid(value.request_id) && uuid(value.local_recording_session_id)
		&& value.consent_version === WORKFLOW_CONSENT_VERSION && value.approval_action === 'approve_assessment_workflow'
		&& Array.isArray(value.approved_workspace_ids) && value.approved_workspace_ids.length > 0
		&& value.approved_workspace_ids.length <= 32 && value.approved_workspace_ids.every(hash)
		&& new Set(value.approved_workspace_ids).size === value.approved_workspace_ids.length
		&& providers(value.providers) && hash(value.processing_policy_digest)
		&& Buffer.byteLength(JSON.stringify(value)) <= 4096;
}
export function validWorkflowSourceRequest(value: unknown): value is WorkflowSourceRequest {
	return exactObject(value, ['workflow_consent_id', 'request_id', 'workspace_id', 'source', 'source_session_id'])
		&& [value.workflow_consent_id, value.request_id, value.source_session_id].every(uuid)
		&& hash(value.workspace_id) && WORKFLOW_PROVIDERS.includes(value.source as WorkflowProvider);
}

/** Binds one UI approval to the exact assessment, destination and notice scope.
 * This is consistency evidence, never proof of trusted execution or human consent. */
export function workflowIntentDigest(codingSessionId: string, httpsOrigin: string, request: WorkflowStartRequest): string {
	if (!/^[1-9][0-9]{0,19}$/.test(codingSessionId) || !validWorkflowStartRequest(request)) { throw new Error('Invalid workflow intent.'); }
	try {
		const origin = new URL(httpsOrigin);
		if (origin.protocol !== 'https:' || origin.origin !== httpsOrigin || origin.username || origin.password) { throw new Error(); }
	} catch { throw new Error('Invalid workflow destination.'); }
	return canonicalSha256({ codingSessionId, httpsOrigin, request: { ...request,
		approved_workspace_ids: [...request.approved_workspace_ids].sort(), providers: [...request.providers].sort() } });
}

/** A candidate must explicitly approve this notice. It is not itself a permission. */
export function workflowConsentNotice(policy: WorkflowPolicy, codingSessionId: string, hostname: string, workspaceCount: number): string {
	if (!validWorkflowPolicy(policy, codingSessionId) || !/^[a-zA-Z0-9.-]{1,253}$/.test(hostname)
		|| !Number.isInteger(workspaceCount) || workspaceCount < 1 || workspaceCount > 32) { throw new Error('Workflow consent unavailable.'); }
	const processor = policy.processor_policy;
	return `This assessment will record file activity, initial code baselines and code changes in ${workspaceCount} approved workspace folder(s). `
		+ `Privacy-filtered evidence will be encrypted locally and uploaded to ${hostname}. `
		+ `New assessment sessions launched through the tracker for ${policy.providers.join(' and ')} may record your prompts, visible responses and tool activity while recording is active. `
		+ 'Unrelated chats, previous conversation history, private reasoning and system/developer instructions are excluded. Native chats without verified assessment linkage are not automatically included.\n\n'
		+ 'Authorized job-owning recruiters may review permitted AI interactions, code changes and tool activity for assessment review. '
		+ `Separately, ${processor.processor.name} (${processor.processor_scope.model}) may process permitted evidence for assessment performance evaluation using an external AI service. `
		+ `Provider policy: operator-approved no training. Reports are retained for ${processor.terms.report_retention_days} days.\n\n`
		+ 'Agree & Start explicitly approves recording, scoped uploads, recruiter disclosure, AI processing and prospective enrollment of supported assessment-launched AI sessions. '
		+ 'These remain separate permissions with separate receipts. Approval applies prospectively to this assessment and recording only. '
		+ 'Disclosure withdrawal blocks future capture authorization; previously authorized evidence can remain reviewable. Processing withdrawal blocks undispatched requests; existing reports remain until expiry. '
		+ 'Revocation does not delete evidence or recall already transmitted/processed data. Stop Recording ends capture. Cancel does not start this assessment.';
}
