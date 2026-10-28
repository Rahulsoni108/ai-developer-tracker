import type { DisclosureContext } from './assessmentDisclosureConsent';
import type { AssessmentStartDiagnostic, AssessmentStartStep } from './assessmentStartDiagnostics';
import { assessmentArchiveKey, type AssessmentArchive, type AssessmentArchiveIndex } from './assessmentArchive';
import { receiptMatches, type AssessmentFinalizationRequest, type FinalizationScope } from './assessmentFinalization';
import type { AssessmentDeliveryLifecycle } from './assessmentEventDelivery';
import type { AssessmentConsentLifecycle } from './assessmentEvidenceConsent';
import { randomUUID } from 'node:crypto';
import type { RecordingController } from './recording';
import { AssessmentApiError, type AssessmentApiClient, type AssessmentAuthentication, type AssessmentFailure, type AssessmentServerStatus } from './assessmentApiClient';
import { validConnection, validServerStatus, type AssessmentMetadata, type AssessmentState, type AssessmentStore } from './assessmentStorage';

export interface AssessmentEvidenceStatus { totalEvents: number; pendingEvents: number; missingSessions: number }
export interface AssessmentEvidence {
	/** Stop has already happened. Drain all collectors/correlations before completing this local session. */
	flushStopped(localSessionId: string): Promise<void>;
	getStatus(localSessionIds: readonly string[]): Promise<AssessmentEvidenceStatus>;
	disableDevelopmentUploads(): Promise<void>;
	freezeFinalization?(scope: FinalizationScope, existingOnly?: boolean): Promise<AssessmentFinalizationRequest>;
}
export interface AssessmentView {
	state: AssessmentState; mode?: 'mock' | 'rails'; reason?: AssessmentFailure; serverTime?: string; deadline?: string;
	/** Display only; measured at the last server response, never from the host's wall clock. */
	remainingMsAtLastCheck?: number; pendingEvents?: number;
	uploadConsent: boolean; uploadStatus?: string;
	lastStart?: AssessmentStartDiagnostic; archiving?: boolean; archivedCount?: number; archivedUnconfirmedCount?: number;
}

/** Assessment workflow only. RecordingController remains the sole recording-state owner. */
export class AssessmentController {
	private metadata?: AssessmentMetadata;
	private phase: AssessmentState = 'unpaired';
	private reason?: AssessmentFailure;
	private pendingEvents?: number;
	private lastStart?: AssessmentStartDiagnostic;
	private consent = false;
	private initialized = false;
	private disposed = false;
	private busy?: Promise<void>;
	private request?: AbortController;
	private starting = false;
	private submitting = false;
	private archiving = false;
	private archiveWork?: Promise<void>;
	private archiveIndex: AssessmentArchiveIndex = { archives: [] };
	private readonly archivedRecordings = new Set<string>();
	private generation = 0;
	private readonly lifecycle: { dispose(): void };
	private consentWork: Promise<void> = Promise.resolve();
	private readonly closingSessions = new Map<string, Promise<void>>();
	constructor(private readonly api: AssessmentApiClient, private readonly store: AssessmentStore,
		private readonly recording: RecordingController, private readonly evidence: AssessmentEvidence,
		private readonly confirmUpload: (hostname: string) => Promise<boolean>,
		private readonly onChange: (view: AssessmentView) => void = () => {}, private readonly requestTimeoutMs = 10000,
		private readonly evidenceConsents?: AssessmentConsentLifecycle, private readonly delivery?: AssessmentDeliveryLifecycle,
		private readonly onStartDiagnostic: (value: AssessmentStartDiagnostic) => void = () => {}) {
		this.lifecycle = recording.addLifecycleListener({
			preparation: 'assessment_authorization',
			prepare: async (id, current) => {
				if (!this.starting) { return; }
				const generation = this.generation; const metadata = this.metadata!;
				this.startStep('upload_consent');
				this.consent = await this.confirmUpload(new URL(metadata.connection.uploadEndpoint).hostname);
				if (!this.consent) { throw new AssessmentApiError('consent_required'); }
				await this.evidence.disableDevelopmentUploads();
				if (!current() || this.disposed || generation !== this.generation) { throw new AssessmentApiError('cancelled'); }
				if (metadata.localRecordingSessionIds.length >= 32) { throw new AssessmentApiError('recovery_required'); }
				this.startStep('binding_write');
				metadata.localRecordingSessionIds.push(id); await this.save('starting');
				this.startStep('rails_start');
				const status = await this.call(signal => this.api.startOrResume(this.auth!, { requestId: id, localRecordingSessionId: id }, signal));
				this.startStep('binding_validation'); this.accept(status);
				if (status.state !== 'active' || !status.localRecordingSessionIds.includes(id)
					|| Date.parse(status.deadline!) <= Date.parse(status.serverTime)) { throw new AssessmentApiError('session_ended'); }
				// Persist binding/deadline BEFORE RecordingController activates any collector.
				await this.save('starting');
				if (this.evidenceConsents) { this.startStep('evidence_consent'); await this.call(signal => this.evidenceConsents!.approve(this.auth!, id, status, signal)); }
				if (!current() || this.disposed || generation !== this.generation) { throw new AssessmentApiError('cancelled'); }
			},
			started: () => {}, cancelled: id => {
				if (!this.archiving && this.evidenceConsents && this.auth && this.isAssociatedSession(id)) { this.closeStoppedConsent(id); }
			},
			stopped: id => { if (this.isAssociatedSession(id) && !this.disposed) { this.set('submission_pending');
				if (!this.archiving && this.evidenceConsents && this.auth) { this.closeStoppedConsent(id); }
			} }
		});
	}
	private auth?: AssessmentAuthentication;
	get mode(): AssessmentApiClient['mode'] { return this.api.mode; }
	get view(): AssessmentView {
		const status = this.metadata?.serverStatus;
		const mode = this.metadata?.connection.mode ?? (this.api.mode === 'unavailable' ? undefined : this.api.mode);
		return { state: this.phase, ...(this.lastStart ? { lastStart: { ...this.lastStart } } : {}), ...(this.archiving ? { archiving: true } : {}),
			...(this.archiveIndex.archives.length ? { archivedCount: this.archiveIndex.archives.length, archivedUnconfirmedCount: this.archiveIndex.archives.filter(item => !item.submissionConfirmed).length } : {}), ...(mode ? { mode } : {}), ...(this.reason ? { reason: this.reason } : {}),
			...(status ? { serverTime: status.serverTime, ...(status.deadline ? { deadline: status.deadline,
				remainingMsAtLastCheck: Math.max(0, Date.parse(status.deadline) - Date.parse(status.serverTime)) } : {}) } : {}),
			...(this.pendingEvents !== undefined ? { pendingEvents: this.pendingEvents } : {}), uploadConsent: this.consent, ...(this.delivery?.status ? { uploadStatus: this.delivery.status } : {}) };
	}
	isAssociatedSession(id: string): boolean { return this.metadata?.localRecordingSessionIds.includes(id) ?? false; }
	/** General-purpose development uploader must never send assessment evidence to arbitrary credentials/endpoints. */
	allowsDevelopmentUpload(id: string): boolean { return this.initialized && this.phase !== 'error' && !this.archiving && !this.archivedRecordings.has(id) && !this.isAssociatedSession(id); }
	revokeUploadConsent(): Promise<void> {
		this.consent = false; ++this.generation; this.request?.abort();
		const disabling = this.delivery?.disable() ?? Promise.resolve();
		if (this.starting) { this.recording.stop(); }
		this.set(this.phase, 'consent_required');
		const auth = this.auth;
		if (!this.archiving && this.evidenceConsents && auth && this.metadata?.serverStatus.state !== 'submitted') {
			const tasks = (this.metadata?.localRecordingSessionIds ?? []).map(id => this.evidenceConsents!.revoke(auth, id, AbortSignal.timeout(this.requestTimeoutMs)));
			this.consentWork = Promise.all(tasks).then(() => {}, () => { this.set(this.phase, 'recovery_required'); });
		}
		return Promise.all([disabling, this.consentWork]).then(() => {});
	}
	initialize(): Promise<void> {
		return this.run(async () => {
			await this.loadArchiveIndex();
			this.metadata = await this.store.load(); this.initialized = true;
			if (!this.metadata) { this.set('unpaired'); return; }
			this.set('recovery'); await this.authenticate(); await this.refresh();
			// A process restart cannot leave an old capture window implicitly open. No recording/upload is resumed.
			if (this.evidenceConsents && this.metadata.serverStatus.state !== 'submitted') {
				for (const id of this.metadata.localRecordingSessionIds) { await this.closeStoppedConsent(id); }
			}
		});
	}
	pair(code: string): Promise<void> {
		return this.run(async () => {
			if (this.archiving || this.recording.isRecording || this.recording.isStarting) { throw new AssessmentApiError('recording_busy'); }
			if (!this.initialized) { throw new AssessmentApiError('storage'); }
			if (this.metadata) { throw new AssessmentApiError('recovery_required'); }
			if (!/^[A-Za-z0-9-]{4,128}$/.test(code)) { throw new AssessmentApiError('rejected'); }
			const result = await this.call(signal => this.api.pair(code, signal));
			if (this.archiveIndex.archives.some(item => item.assessmentKey === assessmentArchiveKey(result.connection)) || !validConnection(result.connection) || result.connection.mode !== this.api.mode || !validServerStatus(result.status, result.connection)
				|| result.status.localRecordingSessionIds.length || !/^[\x21-\x7e]{1,8192}$/.test(result.credential)) { throw new AssessmentApiError('protocol'); }
			const credentialId = randomUUID();
			this.lastStart = undefined;
			this.metadata = { version: 1, connection: result.connection, credentialId, phase: 'paired',
				localRecordingSessionIds: [], serverStatus: result.status, submitRequestId: randomUUID() };
			await this.store.putCredential(credentialId, result.credential); await this.save('paired');
			this.auth = { connection: result.connection, credential: result.credential }; this.initialized = true; this.set('paired');
		});
	}
	start(): Promise<void> {
		const generation = this.generation;
		return this.run(async () => {
			if (this.archiving || this.phase === 'submitted') { return; }
			this.startStep('requested');
			if (this.recording.isRecording && this.isAssociatedSession(this.recording.sessionId!)) { this.startStep('assessment_active', 'active'); this.set('active'); return; }
			if (this.recording.isRecording || this.recording.isStarting) { throw new AssessmentApiError('recording_busy'); }
			if (!this.metadata) { throw new AssessmentApiError('rejected'); }
			if (['submission_pending', 'stopping', 'submitted'].includes(this.metadata.phase)) { throw new AssessmentApiError('recovery_required'); }
			this.startStep('credential_check'); await this.authenticate();
			this.startStep('server_status'); await this.refresh();
			if (this.disposed || generation !== this.generation) { throw new AssessmentApiError('cancelled'); }
			if (this.recording.isRecording || this.recording.isStarting) { throw new AssessmentApiError('recording_busy'); }
			if (!['paired', 'active'].includes(this.metadata.serverStatus.state)) { throw new AssessmentApiError('session_ended'); }
			this.set('starting'); this.starting = true;
			try {
				// Existing dialog/workspace selection is unchanged. Rails gate runs in prepare after consent.
				this.startStep('recording_consent'); await this.recording.start();
				if (!this.recording.isRecording || !this.isAssociatedSession(this.recording.sessionId!)) { throw new AssessmentApiError('consent_required'); }
				this.startStep('recording_activation'); await this.save('active');
				this.startStep('assessment_active', 'active'); this.set('active'); await this.enableDelivery();
			} finally { this.starting = false; }
		});
	}
	stopAndSubmit(): Promise<void> {
		if (this.archiving) { return this.archiveWork ?? Promise.resolve(); }
		++this.generation; this.request?.abort();
		if (this.starting) { this.recording.stop(); }
		// Stop must run after a cancelled/unfinished start, rather than sharing its promise.
		const previous = this.busy;
		return (previous ?? Promise.resolve()).then(() => this.run(async () => {
			if (!this.metadata) { throw new AssessmentApiError('rejected'); }
			if (this.archiving || this.phase === 'submitted') { return; }
			if (this.recording.isRecording && !this.isAssociatedSession(this.recording.sessionId!)) { throw new AssessmentApiError('recording_busy'); }
			if (!this.metadata.localRecordingSessionIds.length && this.metadata.serverStatus.state === 'paired') {
				this.consent = false; await this.save('paired'); this.set('paired'); return;
			}
			this.submitting = true; const generation = this.generation;
			try {
				const local = this.recording.sessionId;
				this.set('stopping'); if (local) { this.recording.stop(); }
				await this.save('submission_pending'); // Durable intent prevents recording restart even if closure fails.
				await this.delivery?.disable();
				for (const id of this.metadata.localRecordingSessionIds) { await this.evidence.flushStopped(id); }
				await this.authenticate(); await this.refresh();
				if (this.metadata.serverStatus.state === 'submitted') { return; } // Verified recovery receipt, no consent mutations/uploads.
				if (this.metadata.serverStatus.state !== 'active') { throw new AssessmentApiError('session_ended'); }
				for (const id of this.metadata.localRecordingSessionIds) {
					if (this.evidenceConsents) { await this.closeStoppedConsent(id); }
				}
				let frozen: AssessmentFinalizationRequest | undefined;
				if (this.metadata.connection.mode === 'rails') { frozen = await this.freeze(); }
				if (!this.consent) {
					const generation = this.generation;
					const accepted = await this.confirmUpload(new URL(this.metadata.connection.uploadEndpoint).hostname);
					if (!accepted || this.disposed || generation !== this.generation) { throw new AssessmentApiError('consent_required'); }
					this.consent = true;
				}
				await this.enableDelivery();
				if (this.delivery?.drain) { await this.call(signal => this.delivery!.drain!(this.metadata!.localRecordingSessionIds, signal)); }
				const evidence = await this.evidence.getStatus(this.metadata.localRecordingSessionIds); this.pendingEvents = evidence.pendingEvents;
				if (evidence.pendingEvents || evidence.missingSessions || !this.metadata.localRecordingSessionIds.length) {
					this.set('submission_pending', 'evidence_pending'); return;
				}
				// Stop the only delivery driver before reconciliation; no batches may race successful finalization.
				await this.delivery?.disable();
				if (frozen && (await this.freeze()).recordings.reduce((sum, row) => sum + row.event_count, 0) !== evidence.totalEvents) {
					throw new AssessmentApiError('recovery_required');
				}
				if (!this.consent || generation !== this.generation || this.disposed) { throw new AssessmentApiError('consent_required'); }
				const status = await this.call(signal => this.api.submit(this.auth!, { requestId: this.metadata!.submitRequestId,
					localRecordingSessionIds: [...this.metadata!.localRecordingSessionIds], retainedEventCount: evidence.totalEvents,
					...(frozen ? { finalization: frozen } : {}) }, signal));
				this.accept(status);
				if (status.state !== 'submitted' || frozen && !receiptMatches(status.submission, frozen)) { throw new AssessmentApiError('protocol'); }
				this.consent = false; await this.save('submitted'); this.set('submitted');
			} finally { this.submitting = false; }

		}));
	}
	enableUploads(): Promise<void> {
		return this.run(async () => {
			if (this.archiving || this.phase === 'submitted') { return; }
			if (!this.metadata || !this.delivery || this.metadata.connection.mode !== 'rails') { throw new AssessmentApiError('unavailable'); }
			await this.authenticate(); await this.refresh();
			if (this.metadata.serverStatus.state !== 'active' || !this.metadata.localRecordingSessionIds.length) { throw new AssessmentApiError('consent_required'); }
			const generation = this.generation;
			const accepted = await this.confirmUpload(new URL(this.metadata.connection.uploadEndpoint).hostname);
			if (!accepted || generation !== this.generation || this.disposed) { this.consent = false; await this.delivery?.disable(); this.set(this.phase, 'consent_required'); return; }
			await this.evidence.disableDevelopmentUploads(); this.consent = true; await this.enableDelivery(); this.set(this.phase);
		});
	}
	revokeCredential(): Promise<void> {
		if (this.archiving) { return this.archiveWork ?? Promise.resolve(); }
		this.consent = false; ++this.generation; this.request?.abort(); void this.delivery?.disable().catch(() => {});
		if (this.starting) { this.recording.stop(); }
		const previous = this.busy;
		return (previous ?? Promise.resolve()).then(() => this.run(async () => {
			if (!this.metadata || !this.api.revokeCredential) { throw new AssessmentApiError('unavailable'); }
			await this.revokeUploadConsent();
			const id = this.recording.sessionId;
			if (id && this.isAssociatedSession(id)) { this.recording.stop(); await this.evidence.flushStopped(id); }
			await this.authenticate(); await this.call(signal => this.api.revokeCredential!(this.auth!, signal));
			await this.store.deleteCredential?.(this.metadata.credentialId);
			this.auth = undefined; await this.save('recovery'); this.set('recovery', 'authentication');
		}));
	}
	/** Explicit local archival only. Authentication failure never invokes this automatically. */
	archive(confirm: (summary: { submissionConfirmed: boolean }) => Promise<boolean>): Promise<void> {
		if (this.archiveWork) { return this.archiveWork; }
		const operation = (async () => {
			if (this.disposed) { return; }
			if (!this.metadata) { this.set(this.initialized ? 'unpaired' : 'error', this.initialized ? undefined : 'storage'); return; }
			const connectionId = this.metadata.credentialId;
			const confirmed = this.metadata.phase === 'submitted' && this.metadata.connection.mode === 'rails' && !!this.metadata.serverStatus.submission;
			if (!await confirm({ submissionConfirmed: confirmed })) { return; }
			if (this.disposed || this.metadata?.credentialId !== connectionId) { return; }
			if (this.recording.isRecording && !this.isAssociatedSession(this.recording.sessionId!) || this.recording.isStarting && !this.starting) {
				this.set(this.phase, 'recording_busy'); return;
			}
			this.archiving = true; this.consent = false; ++this.generation; this.request?.abort();
			if (this.starting) { this.recording.stop(); }
			await this.delivery?.disable();
			await this.busy; // A cancelled start/finalize cannot publish metadata after the archive.
			await this.run(async () => {
				try {
					if (!this.metadata || !this.store.archive || !this.store.getArchiveIndex) { throw new AssessmentApiError('storage'); }
					const previousPhase = this.metadata.phase; const lastFailure = this.reason;
					this.set('recovery');
					await this.evidence.disableDevelopmentUploads(); await this.delivery?.disable();
					const local = this.recording.sessionId;
					if (local && this.isAssociatedSession(local)) { this.recording.stop(); }
					// Drain any previously initiated close; no new network consent mutation is
					// required to archive a deleted/unavailable Rails session. Its state is preserved.
					await this.consentWork; await Promise.allSettled([...this.closingSessions.values()]); await this.delivery?.disable();
					for (const id of this.metadata.localRecordingSessionIds) { await this.evidence.flushStopped(id); }
					const snapshot: AssessmentArchive = { version: 1, archiveId: this.metadata.credentialId, archivedAt: new Date().toISOString(),
						metadata: structuredClone(this.metadata), previousPhase, ...(lastFailure ? { lastFailure } : {}),
						submissionConfirmed: this.metadata.phase === 'submitted' && this.metadata.connection.mode === 'rails' && !!this.metadata.serverStatus.submission,
						remoteDisposition: 'unverified' };
					await this.store.archive(snapshot); // Atomic encrypted snapshot + quarantine, BEFORE clearing memory.
					await this.loadArchiveIndex();
					if (!this.archiveIndex.archives.some(item => item.archiveId === connectionId)) { throw new AssessmentApiError('storage'); }
					this.metadata = undefined; this.auth = undefined; this.pendingEvents = undefined; this.lastStart = undefined; this.closingSessions.clear();
					this.initialized = true; this.set('unpaired');
				} catch {
					// Even an unknown commit outcome keeps this host blocked until retry/reload
					// verifies the authoritative encrypted marker. Never resurrect or overwrite it.
					this.set('recovery', 'storage');
				}
			});
		})().catch(() => { this.set(this.metadata ? 'recovery' : 'error', 'storage'); })
			.finally(() => { this.archiving = false; this.set(this.phase, this.reason); if (this.archiveWork === operation) { this.archiveWork = undefined; } });
		this.archiveWork = operation; return operation;
	}
	private async loadArchiveIndex(): Promise<void> {
		const index = await this.store.getArchiveIndex?.() ?? { archives: [] };
		this.archiveIndex = index; this.archivedRecordings.clear();
		for (const entry of index.archives) { for (const id of entry.recordingSessionIds) { this.archivedRecordings.add(id); } }
	}

	/** Production recording/workspace diagnostics apply only to an ongoing assessment start. */
	reportStartPrerequisite(step: AssessmentStartStep): void { if (this.starting) { this.startStep(step); } }
	private startStep(step: AssessmentStartStep, status: AssessmentStartDiagnostic['status'] = 'running', reason?: AssessmentFailure): void {
		this.lastStart = { step, status, ...(reason ? { reason } : {}) };
		try { this.onStartDiagnostic({ ...this.lastStart }); } catch { /* Fixed diagnostic observers cannot change authorization. */ }
	}
	private async enableDelivery(): Promise<void> {
		if (this.archiving || this.disposed || !this.delivery || !this.metadata || !this.consent || this.metadata.serverStatus.state !== 'active' || this.metadata.connection.mode !== 'rails') { return; }
		try { await this.delivery.enable(this.metadata, () => this.consent && !this.disposed); }
		catch { this.set(this.phase, 'evidence_pending'); } // Network delivery cannot stop or block local collectors.
	}
	showStatus(): Promise<void> {
		if (this.starting && this.lastStart?.status === 'running') { this.set(this.phase, this.reason); return Promise.resolve(); }
		if (this.archiving) { return this.archiveWork ?? Promise.resolve(); } return this.run(async () => { if (this.metadata) { await this.authenticate(); await this.refresh();
			if (this.metadata.connection.mode === 'rails') { this.pendingEvents = (await this.evidence.getStatus(this.metadata.localRecordingSessionIds)).pendingEvents; } } else { this.set('unpaired'); } }); }
	/** Optional disclosure actions must never invoke run(), stop capture or replace assessment recovery state. */
	async withDisclosureContext<T>(grant: boolean, operation: (context: DisclosureContext) => Promise<T>): Promise<T> {
		const available = () => this.initialized && !this.disposed && !this.archiving && !this.starting && !this.submitting && !this.busy
			&& this.metadata?.connection.mode === 'rails';
		if (!available()) { throw new AssessmentApiError('recovery_required'); }
		await this.authenticate();
		const metadata = this.metadata!; const generation = this.generation;
		const currentRecording = this.recording.isRecording && this.isAssociatedSession(this.recording.sessionId!) ? this.recording.sessionId : undefined;
		const current = () => !!available() && this.metadata === metadata && this.generation === generation
			&& (!grant || this.phase === 'active' && this.consent && currentRecording !== undefined && this.recording.isRecording && this.recording.sessionId === currentRecording);
		if (!current()) { throw new AssessmentApiError('consent_required'); }
		return operation({ auth: this.auth!, localSessionIds: [...metadata.localRecordingSessionIds], currentRecording, current });
	}

	private closeStoppedConsent(id: string): Promise<void> {
		const previous = this.closingSessions.get(id); if (previous) { return previous; }
		const auth = this.auth;
		const work = (async () => {
			await this.delivery?.disable();
			await this.evidence.flushStopped(id);
			if (auth && this.evidenceConsents) { await this.evidenceConsents.close(auth, id, AbortSignal.timeout(this.requestTimeoutMs)); }
			if (!this.submitting && !this.archiving) { await this.enableDelivery(); }
		})();
		this.closingSessions.set(id, work);
		this.consentWork = work.catch(() => { this.closingSessions.delete(id); this.set('submission_pending', 'recovery_required'); });
		return work;
	}

	private async authenticate(): Promise<void> {
		if (!this.metadata || this.api.mode !== this.metadata.connection.mode) { throw new AssessmentApiError('unavailable'); }
		await this.loadArchiveIndex();
		if (this.archiveIndex.archives.some(item => item.archiveId === this.metadata!.credentialId || item.assessmentKey === assessmentArchiveKey(this.metadata!.connection))) { throw new AssessmentApiError('recovery_required'); }
		const credential = await this.store.getCredential(this.metadata.credentialId);
		if (!credential || !/^[\x21-\x7e]{1,8192}$/.test(credential)) { throw new AssessmentApiError('authentication'); }
		this.auth = { connection: this.metadata.connection, credential };
	}
	private async refresh(): Promise<void> {
		const status = await this.call(signal => this.api.getStatus(this.auth!, signal));
		// Verify recovery receipts before replacing the last accepted snapshot. A malformed
		// status must not poison immutable receipt comparisons on the next retry.
		if (this.metadata!.connection.mode === 'rails' && status.state === 'submitted'
			&& !receiptMatches(status.submission, await this.freeze(true))) { throw new AssessmentApiError('protocol'); }
		this.accept(status);
		// Reconcile an interrupted start only after the server explicitly reports its durable bindings.
		const unbound = this.metadata!.localRecordingSessionIds.filter(id => !status.localRecordingSessionIds.includes(id));
		if (unbound.length) {
			const evidence = await this.evidence.getStatus(unbound);
			if (evidence.totalEvents) { throw new AssessmentApiError('recovery_required'); }
			this.metadata!.localRecordingSessionIds = this.metadata!.localRecordingSessionIds.filter(id => !unbound.includes(id));
		}
		if (['expired', 'revoked', 'submitted'].includes(status.state) && this.recording.isRecording && this.isAssociatedSession(this.recording.sessionId!)) {
			const id = this.recording.sessionId!; this.recording.stop(); await this.evidence.flushStopped(id);
		}
		if (status.state === 'submitted') {
			await this.delivery?.disable(); this.consent = false;
			const evidence = await this.evidence.getStatus(this.metadata!.localRecordingSessionIds);
			if (evidence.pendingEvents || evidence.missingSessions || !this.metadata!.localRecordingSessionIds.length) {
				this.pendingEvents = evidence.pendingEvents; await this.save('submission_pending'); this.set('submission_pending', 'evidence_pending'); return;
			}
		}
		if (status.state === 'active' && Date.parse(status.deadline!) <= Date.parse(status.serverTime)) { throw new AssessmentApiError('session_ended'); }
		const phase = status.state === 'submitted' ? 'submitted' : ['stopping', 'submission_pending'].includes(this.metadata!.phase)
			? 'submission_pending' : status.state === 'paired' ? 'paired' : this.recording.isRecording && this.isAssociatedSession(this.recording.sessionId!) ? 'active' : 'recovery';
		await this.save(phase); this.set(phase, ['expired', 'revoked'].includes(status.state) ? 'session_ended' : undefined);
	}
	private accept(status: AssessmentServerStatus): void {
		const metadata = this.metadata!;
		if (!validServerStatus(status, metadata.connection) || status.localRecordingSessionIds.some(id => !metadata.localRecordingSessionIds.includes(id))
			|| metadata.serverStatus.localRecordingSessionIds.some(id => !status.localRecordingSessionIds.includes(id))
			|| metadata.serverStatus.deadline && (status.deadline !== metadata.serverStatus.deadline || status.startedAt !== metadata.serverStatus.startedAt)
			|| Date.parse(status.serverTime) < Date.parse(metadata.serverStatus.serverTime)
			|| metadata.connection.mode === 'rails' && status.state === 'submitted' && status.submission?.request_id !== metadata.submitRequestId
			|| metadata.serverStatus.submission && (!status.submission || Object.entries(metadata.serverStatus.submission).some(([key, value]) => status.submission![key as keyof typeof status.submission] !== value))) { throw new AssessmentApiError('protocol'); }
		metadata.serverStatus = structuredClone(status);
	}
	private async freeze(existingOnly = false): Promise<AssessmentFinalizationRequest> {
		if (!this.metadata || !this.evidence.freezeFinalization) { throw new AssessmentApiError('recovery_required'); }
		try { return await this.evidence.freezeFinalization({ codingSessionId: this.metadata.connection.codingSessionId,
			origin: this.metadata.connection.apiOrigin, requestId: this.metadata.submitRequestId,
			localRecordingSessionIds: [...this.metadata.localRecordingSessionIds] }, existingOnly); }
		catch { throw new AssessmentApiError('recovery_required'); }
	}
	private async save(phase: AssessmentState): Promise<void> {
		this.metadata!.phase = phase;
		try { await this.store.save(this.metadata!); } catch { throw new AssessmentApiError('storage'); }
	}
	private async call<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.disposed) { throw new AssessmentApiError('cancelled'); }
		const controller = new AbortController(); this.request = controller;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([operation(controller.signal), new Promise<never>((_, reject) => {
				controller.signal.addEventListener('abort', () => reject(new AssessmentApiError('cancelled')), { once: true });
				timer = setTimeout(() => { reject(new AssessmentApiError('unavailable')); controller.abort(); }, this.requestTimeoutMs);
			})]);
		} finally { clearTimeout(timer); if (this.request === controller) { this.request = undefined; } }
	}
	private run(action: () => Promise<void>): Promise<void> {
		if (this.busy) { return this.busy; }
		if (this.disposed) { return Promise.resolve(); }
		const operation = Promise.resolve().then(action).catch(async error => {
			const reason: AssessmentFailure = error instanceof AssessmentApiError ? error.code : 'unavailable';
			if (this.lastStart?.status === 'running') { this.startStep(this.lastStart.step, 'failed', reason); }
			if (this.recording.isRecording && this.isAssociatedSession(this.recording.sessionId!)) {
				const id = this.recording.sessionId!; this.recording.stop(); try { await this.evidence.flushStopped(id); } catch { /* Recovery remains required. */ }
			}
			this.consent = false; await this.delivery?.disable();
			const phase = this.metadata?.phase === 'submission_pending' ? 'submission_pending' : this.metadata ? 'recovery' : 'error';
			this.set(phase, reason);
			if (this.metadata) { try { await this.save(phase); } catch { this.set('error', 'storage'); } }
		}).finally(() => { if (this.busy === operation) { this.busy = undefined; } });
		this.busy = operation; return operation;
	}
	private set(phase: AssessmentState, reason?: AssessmentFailure): void {
		this.phase = phase; this.reason = reason; try { this.onChange(this.view); } catch { /* Fixed safe view only. */ }
	}
	async dispose(): Promise<void> {
		this.disposed = true; ++this.generation; this.request?.abort(); if (this.starting) { this.recording.stop(); }
		if (!this.archiving && this.evidenceConsents && this.recording.isRecording && this.isAssociatedSession(this.recording.sessionId!)) {
			const id = this.recording.sessionId!; this.recording.stop();
			try { await this.closeStoppedConsent(id); } catch { /* Durable close intent remains pending; never claim remote success. */ }
		}
		await this.archiveWork; await this.busy; await this.consentWork; this.consent = false; await this.delivery?.disable(); this.lifecycle.dispose(); this.auth = undefined;
	}
}
