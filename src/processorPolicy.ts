import { AssessmentApiError, type AssessmentAuthentication } from './assessmentApiClient';
import { validConnection } from './assessmentStorage';
import { canonicalSha256 } from './canonicalJson';
import { DISCLOSURE_CATEGORIES } from './assessmentDisclosure';
import { utcTime } from './evidenceConsent';
import { exactObject, parseRailsControlResponse } from './railsControlResponse';
import { HttpsEventTransport, type UploadTransport } from './httpsEventTransport';
import { validProcessorScope, type ProcessorScope } from './processingConsent';

export const PROCESSING_DISPATCH_VERSION = 'assessment-ai-processing.v2';
export const PROCESSING_REPORT_RETENTION = 'assessment-report-retention.v1';
export interface AssessmentProcessorPolicy {
	version: 'assessment-processor-policy.v1'; available: true; coding_session_id: string; server_time: string;
	purpose: 'assessment_performance_evaluation'; consent_version: typeof PROCESSING_DISPATCH_VERSION;
	retention_policy_version: typeof PROCESSING_REPORT_RETENTION;
	processor: { id: string; name: string; description: string; external: true };
	processor_scope: ProcessorScope; categories: string[]; evaluation_enabled: boolean; policy_digest: string;
	terms: { provider_data_policy: 'operator_approved_no_training'; withdrawal: 'blocks_undispatched_requests';
		reports_after_withdrawal: 'retain_until_expiry'; report_retention_days: number; prepared_input_persistence: 'none'; prospective_only: true };
}
export const PROCESSING_DISPATCH_LIMITATIONS = {
	retention_policy_version: PROCESSING_REPORT_RETENTION, prepared_input_persistence: 'none', external_processing_enabled: false,
	provider_retention: 'operator_approved_no_training', withdrawal: 'blocks_undispatched_requests', existing_report_policy: 'retain_until_expiry'
} as const;
const safeText = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9 .,_():/-]{1,256}$/.test(v);
/** The digest binds displayed terms, not trusted execution. HTTPS/authentication is the trust boundary. */
export function validAssessmentProcessorPolicy(v: unknown): v is AssessmentProcessorPolicy {
	if (!exactObject(v, ['version', 'available', 'coding_session_id', 'server_time', 'purpose', 'consent_version', 'retention_policy_version', 'processor',
		'processor_scope', 'categories', 'evaluation_enabled', 'policy_digest', 'terms']) || v.version !== 'assessment-processor-policy.v1'
		|| v.available !== true || typeof v.coding_session_id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(v.coding_session_id) || !utcTime(v.server_time)
		|| v.purpose !== 'assessment_performance_evaluation' || v.consent_version !== PROCESSING_DISPATCH_VERSION || v.retention_policy_version !== PROCESSING_REPORT_RETENTION
		|| !exactObject(v.processor, ['id', 'name', 'description', 'external']) || ![v.processor.id, v.processor.name, v.processor.description].every(safeText) || v.processor.external !== true
		|| !validProcessorScope(v.processor_scope) || !Array.isArray(v.categories) || v.categories.length !== 3
		|| new Set(v.categories).size !== 3 || !v.categories.every(c => DISCLOSURE_CATEGORIES.includes(c)) || typeof v.evaluation_enabled !== 'boolean'
		|| !exactObject(v.terms, ['provider_data_policy', 'withdrawal', 'reports_after_withdrawal', 'report_retention_days', 'prepared_input_persistence', 'prospective_only'])
		|| v.terms.provider_data_policy !== 'operator_approved_no_training' || v.terms.withdrawal !== 'blocks_undispatched_requests'
		|| v.terms.reports_after_withdrawal !== 'retain_until_expiry' || !Number.isSafeInteger(v.terms.report_retention_days)
		|| (v.terms.report_retention_days as number) < 1 || (v.terms.report_retention_days as number) > 365
		|| v.terms.prepared_input_persistence !== 'none' || v.terms.prospective_only !== true) { return false; }
	try {
		const { policy_digest, server_time, coding_session_id, ...body } = v;
		void server_time; void coding_session_id;
		return typeof policy_digest === 'string' && /^[a-f0-9]{64}$/.test(policy_digest) && canonicalSha256(body) === policy_digest;
	} catch { return false; }
}
export type TrustedProcessor = ProcessorScope | AssessmentProcessorPolicy;
export const isAssessmentProcessorPolicy = (v: TrustedProcessor): v is AssessmentProcessorPolicy => 'version' in v;
export const processorScope = (v: TrustedProcessor): ProcessorScope => isAssessmentProcessorPolicy(v) ? v.processor_scope : v;

/** Paired Rails only. No settings-supplied processor, LLM calls or evidence request bodies. */
export class RailsProcessorPolicyClient {
	constructor(private readonly transport: UploadTransport = new HttpsEventTransport()) {}
	dispose(): void { if (this.transport instanceof HttpsEventTransport) { this.transport.dispose(); } }
	async get(auth: AssessmentAuthentication, signal: AbortSignal): Promise<AssessmentProcessorPolicy | undefined> {
		try {
			if (signal.aborted) { throw new AssessmentApiError('cancelled'); }
			if (!validConnection(auth.connection) || auth.connection.mode !== 'rails' || !/^[\x21-\x7e]{1,8192}$/.test(auth.credential)) { throw new AssessmentApiError('authentication'); }
			const response = await this.transport.send({ endpoint: new URL('/api/v2/coding_session/extension/processor_policy', auth.connection.apiOrigin),
				method: 'GET', token: auth.credential, body: '', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
			if ([401, 403].includes(response.status)) { throw new AssessmentApiError('authentication'); }
			if (response.status !== 200) { throw new AssessmentApiError('unavailable'); }
			if (!/^application\/json(?:\s*;|$)/i.test(response.contentType ?? '')) { throw new AssessmentApiError('protocol'); }
			const responseBody = parseRailsControlResponse(response.body);
			if (!exactObject(responseBody, ['data'])) { throw new AssessmentApiError('protocol'); }
			const v = responseBody.data;
			if (exactObject(v, ['version', 'available', 'reason', 'evaluation_enabled', 'coding_session_id', 'server_time'])
				&& v.version === 'assessment-processor-policy.v1' && v.available === false && v.reason === 'processor_policy_unavailable'
				&& v.evaluation_enabled === false && v.coding_session_id === auth.connection.codingSessionId && utcTime(v.server_time)) { return undefined; }
			if (!validAssessmentProcessorPolicy(v) || v.coding_session_id !== auth.connection.codingSessionId || signal.aborted) { throw new AssessmentApiError('protocol'); }
			return v;
		} catch (e) { throw e instanceof AssessmentApiError ? e : new AssessmentApiError(signal.aborted ? 'cancelled' : 'unavailable'); }
	}
}
