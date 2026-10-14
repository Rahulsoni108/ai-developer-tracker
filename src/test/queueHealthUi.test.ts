import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { QUEUE_HEALTH_COMMAND } from '../extension';
import type { QueueHealth } from '../localEventQueue';

suite('Local queue health command', () => {
	test('activates storage and exposes sanitized counts and usage through the registered command', async function () {
		this.timeout(15000);
		const health = await vscode.commands.executeCommand<QueueHealth>(QUEUE_HEALTH_COMMAND);
		assert.ok(health && Number.isSafeInteger(health.pendingCount), 'Queue startup diagnostic: ' + JSON.stringify(health));
		assert.ok(health.storageBytes > 0); assert.equal(health.maxStorageBytes, 100 * 1024 * 1024);
		assert.ok(!('events' in health)); assert.ok(!('path' in health));
	});
});
