import type { DisclosureState } from './assessmentDisclosure';
import { validDisclosureState } from './assessmentDisclosure';
import { disclosureCategoryForEvent } from './assessmentEventApproval';
import type { EvidenceConsentState } from './evidenceConsent';
import type { TrackerEvent } from './eventSchema';

/** Process-local confirmations expire; persisted receipts alone never authorize fresh capture. */
export const DISCLOSURE_CONFIRMATION_MS = 10000;
export interface DisclosureConfirmation { state: DisclosureState; requestedAt: bigint }
export function freshDisclosureConfirmation(value: DisclosureConfirmation, now = process.hrtime.bigint()): boolean {
	return typeof value?.requestedAt === 'bigint' && now >= value.requestedAt && now - value.requestedAt < BigInt(DISCLOSURE_CONFIRMATION_MS) * 1000000n;
}
/** Server-defined historical interval. Current capture additionally needs a fresh confirmation and active state. */
export function disclosureCoversEvent(state: DisclosureState, upload: EvidenceConsentState, event: TrackerEvent): boolean {
	const receipt = state.receipt; const parent = upload.receipt; const category = disclosureCategoryForEvent(event);
	if (!validDisclosureState(state) || !receipt || !parent || !category || upload.locallyRevoked
		|| state.codingSessionId !== upload.codingSessionId || state.origin !== upload.origin || state.credentialDigest !== upload.credentialDigest
		|| state.deadline !== upload.deadline || receipt.upload_consent_id !== parent.consent_id
		|| receipt.local_recording_session_id !== event.sessionId || upload.request.local_recording_session_id !== event.sessionId
		|| !receipt.categories.includes(category) || !receipt.approved_workspace_ids.includes(event.workspaceId!)
		|| !parent.approved_workspace_ids.includes(event.workspaceId!) || !parent.event_types.includes(event.eventType)
		|| event.source !== 'vscode' && !receipt.approved_source_sessions.some(s => s.source === event.source && s.source_session_id === event.sourceSessionId)) { return false; }
	const start = Math.max(Date.parse(receipt.consented_at), Date.parse(parent.consented_at));
	const end = Math.min(Date.parse(receipt.expires_at), Date.parse(parent.expires_at), Date.parse(upload.deadline),
		receipt.revoked_at === null ? Infinity : Date.parse(receipt.revoked_at),
		parent.evidence_window.stopped_at === undefined ? Infinity : Date.parse(parent.evidence_window.stopped_at));
	return Date.parse(event.timestamp) >= start && Date.parse(event.timestamp) < end;
}
export function activeDisclosureConfirmation(value: DisclosureConfirmation, upload: EvidenceConsentState): boolean {
	const state = value.state; const receipt = state.receipt;
	if (!freshDisclosureConfirmation(value) || !validDisclosureState(state) || !receipt || state.locallyRevoked || state.pendingAction
		|| !upload.receipt || upload.receipt.state !== 'active' || receipt.state !== 'active' || receipt.upload_scope_state !== 'active' || upload.captureClosed || upload.pendingAction || upload.locallyRevoked) { return false; }
	// Request latency is included conservatively; host wall-clock changes cannot extend server expiry.
	const serverUpperNow = Date.parse(receipt.server_time) + Number(process.hrtime.bigint() - value.requestedAt) / 1000000;
	return serverUpperNow < Math.min(Date.parse(receipt.expires_at), Date.parse(upload.deadline), Date.parse(upload.receipt.expires_at));
}
