import type { AssessmentMetadata, AssessmentStore } from './assessmentStorage';
import { validConnection } from './assessmentStorage';
import { AssessmentApiError, type AssessmentAuthentication } from './assessmentApiClient';
import type { AsyncLocalEventQueue } from './asyncLocalEventQueue';
import { EventBatchManager, type PreparedEventBatch } from './eventBatchManager';
import { EventUploader, type UploadOutcome } from './eventUploader';
import { RailsAssessmentApiClient, inspectRailsUploadPermit, type RailsUploadPermit } from './railsAssessmentApiClient';
import type { AssessmentApprovalBinding } from './assessmentEventApproval';
import type { UploadTransport } from './httpsEventTransport';

export interface AssessmentDeliveryLifecycle {
	enable(metadata: AssessmentMetadata, consent: () => boolean): Promise<void>;
	disable(): Promise<void>;
	readonly status?: string;
}
/** One delivery worker for one explicitly approved paired assessment. No global upload token/copy. */
export class AssessmentEventDelivery implements AssessmentDeliveryLifecycle {
	private driver?: EventUploader;
	private generation = 0;
	private draining: Promise<void> = Promise.resolve();
	private outcome: UploadOutcome = 'disabled';
	constructor(private readonly queue: AsyncLocalEventQueue, private readonly store: AssessmentStore, private readonly api: RailsAssessmentApiClient,
		private readonly onStatus: (status: UploadOutcome) => void = () => {}, private readonly transport?: () => UploadTransport,
		private readonly options: { maxEvents?: number; maxBytes?: number; timeoutMs?: number; baseDelayMs?: number; maxDelayMs?: number } = {}) {}
	get status(): UploadOutcome { return this.outcome; }
	async enable(metadata: AssessmentMetadata, consent: () => boolean): Promise<void> {
		await this.disable(); const generation = ++this.generation;
		const snapshot = structuredClone(metadata);
		const current = () => generation === this.generation && consent();
		if (!current() || snapshot.connection.mode !== 'rails' || !validConnection(snapshot.connection)
			|| snapshot.connection.apiOrigin !== this.api.origin || !snapshot.localRecordingSessionIds.length) { throw new AssessmentApiError('consent_required'); }
		let permit: RailsUploadPermit | undefined; let binding: AssessmentApprovalBinding | undefined;
		let activeSession: string | undefined; let token: string | undefined;
		const auth = async (): Promise<AssessmentAuthentication> => {
			const credential = await this.store.getCredential(snapshot.credentialId);
			if (!current() || !credential) { throw new AssessmentApiError('authentication'); }
			return { connection: snapshot.connection, credential };
		};
		const batches = new EventBatchManager({
			prepareBatch: async (maxEvents, maxBytes) => {
				for (const id of snapshot.localRecordingSessionIds) {
					if (!current()) { throw new AssessmentApiError('consent_required'); }
					// Reserve sidecar overhead per event so an otherwise valid batch fits the complete wire limit.
					const count = Math.max(1, Math.min(maxEvents, Math.floor((maxBytes - 128) / 1024)));
					const batch = await this.queue.prepareBatch(count, Math.max(2, maxBytes - count * 640), id);
					if (batch) { activeSession = id; return batch; }
				}
				return null;
			},
			markDelivered: (id, ids) => this.queue.markDelivered(id, ids), releaseBatch: id => this.queue.releaseBatch(id), getDeliveryStatus: () => this.queue.getDeliveryStatus()
		});
		const preparePermit = async (batch: PreparedEventBatch, signal: AbortSignal) => {
			const identity = await auth(); token = identity.credential;
			const scope = activeSession && await this.queue.getEvidenceConsent(activeSession);
			if (!scope) { throw new AssessmentApiError('consent_required'); }
			permit = await this.api.authorizeUpload(identity, scope, batch, signal, snapshot.serverStatus);
			binding = inspectRailsUploadPermit(permit, batch, snapshot.connection.uploadEndpoint, token);
			if (!binding || !current()) { throw new AssessmentApiError('consent_required'); } return permit;
		};
		const driver = new EventUploader(batches, this.queue, { get: async () => (await auth()).credential }, {
			...this.options, endpoint: snapshot.connection.uploadEndpoint, confirmUpload: async origin => current() && origin === snapshot.connection.apiOrigin,
			assessmentPermit: preparePermit,
			privacyContext: event => binding ? this.queue.getAssessmentUploadContext(event, binding) : undefined,
			assessmentStillApproved: async () => {
				if (!current() || !binding || !activeSession || (await auth()).credential !== token) { return false; }
				const scope = await this.queue.getEvidenceConsent(activeSession);
				return !!scope && !scope.locallyRevoked && !scope.pendingAction && scope.receipt?.consent_id === binding.consentReceiptId
					&& ['active', 'stopped'].includes(scope.receipt.state) && (!scope.captureClosed || scope.receipt.state === 'stopped');
			},
			onStatus: status => { if (current() && status !== this.outcome) { this.outcome = status; this.onStatus(status); } }
		}, this.transport?.());
		if (!await driver.enable() || !current()) { await driver.dispose(); throw new AssessmentApiError('consent_required'); }
		this.driver = driver; driver.start();
	}
	/** Used by deterministic integration checks/manual retry without creating a second driver. */
	uploadOnce(): Promise<UploadOutcome> { return this.driver?.uploadOnce() ?? Promise.resolve('disabled'); }
	async disable(): Promise<void> {
		++this.generation; const driver = this.driver; this.driver = undefined; this.outcome = 'disabled';
		if (driver) { this.draining = Promise.all([this.draining, driver.dispose()]).then(() => {}); }
		await this.draining;
	}
}
