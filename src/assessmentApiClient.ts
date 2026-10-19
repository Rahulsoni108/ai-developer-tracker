import { randomUUID } from 'node:crypto';

export type AssessmentServerState = 'paired' | 'active' | 'submitted' | 'expired' | 'revoked';
export interface AssessmentConnection {
	codingSessionId: string;
	/** Pinned by the configured client, never taken from a pairing code. */
	apiOrigin: string;
	uploadEndpoint: string;
	mode: 'mock' | 'rails';
	credentialExpiresAt?: string;
}
export interface AssessmentServerStatus {
	codingSessionId: string;
	state: AssessmentServerState;
	serverTime: string;
	startedAt?: string;
	deadline?: string;
	/** The server must durably bind these IDs before authorizing recording. */
	localRecordingSessionIds: string[];
}
export interface AssessmentAuthentication { connection: AssessmentConnection; credential: string }
export interface AssessmentApiClient {
	readonly mode: 'mock' | 'rails' | 'unavailable';
	pair(code: string, signal: AbortSignal): Promise<{ connection: AssessmentConnection; credential: string; status: AssessmentServerStatus }>;
	startOrResume(auth: AssessmentAuthentication, request: { requestId: string; localRecordingSessionId: string }, signal: AbortSignal): Promise<AssessmentServerStatus>;
	revokeCredential?(auth: AssessmentAuthentication, signal: AbortSignal): Promise<void>;
	getStatus(auth: AssessmentAuthentication, signal: AbortSignal): Promise<AssessmentServerStatus>;
	submit(auth: AssessmentAuthentication, request: { requestId: string; localRecordingSessionIds: string[]; retainedEventCount: number }, signal: AbortSignal): Promise<AssessmentServerStatus>;
}
export type AssessmentFailure = 'unavailable' | 'rejected' | 'authentication' | 'protocol' | 'storage' | 'consent_required'
	| 'finalization_unavailable' | 'recording_busy' | 'evidence_pending' | 'cancelled' | 'session_ended' | 'recovery_required';
export class AssessmentApiError extends Error {
	constructor(readonly code: AssessmentFailure) { super('Assessment operation could not complete.'); }
}

/** Production stays fail-closed until a reviewed Rails transport is implemented. */
export class UnavailableAssessmentApiClient implements AssessmentApiClient {
	readonly mode = 'unavailable' as const;
	async pair(): Promise<never> { throw new AssessmentApiError('unavailable'); }
	async startOrResume(): Promise<never> { throw new AssessmentApiError('unavailable'); }
	async getStatus(): Promise<never> { throw new AssessmentApiError('unavailable'); }
	async submit(): Promise<never> { throw new AssessmentApiError('unavailable'); }
}

interface MockSession { credential: string; status: AssessmentServerStatus; acceptedEventCount: number; starts: Map<string, string> }
/** In-memory SERVER double. Reuse the instance across client restarts in tests. Never uploads or acknowledges queue rows. */
export class MockAssessmentApiClient implements AssessmentApiClient {
	readonly mode = 'mock' as const;
	private readonly invitations = new Map<string, { id: string; claimed: boolean }>();
	private readonly sessions = new Map<string, MockSession>();
	constructor(private readonly now: () => Date = () => new Date(), private readonly durationMs = 3600000) {}
	seedInvitation(code: string, codingSessionId: string, claimed = true): void {
		this.invitations.set(code, { id: codingSessionId, claimed });
	}
	/** Test-server control, representing durable acceptance elsewhere; never called by production commands. */
	setAcceptedEventCount(codingSessionId: string, count: number): void {
		const run = this.sessions.get(codingSessionId); if (!run || !Number.isSafeInteger(count) || count < 0) { throw new AssessmentApiError('protocol'); }
		run.acceptedEventCount = count;
	}
	async pair(code: string, signal: AbortSignal) {
		this.check(signal); const invitation = this.invitations.get(code);
		if (!invitation?.claimed) { throw new AssessmentApiError('rejected'); }
		if (this.sessions.has(invitation.id)) { throw new AssessmentApiError('rejected'); }
		const connection: AssessmentConnection = { codingSessionId: invitation.id, apiOrigin: 'https://assessment.invalid',
			uploadEndpoint: 'https://assessment.invalid/api/v2/assessment_events', mode: 'mock' };
		const run: MockSession = { credential: randomUUID(), acceptedEventCount: 0, starts: new Map(), status: { codingSessionId: invitation.id,
			state: 'paired', serverTime: this.now().toISOString(), localRecordingSessionIds: [] } };
		this.sessions.set(invitation.id, run); return { connection, credential: run.credential, status: structuredClone(run.status) };
	}
	async startOrResume(auth: AssessmentAuthentication, request: { requestId: string; localRecordingSessionId: string }, signal: AbortSignal) {
		const run = this.authorize(auth, signal);
		if (!['paired', 'active'].includes(run.status.state)) { throw new AssessmentApiError('session_ended'); }
		const previous = run.starts.get(request.requestId);
		if (previous && previous !== request.localRecordingSessionId) { throw new AssessmentApiError('rejected'); }
		if (!run.status.deadline) {
			run.status.startedAt = this.now().toISOString(); run.status.deadline = new Date(this.now().getTime() + this.durationMs).toISOString();
		}
		run.starts.set(request.requestId, request.localRecordingSessionId);
		if (!run.status.localRecordingSessionIds.includes(request.localRecordingSessionId)) { run.status.localRecordingSessionIds.push(request.localRecordingSessionId); }
		run.status.state = 'active'; return structuredClone(run.status);
	}
	async getStatus(auth: AssessmentAuthentication, signal: AbortSignal) { return structuredClone(this.authorize(auth, signal).status); }
	async submit(auth: AssessmentAuthentication, request: { requestId: string; localRecordingSessionIds: string[]; retainedEventCount: number }, signal: AbortSignal) {
		const run = this.authorize(auth, signal);
		if (run.status.state === 'submitted') { return structuredClone(run.status); }
		if (run.status.state !== 'active' || JSON.stringify(request.localRecordingSessionIds) !== JSON.stringify(run.status.localRecordingSessionIds)
			|| request.retainedEventCount !== run.acceptedEventCount) { throw new AssessmentApiError('evidence_pending'); }
		run.status.state = 'submitted'; return structuredClone(run.status);
	}
	private authorize(auth: AssessmentAuthentication, signal: AbortSignal): MockSession {
		this.check(signal); const run = this.sessions.get(auth.connection.codingSessionId);
		if (!run || auth.connection.apiOrigin !== 'https://assessment.invalid' || run.credential !== auth.credential) { throw new AssessmentApiError('authentication'); }
		run.status.serverTime = this.now().toISOString();
		if (run.status.state === 'active' && Date.parse(run.status.deadline!) <= this.now().getTime()) { run.status.state = 'expired'; }
		return run;
	}
	private check(signal: AbortSignal): void { if (signal.aborted) { throw new AssessmentApiError('cancelled'); } }
}
