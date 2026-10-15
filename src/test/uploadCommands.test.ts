import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CONFIGURE_UPLOAD_ENDPOINT_COMMAND, CONFIGURE_UPLOAD_AUTHENTICATION_COMMAND, ENABLE_UPLOADS_COMMAND,
	DISABLE_UPLOADS_COMMAND, SHOW_UPLOAD_STATUS_COMMAND, type UploadStatus } from '../uploadController';

suite('VS Code upload commands and settings', () => {
	test('activation exposes disabled upload status and registers all commands without granting consent', async function () {
		this.timeout(15000);
		const status = await vscode.commands.executeCommand<UploadStatus>(SHOW_UPLOAD_STATUS_COMMAND);
		assert.ok(status); assert.equal(status.enabled, false); assert.equal(status.consentGranted, false);
		assert.equal(status.authenticationConfigured, false); assert.equal(status.hostname, undefined);
		assert.equal('token' in status, false); assert.equal('endpoint' in status, false);
		const commands = await vscode.commands.getCommands();
		for (const command of [CONFIGURE_UPLOAD_ENDPOINT_COMMAND, CONFIGURE_UPLOAD_AUTHENTICATION_COMMAND, ENABLE_UPLOADS_COMMAND,
			DISABLE_UPLOADS_COMMAND, SHOW_UPLOAD_STATUS_COMMAND]) { assert.ok(commands.includes(command)); }
	});
	test('configuration defaults keep upload destination and enablement disabled with bounded batches', () => {
		const config = vscode.workspace.getConfiguration('ai-developer-tracker.upload');
		assert.equal(config.inspect('endpoint')?.defaultValue, ''); assert.equal(config.inspect('enabled')?.defaultValue, false);
		assert.equal(config.inspect('maxEvents')?.defaultValue, 100); assert.equal(config.inspect('maxBytes')?.defaultValue, 1048576);
		assert.equal(config.inspect('timeoutMs')?.defaultValue, 30000);
	});
});
