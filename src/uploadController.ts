import type { SecretStorage } from 'vscode';
import { EventUploader, UPLOAD_TOKEN_SECRET, type EventUploaderOptions, type UploadOutcome } from './eventUploader';
import { validatedUploadEndpoint } from './httpsEventTransport';
import type { AsyncLocalEventQueue } from './asyncLocalEventQueue';

export const CONFIGURE_UPLOAD_ENDPOINT_COMMAND = 'ai-developer-tracker.configureUploadEndpoint';
export const CONFIGURE_UPLOAD_AUTHENTICATION_COMMAND = 'ai-developer-tracker.configureUploadAuthentication';
export const ENABLE_UPLOADS_COMMAND = 'ai-developer-tracker.enableUploads';
export const DISABLE_UPLOADS_COMMAND = 'ai-developer-tracker.disableUploads';
export const SHOW_UPLOAD_STATUS_COMMAND = 'ai-developer-tracker.showUploadStatus';
export interface UploadSettings { endpoint: string; enabled: boolean; maxEvents: number; maxBytes: number; timeoutMs: number }
export type UploadNotice = UploadOutcome | 'token_configured' | 'token_removed' | 'endpoint_configured' | 'consent_cancelled' | 'consent_required';
export interface UploadUi {
	readSettings(): UploadSettings;
	writeEndpoint(value: string): Promise<void>;
	writeEnabled(value: boolean): Promise<void>;
	requestEndpoint(current: string): Promise<string | undefined>;
	requestAuthenticationAction(): Promise<'configure' | 'remove' | undefined>;
	requestToken(): Promise<string | undefined>;
	confirmUpload(hostname: string): Promise<boolean>;
	notice(reason: UploadNotice): void;
}
export interface UploadStatus {
	enabled: boolean;
	consentGranted: boolean;
	hostname?: string;
	authenticationConfigured: boolean;
	outcome: UploadOutcome;
	pendingEvents?: number;
	nextAttemptAt?: number;
	pauseReason?: string | null;
}
export type UploadDriver = Pick<EventUploader, 'enable' | 'start' | 'dispose'>;

/** Endpoint-scoped volatile consent. Settings reflect state and cannot grant permission. */
export class UploadController {
	private driver?: UploadDriver;
	private approvedEndpoint?: string;
	private approvedSettings?: string;
	private generation = 0;
	private enabling?: Promise<boolean>;
	private disposed = false;
	private outcome: UploadOutcome = 'disabled';
	private draining: Promise<void> = Promise.resolve();
	constructor(private readonly queue: Pick<AsyncLocalEventQueue, 'getPendingCount' | 'getUploadRetryState'>,
		private readonly secrets: Pick<SecretStorage, 'get' | 'store' | 'delete'>, private readonly ui: UploadUi,
		private readonly createUploader: (settings: UploadSettings, hooks: Pick<EventUploaderOptions, 'confirmUpload' | 'onStatus'>) => UploadDriver) {}

	async initialize(): Promise<void> {
		// Upgrade/reload/settings sync never restores upload consent.
		await this.setEnabled(false);
	}
	get enabled(): boolean { return !!this.driver && !!this.approvedEndpoint && !this.disposed; }
	enable(): Promise<boolean> {
		if (this.enabling) { return this.enabling; }
		if (this.disposed) { return Promise.resolve(false); }
		if (this.enabled) { return Promise.resolve(true); }
		const generation = ++this.generation;
		const operation = this.enableApproved(generation);
		this.enabling = operation;
		void operation.finally(() => { if (this.enabling === operation) { this.enabling = undefined; } });
		return operation;
	}
	private async enableApproved(generation: number): Promise<boolean> {
		let driver: UploadDriver | undefined;
		try {
			await this.draining;
			const settings = this.ui.readSettings(); const endpoint = validatedUploadEndpoint(settings.endpoint);
			const signature = this.signature(settings);
			const token = await this.secrets.get(UPLOAD_TOKEN_SECRET);
			if (!token || !/^[\x21-\x7e]{1,8192}$/.test(token)) { this.notice('authentication'); return false; }
			if (!this.current(generation, signature)) { return false; }
			driver = this.createUploader(settings, {
				confirmUpload: async () => {
					const accepted = await this.ui.confirmUpload(endpoint.hostname);
					if (!accepted) { this.notice('consent_cancelled'); }
					return accepted && this.current(generation, signature);
				},
				onStatus: status => {
					if (this.driver !== driver) { return; }
					if (status !== this.outcome) { this.outcome = status; this.notice(status); }
				}
			});
			if (!await driver.enable() || !this.current(generation, signature)) { await driver.dispose(); return false; }
			this.driver = driver; this.approvedEndpoint = endpoint.href; this.approvedSettings = signature;
			if (!await this.setEnabled(true) || !this.current(generation, signature)) { await this.disable(); return false; }
			// Recheck token after consent: removal/change during the dialog cannot authorize a request.
			const currentToken = await this.secrets.get(UPLOAD_TOKEN_SECRET);
			if (currentToken !== token || !this.current(generation, signature)) { await this.disable(); this.notice('authentication'); return false; }
			this.outcome = 'waiting'; driver.start(); return true;
		} catch {
			if (driver && this.driver !== driver) { try { await driver.dispose(); } catch { /* Safe notice below. */ } }
			await this.disable(); this.notice('configuration'); return false;
		}
	}
	async disable(): Promise<void> {
		++this.generation; const driver = this.driver;
		this.driver = undefined; this.approvedEndpoint = undefined; this.approvedSettings = undefined; this.outcome = 'disabled';
		// dispose aborts immediately, then drains; serialize replacement drivers behind that drain.
		if (driver) {
			const disposing = driver.dispose().catch(() => { this.notice('storage'); });
			this.draining = Promise.all([this.draining, disposing]).then(() => {});
		}
		await this.setEnabled(false); await this.draining;
	}
	/** Call immediately when upload settings change; never open a consent dialog from settings. */
	async settingsChanged(): Promise<void> {
		try {
			const settings = this.ui.readSettings();
			if (this.enabled && settings.enabled && this.signature(settings) === this.approvedSettings) { return; }
			if (this.enabling && !this.enabled) { ++this.generation; }
			if (settings.enabled && !this.enabled) { this.notice('consent_required'); }
			await this.disable();
		} catch { await this.disable(); this.notice('configuration'); }
	}
	async configureEndpoint(): Promise<void> {
		if (this.disposed) { return; }
		try {
			let current = ''; try { current = validatedUploadEndpoint(this.ui.readSettings().endpoint).href; } catch { /* Never display invalid credential-bearing URLs. */ }
			const value = await this.ui.requestEndpoint(current); if (value === undefined || this.disposed) { return; }
			const endpoint = value === '' ? '' : validatedUploadEndpoint(value).href;
			await this.disable(); if (this.disposed) { return; }
			await this.ui.writeEndpoint(endpoint); this.notice('endpoint_configured');
		} catch { this.notice('configuration'); }
	}
	async configureAuthentication(): Promise<void> {
		if (this.disposed) { return; }
		try {
			const action = await this.ui.requestAuthenticationAction(); if (!action || this.disposed) { return; }
			if (action === 'remove') {
				await this.disable(); await this.secrets.delete(UPLOAD_TOKEN_SECRET); this.notice('token_removed'); return;
			}
			const token = await this.ui.requestToken(); if (token === undefined || this.disposed) { return; }
			if (!/^[\x21-\x7e]{1,8192}$/.test(token)) { this.notice('authentication'); return; }
			await this.disable(); await this.secrets.store(UPLOAD_TOKEN_SECRET, token);
			if (await this.secrets.get(UPLOAD_TOKEN_SECRET) !== token) { this.notice('authentication'); return; }
			this.notice('token_configured');
		} catch { this.notice('authentication'); }
	}
	async showStatus(): Promise<UploadStatus> {
		const status: UploadStatus = { enabled: this.enabled, consentGranted: this.enabled, authenticationConfigured: false, outcome: this.outcome };
		try { status.hostname = validatedUploadEndpoint(this.ui.readSettings().endpoint).hostname; } catch { /* No unsafe URL returned. */ }
		try { const token = await this.secrets.get(UPLOAD_TOKEN_SECRET); status.authenticationConfigured = !!token && /^[\x21-\x7e]{1,8192}$/.test(token); } catch { /* Never expose SecretStorage errors. */ }
		try {
			status.pendingEvents = await this.queue.getPendingCount();
			const retry = await this.queue.getUploadRetryState(); status.nextAttemptAt = retry?.nextAttemptAt; status.pauseReason = retry?.pauseReason;
		} catch { status.outcome = 'storage'; }
		return status;
	}
	async dispose(): Promise<void> { this.disposed = true; await this.disable(); }
	private current(generation: number, signature: string): boolean {
		return !this.disposed && generation === this.generation && this.signature(this.ui.readSettings()) === signature;
	}
	private signature(settings: UploadSettings): string {
		return JSON.stringify([validatedUploadEndpoint(settings.endpoint).href, settings.maxEvents, settings.maxBytes, settings.timeoutMs]);
	}
	private async setEnabled(value: boolean): Promise<boolean> {
		try { if (this.ui.readSettings().enabled !== value) { await this.ui.writeEnabled(value); } return true; }
		catch { this.notice('configuration'); return false; }
	}
	private notice(reason: UploadNotice): void { try { this.ui.notice(reason); } catch { /* Fixed codes only. */ } }
}
