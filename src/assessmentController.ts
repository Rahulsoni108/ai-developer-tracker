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
}
export interface AssessmentView {
	state: AssessmentState; mode?: 'mock'; reason?: AssessmentFailure; serverTime?: string; deadline?: string;
	/** Display only; measured at the last server response, never from the host's wall clock. */
	remainingMsAtLastCheck?: number; pendingEvents?: number;
	uploadConsent: boolean;
}

/** Assessment workflow only. RecordingController remains the sole recording-state owner. */
export class AssessmentController {
	private metadata?: AssessmentMetadata;
	private phase: AssessmentState = 'unpaired';
	private reason?: AssessmentFailure;
	private pendingEvents?: number;
	private consent = false;
	private initialized = false;
	private disposed = false;
	private busy?: Promise<void>;
	private request?: AbortController;
	private starting = false;
	private generation = 0;
	private readonly lifecycle: { dispose(): void };
	private consentWork: Promise<void> = Promise.resolve();
	private readonly closingSessions = new Map<string, Promise<void>>();
	constructor(private readonly api: AssessmentApiClient, private readonly store: AssessmentStore,
		private readonly recording: RecordingController, private readonly evidence: AssessmentEvidence,
		private readonly confirmUpload: (hostname: string) => Promise<boolean>,
		private readonly onChange: (view: AssessmentView) => void = () => {}, private readonly requestTimeoutMs = 10000,
		private readonly evidenceConsents?: AssessmentConsentLifecycle) {
		this.lifecycle = recording.addLifecycleListener({
			prepare: async (id, current) => {
				if (!this.starting) { return; }
				const generation = this.generation; const metadata = this.metadata!;
				this.consent = await this.confirmUpload(new URL(metadata.connection.uploadEndpoint).hostname);
				if (!this.consent) { throw new AssessmentApiError('consent_required'); }
				await this.evidence.disableDevelopmentUploads();
				if (!current() || this.disposed || generation !== this.generation) { throw new AssessmentApiError('cancelled'); }
				if (metadata.localRecordingSessionIds.length >= 32) { throw new AssessmentApiError('recovery_required'); }
				metadata.localRecordingSessionIds.push(id); await this.save('starting');
				const status = await this.call(signal => this.api.startOrResume(this.auth!, { requestId: id, localRecordingSessionId: id }, signal));
				this.accept(status);
				if (status.state !== 'active' || !status.localRecordingSessionIds.includes(id)
					|| Date.parse(status.deadline!) <= Date.parse(status.serverTime)) { throw new AssessmentApiError('session_ended'); }
				// Persist binding/deadline BEFORE RecordingController activates any collector.
				await this.save('starting');
				if (this.evidenceConsents) { await this.call(signal => this.evidenceConsents!.approve(this.auth!, id, status, signal)); }
				if (!current() || this.disposed || generation !== this.generation) { throw new AssessmentApiError('cancelled'); }
			},
			started: () => {}, cancelled: id => {
				if (this.evidenceConsents && this.auth && this.isAssociatedSession(id)) { this.closeStoppedConsent(id); }
			},
			stopped: id => { if (this.isAssociatedSession(id) && !this.disposed) { this.set('submission_pending');
				if (this.evidenceConsents && this.auth) { this.closeStoppedConsent(id); }
			} }
		});
	}
	private auth?: AssessmentAuthentication;
	get view(): AssessmentView {
		const status = this.metadata?.serverStatus;
		return { state: this.phase, ...(this.metadata ? { mode: this.metadata.connection.mode } : {}), ...(this.reason ? { reason: this.reason } : {}),
			...(status ? { serverTime: status.serverTime, ...(status.deadline ? { deadline: status.deadline,
				remainingMsAtLastCheck: Math.max(0, Date.parse(status.deadline) - Date.parse(status.serverTime)) } : {}) } : {}),
			...(this.pendingEvents !== undefined ? { pendingEvents: this.pendingEvents } : {}), uploadConsent: this.consent };
	}
	isAssociatedSession(id: string): boolean { return this.metadata?.localRecordingSessionIds.includes(id) ?? false; }
	/** General-purpose development uploader must never send assessment evidence to arbitrary credentials/endpoints. */
	allowsDevelopmentUpload(id: string): boolean { return this.initialized && this.phase !== 'error' && !this.isAssociatedSession(id); }
	revokeUploadConsent(): Promise<void> {
		this.consent = false; ++this.generation; this.request?.abort();
		if (this.starting) { this.recording.stop(); }
		this.set(this.phase, 'consent_required');
		const auth = this.auth;
		if (this.evidenceConsents && auth) {
			const tasks = (this.metadata?.localRecordingSessionIds ?? []).map(id => this.evidenceConsents!.revoke(auth, id, AbortSignal.timeout(this.requestTimeoutMs)));
			this.consentWork = Promise.all(tasks).then(() => {}, () => { this.set(this.phase, 'recovery_required'); });
		}
		return this.consentWork;
	}
	initialize(): Promise<void> {
		return this.run(async () => {
			this.metadata = await this.store.load(); this.initialized = true;
			if (!this.metadata) { this.set('unpaired'); return; }
			this.set('recovery'); await this.authenticate(); await this.refresh();
			// A process restart cannot leave an old capture window implicitly open. No recording/upload is resumed.
			if (this.evidenceConsents) {
				for (const id of this.metadata.localRecordingSessionIds) { await this.closeStoppedConsent(id); }
			}
		});
	}
	pair(code: string): Promise<void> {
		return this.run(async () => {
			if (this.recording.isRecording || this.recording.isStarting) { throw new AssessmentApiError('recording_busy'); }
			if (this.metadata) { throw new AssessmentApiError('recovery_required'); }
			if (!/^[A-Za-z0-9-]{4,128}$/.test(code)) { throw new AssessmentApiError('rejected'); }
			const result = await this.call(signal => this.api.pair(code, signal));
			if (!validConnection(result.connection) || result.connection.mode !== this.api.mode || !validServerStatus(result.status, result.connection)
				|| result.status.localRecordingSessionIds.length || !/^[\x21-\x7e]{1,8192}$/.test(result.credential)) { throw new AssessmentApiError('protocol'); }
			const credentialId = randomUUID();
			this.metadata = { version: 1, connection: result.connection, credentialId, phase: 'paired',
				localRecordingSessionIds: [], serverStatus: result.status, submitRequestId: randomUUID() };
			await this.store.putCredential(credentialId, result.credential); await this.save('paired');
			this.auth = { connection: result.connection, credential: result.credential }; this.initialized = true; this.set('paired');
		});
	}
	start(): Promise<void> {
		const generation = this.generation;
		return this.run(async () => {
			if (this.recording.isRecording && this.isAssociatedSession(this.recording.sessionId!)) { this.set('active'); return; }
			if (this.recording.isRecording || this.recording.isStarting) { throw new AssessmentApiError('recording_busy'); }
			if (!this.metadata) { throw new AssessmentApiError('rejected'); }
			if (['submission_pending', 'stopping', 'submitted'].includes(this.metadata.phase)) { throw new AssessmentApiError('recovery_required'); }
			await this.authenticate(); await this.refresh();
			if (this.disposed || generation !== this.generation) { throw new AssessmentApiError('cancelled'); }
			if (this.recording.isRecording || this.recording.isStarting) { throw new AssessmentApiError('recording_busy'); }
			if (!['paired', 'active'].includes(this.metadata.serverStatus.state)) { throw new AssessmentApiError('session_ended'); }
			this.set('starting'); this.starting = true;
			try {
				// Existing dialog/workspace selection is unchanged. Rails gate runs in prepare after consent.
				await this.recording.start();
				if (!this.recording.isRecording || !this.isAssociatedSession(this.recording.sessionId!)) { throw new AssessmentApiError('consent_required'); }
				await this.save('active'); this.set('active');
			} finally { this.starting = false; }
		});
	}
	stopAndSubmit(): Promise<void> {
		++this.generation; this.request?.abort();
		if (this.starting) { this.recording.stop(); }
		// Stop must run after a cancelled/unfinished start, rather than sharing its promise.
		const previous = this.busy;
		return (previous ?? Promise.resolve()).then(() => this.run(async () => {
			if (!this.metadata) { throw new AssessmentApiError('rejected'); }
			if (this.phase === 'submitted') { return; }
			if (this.recording.isRecording && !this.isAssociatedSession(this.recording.sessionId!)) { throw new AssessmentApiError('recording_busy'); }
			if (!this.metadata.localRecordingSessionIds.length && this.metadata.serverStatus.state === 'paired') {
				this.consent = false; await this.save('paired'); this.set('paired'); return;
			}
			const local = this.recording.sessionId;
			this.set('stopping'); if (local) { this.recording.stop(); }
			// Durable stop intent precedes drains/network; never restart a stopped assessment as a side effect of retry.
			await this.save('submission_pending');
			for (const id of this.metadata.localRecordingSessionIds) {
				await this.evidence.flushStopped(id);
				if (this.evidenceConsents && this.auth) { await this.closeStoppedConsent(id); }
			}
			await this.authenticate(); await this.refresh();
			const delivery = await this.evidence.getStatus(this.metadata.localRecordingSessionIds); this.pendingEvents = delivery.pendingEvents;
			if (delivery.pendingEvents || delivery.missingSessions || !this.metadata.localRecordingSessionIds.length) {
				this.set('submission_pending', 'evidence_pending'); return;
			}
			if (!['active', 'submitted'].includes(this.metadata.serverStatus.state)) { this.set('submission_pending', 'session_ended'); return; }
			if (!this.consent) {
				const generation = this.generation;
				const accepted = await this.confirmUpload(new URL(this.metadata.connection.uploadEndpoint).hostname);
				if (!accepted || this.disposed || generation !== this.generation) {
					this.consent = false; this.set('submission_pending', 'consent_required'); return;
				}
				this.consent = true;
			}
			const status = await this.call(signal => this.api.submit(this.auth!, { requestId: this.metadata!.submitRequestId,
				localRecordingSessionIds: [...this.metadata!.localRecordingSessionIds], retainedEventCount: delivery.totalEvents }, signal));
			this.accept(status);
			if (status.state !== 'submitted') { throw new AssessmentApiError('protocol'); }
			await this.save('submitted'); this.set('submitted');
		}));
	}
	showStatus(): Promise<void> { return this.run(async () => { if (this.metadata) { await this.authenticate(); await this.refresh(); } else { this.set('unpaired'); } }); }
	private closeStoppedConsent(id: string): Promise<void> {
		const previous = this.closingSessions.get(id); if (previous) { return previous; }
		const auth = this.auth;
		const work = (async () => {
			await this.evidence.flushStopped(id);
			if (auth && this.evidenceConsents) { await this.evidenceConsents.close(auth, id, AbortSignal.timeout(this.requestTimeoutMs)); }
		})();
		this.closingSessions.set(id, work);
		this.consentWork = work.catch(() => { this.closingSessions.delete(id); this.set('submission_pending', 'recovery_required'); });
		return work;
	}

	private async authenticate(): Promise<void> {
		if (!this.metadata || this.api.mode !== this.metadata.connection.mode) { throw new AssessmentApiError('unavailable'); }
		const credential = await this.store.getCredential(this.metadata.credentialId);
		if (!credential || !/^[\x21-\x7e]{1,8192}$/.test(credential)) { throw new AssessmentApiError('authentication'); }
		this.auth = { connection: this.metadata.connection, credential };
	}
	private async refresh(): Promise<void> {
		const status = await this.call(signal => this.api.getStatus(this.auth!, signal)); this.accept(status);
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
			|| Date.parse(status.serverTime) < Date.parse(metadata.serverStatus.serverTime)) { throw new AssessmentApiError('protocol'); }
		metadata.serverStatus = structuredClone(status);
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
			if (this.recording.isRecording && this.isAssociatedSession(this.recording.sessionId!)) {
				const id = this.recording.sessionId!; this.recording.stop(); try { await this.evidence.flushStopped(id); } catch { /* Recovery remains required. */ }
			}
			this.consent = false;
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
		if (this.evidenceConsents && this.recording.isRecording && this.isAssociatedSession(this.recording.sessionId!)) {
			const id = this.recording.sessionId!; this.recording.stop();
			try { await this.closeStoppedConsent(id); } catch { /* Durable close intent remains pending; never claim remote success. */ }
		}
		await this.busy; await this.consentWork; this.consent = false; this.lifecycle.dispose(); this.auth = undefined;
	}
}
