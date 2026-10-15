import * as assert from 'node:assert/strict';
import { UploadController, type UploadSettings, type UploadNotice, type UploadUi, type UploadDriver } from '../uploadController';
import { UPLOAD_TOKEN_SECRET } from '../eventUploader';
import { RecordingController } from '../recording';

suite('VS Code upload consent and lifecycle controller', () => {
	let settings: UploadSettings; let token: string | undefined; let ui: UploadUi; let controller: UploadController;
	let consent: boolean; let consentCount: number; let hostname: string | undefined;
	let starts: number; let disposals: number; let creations: number; let active: number; let maximumActive: number;
	let notices: UploadNotice[]; let tokenInput: string | undefined; let endpointInput: string | undefined;
	let action: 'configure' | 'remove' | undefined;
	setup(() => {
		settings = { endpoint: 'https://assessment.example.test/events', enabled: false, maxEvents: 100, maxBytes: 1048576, timeoutMs: 30000 };
		token = 'dummy-secret-token'; consent = true; consentCount = 0; starts = 0; disposals = 0; creations = 0; active = 0; maximumActive = 0; notices = [];
		tokenInput = undefined; endpointInput = undefined; action = undefined;
		ui = { readSettings: () => ({ ...settings }), writeEnabled: async enabled => { settings.enabled = enabled; },
			writeEndpoint: async endpoint => { settings.endpoint = endpoint; }, requestEndpoint: async () => endpointInput,
			requestAuthenticationAction: async () => action, requestToken: async () => tokenInput,
			confirmUpload: async destination => { hostname = destination; consentCount++; return consent; }, notice: reason => notices.push(reason) };
		controller = new UploadController({ getPendingCount: async () => 7, getUploadRetryState: async () => null },
			{ get: async name => name === UPLOAD_TOKEN_SECRET ? token : undefined, store: async (name, value) => { assert.equal(name, UPLOAD_TOKEN_SECRET); token = value; },
				delete: async name => { assert.equal(name, UPLOAD_TOKEN_SECRET); token = undefined; } }, ui, (_settings, hooks) => {
				creations++; let disposed = false;
				return { enable: async () => hooks.confirmUpload('https://assessment.example.test'), start: () => { starts++; active++; maximumActive = Math.max(maximumActive, active); },
					dispose: async () => { if (!disposed) { disposed = true; disposals++; if (active) { active--; } } } } satisfies UploadDriver;
			});
	});
	teardown(async () => { await controller.dispose(); });

	test('startup and upgrade ignore a previously enabled setting', async () => {
		settings.enabled = true; await controller.initialize(); assert.equal(settings.enabled, false);
		assert.equal(controller.enabled, false); assert.equal(starts, 0); assert.equal(consentCount, 0);
	});
	test('enable requires separate hostname consent and valid authentication', async () => {
		await controller.initialize(); assert.equal(await controller.enable(), true);
		assert.equal(hostname, 'assessment.example.test'); assert.equal(consentCount, 1); assert.equal(starts, 1);
		assert.equal(controller.enabled, true); assert.equal(settings.enabled, true);
		await controller.disable(); assert.equal(settings.enabled, false); assert.equal(active, 0);
	});
	test('cancelled consent never starts a worker', async () => {
		consent = false; assert.equal(await controller.enable(), false); assert.equal(starts, 0); assert.equal(settings.enabled, false);
		assert.ok(notices.includes('consent_cancelled'));
	});
	test('missing or unavailable authentication never requests consent or starts uploads', async () => {
		token = undefined; assert.equal(await controller.enable(), false); assert.equal(consentCount, 0); assert.equal(creations, 0);
		assert.ok(notices.includes('authentication'));
	});
	test('settings cannot enable uploads without consent', async () => {
		settings.enabled = true; await controller.settingsChanged(); assert.equal(settings.enabled, false);
		assert.equal(starts, 0); assert.equal(consentCount, 0); assert.ok(notices.includes('consent_required'));
	});
	test('endpoint path changes on the same host revoke consent and require confirmation again', async () => {
		await controller.enable(); settings.endpoint = 'https://assessment.example.test/other'; await controller.settingsChanged();
		assert.equal(controller.enabled, false); assert.equal(active, 0); assert.equal(settings.enabled, false);
		await controller.enable(); assert.equal(consentCount, 2); assert.equal(maximumActive, 1);
	});
	test('batch settings and disabled settings revoke consent, while a status mirror update does not', async () => {
		await controller.enable(); await controller.settingsChanged(); assert.equal(controller.enabled, true);
		settings.maxEvents = 5; await controller.settingsChanged(); assert.equal(controller.enabled, false);
		await controller.enable(); settings.enabled = false; await controller.settingsChanged(); assert.equal(controller.enabled, false);
	});
	test('concurrent enable commands share a single dialog and driver', async () => {
		assert.deepEqual(await Promise.all([controller.enable(), controller.enable(), controller.enable()]), [true, true, true]);
		assert.equal(creations, 1); assert.equal(consentCount, 1); assert.equal(starts, 1);
	});
	test('revocation invalidates an outstanding consent dialog', async () => {
		let resolve!: (accepted: boolean) => void; let opened!: () => void; const visible = new Promise<void>(done => { opened = done; });
		ui.confirmUpload = () => { opened(); return new Promise(done => { resolve = done; }); };
		const enabling = controller.enable(); await visible; await controller.disable(); resolve(true);
		assert.equal(await enabling, false); assert.equal(starts, 0); assert.equal(settings.enabled, false);
	});
	test('endpoint changes and disposal during consent prevent late enabling', async () => {
		let resolve!: (accepted: boolean) => void; let opened!: () => void; const visible = new Promise<void>(done => { opened = done; });
		ui.confirmUpload = () => { opened(); return new Promise(done => { resolve = done; }); };
		const enabling = controller.enable(); await visible; settings.endpoint = 'https://another.example.test/events';
		await controller.settingsChanged(); await controller.dispose(); resolve(true);
		assert.equal(await enabling, false); assert.equal(starts, 0);
	});
	test('token replacement while consent is pending prevents starting with stale authentication', async () => {
		ui.confirmUpload = async () => { token = 'changed-dummy-token'; return true; };
		assert.equal(await controller.enable(), false); assert.equal(starts, 0); assert.equal(settings.enabled, false);
	});
	test('secure token configure/remove and cancellation never expose token in notices or settings', async () => {
		await controller.enable(); action = 'configure'; await controller.configureAuthentication(); assert.equal(controller.enabled, true);
		tokenInput = 'new-dummy-token'; await controller.configureAuthentication(); assert.equal(token, tokenInput); assert.equal(controller.enabled, false);
		assert.equal(JSON.stringify(notices).includes(tokenInput), false); assert.equal(JSON.stringify(settings).includes(tokenInput), false);
		await controller.enable(); action = 'remove'; await controller.configureAuthentication(); assert.equal(token, undefined); assert.equal(active, 0);
	});
	test('endpoint configuration validates before saving, then requires new upload consent', async () => {
		await controller.enable(); endpointInput = 'https://user:dummy-password@example.test/events'; await controller.configureEndpoint();
		assert.equal(settings.endpoint, 'https://assessment.example.test/events'); assert.equal(JSON.stringify(notices).includes('dummy-password'), false);
		endpointInput = 'https://other.example.test/events'; await controller.configureEndpoint(); assert.equal(controller.enabled, false);
		assert.equal(settings.endpoint, endpointInput); endpointInput = ''; await controller.configureEndpoint(); assert.equal(settings.endpoint, '');
	});
	test('status contains only safe counts, hostname and flags', async () => {
		await controller.enable(); const status = await controller.showStatus();
		assert.equal(status.hostname, 'assessment.example.test'); assert.equal(status.pendingEvents, 7); assert.equal(status.authenticationConfigured, true);
		assert.equal(JSON.stringify(status).includes('dummy-secret-token'), false); assert.equal('endpoint' in status, false);
	});
	test('network lifecycle never starts/stops recording or grants recording consent', async () => {
		let recordingConsent = 0;
		const recording = new RecordingController({ text: '', tooltip: '', command: '', show() {}, dispose() {} }, async () => { recordingConsent++; return true; });
		await recording.start(); const session = recording.sessionId;
		await controller.enable(); await controller.disable(); await controller.dispose();
		assert.equal(recording.isRecording, true); assert.equal(recording.sessionId, session); assert.equal(recordingConsent, 1);
		recording.dispose();
	});
});
