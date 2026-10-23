import { validFinalizationRequest, receiptMatches } from './assessmentFinalization';
import { createHash } from 'node:crypto';
import { isUuid } from './eventSchema';
import { AssessmentApiError, type AssessmentApiClient, type AssessmentAuthentication, type AssessmentConnection, type AssessmentServerStatus } from './assessmentApiClient';
import { validConnection, validServerStatus } from './assessmentStorage';
import { validOrigin } from './evidenceApproval';
import { utcTime, validConsentState, type EvidenceConsentState } from './evidenceConsent';
import { RailsEvidenceConsentClient, type EvidenceConsentApi } from './railsEvidenceConsentClient';
import { HttpsEventTransport, UploadTransportError, type UploadTransport } from './httpsEventTransport';
import { exactObject, parseRailsControlResponse } from './railsControlResponse';
import type { PreparedEventBatch } from './eventBatchManager';
import type { AssessmentApprovalBinding } from './assessmentEventApproval';

const BASE = '/api/v2/coding_session/extension';
interface PermitScope { binding: AssessmentApprovalBinding; localSessionId: string; batchId: string; eventIds: string[]; endpoint: string; credentialDigest: string }
/** Process-local capability issued only after authenticated Rails status and receipt/scope validation.
 * Pins the reviewed R4.2D protocol; it is not a server capability advertisement or execution attestation. */
export interface RailsUploadPermit { readonly contract: 'rails-assessment-events.v1' }
const permits = new WeakMap<RailsUploadPermit, PermitScope>();
export function inspectRailsUploadPermit(permit: RailsUploadPermit | undefined, batch: PreparedEventBatch, endpoint: string, token: string): AssessmentApprovalBinding | undefined {
	const scope = permit && permits.get(permit);
	return scope && scope.endpoint === endpoint && scope.batchId === batch.batchId
		&& scope.credentialDigest === createHash('sha256').update(token).digest('hex')
		&& JSON.stringify(scope.eventIds) === JSON.stringify(batch.events.map(event => event.eventId))
		&& batch.events.every(event => event.sessionId === scope.localSessionId) ? { ...scope.binding } : undefined;
}

/** Strict adapter for the inspected R4.1D/R4.2B/R4.2D Rails contracts. Never falls back to a mock. */
export class RailsAssessmentApiClient implements AssessmentApiClient, EvidenceConsentApi {
	readonly mode = 'rails' as const;
	private readonly consents: RailsEvidenceConsentClient;
	constructor(readonly origin: string, private readonly transport: UploadTransport = new HttpsEventTransport(), private readonly timeoutMs = 10000) {
		if (origin.length > 2048 || !validOrigin(origin) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) { throw new AssessmentApiError('protocol'); }
		this.consents = new RailsEvidenceConsentClient(transport, timeoutMs);
	}
	async pair(code: string, signal: AbortSignal) {
		if (code.length > 64 || !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/.test(code.replace(/-/g, '').toUpperCase())) { throw new AssessmentApiError('rejected'); }
		const data = await this.send('/pair', 'POST', { pairing_code: code }, undefined, signal);
		if (!exactObject(data, ['coding_session_id', 'api_origin', 'upload_endpoint', 'credential', 'credential_expires_at', 'status'])
			|| data.api_origin !== this.origin || data.upload_endpoint !== this.origin + BASE + '/events'
			|| typeof data.credential !== 'string' || !/^adt_ext_[A-Za-z0-9_-]{43}$/.test(data.credential) || !utcTime(data.credential_expires_at)) { throw new AssessmentApiError('protocol'); }
		const connection: AssessmentConnection = { codingSessionId: data.coding_session_id as string, apiOrigin: this.origin,
			uploadEndpoint: data.upload_endpoint as string, mode: 'rails', credentialExpiresAt: data.credential_expires_at };
		if (!validConnection(connection)) { throw new AssessmentApiError('protocol'); }
		const status = this.status(data.status, connection);
		if (Date.parse(connection.credentialExpiresAt!) <= Date.parse(status.serverTime)) { throw new AssessmentApiError('authentication'); }
		return { connection, credential: data.credential, status };
	}
	async startOrResume(auth: AssessmentAuthentication, request: { requestId: string; localRecordingSessionId: string }, signal: AbortSignal) {
		if (![request.requestId, request.localRecordingSessionId].every(id => isUuid(id) && id === id.toLowerCase())) { throw new AssessmentApiError('protocol'); }
		const data = await this.send('/start', 'POST', { request_id: request.requestId, local_recording_session_id: request.localRecordingSessionId }, auth, signal);
		const status = this.status(data, auth.connection);
		if (status.state !== 'active' || !status.localRecordingSessionIds.includes(request.localRecordingSessionId)) { throw new AssessmentApiError('protocol'); }
		return status;
	}
	async getStatus(auth: AssessmentAuthentication, signal: AbortSignal) { return this.status(await this.send('/status', 'GET', undefined, auth, signal), auth.connection); }
	async revokeCredential(auth: AssessmentAuthentication, signal: AbortSignal): Promise<void> {
		const data = await this.send('/credential', 'DELETE', {}, auth, signal);
		if (!exactObject(data, ['revoked']) || data.revoked !== true) { throw new AssessmentApiError('protocol'); }
	}
	async submit(auth: AssessmentAuthentication, request: Parameters<AssessmentApiClient['submit']>[1], signal: AbortSignal): Promise<AssessmentServerStatus> {
		const frozen = request.finalization;
		if (!validFinalizationRequest(frozen) || frozen.request_id !== request.requestId
			|| JSON.stringify(frozen.recordings.map(row => row.local_recording_session_id).sort()) !== JSON.stringify([...request.localRecordingSessionIds].sort())
			|| frozen.recordings.reduce((sum, row) => sum + row.event_count, 0) !== request.retainedEventCount) { throw new AssessmentApiError('protocol'); }
		const status = this.status(await this.send('/finalize', 'POST', frozen, auth, signal), auth.connection);
		if (status.state !== 'submitted' || !receiptMatches(status.submission, frozen)
			|| JSON.stringify([...status.localRecordingSessionIds].sort()) !== JSON.stringify([...request.localRecordingSessionIds].sort())) { throw new AssessmentApiError('protocol'); }
		return status;
	}
	register(auth: AssessmentAuthentication, state: EvidenceConsentState, signal: AbortSignal) { this.checkAuth(auth); return this.consents.register(auth, state, signal); }
	stop(auth: AssessmentAuthentication, state: EvidenceConsentState, signal: AbortSignal) { this.checkAuth(auth); return this.consents.stop(auth, state, signal); }
	revoke(auth: AssessmentAuthentication, state: EvidenceConsentState, signal: AbortSignal) { this.checkAuth(auth); return this.consents.revoke(auth, state, signal); }
	async authorizeUpload(auth: AssessmentAuthentication, state: EvidenceConsentState, batch: PreparedEventBatch, signal: AbortSignal, expected?: AssessmentServerStatus): Promise<RailsUploadPermit> {
		this.checkAuth(auth);
		if (!validConsentState(state) || state.credentialDigest !== createHash('sha256').update(auth.credential).digest('hex') || state.codingSessionId !== auth.connection.codingSessionId || state.origin !== this.origin
			|| state.locallyRevoked || state.pendingAction || !state.receipt || !['active', 'stopped'].includes(state.receipt.state)
			|| state.captureClosed && state.receipt.state !== 'stopped' || !batch.events.length
			|| batch.events.some(event => event.sessionId !== state.request.local_recording_session_id || !state.receipt!.approved_workspace_ids.includes(event.workspaceId!)
				|| !state.receipt!.event_types.includes(event.eventType))) { throw new AssessmentApiError('consent_required'); }
		const status = await this.getStatus(auth, signal); const receipt = state.receipt;
		if (expected && (status.startedAt !== expected.startedAt || status.deadline !== expected.deadline || Date.parse(status.serverTime) < Date.parse(expected.serverTime)
			|| status.localRecordingSessionIds.some(id => !expected.localRecordingSessionIds.includes(id)))) { throw new AssessmentApiError('protocol'); }
		if (status.state !== 'active' || status.deadline !== state.deadline || !status.localRecordingSessionIds.includes(state.request.local_recording_session_id)
			|| Date.parse(status.serverTime) < Date.parse(receipt.server_time) || Date.parse(status.serverTime) >= Date.parse(receipt.expires_at)
			|| batch.events.some(event => Date.parse(event.timestamp) < Date.parse(receipt.evidence_window.starts_at)
				|| Date.parse(event.timestamp) > Math.min(Date.parse(status.serverTime), Date.parse(receipt.evidence_window.ends_at)))) { throw new AssessmentApiError('consent_required'); }
		const permit: RailsUploadPermit = Object.freeze({ contract: 'rails-assessment-events.v1' });
		permits.set(permit, { binding: { codingSessionId: status.codingSessionId, origin: this.origin, consentReceiptId: receipt.consent_id, serverTime: status.serverTime },
			localSessionId: state.request.local_recording_session_id, batchId: batch.batchId, eventIds: batch.events.map(event => event.eventId),
			endpoint: auth.connection.uploadEndpoint, credentialDigest: createHash('sha256').update(auth.credential).digest('hex') });
		return permit;
	}
	dispose(): void { if (this.transport instanceof HttpsEventTransport) { this.transport.dispose(); } }
	private checkAuth(auth: AssessmentAuthentication): void {
		if (!validConnection(auth.connection) || auth.connection.mode !== 'rails' || auth.connection.apiOrigin !== this.origin
			|| !/^adt_ext_[A-Za-z0-9_-]{43}$/.test(auth.credential)) { throw new AssessmentApiError('authentication'); }
	}
	private status(value: unknown, connection: AssessmentConnection): AssessmentServerStatus {
		if (!exactObject(value, ['coding_session_id', 'state', 'server_time', 'local_recording_session_ids'], ['started_at', 'deadline', 'submission'])
			|| !['paired', 'active', 'submitted'].includes(value.state as string) || !utcTime(value.server_time)
			|| value.started_at !== undefined && !utcTime(value.started_at) || value.deadline !== undefined && !utcTime(value.deadline)) { throw new AssessmentApiError('protocol'); }
		const status = { ...(value.submission === undefined ? {} : { submission: value.submission }), codingSessionId: value.coding_session_id, state: value.state, serverTime: value.server_time,
			localRecordingSessionIds: value.local_recording_session_ids, ...(value.started_at === undefined ? {} : { startedAt: value.started_at }),
			...(value.deadline === undefined ? {} : { deadline: value.deadline }) } as AssessmentServerStatus;
		if (!validServerStatus(status, connection) || status.state === 'paired' && (status.localRecordingSessionIds.length || status.startedAt !== undefined || status.deadline !== undefined)
			|| status.state === 'active' && Date.parse(status.serverTime) >= Date.parse(status.deadline!)
			|| Date.parse(status.serverTime) >= Date.parse(connection.credentialExpiresAt!)) { throw new AssessmentApiError('protocol'); }
		return status;
	}
	private async send(path: string, method: 'POST' | 'GET' | 'DELETE', body: unknown, auth: AssessmentAuthentication | undefined, signal: AbortSignal): Promise<unknown> {
		try {
			if (auth) { this.checkAuth(auth); }
			const response = await this.transport.send({ endpoint: new URL(BASE + path, this.origin), method, ...(auth ? { token: auth.credential } : {}),
				body: body === undefined ? '' : JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) });
			if ([401, 403].includes(response.status)) { throw new AssessmentApiError('authentication'); }
			if (response.status !== 200) { throw new AssessmentApiError(response.status === 409 && path === '/finalize' ? 'evidence_pending' : response.status === 409 || response.status === 422 ? 'rejected'
				: response.status >= 300 && response.status < 400 ? 'protocol' : 'unavailable'); }
			if (!/^application\/json(?:\s*;|$)/i.test(response.contentType ?? '')) { throw new AssessmentApiError('protocol'); }
			const envelope = parseRailsControlResponse(response.body);
			if (!exactObject(envelope, ['data'])) { throw new AssessmentApiError('protocol'); } return envelope.data;
		} catch (error) { throw error instanceof AssessmentApiError ? error : new AssessmentApiError(signal.aborted ? 'cancelled'
			: error instanceof UploadTransportError && error.category !== 'network' ? 'protocol' : 'unavailable'); }
	}
}
