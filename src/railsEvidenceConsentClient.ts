import { parseRailsControlResponse } from './railsControlResponse';
import type { AssessmentAuthentication } from './assessmentApiClient';
import { AssessmentApiError } from './assessmentApiClient';
import { validOrigin } from './evidenceApproval';
import { validConsentReceipt, validConsentState, type EvidenceConsentState, type EvidenceConsentReceipt } from './evidenceConsent';
import { HttpsEventTransport, type UploadTransport } from './httpsEventTransport';

const BASE_PATH = '/api/v2/coding_session/extension/evidence_consents';
export interface EvidenceConsentApi {
	register(auth: AssessmentAuthentication, state: EvidenceConsentState, signal: AbortSignal): Promise<EvidenceConsentReceipt>;
	stop(auth: AssessmentAuthentication, state: EvidenceConsentState, signal: AbortSignal): Promise<EvidenceConsentReceipt>;
	revoke(auth: AssessmentAuthentication, state: EvidenceConsentState, signal: AbortSignal): Promise<EvidenceConsentReceipt>;
}
/** Only the three documented Rails consent endpoints. No pairing/start/ingestion/finalization transport. */
export class RailsEvidenceConsentClient implements EvidenceConsentApi {
	constructor(private readonly transport: UploadTransport = new HttpsEventTransport(), private readonly timeoutMs = 10000) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) { throw new AssessmentApiError('protocol'); }
	}
	register(auth: AssessmentAuthentication, state: EvidenceConsentState, signal: AbortSignal): Promise<EvidenceConsentReceipt> {
		return this.send(auth, state, 'register', signal);
	}
	stop(auth: AssessmentAuthentication, state: EvidenceConsentState, signal: AbortSignal): Promise<EvidenceConsentReceipt> {
		return this.send(auth, state, 'stop', signal);
	}
	revoke(auth: AssessmentAuthentication, state: EvidenceConsentState, signal: AbortSignal): Promise<EvidenceConsentReceipt> {
		return this.send(auth, state, 'revoke', signal);
	}
	private async send(auth: AssessmentAuthentication, state: EvidenceConsentState, action: 'register' | 'stop' | 'revoke', signal: AbortSignal): Promise<EvidenceConsentReceipt> {
		try {
			if (!validConsentState(state) || !validOrigin(state.origin) || state.origin !== auth.connection.apiOrigin
				|| state.codingSessionId !== auth.connection.codingSessionId || new URL(auth.connection.uploadEndpoint).origin !== state.origin
				|| !/^[\x21-\x7e]{1,8192}$/.test(auth.credential) || action !== 'register' && !state.receipt) { throw new AssessmentApiError('protocol'); }
			const response = await this.transport.send({ endpoint: new URL(BASE_PATH + (action === 'stop' ? '/stop' : ''), state.origin),
				token: auth.credential, signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
				method: action === 'revoke' ? 'DELETE' : 'POST', body: JSON.stringify(action === 'register' ? state.request : {
					consent_id: state.receipt!.consent_id, local_recording_session_id: state.request.local_recording_session_id }) });
			if ([401, 403].includes(response.status)) { throw new AssessmentApiError('authentication'); }
			if (response.status !== 200) { throw new AssessmentApiError(response.status === 409 ? 'rejected' : 'unavailable'); }
			if (!/^application\/json(?:\s*;|$)/i.test(response.contentType ?? '') || Buffer.byteLength(response.body) > 32768) { throw new AssessmentApiError('protocol'); }
			const envelope = parseRailsControlResponse(response.body) as { data?: EvidenceConsentReceipt };
			if (!envelope || Object.keys(envelope).length !== 1 || !envelope.data || !validConsentReceipt(envelope.data, state)
				|| action === 'revoke' && envelope.data.state !== 'revoked'
				|| action === 'stop' && !['stopped', 'revoked', 'expired'].includes(envelope.data.state)) { throw new AssessmentApiError('protocol'); }
			return envelope.data;
		} catch (error) { throw error instanceof AssessmentApiError ? error : new AssessmentApiError(signal.aborted ? 'cancelled' : 'unavailable'); }
	}
}
