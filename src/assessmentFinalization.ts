import { utcTime } from './evidenceConsent';

export interface RecordingManifest {
	local_recording_session_id: string;
	event_count: number;
	event_ids_sha256: string;
}
/** Exact R4.3 wire contract; persisted encrypted before the first attempt. */
export interface AssessmentFinalizationRequest {
	contract_version: 1;
	request_id: string;
	recordings: RecordingManifest[];
}
export interface AssessmentSubmissionReceipt {
	contract_version: 1;
	request_id: string;
	submitted_at: string;
	event_count: number;
	recording_count: number;
}
export interface FinalizationScope { codingSessionId: string; origin: string; requestId: string; localRecordingSessionIds: string[] }
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
	&& Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));
// R4.3 accepts canonical UUID versions 1–8. Locally generated recording/request IDs remain v4.
const uuid = (id: unknown): id is string => typeof id === 'string'
	&& /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function validFinalizationRequest(value: unknown): value is AssessmentFinalizationRequest {
	try {
		if (!exact(value, ['contract_version', 'request_id', 'recordings']) || value.contract_version !== 1 || !uuid(value.request_id)
			|| !Array.isArray(value.recordings) || !value.recordings.length || value.recordings.length > 32) { return false; }
		return value.recordings.every(row => exact(row, ['local_recording_session_id', 'event_count', 'event_ids_sha256'])
			&& uuid(row.local_recording_session_id) && count(row.event_count) && typeof row.event_ids_sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.event_ids_sha256))
			&& new Set(value.recordings.map(row => row.local_recording_session_id)).size === value.recordings.length
			&& Buffer.byteLength(JSON.stringify(value)) <= 16384 && Number.isSafeInteger(value.recordings.reduce((sum, row) => sum + row.event_count, 0));
	} catch { return false; }
}
export function validSubmissionReceipt(value: unknown): value is AssessmentSubmissionReceipt {
	return exact(value, ['contract_version', 'request_id', 'submitted_at', 'event_count', 'recording_count']) && value.contract_version === 1
		&& uuid(value.request_id) && utcTime(value.submitted_at) && count(value.event_count) && count(value.recording_count)
		&& value.recording_count >= 1 && value.recording_count <= 32;
}
export function receiptMatches(receipt: AssessmentSubmissionReceipt | undefined, request: AssessmentFinalizationRequest): boolean {
	return validSubmissionReceipt(receipt) && receipt.request_id === request.request_id && receipt.recording_count === request.recordings.length
		&& receipt.event_count === request.recordings.reduce((sum, row) => sum + row.event_count, 0);
}
