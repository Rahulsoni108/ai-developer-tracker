import { validOrigin } from './evidenceApproval';
import { utcTime } from './evidenceConsent';
import { validAssessmentEventApproval, type AssessmentEventApproval } from './assessmentEventApproval';
import { eventDigest } from './evidenceApproval';
import { PrivacyFilter, type PrivacyContext } from './privacyFilter';
import type { UploadPrivacyContext } from './uploadPrivacyContext';
import type { PreparedEventBatch } from './eventBatchManager';

export interface SerializedUploadBatch { body: string; includesAssessmentApprovals: boolean }
/** Used on the upload worker. Serialization is not permission to send an unsupported assessment contract. */
export function serializeUploadBatch(batch: PreparedEventBatch, contexts: UploadPrivacyContext[], maxBytes: number): SerializedUploadBatch {
	if (!batch.events.length || batch.events.length > 1000 || batch.events.length !== contexts.length) { throw new Error(); }
	const filter = new PrivacyFilter(); const approvals: AssessmentEventApproval[] = [];
	const eventIds = new Set<string>(); const references = new Set<string>();
	const includesAssessmentApprovals = contexts.some(context => context.assessmentEventApproval !== undefined || context.assessmentApprovalBinding !== undefined);
	let recording: string | undefined; let receipt: string | undefined; let owner: string | undefined; let origin: string | undefined; // A request is scoped to one approved recording/receipt.
	const events = batch.events.map((event, index) => {
		const snapshot = contexts[index];
		const context: PrivacyContext = { ...snapshot, resolveToolPath: (path, workspaceId) =>
			snapshot.verifiedToolPaths?.find(entry => entry.path === path && entry.workspaceId === workspaceId)?.relativePath };
		const result = filter.filter(event, context);
		if (result.status === 'rejected' || result.requiresReconstructionGap
			|| snapshot.exactEventDigest !== undefined && (eventDigest(event) !== snapshot.exactEventDigest || eventDigest(result.event) !== snapshot.exactEventDigest)) { throw new Error(); }
		if (includesAssessmentApprovals) {
			const approval = snapshot.assessmentEventApproval; const binding = snapshot.assessmentApprovalBinding;
			if (!binding || !validOrigin(binding.origin) || !/^[1-9][0-9]{0,19}$/.test(binding.codingSessionId) || !utcTime(binding.serverTime)
				|| !snapshot.exactEventDigest || !validAssessmentEventApproval(approval, result.event, binding) || eventIds.has(event.eventId)
				|| references.has(approval.captureApprovalReference) || recording !== undefined && recording !== approval.localRecordingSessionId
				|| receipt !== undefined && receipt !== approval.consentReceiptId || owner !== undefined && owner !== binding.codingSessionId
				|| origin !== undefined && origin !== binding.origin) { throw new Error(); }
			eventIds.add(event.eventId); references.add(approval.captureApprovalReference);
			recording = approval.localRecordingSessionId; receipt = approval.consentReceiptId; owner = binding.codingSessionId; origin = binding.origin; approvals.push(approval);
		}
		return result.event;
	});
	const body = JSON.stringify({ contractVersion: 1, batchId: batch.batchId, events,
		...(includesAssessmentApprovals ? { eventApprovals: approvals } : {}) });
	if (Buffer.byteLength(body) > maxBytes) { throw new RangeError(); }
	return { body, includesAssessmentApprovals };
}
