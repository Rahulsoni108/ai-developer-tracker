import type { DisclosureCategory } from './assessmentDisclosure';
import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from './canonicalJson';
import { isUuid, validateEvent, type TrackerEvent } from './eventSchema';

export const APPROVAL_PROTOCOL_VERSION = 1;
export interface AssessmentUploadApproval {
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
export interface AssessmentDisclosureApproval extends Omit<AssessmentUploadApproval, 'approvalProtocolVersion'> {
	approvalProtocolVersion: 2;
	disclosureContractVersion: 'assessment-disclosure.v1';
	disclosureConsentReceiptId: string;
	disclosureCategory: DisclosureCategory;
}
export type AssessmentEventApproval = AssessmentUploadApproval | AssessmentDisclosureApproval;
/** Relationships lack the two referenced approvals required by Rails; never eligible for protocol 2. */
export function disclosureCategoryForEvent(event: TrackerEvent): DisclosureCategory | undefined {
	if (event.eventType.startsWith('file.')) { return 'code_changes'; }
	if (['ai.prompt.submitted', 'ai.response.completed'].includes(event.eventType)) { return 'ai_interactions'; }
	if (event.eventType.startsWith('ai.tool.') || event.eventType.startsWith('ai.session.')) { return 'tool_activity'; }
	return undefined;
}
/** Trusted assessment context from authenticated Rails status/receipt, never inferred from an event. */
export interface AssessmentApprovalBinding {
	codingSessionId: string;
	origin: string;
	consentReceiptId: string;
	serverTime: string;
}

/** Storage-worker capture path ONLY. Upload code must retrieve the persisted envelope, never call this. */
export function createAssessmentEventApproval(event: TrackerEvent, consentReceiptId: string, disclosureConsentReceiptId?: string): AssessmentEventApproval {
	if (!validateEvent(event).valid || !isUuid(consentReceiptId) || !/^[a-f0-9]{64}$/.test(event.workspaceId ?? '')) { throw new Error('Invalid assessment approval.'); }
	const base: AssessmentUploadApproval = { approvalProtocolVersion: APPROVAL_PROTOCOL_VERSION, eventId: event.eventId,
		localRecordingSessionId: event.sessionId, consentReceiptId, workspaceId: event.workspaceId!,
		captureApprovalReference: randomUUID(), canonicalization: 'RFC8785', eventDigest: canonicalSha256(event) };
	if (disclosureConsentReceiptId === undefined) { return base; }
	const category = disclosureCategoryForEvent(event);
	if (!isUuid(disclosureConsentReceiptId) || !category) { throw new Error('Invalid disclosure approval.'); }
	return { ...base, approvalProtocolVersion: 2, disclosureContractVersion: 'assessment-disclosure.v1',
		disclosureConsentReceiptId, disclosureCategory: category };
}

export function validAssessmentEventApproval(value: unknown, event: TrackerEvent, binding?: Pick<AssessmentApprovalBinding, 'consentReceiptId'>): value is AssessmentEventApproval {
	try {
		const proof = value as AssessmentEventApproval;
		const fields = ['approvalProtocolVersion', 'eventId', 'localRecordingSessionId', 'consentReceiptId', 'workspaceId',
			'captureApprovalReference', 'canonicalization', 'eventDigest'];
		if (proof?.approvalProtocolVersion === 2) {
			fields.push('disclosureContractVersion', 'disclosureConsentReceiptId', 'disclosureCategory');
			if (proof.disclosureContractVersion !== 'assessment-disclosure.v1' || !isUuid(proof.disclosureConsentReceiptId)
				|| !proof.disclosureCategory || proof.disclosureCategory !== disclosureCategoryForEvent(event)) { return false; }
		}
		return !!proof && typeof proof === 'object' && !Array.isArray(proof) && Object.keys(proof).length === fields.length
			&& Object.keys(proof).every(key => fields.includes(key)) && [1, 2].includes(proof.approvalProtocolVersion)
			&& (!binding || proof.consentReceiptId === binding.consentReceiptId) && proof.canonicalization === 'RFC8785' && isUuid(proof.consentReceiptId) && isUuid(proof.captureApprovalReference)
			&& proof.eventId === event.eventId && proof.localRecordingSessionId === event.sessionId && proof.workspaceId === event.workspaceId
			&& /^[a-f0-9]{64}$/.test(proof.workspaceId) && /^[a-f0-9]{64}$/.test(proof.eventDigest)
			&& validateEvent(event).valid && proof.eventDigest === canonicalSha256(event);
	} catch { return false; }
}
