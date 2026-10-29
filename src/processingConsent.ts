import { canonicalJson } from './canonicalJson';
import { DISCLOSURE_CATEGORIES, disclosureSourceKey, validDisclosureSources, type DisclosureCategory, type DisclosureSource } from './assessmentDisclosure';
import { utcTime } from './evidenceConsent';
import { validOrigin } from './evidenceApproval';
import { isUuid } from './eventSchema';
import { exactObject } from './railsControlResponse';

export const PROCESSING_VERSION = 'assessment-ai-processing.v1';
export const PROCESSING_PURPOSE = 'assessment_performance_evaluation';
export const PROCESSING_RETENTION = 'ephemeral-preparation.v1';
export interface ProcessorScope {
	backend: 'direct'; provider: 'openai_compatible'; model: string; origin: string; configuration_digest: string;
}
export interface ProcessingSelection { categories: DisclosureCategory[]; workspaceIds: string[]; sourceSessions: DisclosureSource[] }
export interface ProcessingRequest {
	request_id: string; local_recording_session_id: string; upload_consent_id: string;
	approval_action: 'approve_assessment_ai_processing'; consent_version: typeof PROCESSING_VERSION;
	purpose: typeof PROCESSING_PURPOSE; retention_policy_version: typeof PROCESSING_RETENTION;
	external_processing_permitted: boolean; processor_scope: ProcessorScope;
	categories: DisclosureCategory[]; approved_workspace_ids: string[]; approved_source_sessions: DisclosureSource[];
}
export const PROCESSING_LIMITATIONS = {
	retention_policy_version: PROCESSING_RETENTION, prepared_input_persistence: 'none', external_processing_enabled: false,
	provider_retention: 'not_approved', withdrawal: 'blocks_future_preparation', existing_report_policy: 'unresolved_no_reports_created'
} as const;
export interface ProcessingReceipt {
	consent_id: string; local_recording_session_id: string; upload_consent_id: string;
	consent_version: typeof PROCESSING_VERSION; purpose: typeof PROCESSING_PURPOSE;
	retention_policy_version: typeof PROCESSING_RETENTION; external_processing_permitted: boolean;
	processor_scope: ProcessorScope; categories: DisclosureCategory[]; approved_workspace_ids: string[]; approved_source_sessions: DisclosureSource[];
	consented_at: string; capture_until: string; expires_at: string; revoked_at: string | null;
	external_processing_enabled: false; limitations: typeof PROCESSING_LIMITATIONS;
	state: 'preparation_only' | 'declined' | 'revoked' | 'expired';
}
/** SecretStorage control ledger only. Never an event approval or authority to call a model. */
export interface ProcessingState {
	version: 1; codingSessionId: string; origin: string; credentialDigest: string; deadline: string;
	request: ProcessingRequest; receipt?: ProcessingReceipt; locallyRevoked: boolean; pendingAction?: 'grant' | 'revoke';
}
const requestKeys = ['request_id', 'local_recording_session_id', 'upload_consent_id', 'approval_action', 'consent_version', 'purpose',
	'retention_policy_version', 'external_processing_permitted', 'processor_scope', 'categories', 'approved_workspace_ids', 'approved_source_sessions'];
const receiptKeys = ['consent_id', 'local_recording_session_id', 'upload_consent_id', 'consent_version', 'purpose', 'retention_policy_version',
	'external_processing_permitted', 'processor_scope', 'categories', 'approved_workspace_ids', 'approved_source_sessions', 'consented_at',
	'capture_until', 'expires_at', 'revoked_at', 'external_processing_enabled', 'limitations', 'state'];
const uuid = (v: unknown): v is string => isUuid(v) && v === v.toLowerCase();
const list = (v: unknown, max: number, check: (v: unknown) => boolean): v is string[] => Array.isArray(v) && v.length > 0
	&& v.length <= max && v.every(check) && new Set(v).size === v.length;
export function sameProcessingValue(a: unknown, b: unknown): boolean {
	try { return canonicalJson(a) === canonicalJson(b); } catch { return false; }
}
export function validProcessorScope(v: unknown): v is ProcessorScope {
	return exactObject(v, ['backend', 'provider', 'model', 'origin', 'configuration_digest']) && v.backend === 'direct'
		&& v.provider === 'openai_compatible' && typeof v.model === 'string' && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(v.model)
		&& validOrigin(v.origin) && typeof v.configuration_digest === 'string' && /^[a-f0-9]{64}$/.test(v.configuration_digest);
}
export function validProcessingRequest(v: unknown): v is ProcessingRequest {
	return exactObject(v, requestKeys) && [v.request_id, v.local_recording_session_id, v.upload_consent_id].every(uuid)
		&& v.approval_action === 'approve_assessment_ai_processing' && v.consent_version === PROCESSING_VERSION
		&& v.purpose === PROCESSING_PURPOSE && v.retention_policy_version === PROCESSING_RETENTION
		&& typeof v.external_processing_permitted === 'boolean' && validProcessorScope(v.processor_scope)
		&& list(v.categories, 3, c => DISCLOSURE_CATEGORIES.includes(c as DisclosureCategory))
		&& list(v.approved_workspace_ids, 32, w => typeof w === 'string' && /^[a-f0-9]{64}$/.test(w))
		&& validDisclosureSources(v.approved_source_sessions)
		&& (v.categories.some(c => c !== 'code_changes') ? v.approved_source_sessions.length > 0 : v.approved_source_sessions.length === 0)
		&& Buffer.byteLength(JSON.stringify(v)) <= 4096;
}
const sameList = (a: unknown, b: string[]): boolean => Array.isArray(a) && sameProcessingValue([...a].sort(), [...b].sort());
export function validProcessingReceipt(v: unknown, request: ProcessingRequest, deadline: string, previous?: ProcessingReceipt): v is ProcessingReceipt {
	if (!validProcessingRequest(request) || !utcTime(deadline) || !exactObject(v, receiptKeys) || !uuid(v.consent_id)
		|| v.local_recording_session_id !== request.local_recording_session_id || v.upload_consent_id !== request.upload_consent_id
		|| v.consent_version !== PROCESSING_VERSION || v.purpose !== PROCESSING_PURPOSE || v.retention_policy_version !== PROCESSING_RETENTION
		|| v.external_processing_permitted !== request.external_processing_permitted || !validProcessorScope(v.processor_scope)
		|| !sameProcessingValue(v.processor_scope, request.processor_scope) || !sameList(v.categories, request.categories)
		|| !sameList(v.approved_workspace_ids, request.approved_workspace_ids) || !validDisclosureSources(v.approved_source_sessions)
		|| !sameList(v.approved_source_sessions.map(disclosureSourceKey), request.approved_source_sessions.map(disclosureSourceKey))
		|| !utcTime(v.consented_at) || !utcTime(v.capture_until) || !utcTime(v.expires_at)
		|| Date.parse(v.capture_until) <= Date.parse(v.consented_at) || Date.parse(v.capture_until) > Date.parse(deadline)
		|| Date.parse(v.expires_at) - Date.parse(v.consented_at) !== 24 * 60 * 60 * 1000
		|| v.external_processing_enabled !== false || !sameProcessingValue(v.limitations, PROCESSING_LIMITATIONS)
		|| !['preparation_only', 'declined', 'revoked', 'expired'].includes(v.state as string)
		|| v.revoked_at !== null && (!utcTime(v.revoked_at) || Date.parse(v.revoked_at) < Date.parse(v.consented_at))
		|| (v.state === 'revoked') !== (v.revoked_at !== null)
		|| v.state === 'preparation_only' && !v.external_processing_permitted || v.state === 'declined' && v.external_processing_permitted) { return false; }
	// Status can change state/revocation only. It cannot replace the immutable receipt or renew its window.
	if (previous) {
		const immutable = (r: object) => Object.fromEntries(Object.entries(r).filter(([k]) => !['state', 'revoked_at'].includes(k)));
		if (!sameProcessingValue(immutable(v), immutable(previous)) || previous.revoked_at !== null && v.revoked_at !== previous.revoked_at
			|| previous.state === 'expired' && !['expired', 'revoked'].includes(v.state as string)) { return false; }
	}
	return true;
}
export function validProcessingState(v: unknown): v is ProcessingState {
	return exactObject(v, ['version', 'codingSessionId', 'origin', 'credentialDigest', 'deadline', 'request', 'locallyRevoked'], ['receipt', 'pendingAction'])
		&& v.version === 1 && typeof v.codingSessionId === 'string' && /^[1-9][0-9]{0,19}$/.test(v.codingSessionId) && validOrigin(v.origin)
		&& typeof v.credentialDigest === 'string' && /^[a-f0-9]{64}$/.test(v.credentialDigest) && utcTime(v.deadline)
		&& validProcessingRequest(v.request) && typeof v.locallyRevoked === 'boolean'
		&& (v.pendingAction === undefined || ['grant', 'revoke'].includes(v.pendingAction as string))
		&& (!v.locallyRevoked || v.pendingAction !== 'grant') && (v.receipt === undefined || validProcessingReceipt(v.receipt, v.request, v.deadline));
}
