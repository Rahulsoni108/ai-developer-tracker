import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from './canonicalJson';
import { isUuid, validateEvent, type TrackerEvent } from './eventSchema';

export const APPROVAL_PROTOCOL_VERSION = 1;
export interface AssessmentEventApproval {
	approvalProtocolVersion: 1;
	eventId: string;
	localRecordingSessionId: string;
	consentReceiptId: string;
	workspaceId: string;
	/** Random public reference assigned during the atomic capture commit; never a bearer secret. */
	captureApprovalReference: string;
	canonicalization: 'RFC8785';
	eventDigest: string;
}
/** Trusted assessment context from authenticated Rails status/receipt, never inferred from an event. */
export interface AssessmentApprovalBinding {
	codingSessionId: string;
	origin: string;
	consentReceiptId: string;
	serverTime: string;
}

/** Storage-worker capture path ONLY. Upload code must retrieve the persisted envelope, never call this. */
export function createAssessmentEventApproval(event: TrackerEvent, consentReceiptId: string): AssessmentEventApproval {
	if (!validateEvent(event).valid || !isUuid(consentReceiptId) || !/^[a-f0-9]{64}$/.test(event.workspaceId ?? '')) { throw new Error('Invalid assessment approval.'); }
	return { approvalProtocolVersion: APPROVAL_PROTOCOL_VERSION, eventId: event.eventId,
		localRecordingSessionId: event.sessionId, consentReceiptId, workspaceId: event.workspaceId!,
		captureApprovalReference: randomUUID(), canonicalization: 'RFC8785', eventDigest: canonicalSha256(event) };
}

export function validAssessmentEventApproval(value: unknown, event: TrackerEvent, binding?: Pick<AssessmentApprovalBinding, 'consentReceiptId'>): value is AssessmentEventApproval {
	try {
		const proof = value as AssessmentEventApproval;
		const fields = ['approvalProtocolVersion', 'eventId', 'localRecordingSessionId', 'consentReceiptId', 'workspaceId',
			'captureApprovalReference', 'canonicalization', 'eventDigest'];
		return !!proof && typeof proof === 'object' && !Array.isArray(proof) && Object.keys(proof).length === fields.length
			&& Object.keys(proof).every(key => fields.includes(key)) && proof.approvalProtocolVersion === APPROVAL_PROTOCOL_VERSION
			&& (!binding || proof.consentReceiptId === binding.consentReceiptId) && proof.canonicalization === 'RFC8785' && isUuid(proof.consentReceiptId) && isUuid(proof.captureApprovalReference)
			&& proof.eventId === event.eventId && proof.localRecordingSessionId === event.sessionId && proof.workspaceId === event.workspaceId
			&& /^[a-f0-9]{64}$/.test(proof.workspaceId) && /^[a-f0-9]{64}$/.test(proof.eventDigest)
			&& validateEvent(event).valid && proof.eventDigest === canonicalSha256(event);
	} catch { return false; }
}
