import { AssessmentApiError, type AssessmentAuthentication } from './assessmentApiClient';
import { validDisclosureReceipt, validDisclosureState, type DisclosureReceipt, type DisclosureState } from './assessmentDisclosure';
import { HttpsEventTransport, type UploadTransport } from './httpsEventTransport';
import { parseRailsControlResponse } from './railsControlResponse';

export type DisclosureAction = 'grant' | 'status' | 'revoke';
export interface DisclosureApi {
	send(auth: AssessmentAuthentication, state: DisclosureState, action: DisclosureAction, signal: AbortSignal): Promise<DisclosureReceipt>;
}
/** Exact R4.6 HTTPS control contract. Responses never enter diagnostic logs. */
export class RailsDisclosureConsentClient implements DisclosureApi {
	constructor(private readonly transport: UploadTransport = new HttpsEventTransport(), private readonly timeoutMs = 10000) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) { throw new AssessmentApiError('protocol'); }
	}
	dispose(): void { if (this.transport instanceof HttpsEventTransport) { this.transport.dispose(); } }
	async send(auth: AssessmentAuthentication, state: DisclosureState, action: DisclosureAction, signal: AbortSignal): Promise<DisclosureReceipt> {
		try {
			if (!validDisclosureState(state) || auth.connection.mode !== 'rails' || state.origin !== auth.connection.apiOrigin
				|| state.codingSessionId !== auth.connection.codingSessionId || new URL(auth.connection.uploadEndpoint).origin !== state.origin
				|| !/^[\x21-\x7e]{1,8192}$/.test(auth.credential) || !['grant', 'status', 'revoke'].includes(action)
				|| action === 'grant' && state.locallyRevoked || action !== 'grant' && !state.receipt) { throw new AssessmentApiError('protocol'); }
			const response = await this.transport.send({ endpoint: new URL('/api/v2/coding_session/extension/disclosure_consents' + (action === 'status' ? '/status' : ''), state.origin),
				token: auth.credential, signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]), method: action === 'revoke' ? 'DELETE' : 'POST',
				body: JSON.stringify(action === 'grant' ? state.request : { consent_id: state.receipt!.consent_id, local_recording_session_id: state.request.local_recording_session_id }) });
			if ([401, 403].includes(response.status)) { throw new AssessmentApiError('authentication'); }
			if (response.status !== 200) { throw new AssessmentApiError([409, 413, 415, 422, 426].includes(response.status) ? 'rejected' : 'unavailable'); }
			if (!/^application\/json(?:\s*;|$)/i.test(response.contentType ?? '') || Buffer.byteLength(response.body) > 32768) { throw new AssessmentApiError('protocol'); }
			const envelope = parseRailsControlResponse(response.body) as { data?: DisclosureReceipt };
			if (!envelope || Object.keys(envelope).length !== 1 || !envelope.data || !validDisclosureReceipt(envelope.data, state)
				|| action === 'revoke' && envelope.data.state !== 'revoked') { throw new AssessmentApiError('protocol'); }
			return envelope.data;
		} catch (error) { throw error instanceof AssessmentApiError ? error : new AssessmentApiError(signal.aborted ? 'cancelled' : 'unavailable'); }
	}
}
