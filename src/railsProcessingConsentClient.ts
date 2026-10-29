import { AssessmentApiError, type AssessmentAuthentication } from './assessmentApiClient';
import { validConnection } from './assessmentStorage';
import { createHash } from 'node:crypto';
import { HttpsEventTransport, type UploadTransport } from './httpsEventTransport';
import { exactObject, parseRailsControlResponse } from './railsControlResponse';
import { validProcessingReceipt, validProcessingState, type ProcessingReceipt, type ProcessingState } from './processingConsent';

export type ProcessingAction = 'grant' | 'status' | 'revoke';
export interface ProcessingApi {
	send(auth: AssessmentAuthentication, state: ProcessingState, action: ProcessingAction, signal: AbortSignal): Promise<ProcessingReceipt>;
}
/** R5.0C control API only. No evidence, redirects, model calls or response diagnostics. */
export class RailsProcessingConsentClient implements ProcessingApi {
	constructor(private readonly transport: UploadTransport = new HttpsEventTransport(), private readonly timeoutMs = 10000) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) { throw new AssessmentApiError('protocol'); }
	}
	dispose(): void { if (this.transport instanceof HttpsEventTransport) { this.transport.dispose(); } }
	async send(auth: AssessmentAuthentication, state: ProcessingState, action: ProcessingAction, signal: AbortSignal): Promise<ProcessingReceipt> {
		try {
			if (signal.aborted) { throw new AssessmentApiError('cancelled'); }
			if (!validProcessingState(state) || !validConnection(auth.connection) || auth.connection.mode !== 'rails'
				|| state.origin !== auth.connection.apiOrigin || state.codingSessionId !== auth.connection.codingSessionId
				|| !/^[\x21-\x7e]{1,8192}$/.test(auth.credential)
				|| state.credentialDigest !== createHash('sha256').update(auth.credential).digest('hex')
				|| !['grant', 'status', 'revoke'].includes(action) || action === 'grant' && state.locallyRevoked
				|| action !== 'grant' && !state.receipt) { throw new AssessmentApiError('protocol'); }
			const response = await this.transport.send({ endpoint: new URL('/api/v2/coding_session/extension/processing_consents' + (action === 'status' ? '/status' : ''), state.origin),
				token: auth.credential, signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]), method: action === 'revoke' ? 'DELETE' : 'POST',
				body: JSON.stringify(action === 'grant' ? state.request : { consent_id: state.receipt!.consent_id, local_recording_session_id: state.request.local_recording_session_id }) });
			if ([401, 403].includes(response.status)) { throw new AssessmentApiError('authentication'); }
			if (response.status !== 200) { throw new AssessmentApiError([404, 409, 413, 415, 422, 426].includes(response.status) ? 'rejected' : 'unavailable'); }
			if (!/^application\/json(?:\s*;|$)/i.test(response.contentType ?? '')) { throw new AssessmentApiError('protocol'); }
			const envelope = parseRailsControlResponse(response.body);
			if (!exactObject(envelope, ['data']) || !validProcessingReceipt(envelope.data, state.request, state.deadline, state.receipt)
				|| Date.parse(envelope.data.capture_until) > Date.parse(auth.connection.credentialExpiresAt!)
				|| action === 'revoke' && envelope.data.state !== 'revoked') { throw new AssessmentApiError('protocol'); }
			if (signal.aborted) { throw new AssessmentApiError('cancelled'); }
			return envelope.data;
		} catch (error) { throw error instanceof AssessmentApiError ? error : new AssessmentApiError(signal.aborted ? 'cancelled' : 'unavailable'); }
	}
}
