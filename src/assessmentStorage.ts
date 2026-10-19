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
		&& Array.isArray(value.localRecordingSessionIds) && value.localRecordingSessionIds.length <= 32 && value.localRecordingSessionIds.every(isUuid)
		&& new Set(value.localRecordingSessionIds).size === value.localRecordingSessionIds.length
		&& ((['paired', 'revoked', 'expired'].includes(value.state) && value.startedAt === undefined && value.deadline === undefined)
			|| utc(value.startedAt) && utc(value.deadline)
				&& Date.parse(value.startedAt) <= Date.parse(value.serverTime)
				&& Date.parse(value.deadline) > Date.parse(value.startedAt));
}

/** Only a fixed allowlist of connection metadata is persisted; no pairing codes, event contents or tokens. */
export class AssessmentConnectionStore implements AssessmentStore {
	private writes: Promise<void> = Promise.resolve();
	constructor(private readonly state: Pick<Memento, 'get' | 'update'>, private readonly secrets: Pick<SecretStorage, 'get' | 'store'> & Partial<Pick<SecretStorage, 'delete'>>) {}
	async load(): Promise<AssessmentMetadata | undefined> {
		const raw = this.state.get<AssessmentMetadata>(ASSESSMENT_METADATA_KEY); if (raw === undefined) { return undefined; }
		if (!raw || raw.version !== 1 || !validConnection(raw.connection) || !isUuid(raw.credentialId) || !isUuid(raw.submitRequestId)
			|| !['paired', 'starting', 'active', 'stopping', 'submission_pending', 'submitted', 'recovery', 'error'].includes(raw.phase)
			|| !Array.isArray(raw.localRecordingSessionIds) || raw.localRecordingSessionIds.length > 32 || !raw.localRecordingSessionIds.every(isUuid)
			|| new Set(raw.localRecordingSessionIds).size !== raw.localRecordingSessionIds.length || !validServerStatus(raw.serverStatus, raw.connection)) {
			throw new AssessmentApiError('storage');
		}
		return structuredClone(raw);
	}
	save(value: AssessmentMetadata): Promise<void> {
		const { codingSessionId, apiOrigin, uploadEndpoint, mode, credentialExpiresAt } = value.connection;
		const { state, serverTime, startedAt, deadline, localRecordingSessionIds } = value.serverStatus;
		const snapshot: AssessmentMetadata = { version: 1, connection: { codingSessionId, apiOrigin, uploadEndpoint, mode, ...(credentialExpiresAt ? { credentialExpiresAt } : {}) }, credentialId: value.credentialId,
			phase: value.phase, localRecordingSessionIds: [...value.localRecordingSessionIds], submitRequestId: value.submitRequestId,
			serverStatus: { codingSessionId, state, serverTime, ...(startedAt ? { startedAt } : {}), ...(deadline ? { deadline } : {}), localRecordingSessionIds: [...localRecordingSessionIds] } };
		const write = this.writes.then(async () => { await this.state.update(ASSESSMENT_METADATA_KEY, snapshot); });
		this.writes = write.catch(() => {}); return write;
	}
	async deleteCredential(id: string): Promise<void> {
		if (!this.secrets.delete) { throw new AssessmentApiError('storage'); }
		await this.secrets.delete(assessmentCredentialKey(id));
	}
	getCredential(id: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(assessmentCredentialKey(id))); }
	async putCredential(id: string, credential: string): Promise<void> {
		await this.secrets.store(assessmentCredentialKey(id), credential);
		if (await this.getCredential(id) !== credential) { throw new AssessmentApiError('storage'); }
	}
}
