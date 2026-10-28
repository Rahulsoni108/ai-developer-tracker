import { validAssessmentEventApproval, type AssessmentEventApproval } from './assessmentEventApproval';
import { createHash } from 'node:crypto';
import { isUuid, validateEvent, type TrackerEvent } from './eventSchema';
import { PrivacyFilter } from './privacyFilter';
import type { UploadPrivacyContext } from './uploadPrivacyContext';

/** This is local integrity evidence, NOT a remotely verifiable client attestation. */
export interface EvidenceApproval {
	version: 1 | 2;
	consentScope: 'local_filtered_capture.v1';
	eventId: string;
	sessionId: string;
	workspaceId: string;
	eventType: TrackerEvent['eventType'];
	eventDigest: string;
	context: UploadPrivacyContext;
	/** Present only on new v2 assessment captures; v1 approvals are never backfilled. */
	assessmentEventApproval?: AssessmentEventApproval;
	/** Local encrypted lookup only; never serialized into the Rails sidecar. */
	disclosureRequestId?: string;
	/** Immutable capture-time assessment scope. Absence never authorizes assessment uploads. */
	assessment?: { codingSessionId: string; origin: string; consentId?: string };
}
export function eventDigest(event: TrackerEvent): string {
	return createHash('sha256').update(JSON.stringify(event), 'utf8').digest('hex');
}

/** Re-run the filter on the storage worker; accept only the exact already-sanitized snapshot. */
export function createEvidenceApproval(event: TrackerEvent, input: UploadPrivacyContext): EvidenceApproval {
	const serialized = JSON.stringify(input);
	if (Buffer.byteLength(serialized) > 96 * 1024 || !input || input.isApprovedRelativePath || input.resolveToolPath
		|| input.exactEventDigest !== undefined || input.sessionId !== event.sessionId || !isUuid(input.sessionId)) { throw new Error(); }
	const context = JSON.parse(serialized) as UploadPrivacyContext;
	const keys = ['recordingActive', 'sessionId', 'approvedWorkspaceIds', 'confirmedCodexSessions', 'codexContentConsent',
		'confirmedClaudeSessions', 'claudeContentConsent', 'verifiedToolPaths'];
	if (Object.keys(context).some(key => !keys.includes(key)) || typeof context.codexContentConsent !== 'boolean' || context.claudeContentConsent !== undefined && typeof context.claudeContentConsent !== 'boolean'
		|| context.recordingActive !== true
		|| !Array.isArray(context.approvedWorkspaceIds) || context.approvedWorkspaceIds.length !== 1
		|| context.approvedWorkspaceIds[0] !== event.workspaceId
		|| !Array.isArray(context.confirmedCodexSessions) || context.confirmedCodexSessions.length > 1
		|| (context.confirmedClaudeSessions?.length ?? 0) > 1
		|| (context.verifiedToolPaths?.length ?? 0) > 128) { throw new Error(); }
	const filtered = new PrivacyFilter().filter(event, { ...context, resolveToolPath: (path, workspaceId) =>
		context.verifiedToolPaths?.find(entry => entry.path === path && entry.workspaceId === workspaceId)?.relativePath });
	if (filtered.status !== 'accepted' || filtered.requiresReconstructionGap
		|| JSON.stringify(filtered.event) !== JSON.stringify(event)) { throw new Error(); }
	return { version: 1, consentScope: 'local_filtered_capture.v1', eventId: event.eventId, sessionId: event.sessionId,
		workspaceId: event.workspaceId!, eventType: event.eventType, eventDigest: eventDigest(event), context };
}

export function verifyEvidenceApproval(value: unknown, event: TrackerEvent): EvidenceApproval {
	const approval = value as EvidenceApproval;
	if (!approval || ![1, 2].includes(approval.version) || Object.keys(approval).some(key => !['version', 'consentScope', 'eventId', 'sessionId', 'workspaceId', 'eventType', 'eventDigest', 'context', 'assessment', 'assessmentEventApproval', 'disclosureRequestId'].includes(key))
		|| approval.consentScope !== 'local_filtered_capture.v1' || approval.eventId !== event.eventId || approval.sessionId !== event.sessionId
		|| approval.workspaceId !== event.workspaceId || approval.eventType !== event.eventType || !validateEvent(event).valid || approval.eventDigest !== eventDigest(event)) { throw new Error(); }
	const verified = createEvidenceApproval(event, approval.context);
	if (approval.assessment) {
		if (!/^[1-9][0-9]{0,19}$/.test(approval.assessment.codingSessionId)
			|| !validOrigin(approval.assessment.origin) || approval.assessment.consentId !== undefined && !isUuid(approval.assessment.consentId)
			|| Object.keys(approval.assessment).some(key => !['codingSessionId', 'origin', 'consentId'].includes(key))) { throw new Error(); }
		verified.assessment = approval.assessment;
	}
	if (approval.version === 2) {
		if (!validAssessmentEventApproval(approval.assessmentEventApproval, event) || !approval.assessment?.consentId
			|| approval.assessmentEventApproval.consentReceiptId !== approval.assessment.consentId) { throw new Error(); }
		if (approval.assessmentEventApproval.approvalProtocolVersion === 2 ? !isUuid(approval.disclosureRequestId) : approval.disclosureRequestId !== undefined) { throw new Error(); }
		if (approval.disclosureRequestId) { verified.disclosureRequestId = approval.disclosureRequestId; }
		verified.version = 2; verified.assessmentEventApproval = approval.assessmentEventApproval;
	} else if (approval.assessmentEventApproval !== undefined || approval.disclosureRequestId !== undefined) { throw new Error(); }
	return verified;
}
export function validOrigin(origin: unknown): origin is string {
	try { const url = new URL(origin as string); return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password; }
	catch { return false; }
}
