import { createHash, randomUUID } from 'node:crypto';
import { AssessmentApiError, type AssessmentAuthentication } from './assessmentApiClient';
import { DISCLOSURE_VERSION, disclosureSourceKey, validDisclosureState, type DisclosureRequest, type DisclosureCategory, type DisclosureSource, type DisclosureState } from './assessmentDisclosure';
import type { LocalEventQueue } from './localEventQueue';
import type { DisclosureApi } from './railsDisclosureConsentClient';

export interface DisclosureSelection { categories: DisclosureCategory[]; workspaceIds: string[]; sourceSessions: DisclosureSource[] }
export interface DisclosureContext {
	auth: AssessmentAuthentication; localSessionIds: readonly string[]; currentRecording?: string;
	/** Rechecked across dialogs/network; archival, stop and credential/consent changes invalidate grants. */
	current(): boolean;
}
/** Separate optional control plane. Never mutates events, upload approvals, recording or finalization. */
export class AssessmentDisclosureConsent {
	private pending: Promise<unknown> = Promise.resolve();
	private readonly blocked = new Set<string>();
	constructor(private readonly queue: Pick<LocalEventQueue, 'getDisclosureConsents' | 'setDisclosureConsent' | 'getEvidenceConsent'>,
		private readonly api: DisclosureApi,
		private readonly approvedSources: (recordingId: string) => { workspaceId: string; session: DisclosureSource }[]) {}
	async choices(context: DisclosureContext): Promise<{ workspaceIds: string[]; sources: { workspaceId: string; session: DisclosureSource }[] }> {
		const upload = await this.upload(context);
		return { workspaceIds: [...upload.request.approved_workspace_ids], sources: this.approvedSources(context.currentRecording!)
			.filter(s => upload.request.approved_workspace_ids.includes(s.workspaceId)) };
	}
	grant(context: DisclosureContext, selection: DisclosureSelection, signal: AbortSignal): Promise<DisclosureState> {
		return this.serial(async () => {
			const upload = await this.upload(context); const id = context.currentRecording!;
			const allowed = this.approvedSources(id).filter(s => selection.workspaceIds.includes(s.workspaceId)).map(s => disclosureSourceKey(s.session));
			if (!selection.categories.length || !selection.workspaceIds.length || selection.workspaceIds.some(w => !upload.request.approved_workspace_ids.includes(w))
				|| selection.sourceSessions.some(s => !allowed.includes(disclosureSourceKey(s))) || signal.aborted || !context.current()) { throw new AssessmentApiError('consent_required'); }
			const request: DisclosureRequest = { request_id: randomUUID(), local_recording_session_id: id, upload_consent_id: upload.receipt!.consent_id,
				approval_action: 'approve_recruiter_disclosure' as const, consent_version: DISCLOSURE_VERSION,
				audience: 'job_owning_recruiter' as const, purpose: 'assessment_review' as const,
				categories: [...selection.categories].sort(), approved_workspace_ids: [...selection.workspaceIds].sort(),
				approved_source_sessions: [...selection.sourceSessions].sort((a, b) => disclosureSourceKey(a).localeCompare(disclosureSourceKey(b))) };
			const states = await this.queue.getDisclosureConsents(id);
			const same = (s: DisclosureState) => JSON.stringify({ ...s.request, request_id: '' }) === JSON.stringify({ ...request, request_id: '' });
			// Only an explicit retry can resume an unresolved grant. Never restore permission from a receipt alone.
			let state = states.find(s => s.pendingAction === 'grant' && !s.locallyRevoked && same(s));
			if (!state) { state = { version: 1, codingSessionId: upload.codingSessionId, origin: upload.origin,
				credentialDigest: upload.credentialDigest!, deadline: upload.deadline, request, locallyRevoked: false, pendingAction: 'grant' }; }
			this.owner(context, state);
			if (!validDisclosureState(state) || this.blocked.has(state.request.request_id)) { throw new AssessmentApiError('consent_required'); }
			await this.queue.setDisclosureConsent(state);
			if (!context.current() || signal.aborted || this.blocked.has(state.request.request_id)) { throw new AssessmentApiError('cancelled'); }
			const receipt = await this.api.send(context.auth, state, 'grant', signal);
			state = { ...state, receipt, pendingAction: undefined };
			await this.queue.setDisclosureConsent(state);
			if (!context.current()) { throw new AssessmentApiError('cancelled'); }
			return state; // raw_disclosure_enabled remains false; no event sidecar or capture permission.
		});
	}
	list(context: DisclosureContext): Promise<DisclosureState[]> {
		return this.serial(async () => {
			const states: DisclosureState[] = [];
			for (const id of context.localSessionIds) { for (const s of await this.queue.getDisclosureConsents(id)) { this.owner(context, s); states.push(s); } }
			if (!context.current()) { throw new AssessmentApiError('cancelled'); } return states;
		});
	}
	inspect(context: DisclosureContext, state: DisclosureState, signal: AbortSignal): Promise<DisclosureState> {
		return this.serial(async () => {
			const stored = await this.stored(context, state);
			if (!stored.receipt) { return stored; } // Cannot discover unknown receipts by replaying a grant.
			const receipt = await this.api.send(context.auth, stored, 'status', signal);
			const next = { ...stored, receipt }; await this.queue.setDisclosureConsent(next); return next;
		});
	}
	revoke(context: DisclosureContext, state: DisclosureState, signal: AbortSignal): Promise<DisclosureState> {
		this.blocked.add(state.request.request_id); // Deny future local use immediately, including an in-flight grant.
		return this.serial(async () => {
			let stored = await this.stored(context, state);
			stored = { ...stored, locallyRevoked: true, pendingAction: 'revoke' };
			await this.queue.setDisclosureConsent(stored); // Durable local withdrawal before network.
			if (!stored.receipt) { throw new AssessmentApiError('recovery_required'); }
			const receipt = await this.api.send(context.auth, stored, 'revoke', signal);
			const next = { ...stored, receipt, pendingAction: undefined }; await this.queue.setDisclosureConsent(next); return next;
		});
	}
	private async stored(context: DisclosureContext, state: DisclosureState): Promise<DisclosureState> {
		this.owner(context, state);
		const stored = (await this.queue.getDisclosureConsents(state.request.local_recording_session_id)).find(s => s.request.request_id === state.request.request_id);
		if (!stored) { throw new AssessmentApiError('recovery_required'); } this.owner(context, stored); return stored;
	}
	private owner(context: DisclosureContext, state: DisclosureState): void {
		if (!context.current() || !context.localSessionIds.includes(state.request.local_recording_session_id)
			|| state.codingSessionId !== context.auth.connection.codingSessionId || state.origin !== context.auth.connection.apiOrigin
			|| state.credentialDigest !== createHash('sha256').update(context.auth.credential).digest('hex')) { throw new AssessmentApiError('authentication'); }
	}
	private async upload(context: DisclosureContext) {
		if (!context.current() || !context.currentRecording || !context.localSessionIds.includes(context.currentRecording)) { throw new AssessmentApiError('recording_busy'); }
		const scope = await this.queue.getEvidenceConsent(context.currentRecording);
		if (!scope || scope.locallyRevoked || scope.captureClosed || scope.pendingAction || scope.receipt?.state !== 'active') { throw new AssessmentApiError('consent_required'); }
		if (scope.codingSessionId !== context.auth.connection.codingSessionId || scope.origin !== context.auth.connection.apiOrigin
			|| scope.credentialDigest !== createHash('sha256').update(context.auth.credential).digest('hex')) { throw new AssessmentApiError('authentication'); }
		return scope;
	}
	private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.pending.then(work); this.pending = next.catch(() => {}); return next; }
}
