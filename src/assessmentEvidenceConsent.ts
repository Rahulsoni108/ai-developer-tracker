import { randomUUID } from 'node:crypto';
import { AssessmentApiError, type AssessmentAuthentication, type AssessmentServerStatus } from './assessmentApiClient';
import { EVIDENCE_CONSENT_VERSION, type EvidenceConsentState } from './evidenceConsent';
import type { EvidenceConsentApi } from './railsEvidenceConsentClient';
import type { TrackerEvent } from './eventSchema';
import type { LocalEventQueue } from './localEventQueue';

export interface AssessmentConsentLifecycle {
	approve(auth: AssessmentAuthentication, localSessionId: string, status: AssessmentServerStatus, signal: AbortSignal): Promise<void>;
	close(auth: AssessmentAuthentication, localSessionId: string, signal: AbortSignal): Promise<void>;
	revoke(auth: AssessmentAuthentication, localSessionId: string, signal: AbortSignal): Promise<void>;
}
/** Called only after the separate, explicit assessment upload dialog and authenticated start/binding. */
export class AssessmentEvidenceConsent implements AssessmentConsentLifecycle {
	private pending: Promise<void> = Promise.resolve();
	private readonly blocked = new Set<string>();
	constructor(private readonly queue: Pick<LocalEventQueue, 'getEvidenceConsent' | 'setEvidenceConsent' | 'revokeEvidenceApprovals'>,
		/** Undefined is a local-only mock: retain a blocked intent, never fabricate a Rails receipt. */
		private readonly api: EvidenceConsentApi | undefined,
		private readonly scope: () => { workspaceIds: string[]; eventTypes: TrackerEvent['eventType'][] }) {}

	approve(auth: AssessmentAuthentication, localSessionId: string, status: AssessmentServerStatus, signal: AbortSignal): Promise<void> {
		return this.serial(async () => {
			if (signal.aborted || this.blocked.has(localSessionId) || status.codingSessionId !== auth.connection.codingSessionId
				|| status.state !== 'active' || !status.localRecordingSessionIds.includes(localSessionId)
				|| !status.deadline || Date.parse(status.serverTime) >= Date.parse(status.deadline)) { throw new AssessmentApiError('consent_required'); }
			const scope = this.scope();
			let state = await this.queue.getEvidenceConsent(localSessionId);
			if (state) {
				this.checkOwner(state, auth);
				if (state.locallyRevoked || state.captureClosed || state.deadline !== status.deadline
					|| JSON.stringify([...state.request.approved_workspace_ids].sort()) !== JSON.stringify([...scope.workspaceIds].sort())
					|| JSON.stringify([...state.request.event_types].sort()) !== JSON.stringify([...scope.eventTypes].sort())) { throw new AssessmentApiError('consent_required'); }
			} else {
				state = { version: 1, codingSessionId: status.codingSessionId, origin: auth.connection.apiOrigin,
					deadline: status.deadline, locallyRevoked: false, captureClosed: false, pendingAction: 'register',
					request: { request_id: randomUUID(), local_recording_session_id: localSessionId,
						approval_action: 'approve_upload', consent_version: EVIDENCE_CONSENT_VERSION, scope: 'assessment_evidence',
						approved_workspace_ids: [...scope.workspaceIds].sort(), event_types: [...scope.eventTypes].sort() } };
			}
			await this.queue.setEvidenceConsent(state); // Durable intent BEFORE network, never a stored credential.
			if (!this.api) { return; }
			const receipt = await this.api.register(auth, state, signal);
			state = { ...state, receipt, pendingAction: undefined };
			await this.queue.setEvidenceConsent(state);
			if (signal.aborted || this.blocked.has(localSessionId) || receipt.state !== 'active') { throw new AssessmentApiError('consent_required'); }
			// upload_authorized remains false: registration cannot enable assessment transmission.
		});
	}
	close(auth: AssessmentAuthentication, localSessionId: string, signal: AbortSignal): Promise<void> {
		return this.mutate(auth, localSessionId, 'stop', signal);
	}
	revoke(auth: AssessmentAuthentication, localSessionId: string, signal: AbortSignal): Promise<void> {
		// Immediate process-local denial, even while a registration request is in flight.
		this.blocked.add(localSessionId);
		return this.mutate(auth, localSessionId, 'revoke', signal);
	}
	private mutate(auth: AssessmentAuthentication, localSessionId: string, action: 'stop' | 'revoke', signal: AbortSignal): Promise<void> {
		return this.serial(async () => {
			let state = await this.queue.getEvidenceConsent(localSessionId); if (!state) { return; }
			this.checkOwner(state, auth);
			state = { ...state, captureClosed: true, locallyRevoked: state.locallyRevoked || action === 'revoke',
				pendingAction: state.locallyRevoked || action === 'revoke' ? 'revoke' : 'stop' };
			await this.queue.setEvidenceConsent(state); // Survives network failure/restart; never pretend server success.
			if (state.locallyRevoked) { await this.queue.revokeEvidenceApprovals(localSessionId); }
			if (!this.api) { return; }
			// There is no documented read-only receipt lookup. Replaying registration here could
			// CREATE a grant after withdrawal if the original request never reached Rails.
			// Keep local denial and the unresolved mutation; never invent a receipt/endpoint.
			if (!state.receipt) { throw new AssessmentApiError('recovery_required'); }
			const receipt = await (state.locallyRevoked ? this.api.revoke(auth, state, signal) : this.api.stop(auth, state, signal));
			await this.queue.setEvidenceConsent({ ...state, receipt, pendingAction: undefined });
		});
	}
	private checkOwner(state: EvidenceConsentState, auth: AssessmentAuthentication): void {
		if (state.codingSessionId !== auth.connection.codingSessionId || state.origin !== auth.connection.apiOrigin) { throw new AssessmentApiError('authentication'); }
	}
	private serial(operation: () => Promise<void>): Promise<void> {
		const next = this.pending.then(operation); this.pending = next.catch(() => {}); return next;
	}
}
