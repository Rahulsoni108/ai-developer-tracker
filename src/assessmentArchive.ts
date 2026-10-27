import { isUuid } from './eventSchema';
import { utcTime } from './evidenceConsent';
import { validAssessmentMetadata, type AssessmentMetadata, type AssessmentState } from './assessmentStorage';
import type { AssessmentFailure } from './assessmentApiClient';

export const MAX_ASSESSMENT_ARCHIVES = 128;
export interface AssessmentArchive {
	version: 1;
	/** Stable per-connection reference, never a credential. */
	archiveId: string;
	archivedAt: string;
	metadata: AssessmentMetadata;
	previousPhase: AssessmentState;
	lastFailure?: AssessmentFailure;
	submissionConfirmed: boolean;
	/** Archiving is local only; it never asserts server closure, deletion or revocation. */
	remoteDisposition: 'unverified';
}
export interface AssessmentArchiveIndex {
	archives: { archiveId: string; assessmentKey: string; recordingSessionIds: string[]; submissionConfirmed: boolean }[];
}
export { assessmentArchiveKey } from './assessmentStorage';
export interface AssessmentArchiveStorage {
	archiveAssessment(value: AssessmentArchive): Promise<void>;
	getAssessmentArchiveIndex(): Promise<AssessmentArchiveIndex>;
}
export function validAssessmentArchive(value: unknown): value is AssessmentArchive {
	try {
		const record = value as AssessmentArchive;
		return !!record && record.version === 1 && isUuid(record.archiveId) && utcTime(record.archivedAt)
			&& validAssessmentMetadata(record.metadata) && record.archiveId === record.metadata.credentialId
			&& ['paired', 'starting', 'active', 'stopping', 'submission_pending', 'submitted', 'recovery', 'error'].includes(record.previousPhase)
			&& (record.lastFailure === undefined || ['unavailable', 'rejected', 'authentication', 'protocol', 'storage', 'consent_required',
				'finalization_unavailable', 'recording_busy', 'evidence_pending', 'cancelled', 'session_ended', 'recovery_required'].includes(record.lastFailure))
			&& typeof record.submissionConfirmed === 'boolean'
			&& (!record.submissionConfirmed || record.metadata.connection.mode === 'rails' && record.metadata.phase === 'submitted'
				&& record.metadata.serverStatus.state === 'submitted' && !!record.metadata.serverStatus.submission)
			&& record.remoteDisposition === 'unverified' && Buffer.byteLength(JSON.stringify(record)) <= 96 * 1024
			&& Object.keys(record).every(key => ['version', 'archiveId', 'archivedAt', 'metadata', 'previousPhase', 'lastFailure', 'submissionConfirmed', 'remoteDisposition'].includes(key));
	} catch { return false; }
}
