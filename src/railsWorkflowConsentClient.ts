import { createHash } from 'node:crypto';
import { AssessmentApiError, type AssessmentAuthentication, type AssessmentServerStatus } from './assessmentApiClient';
import { validConnection, validServerStatus } from './assessmentStorage';
import { canonicalSha256 } from './canonicalJson';
import { NATIVE_SESSION_VERSION, nativeIdentityDigest, validNativeCapabilities, validNativeSourceBundle, type NativeSessionCapabilities, type NativeSourceBundle } from './assessmentNativeSession';
import { exactObject, parseRailsControlResponse } from './railsControlResponse';
import { HttpsEventTransport, type UploadTransport } from './httpsEventTransport';
import { utcTime, validConsentState, type EvidenceConsentState } from './evidenceConsent';
import { validDisclosureState, type DisclosureState } from './assessmentDisclosure';
import { validProcessingReceipt, type ProcessingState } from './processingConsent';
import { validWorkflowPolicy, validWorkflowStartBundle, validWorkflowSourceBundle, WORKFLOW_CONSENT_VERSION,
 type WorkflowPolicy, type WorkflowStartBundle, type WorkflowSourceBundle } from './assessmentWorkflowContract';

export interface WorkflowReceipts { workflowId: string; state: 'active' | 'blocked'; status: AssessmentServerStatus;
 upload: EvidenceConsentState; disclosure: DisclosureState; processing: ProcessingState; confirmations: DisclosureState[] }
const BASE = '/api/v2/coding_session/extension/workflow_consents';
/** Fixed validation stages only; never include response values or exception text. */
export type WorkflowProtocolCheck = 'request' | 'response_shape' | 'recording_binding' | 'upload_receipt' | 'disclosure_receipt'
 | 'processing_receipt' | 'purpose_association' | 'request_binding' | 'confirmation_shape' | 'confirmation_scope'
 | 'confirmation_identity' | 'content_type' | 'response_envelope' | 'response_json';

export interface WorkflowProtocolDetails {
	operation?: string;
	httpStatus?: number;
	mismatchedFields?: string[];
	reason?: string;
}

function findFieldMismatches(value: unknown, required: string[], optional: string[] = []): string[] {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return ['not_an_object']; }
	const val = value as Record<string, unknown>;
	const missing = required.filter(k => !Object.hasOwn(val, k)).map(k => `missing:${k}`);
	const unexpected = Object.keys(val).filter(k => !required.includes(k) && !optional.includes(k)).map(k => `unexpected:${k}`);
	return [...missing, ...unexpected];
}

export class RailsWorkflowConsentClient {
	constructor(
		private readonly transport: UploadTransport = new HttpsEventTransport(),
		private readonly onProtocolFailure: (check: WorkflowProtocolCheck, details?: WorkflowProtocolDetails) => void = () => {}
	) {}
	private invalid(check: WorkflowProtocolCheck, details?: WorkflowProtocolDetails): never {
		try { this.onProtocolFailure(check, details); } catch { /* Diagnostics cannot change authorization. */ }
		throw new AssessmentApiError('protocol');
	}
	dispose(): void { if (this.transport instanceof HttpsEventTransport) { this.transport.dispose(); } }
	async policy(auth: AssessmentAuthentication, signal: AbortSignal): Promise<WorkflowPolicy> {
		const data = await this.send(auth, '/policy', 'GET', undefined, signal, false, 'policy');
		if (!validWorkflowPolicy(data, auth.connection.codingSessionId)) { throw new AssessmentApiError('unavailable'); }
		return data;
	}
	async start(auth: AssessmentAuthentication, bundle: WorkflowStartBundle, signal: AbortSignal): Promise<WorkflowReceipts> {
		if (!validWorkflowStartBundle(bundle)) { this.invalid('request', { operation: 'start', reason: 'invalid_workflow_start_bundle' }); }
		return this.receipts(auth, await this.send(auth, '/start', 'POST', bundle, signal, false, 'start'), bundle, 'start');
	}
	async enroll(auth: AssessmentAuthentication, bundle: WorkflowSourceBundle, signal: AbortSignal): Promise<WorkflowReceipts> {
		if (!validWorkflowSourceBundle(bundle)) { this.invalid('request', { operation: 'enroll', reason: 'invalid_workflow_source_bundle' }); }
		return this.receipts(auth, await this.send(auth, '/sources', 'POST', bundle, signal, false, 'enroll'), bundle, 'enroll');
	}
	async sessionCapabilities(auth: AssessmentAuthentication, signal: AbortSignal): Promise<NativeSessionCapabilities | undefined> {
		const data = await this.send(auth, '/session_capabilities', 'GET', undefined, signal, true, 'session_capabilities');
		if (data === undefined) { return undefined; }
		if (!validNativeCapabilities(data, auth.connection.codingSessionId) || Date.parse(data.server_time) >= Date.parse(auth.connection.credentialExpiresAt!)) {
			this.invalid('response_shape', { operation: 'session_capabilities', reason: 'invalid_native_capabilities' });
		}
		return data;
	}
	async enrollNative(auth: AssessmentAuthentication, bundle: NativeSourceBundle, signal: AbortSignal): Promise<WorkflowReceipts> {
		if (!validNativeSourceBundle(bundle)) {
			this.invalid('request', { operation: 'enroll_native', reason: 'invalid_native_source_bundle' });
		}
		if (nativeIdentityDigest(auth.connection.codingSessionId, bundle) !== bundle.intent.identity_digest) {
			this.invalid('request', { operation: 'enroll_native', reason: 'identity_digest_mismatch' });
		}
		const data = await this.send(auth, '/native_sources', 'POST', bundle, signal, false, 'enroll_native');
		const required = ['authorization_version', 'connection_mode', 'identity_digest', 'authorization'];
		if (!exactObject(data, required)
			|| data.authorization_version !== NATIVE_SESSION_VERSION || data.connection_mode !== 'native_confirmed' || data.identity_digest !== bundle.intent.identity_digest) {
			const mismatches = findFieldMismatches(data, required);
			this.invalid('response_shape', { operation: 'enroll_native', reason: 'native_source_response_mismatch', mismatchedFields: mismatches });
		}
		return this.receipts(auth, data.authorization, bundle, 'enroll_native');
	}
	async recoverNative(auth: AssessmentAuthentication, bundle: NativeSourceBundle, signal: AbortSignal): Promise<WorkflowReceipts> {
		if (!validNativeSourceBundle(bundle)) {
			this.invalid('request', { operation: 'recover_native', reason: 'invalid_native_source_bundle' });
		}
		if (nativeIdentityDigest(auth.connection.codingSessionId, bundle) !== bundle.intent.identity_digest) {
			this.invalid('request', { operation: 'recover_native', reason: 'identity_digest_mismatch' });
		}
		const data = await this.send(auth, '/native_sources/status', 'POST', { workflow_consent_id: bundle.intent.workflow_consent_id, request_id: bundle.intent.request_id }, signal, false, 'recover_native');
		const required = ['authorization_version', 'connection_mode', 'identity_digest', 'authorization'];
		if (!exactObject(data, required)
			|| data.authorization_version !== NATIVE_SESSION_VERSION || data.connection_mode !== 'native_confirmed' || data.identity_digest !== bundle.intent.identity_digest) {
			const mismatches = findFieldMismatches(data, required);
			this.invalid('response_shape', { operation: 'recover_native', reason: 'native_status_response_mismatch', mismatchedFields: mismatches });
		}
		return this.receipts(auth, data.authorization, bundle, 'recover_native'); // Receipt inspection never enables a reader.
	}
	async recover(auth: AssessmentAuthentication, bundle: WorkflowStartBundle, signal: AbortSignal): Promise<WorkflowReceipts> {
		return this.receipts(auth, await this.send(auth, '/status', 'POST', { workflow_consent_id: bundle.intent.request_id }, signal, false, 'recover'), bundle, 'recover');
	}
	async revoke(auth: AssessmentAuthentication, bundle: WorkflowStartBundle, signal: AbortSignal): Promise<WorkflowReceipts> {
		const result = this.receipts(auth, await this.send(auth, '', 'DELETE', { workflow_consent_id: bundle.intent.request_id }, signal, false, 'revoke'), bundle, 'revoke');
		if (result.state !== 'blocked') { throw new AssessmentApiError('protocol'); } return result;
	}
	private receipts(auth: AssessmentAuthentication, value: unknown, bundle: WorkflowStartBundle | WorkflowSourceBundle, operation = 'unknown'): WorkflowReceipts {
		const requiredReceipts = ['consent_version', 'workflow_consent_id', 'coding_session_id', 'state', 'server_time', 'request', 'status', 'upload', 'disclosure', 'processing', 'confirmations'];
		if (!exactObject(value, requiredReceipts)) {
			const mismatches = findFieldMismatches(value, requiredReceipts);
			this.invalid('response_shape', { operation, reason: 'receipts_shape_mismatch', mismatchedFields: mismatches });
		}
		if (value.consent_version !== WORKFLOW_CONSENT_VERSION || value.coding_session_id !== auth.connection.codingSessionId
			|| !['active', 'blocked'].includes(value.state as string) || canonicalSha256(value.request) !== canonicalSha256(bundle)
			|| !exactObject(value.status, ['coding_session_id', 'state', 'server_time', 'local_recording_session_ids'], ['started_at', 'deadline', 'submission'])
			|| !exactObject(value.upload, ['request', 'receipt']) || !exactObject(value.disclosure, ['request', 'receipt']) || !exactObject(value.processing, ['request', 'receipt'])) {
			this.invalid('response_shape', { operation, reason: 'receipts_fields_mismatch' });
		}
		const s = value.status;
		const status = { codingSessionId: s.coding_session_id, state: s.state, serverTime: s.server_time, localRecordingSessionIds: s.local_recording_session_ids,
			...(s.started_at ? { startedAt: s.started_at } : {}), ...(s.deadline ? { deadline: s.deadline } : {}), ...(s.submission ? { submission: s.submission } : {}) } as AssessmentServerStatus;
		const workflowId = 'upload' in bundle ? bundle.intent.request_id : bundle.intent.workflow_consent_id;
		if (value.workflow_consent_id !== workflowId || !validServerStatus(status, auth.connection) || !status.deadline || (!utcTime(value.server_time) || Date.parse(value.server_time) > Date.parse(status.serverTime))
			|| Date.parse(status.serverTime) >= Date.parse(auth.connection.credentialExpiresAt!) || !status.localRecordingSessionIds.includes(bundle.disclosure.local_recording_session_id)) {
			this.invalid('recording_binding', { operation, reason: 'recording_binding_mismatch' });
		}
		const common = { version: 1 as const, codingSessionId: auth.connection.codingSessionId, origin: auth.connection.apiOrigin,
			credentialDigest: createHash('sha256').update(auth.credential).digest('hex'), deadline: status.deadline, locallyRevoked: false };
		const upload = { ...common, ...value.upload, captureClosed: false } as EvidenceConsentState;
		const disclosure = { ...common, ...value.disclosure, workflowConsentId: workflowId } as DisclosureState;
		const processing = { ...common, ...value.processing } as ProcessingState;
		if (!validConsentState(upload)) { this.invalid('upload_receipt', { operation, reason: 'invalid_upload_state' }); }
		if (!validDisclosureState(disclosure)) { this.invalid('disclosure_receipt', { operation, reason: 'invalid_disclosure_state' }); }
		if (!processing.receipt || !validProcessingReceipt(processing.receipt, processing.request, processing.deadline)) {
			this.invalid('processing_receipt', { operation, reason: 'invalid_processing_receipt' });
		}
		if (!upload.receipt || !disclosure.receipt || upload.receipt.destination_origin !== auth.connection.apiOrigin
			|| processing.receipt.capture_until > auth.connection.credentialExpiresAt! || disclosure.request.upload_consent_id !== upload.receipt.consent_id
			|| processing.request.upload_consent_id !== upload.receipt.consent_id) {
			this.invalid('purpose_association', { operation, reason: 'purpose_association_mismatch' });
		}
		const resolved = (purpose: 'disclosure' | 'processing') => {
			const request = bundle[purpose]; if (!('upload' in bundle)) { return request; }
			const { upload_request_id, ...rest } = request as WorkflowStartBundle[typeof purpose]; void upload_request_id;
			return { ...rest, upload_consent_id: upload.receipt!.consent_id };
		};
		if ('upload' in bundle && canonicalSha256(bundle.upload) !== canonicalSha256(upload.request)
			|| canonicalSha256(resolved('disclosure')) !== canonicalSha256(disclosure.request) || canonicalSha256(resolved('processing')) !== canonicalSha256(processing.request)
			|| value.state === 'active' && (status.state !== 'active' || upload.receipt.state !== 'active' || disclosure.receipt.state !== 'active' || processing.receipt.state !== 'preparation_only')) {
			this.invalid('request_binding', { operation, reason: 'request_binding_mismatch' });
		}
		if (!Array.isArray(value.confirmations) || value.confirmations.length < 1 || value.confirmations.length > 32) {
			this.invalid('confirmation_shape', { operation, reason: 'confirmations_length_invalid' });
		}
		const confirmations = value.confirmations.map(item => {
			if (!exactObject(item, ['request', 'receipt'])) { this.invalid('confirmation_shape', { operation, reason: 'confirmation_item_not_exact' }); }
			const state = { ...common, ...item, workflowConsentId: workflowId } as DisclosureState;
			if (!validDisclosureState(state) || state.request.local_recording_session_id !== upload.request.local_recording_session_id
				|| state.request.upload_consent_id !== upload.receipt!.consent_id || state.request.approved_workspace_ids.some(w => !upload.request.approved_workspace_ids.includes(w))) {
				this.invalid('confirmation_scope', { operation, reason: 'confirmation_scope_mismatch' });
			}
			return state;
		});
		// Each Rails serializer independently samples Time.current. Compare all identity,
		// scope, window and revocation fields, excluding only that observation timestamp.
		// Both observations must still pass the full receipt validation above.
		const comparable = (state: DisclosureState) => {
			const { server_time, ...receipt } = state.receipt!; void server_time;
			return { ...state, receipt };
		};
		if (new Set(confirmations.map(s => s.request.request_id)).size !== confirmations.length
			|| !confirmations.some(s => canonicalSha256(comparable(s)) === canonicalSha256(comparable(disclosure)))) {
			this.invalid('confirmation_identity', { operation, reason: 'confirmation_identity_mismatch' });
		}
		return { workflowId, state: value.state as WorkflowReceipts['state'], status, upload: { ...upload, captureClosed: upload.receipt.state === 'stopped' }, disclosure, processing, confirmations };
	}
	private async send(auth: AssessmentAuthentication, path: string, method: 'GET' | 'POST' | 'DELETE', body: unknown, signal: AbortSignal, optionalCapability = false, operation = 'unknown'): Promise<unknown> {
		try {
			if (!validConnection(auth.connection) || auth.connection.mode !== 'rails' || !/^adt_ext_[A-Za-z0-9_-]{43}$/.test(auth.credential)) { throw new AssessmentApiError('authentication'); }
			const response = await this.transport.send({ endpoint: new URL(BASE + path, auth.connection.apiOrigin), method, token: auth.credential,
				body: body === undefined ? '' : JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
			if (optionalCapability && response.status === 404) { return undefined; }
			if ([401, 403].includes(response.status)) { throw new AssessmentApiError('authentication'); }
			if (response.status !== 200) {
				this.onProtocolFailure?.('response_shape', { operation, httpStatus: response.status, reason: `http_${response.status}` });
				throw new AssessmentApiError([404, 409, 413, 415, 422, 426].includes(response.status) ? 'rejected' : 'unavailable');
			}
			if (!/^application\/json(?:\s*;|$)/i.test(response.contentType ?? '')) { this.invalid('content_type', { operation, httpStatus: response.status, reason: 'content_type_not_json' }); }
			let value: unknown;
			try { value = parseRailsControlResponse(response.body, 262144); } catch { this.invalid('response_json', { operation, httpStatus: response.status, reason: 'parse_json_failed' }); }
			if (signal.aborted) { throw new AssessmentApiError('cancelled'); }
			if (!exactObject(value, ['data'])) { this.invalid('response_envelope', { operation, httpStatus: response.status, reason: 'missing_data_envelope' }); }
			return value.data;
		} catch (error) { throw error instanceof AssessmentApiError ? error : new AssessmentApiError(signal.aborted ? 'cancelled' : 'unavailable'); }
	}
}
