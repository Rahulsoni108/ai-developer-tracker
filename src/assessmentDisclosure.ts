import { isUuid } from './eventSchema';
import { utcTime } from './evidenceConsent';
import { validOrigin } from './evidenceApproval';

export const DISCLOSURE_VERSION = 'assessment-disclosure.v1';
export const DISCLOSURE_CATEGORIES = ['ai_interactions', 'code_changes', 'tool_activity'] as const;
export type DisclosureCategory = typeof DISCLOSURE_CATEGORIES[number];
export interface DisclosureSource { source: 'codex' | 'claude'; source_session_id: string }
export interface DisclosureRequest {
	request_id: string; local_recording_session_id: string; upload_consent_id: string;
	approval_action: 'approve_recruiter_disclosure'; consent_version: typeof DISCLOSURE_VERSION;
	audience: 'job_owning_recruiter'; purpose: 'assessment_review'; categories: DisclosureCategory[];
	approved_workspace_ids: string[]; approved_source_sessions: DisclosureSource[];
}
export interface DisclosureReceipt {
	consent_id: string; upload_consent_id: string; local_recording_session_id: string;
	consent_version: typeof DISCLOSURE_VERSION; audience: 'job_owning_recruiter'; purpose: 'assessment_review';
	categories: DisclosureCategory[]; approved_workspace_ids: string[]; approved_source_sessions: DisclosureSource[];
	consented_at: string; expires_at: string; revoked_at: string | null; server_time: string;
	state: 'active' | 'revoked' | 'expired'; upload_scope_state: 'active' | 'stopped' | 'revoked' | 'expired';
	raw_disclosure_enabled: false; event_authorization: 'capture_approval_contract_required';
}
/** Encrypted control state, never an event authorization. No bearer credentials or event content. */
export interface DisclosureState {
	version: 1; codingSessionId: string; origin: string; credentialDigest: string;
	deadline: string; request: DisclosureRequest; locallyRevoked: boolean;
	pendingAction?: 'grant' | 'revoke'; receipt?: DisclosureReceipt;
}
const uuid = (v: unknown): v is string => isUuid(v) && v === v.toLowerCase();
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: object, names: string[]) => Object.keys(v).every(k => names.includes(k));
const list = (v: unknown, max: number, valid: (v: unknown) => boolean): v is unknown[] => Array.isArray(v) && v.length > 0 && v.length <= max && v.every(valid) && new Set(v).size === v.length;
export const disclosureSourceKey = (v: DisclosureSource): string => JSON.stringify([v.source, v.source_session_id]);
export function validDisclosureSources(v: unknown): v is DisclosureSource[] {
	return Array.isArray(v) && v.length <= 32 && v.every(s => object(s) && keys(s, ['source', 'source_session_id'])
		&& ['codex', 'claude'].includes(s.source as string) && typeof s.source_session_id === 'string'
		&& s.source_session_id.length > 0 && s.source_session_id.length <= 256 && s.source_session_id.trim() === s.source_session_id
		&& !/[\x00-\x1f\x7f]/.test(s.source_session_id)) && new Set(v.map(disclosureSourceKey)).size === v.length;
}
export function validDisclosureRequest(v: DisclosureRequest): boolean {
	return object(v) && keys(v, ['request_id', 'local_recording_session_id', 'upload_consent_id', 'approval_action', 'consent_version', 'audience', 'purpose', 'categories', 'approved_workspace_ids', 'approved_source_sessions'])
		&& [v.request_id, v.local_recording_session_id, v.upload_consent_id].every(uuid)
		&& v.approval_action === 'approve_recruiter_disclosure' && v.consent_version === DISCLOSURE_VERSION
		&& v.audience === 'job_owning_recruiter' && v.purpose === 'assessment_review'
		&& list(v.categories, 3, c => DISCLOSURE_CATEGORIES.includes(c as DisclosureCategory))
		&& list(v.approved_workspace_ids, 32, w => typeof w === 'string' && /^[a-f0-9]{64}$/.test(w))
		&& validDisclosureSources(v.approved_source_sessions)
		&& (v.categories.some(c => c !== 'code_changes') ? v.approved_source_sessions.length > 0 : v.approved_source_sessions.length === 0)
		&& Buffer.byteLength(JSON.stringify(v)) <= 4096;
}
const sameList = (a: unknown[], b: unknown[]): boolean => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export function validDisclosureReceipt(v: DisclosureReceipt, state: DisclosureState): boolean {
	const r = state.request;
	return object(v) && keys(v, ['consent_id', 'upload_consent_id', 'local_recording_session_id', 'consent_version', 'audience', 'purpose', 'categories', 'approved_workspace_ids', 'approved_source_sessions', 'consented_at', 'expires_at', 'revoked_at', 'server_time', 'state', 'upload_scope_state', 'raw_disclosure_enabled', 'event_authorization'])
		&& uuid(v.consent_id) && v.upload_consent_id === r.upload_consent_id && v.local_recording_session_id === r.local_recording_session_id
		&& v.consent_version === r.consent_version && v.audience === r.audience && v.purpose === r.purpose
		&& Array.isArray(v.categories) && sameList(v.categories, r.categories)
		&& Array.isArray(v.approved_workspace_ids) && sameList(v.approved_workspace_ids, r.approved_workspace_ids)
		&& validDisclosureSources(v.approved_source_sessions) && sameList(v.approved_source_sessions.map(disclosureSourceKey), r.approved_source_sessions.map(disclosureSourceKey))
		&& [v.consented_at, v.expires_at, v.server_time].every(utcTime)
		&& Date.parse(v.consented_at) <= Date.parse(v.server_time) && Date.parse(v.consented_at) < Date.parse(v.expires_at)
		&& Date.parse(v.expires_at) <= Date.parse(state.deadline)
		&& (v.revoked_at === null || utcTime(v.revoked_at) && Date.parse(v.revoked_at) >= Date.parse(v.consented_at) && Date.parse(v.revoked_at) <= Date.parse(v.server_time))
		&& ['active', 'revoked', 'expired'].includes(v.state) && ['active', 'stopped', 'revoked', 'expired'].includes(v.upload_scope_state)
		&& (v.state !== 'active' || v.revoked_at === null && Date.parse(v.server_time) < Date.parse(v.expires_at))
		&& (v.state !== 'revoked' || v.revoked_at !== null) && (v.state !== 'expired' || Date.parse(v.server_time) >= Date.parse(v.expires_at))
		&& v.raw_disclosure_enabled === false && v.event_authorization === 'capture_approval_contract_required';
}
export function validDisclosureState(v: DisclosureState): boolean {
	return object(v) && keys(v, ['version', 'codingSessionId', 'origin', 'credentialDigest', 'deadline', 'request', 'locallyRevoked', 'pendingAction', 'receipt'])
		&& v.version === 1 && typeof v.codingSessionId === 'string' && /^[1-9][0-9]{0,19}$/.test(v.codingSessionId)
		&& validOrigin(v.origin) && typeof v.credentialDigest === 'string' && /^[a-f0-9]{64}$/.test(v.credentialDigest)
		&& utcTime(v.deadline) && validDisclosureRequest(v.request) && typeof v.locallyRevoked === 'boolean'
		&& (v.pendingAction === undefined || ['grant', 'revoke'].includes(v.pendingAction))
		&& (!v.locallyRevoked || v.pendingAction !== 'grant') && (v.receipt === undefined || validDisclosureReceipt(v.receipt, v));
}
