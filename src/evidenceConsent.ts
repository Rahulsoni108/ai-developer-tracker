import { isUuid, type TrackerEvent } from './eventSchema';
import { PRIVACY_EVENT_TYPES } from './privacyFilter';
import { validOrigin } from './evidenceApproval';

export const EVIDENCE_CONSENT_VERSION = 'assessment-evidence.v1';
export interface EvidenceConsentRequest {
	request_id: string;
	local_recording_session_id: string;
	approval_action: 'approve_upload';
	consent_version: typeof EVIDENCE_CONSENT_VERSION;
	scope: 'assessment_evidence';
	approved_workspace_ids: string[];
	event_types: TrackerEvent['eventType'][];
}
export interface EvidenceConsentReceipt {
	consent_id: string;
	local_recording_session_id: string;
	consent_version: typeof EVIDENCE_CONSENT_VERSION;
	scope: 'assessment_evidence';
	approved_workspace_ids: string[];
	event_types: TrackerEvent['eventType'][];
	destination_origin: string;
	consented_at: string;
	expires_at: string;
	server_time: string;
	state: 'active' | 'stopped' | 'revoked' | 'expired';
	evidence_window: { starts_at: string; ends_at: string; stopped_at?: string };
	revoked_at?: string;
	upload_authorized: false;
	privacy_authorization: 'unverified';
}
/** Encrypted storage only. A pending intent is never an authorization. No credentials here. */
export interface EvidenceConsentState {
	version: 1;
	codingSessionId: string;
	origin: string;
	request: EvidenceConsentRequest;
	deadline: string;
	pendingAction?: 'register' | 'stop' | 'revoke';
	locallyRevoked: boolean;
	captureClosed: boolean;
	receipt?: EvidenceConsentReceipt;
}
const canonicalUuid = (id: unknown): id is string => isUuid(id) && id === id.toLowerCase();
export const utcTime = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
	&& Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function exactKeys(value: object, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function uniqueList(value: unknown, max: number, valid: (entry: unknown) => boolean): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.length <= max && value.every(valid) && new Set(value).size === value.length;
}
export function validConsentRequest(value: EvidenceConsentRequest): boolean {
	return !!value && exactKeys(value, ['request_id', 'local_recording_session_id', 'approval_action', 'consent_version', 'scope', 'approved_workspace_ids', 'event_types'])
		&& canonicalUuid(value.request_id) && canonicalUuid(value.local_recording_session_id) && value.approval_action === 'approve_upload'
		&& value.consent_version === EVIDENCE_CONSENT_VERSION && value.scope === 'assessment_evidence'
		&& uniqueList(value.approved_workspace_ids, 32, id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))
		&& uniqueList(value.event_types, 17, type => PRIVACY_EVENT_TYPES.includes(type as TrackerEvent['eventType']))
		&& Buffer.byteLength(JSON.stringify(value)) <= 4096;
}
export function validConsentReceipt(value: EvidenceConsentReceipt, state: EvidenceConsentState): boolean {
	if (!value || !exactKeys(value, ['consent_id', 'local_recording_session_id', 'consent_version', 'scope', 'approved_workspace_ids', 'event_types',
		'destination_origin', 'consented_at', 'expires_at', 'server_time', 'state', 'evidence_window', 'revoked_at', 'upload_authorized', 'privacy_authorization'])
		|| !canonicalUuid(value.consent_id) || value.local_recording_session_id !== state.request.local_recording_session_id
		|| value.consent_version !== EVIDENCE_CONSENT_VERSION || value.scope !== 'assessment_evidence'
		|| value.destination_origin !== state.origin || value.upload_authorized !== false || value.privacy_authorization !== 'unverified'
		|| !['active', 'stopped', 'revoked', 'expired'].includes(value.state)
		|| ![value.consented_at, value.expires_at, value.server_time].every(utcTime)
		|| !value.evidence_window || !exactKeys(value.evidence_window, ['starts_at', 'ends_at', 'stopped_at'])
		|| !utcTime(value.evidence_window.starts_at) || !utcTime(value.evidence_window.ends_at)
		|| value.evidence_window.starts_at !== value.consented_at
		|| Date.parse(value.expires_at) > Date.parse(state.deadline) || Date.parse(value.expires_at) < Date.parse(value.consented_at)
		|| Date.parse(value.server_time) < Date.parse(value.consented_at)
		|| Date.parse(value.evidence_window.ends_at) < Date.parse(value.consented_at)
		|| Date.parse(value.evidence_window.ends_at) > Date.parse(value.expires_at)
		|| value.revoked_at !== undefined && (!utcTime(value.revoked_at) || Date.parse(value.revoked_at) > Date.parse(value.server_time))
		|| value.state === 'expired' && Date.parse(value.server_time) < Date.parse(value.expires_at)
		|| value.evidence_window.stopped_at !== undefined && (!utcTime(value.evidence_window.stopped_at) || value.evidence_window.stopped_at !== value.evidence_window.ends_at
			|| Date.parse(value.evidence_window.stopped_at) > Date.parse(value.server_time))
		|| value.state === 'active' && (Date.parse(value.server_time) >= Date.parse(value.expires_at) || value.evidence_window.ends_at !== value.expires_at
			|| value.revoked_at !== undefined || value.evidence_window.stopped_at !== undefined)
		|| value.state === 'revoked' && !value.revoked_at || value.state === 'stopped' && !value.evidence_window.stopped_at) { return false; }
	return Array.isArray(value.approved_workspace_ids) && Array.isArray(value.event_types)
		&& JSON.stringify([...value.approved_workspace_ids].sort()) === JSON.stringify([...state.request.approved_workspace_ids].sort())
		&& JSON.stringify([...value.event_types].sort()) === JSON.stringify([...state.request.event_types].sort());
}
export function validConsentState(state: EvidenceConsentState): boolean {
	return !!state && exactKeys(state, ['version', 'codingSessionId', 'origin', 'request', 'deadline', 'pendingAction', 'locallyRevoked', 'captureClosed', 'receipt'])
		&& state.version === 1 && /^[1-9][0-9]{0,19}$/.test(state.codingSessionId) && validOrigin(state.origin)
		&& validConsentRequest(state.request) && utcTime(state.deadline) && typeof state.locallyRevoked === 'boolean' && typeof state.captureClosed === 'boolean'
		&& (state.pendingAction === undefined || ['register', 'stop', 'revoke'].includes(state.pendingAction))
		&& (!state.receipt || validConsentReceipt(state.receipt, state));
}
/** Capture eligibility is a scope check against server-provided bounds, not a claim about client clock accuracy. */
export function consentCoversEvent(state: EvidenceConsentState, event: TrackerEvent): boolean {
	const receipt = state.receipt;
	return !state.locallyRevoked && !state.captureClosed && !state.pendingAction && receipt?.state === 'active'
		&& receipt.local_recording_session_id === event.sessionId && receipt.approved_workspace_ids.includes(event.workspaceId!)
		&& receipt.event_types.includes(event.eventType) && Date.parse(event.timestamp) >= Date.parse(receipt.evidence_window.starts_at)
		&& Date.parse(event.timestamp) <= Date.parse(receipt.evidence_window.ends_at);
}
