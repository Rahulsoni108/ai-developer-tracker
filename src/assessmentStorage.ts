import { createHash } from 'node:crypto';
import type { AssessmentArchive, AssessmentArchiveIndex, AssessmentArchiveStorage } from './assessmentArchive';
import { validSubmissionReceipt } from './assessmentFinalization';
import type { Memento, SecretStorage } from 'vscode';
import { utcTime } from './evidenceConsent';
import { isUuid } from './eventSchema';
import { AssessmentApiError, type AssessmentConnection, type AssessmentServerStatus } from './assessmentApiClient';

export const ASSESSMENT_METADATA_KEY = 'ai-developer-tracker.assessment.v1';
export const assessmentCredentialKey = (id: string) => 'ai-developer-tracker.assessment-credential.v1.' + id;
export type AssessmentState = 'unpaired' | 'paired' | 'starting' | 'active' | 'stopping' | 'submission_pending' | 'submitted' | 'recovery' | 'error';
export interface AssessmentMetadata {
	version: 1; connection: AssessmentConnection; credentialId: string; phase: AssessmentState;
	localRecordingSessionIds: string[]; serverStatus: AssessmentServerStatus;
	submitRequestId: string;
}
export interface AssessmentStore {
	load(): Promise<AssessmentMetadata | undefined>;
	save(value: AssessmentMetadata): Promise<void>;
	getCredential(id: string): Promise<string | undefined>;
	putCredential(id: string, credential: string): Promise<void>;
	deleteCredential?(id: string): Promise<void>;
	archive?(value: AssessmentArchive): Promise<void>;
	getArchiveIndex?(): Promise<AssessmentArchiveIndex>;
}

export function assessmentArchiveKey(connection: Pick<AssessmentConnection, 'apiOrigin' | 'codingSessionId'>): string {
	return createHash('sha256').update(JSON.stringify([connection.apiOrigin, connection.codingSessionId])).digest('hex');
}

export function validConnection(value: AssessmentConnection): boolean {
	try {
		const origin = new URL(value.apiOrigin); const endpoint = new URL(value.uploadEndpoint);
		return ['mock', 'rails'].includes(value.mode) && (value.mode !== 'rails' || utcTime(value.credentialExpiresAt)
			&& endpoint.href === origin.origin + '/api/v2/coding_session/extension/events') && typeof value.codingSessionId === 'string' && /^[1-9]\d{0,19}$/.test(value.codingSessionId) && origin.protocol === 'https:'
			&& origin.origin === value.apiOrigin && !origin.username && !origin.password && !origin.search && !origin.hash
			&& endpoint.origin === origin.origin && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash;
	} catch { return false; }
}
export function validServerStatus(value: AssessmentServerStatus, connection: AssessmentConnection): boolean {
	const utc = (timestamp: unknown): timestamp is string => typeof timestamp === 'string'
		&& /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(timestamp) && Number.isFinite(Date.parse(timestamp));
	return !!value && value.codingSessionId === connection.codingSessionId && ['paired', 'active', 'submitted', 'expired', 'revoked'].includes(value.state)
		&& utc(value.serverTime)
		&& (value.submission === undefined ? connection.mode !== 'rails' || value.state !== 'submitted'
			: value.state === 'submitted' && validSubmissionReceipt(value.submission) && utc(value.startedAt) && utc(value.deadline)
				&& Date.parse(value.submission.submitted_at) >= Date.parse(value.startedAt) && Date.parse(value.submission.submitted_at) < Date.parse(value.deadline)
				&& Date.parse(value.submission.submitted_at) <= Date.parse(value.serverTime) && value.submission.recording_count === value.localRecordingSessionIds?.length)
		&& Array.isArray(value.localRecordingSessionIds) && value.localRecordingSessionIds.length <= 32 && value.localRecordingSessionIds.every(isUuid)
		&& new Set(value.localRecordingSessionIds).size === value.localRecordingSessionIds.length
		&& ((['paired', 'revoked', 'expired'].includes(value.state) && value.startedAt === undefined && value.deadline === undefined)
			|| utc(value.startedAt) && utc(value.deadline)
				&& Date.parse(value.startedAt) <= Date.parse(value.serverTime)
				&& Date.parse(value.deadline) > Date.parse(value.startedAt));
}

export function validAssessmentMetadata(raw: AssessmentMetadata): boolean {
	try {
		return !!raw && raw.version === 1 && validConnection(raw.connection) && isUuid(raw.credentialId) && isUuid(raw.submitRequestId)
			&& ['paired', 'starting', 'active', 'stopping', 'submission_pending', 'submitted', 'recovery', 'error'].includes(raw.phase)
			&& Array.isArray(raw.localRecordingSessionIds) && raw.localRecordingSessionIds.length <= 32 && raw.localRecordingSessionIds.every(isUuid)
			&& new Set(raw.localRecordingSessionIds).size === raw.localRecordingSessionIds.length && validServerStatus(raw.serverStatus, raw.connection)
			&& raw.serverStatus.localRecordingSessionIds.every(id => raw.localRecordingSessionIds.includes(id))
			&& Object.keys(raw).every(key => ['version', 'connection', 'credentialId', 'phase', 'localRecordingSessionIds', 'serverStatus', 'submitRequestId'].includes(key))
			&& Object.keys(raw.connection).every(key => ['codingSessionId', 'apiOrigin', 'uploadEndpoint', 'mode', 'credentialExpiresAt'].includes(key))
			&& Object.keys(raw.serverStatus).every(key => ['codingSessionId', 'state', 'serverTime', 'startedAt', 'deadline', 'localRecordingSessionIds', 'submission'].includes(key));
	} catch { return false; }
}

/** Only a fixed allowlist of connection metadata is persisted; no pairing codes, event contents or tokens. */
export class AssessmentConnectionStore implements AssessmentStore {
	private writes: Promise<void> = Promise.resolve();
	constructor(private readonly state: Pick<Memento, 'get' | 'update'>, private readonly secrets: Pick<SecretStorage, 'get' | 'store'> & Partial<Pick<SecretStorage, 'delete'>>, private readonly archives?: AssessmentArchiveStorage) {}
	async load(): Promise<AssessmentMetadata | undefined> {
		const raw = this.state.get<AssessmentMetadata>(ASSESSMENT_METADATA_KEY); if (raw === undefined) { return undefined; }
		if (!validAssessmentMetadata(raw)) { throw new AssessmentApiError('storage'); }
		if (this.archives && (await this.getArchiveIndex()).archives.some(item => item.archiveId === raw.credentialId || item.assessmentKey === assessmentArchiveKey(raw.connection))) { return undefined; }
		return structuredClone(raw);
	}
	save(value: AssessmentMetadata): Promise<void> {
		const { codingSessionId, apiOrigin, uploadEndpoint, mode, credentialExpiresAt } = value.connection;
		const { state, serverTime, startedAt, deadline, localRecordingSessionIds, submission } = value.serverStatus;
		const snapshot: AssessmentMetadata = { version: 1, connection: { codingSessionId, apiOrigin, uploadEndpoint, mode, ...(credentialExpiresAt ? { credentialExpiresAt } : {}) }, credentialId: value.credentialId,
			phase: value.phase, localRecordingSessionIds: [...value.localRecordingSessionIds], submitRequestId: value.submitRequestId,
			serverStatus: { codingSessionId, state, serverTime, ...(startedAt ? { startedAt } : {}), ...(deadline ? { deadline } : {}), localRecordingSessionIds: [...localRecordingSessionIds], ...(submission ? { submission: structuredClone(submission) } : {}) } };
		const write = this.writes.then(async () => {
			if (!validAssessmentMetadata(snapshot) || this.archives && (await this.getArchiveIndex()).archives.some(item => item.archiveId === snapshot.credentialId || item.assessmentKey === assessmentArchiveKey(snapshot.connection))) { throw new AssessmentApiError('storage'); }
			await this.state.update(ASSESSMENT_METADATA_KEY, snapshot);
		});
		this.writes = write.catch(() => {}); return write;
	}
	getArchiveIndex(): Promise<AssessmentArchiveIndex> { return this.archives?.getAssessmentArchiveIndex() ?? Promise.resolve({ archives: [] }); }
	archive(value: AssessmentArchive): Promise<void> {
		const snapshot = structuredClone(value);
		const write = this.writes.then(async () => {
			if (!this.archives) { throw new AssessmentApiError('storage'); }
			await this.archives.archiveAssessment(snapshot);
			// The encrypted archive is the terminal marker. Never clear globalState in a
			// second write: load() ignores this old pointer after a crash, and normal pair
			// replaces it only after obtaining a fresh credential. No credential is deleted.
		});
		this.writes = write.catch(() => {}); return write;
	}
	async deleteCredential(id: string): Promise<void> {
		if (!this.secrets.delete || this.archives && (await this.getArchiveIndex()).archives.some(item => item.archiveId === id)) { throw new AssessmentApiError('storage'); }
		await this.secrets.delete(assessmentCredentialKey(id));
	}
	getCredential(id: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(assessmentCredentialKey(id))); }
	async putCredential(id: string, credential: string): Promise<void> {
		await this.secrets.store(assessmentCredentialKey(id), credential);
		if (await this.getCredential(id) !== credential) { throw new AssessmentApiError('storage'); }
	}
}
