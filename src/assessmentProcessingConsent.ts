import { validAssessmentProcessorPolicy, isAssessmentProcessorPolicy, processorScope, type TrustedProcessor } from './processorPolicy';
import { createHash, randomUUID } from 'node:crypto';
import type { SecretStorage } from 'vscode';
import { AssessmentApiError } from './assessmentApiClient';
import { assessmentArchiveKey } from './assessmentStorage';
import type { DisclosureContext } from './assessmentDisclosureConsent';
import { disclosureCategoryForEvent } from './assessmentEventApproval';
import type { TrackerEvent } from './eventSchema';
import { disclosureSourceKey, type DisclosureSource } from './assessmentDisclosure';
import type { LocalEventQueue } from './localEventQueue';
import { PROCESSING_PURPOSE, PROCESSING_RETENTION, PROCESSING_VERSION, sameProcessingValue, validProcessingState, validProcessorScope,
	type ProcessorScope, type ProcessingRequest, type ProcessingSelection, type ProcessingState } from './processingConsent';
import type { ProcessingApi } from './railsProcessingConsentClient';

type Secrets = Pick<SecretStorage, 'get' | 'store'>;
type Sources = { workspaceId: string; session: DisclosureSource }[];
/** Authenticated Rails policy discovery supplies this; synthetic legacy scopes are test-only. Never settings or receipt-derived. */
export type TrustedProcessorPolicy = (context: DisclosureContext) => Promise<TrustedProcessor | undefined>;
export const PROCESSOR_UNAVAILABLE = 'AI processing consent is unavailable: Rails has not supplied an available, approved processor policy (provider, model, HTTPS origin and configuration digest). No processing grant was sent. Recording, upload and recruiter disclosure choices are unchanged.';

/** Optional control ledger. No collector/uploader consumes this as evidence approval. */
export class AssessmentProcessingConsent {
	private pending: Promise<unknown> = Promise.resolve();
	private readonly withdrawn = new Set<string>();
	constructor(private readonly secrets: Secrets, private readonly queue: Pick<LocalEventQueue, 'getEvidenceConsent'>,
		private readonly api: ProcessingApi, private readonly approvedSources: (id: string) => Sources,
		// No policy is trusted by default. Production explicitly injects the pinned Rails client.
		private readonly trustedPolicy: TrustedProcessorPolicy = async () => undefined) {}
	async processor(context: DisclosureContext): Promise<TrustedProcessor | undefined> {
		this.current(context); const scope = await this.trustedPolicy(context); this.current(context);
		if (scope !== undefined && !(isAssessmentProcessorPolicy(scope) ? validAssessmentProcessorPolicy(scope) && scope.coding_session_id === context.auth.connection.codingSessionId : validProcessorScope(scope))) { throw new AssessmentApiError('protocol'); }
		return scope === undefined ? undefined : structuredClone(scope);
	}
	async choices(context: DisclosureContext) {
		const upload = await this.upload(context);
		return { workspaceIds: [...upload.request.approved_workspace_ids], sources: this.approvedSources(context.currentRecording!)
			.filter(s => upload.request.approved_workspace_ids.includes(s.workspaceId)) };
	}
	grant(context: DisclosureContext, selection: ProcessingSelection, processor: TrustedProcessor, signal: AbortSignal): Promise<ProcessingState> {
		return this.serial(async () => {
			const verified = await this.processor(context);
			if (!verified || !sameProcessingValue(isAssessmentProcessorPolicy(verified) ? verified.policy_digest : verified, isAssessmentProcessorPolicy(processor) ? processor.policy_digest : processor)) { throw new AssessmentApiError('unavailable'); }
			const upload = await this.upload(context); this.current(context, signal);
			const sources = this.approvedSources(context.currentRecording!).filter(s => selection.workspaceIds.includes(s.workspaceId)).map(s => disclosureSourceKey(s.session));
			if (selection.workspaceIds.some(w => !upload.request.approved_workspace_ids.includes(w))
				|| selection.sourceSessions.some(s => !sources.includes(disclosureSourceKey(s)))
				|| selection.categories.some(c => !upload.request.event_types.some(eventType => disclosureCategoryForEvent({ eventType } as TrackerEvent) === c))) { throw new AssessmentApiError('consent_required'); }
			const request: ProcessingRequest = { request_id: randomUUID(), local_recording_session_id: context.currentRecording!, upload_consent_id: upload.receipt!.consent_id,
				approval_action: 'approve_assessment_ai_processing', consent_version: isAssessmentProcessorPolicy(verified) ? verified.consent_version : PROCESSING_VERSION, purpose: PROCESSING_PURPOSE,
				retention_policy_version: isAssessmentProcessorPolicy(verified) ? verified.retention_policy_version : PROCESSING_RETENTION, external_processing_permitted: true, processor_scope: processorScope(verified),
				...(isAssessmentProcessorPolicy(verified) ? { processing_policy_digest: verified.policy_digest } : {}),
				categories: [...selection.categories].sort(), approved_workspace_ids: [...selection.workspaceIds].sort(),
				approved_source_sessions: [...selection.sourceSessions].sort((a, b) => disclosureSourceKey(a).localeCompare(disclosureSourceKey(b))) };
			const states = await this.load(context);
			const last = states.at(-1);
			if (last?.pendingAction === 'revoke') { throw new AssessmentApiError('recovery_required'); }
			const sameRequest = (r: ProcessingRequest) => ({ ...r, request_id: '' });
			if (last?.pendingAction === 'grant' && !sameProcessingValue(sameRequest(last.request), sameRequest(request))) { throw new AssessmentApiError('recovery_required'); }
			let state: ProcessingState = last?.pendingAction === 'grant' ? last : { version: 1, codingSessionId: upload.codingSessionId,
				origin: upload.origin, credentialDigest: upload.credentialDigest!, deadline: upload.deadline, request, ...(isAssessmentProcessorPolicy(verified) ? { policy: verified } : {}), locallyRevoked: false, pendingAction: 'grant' };
			if (!validProcessingState(state) || state.locallyRevoked || this.withdrawn.has(state.request.request_id)) { throw new AssessmentApiError('consent_required'); }
			await this.save(context, state); this.current(context, signal);
			const receipt = await this.api.send(context.auth, state, 'grant', signal);
			// Preserve a racing withdrawal; never restore permission from a successful late response.
			state = { ...state, receipt, pendingAction: this.withdrawn.has(state.request.request_id) ? 'revoke' : undefined,
				locallyRevoked: this.withdrawn.has(state.request.request_id) };
			await this.save(context, state); return state;
		});
	}
	list(context: DisclosureContext): Promise<ProcessingState[]> { return this.serial(() => this.load(context)); }
	inspect(context: DisclosureContext, state: ProcessingState, signal: AbortSignal): Promise<ProcessingState> {
		return this.serial(async () => {
			const stored = await this.stored(context, state); if (!stored.receipt) { return stored; }
			const receipt = await this.api.send(context.auth, stored, 'status', signal); this.current(context, signal);
			const next = { ...stored, receipt }; await this.save(context, next); return next;
		});
	}
	revoke(context: DisclosureContext, state: ProcessingState, signal: AbortSignal): Promise<ProcessingState> {
		this.withdrawn.add(state.request.request_id);
		return this.serial(async () => {
			let stored = await this.stored(context, state);
			stored = { ...stored, locallyRevoked: true, pendingAction: 'revoke' };
			await this.save(context, stored); // Durable intent before DELETE; no background grant or replay on restart.
			if (!stored.receipt) { throw new AssessmentApiError('recovery_required'); }
			this.current(context, signal);
			const receipt = await this.api.send(context.auth, stored, 'revoke', signal); this.current(context, signal);
			const next = { ...stored, receipt, pendingAction: undefined }; await this.save(context, next); return next;
		});
	}
	private current(context: DisclosureContext, signal?: AbortSignal): void {
		if (!context.current() || signal?.aborted) { throw new AssessmentApiError('cancelled'); }
		if (context.auth.connection.mode !== 'rails') { throw new AssessmentApiError('unavailable'); }
	}
	private owner(context: DisclosureContext, state: ProcessingState): void {
		this.current(context);
		if (state.origin !== context.auth.connection.apiOrigin || state.codingSessionId !== context.auth.connection.codingSessionId
			|| state.credentialDigest !== createHash('sha256').update(context.auth.credential).digest('hex')
			|| !context.localSessionIds.includes(state.request.local_recording_session_id)) { throw new AssessmentApiError('authentication'); }
	}
	private key(context: DisclosureContext): string { return 'ai-developer-tracker.processing-consent.v1.' + assessmentArchiveKey(context.auth.connection); }
	private async load(context: DisclosureContext): Promise<ProcessingState[]> {
		this.current(context);
		try {
			const value = await this.secrets.get(this.key(context)); this.current(context);
			if (value === undefined) { return []; }
			if (Buffer.byteLength(value) > 2 * 1024 * 1024) { throw new Error(); }
			const states: unknown = JSON.parse(value);
			if (!Array.isArray(states) || states.length > 128 || !states.every(validProcessingState)
				|| new Set(states.map(s => s.request.request_id)).size !== states.length) { throw new Error(); }
			for (const state of states) { this.owner(context, state); } return states;
		} catch (e) { throw e instanceof AssessmentApiError ? e : new AssessmentApiError('storage'); }
	}
	private async save(context: DisclosureContext, state: ProcessingState): Promise<void> {
		this.owner(context, state); if (!validProcessingState(state)) { throw new AssessmentApiError('protocol'); }
		const states = await this.load(context); const index = states.findIndex(s => s.request.request_id === state.request.request_id);
		if (index < 0) { states.push(state); } else { states[index] = state; }
		if (states.length > 128 || Buffer.byteLength(JSON.stringify(states)) > 2 * 1024 * 1024) { throw new AssessmentApiError('storage'); }
		try { await this.secrets.store(this.key(context), JSON.stringify(states)); } catch { throw new AssessmentApiError('storage'); }
		this.current(context);
	}
	private async stored(context: DisclosureContext, state: ProcessingState): Promise<ProcessingState> {
		this.owner(context, state);
		const stored = (await this.load(context)).find(s => s.request.request_id === state.request.request_id);
		if (!stored) { throw new AssessmentApiError('recovery_required'); } return stored;
	}
	private async upload(context: DisclosureContext) {
		this.current(context);
		if (!context.currentRecording || !context.localSessionIds.includes(context.currentRecording)) { throw new AssessmentApiError('recording_busy'); }
		const upload = await this.queue.getEvidenceConsent(context.currentRecording); this.current(context);
		if (!upload || upload.locallyRevoked || upload.captureClosed || upload.pendingAction || upload.receipt?.state !== 'active') { throw new AssessmentApiError('consent_required'); }
		if (upload.codingSessionId !== context.auth.connection.codingSessionId || upload.origin !== context.auth.connection.apiOrigin
			|| upload.credentialDigest !== createHash('sha256').update(context.auth.credential).digest('hex')) { throw new AssessmentApiError('authentication'); }
		return upload;
	}
	private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.pending.then(work); this.pending = next.catch(() => {}); return next; }
}
