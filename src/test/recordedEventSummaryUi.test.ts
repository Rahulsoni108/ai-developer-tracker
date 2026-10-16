import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { RECORDED_EVENT_SUMMARY_COMMAND } from '../recordedEventSummary';
import type { RecordedEventSummary } from '../localEventQueue';

suite('Recorded event summary command', () => {
	test('is registered on activation and exposes only counts for an empty profile', async function () {
		this.timeout(15000);
		const summary = await vscode.commands.executeCommand<RecordedEventSummary>(RECORDED_EVENT_SUMMARY_COMMAND);
		assert.deepEqual(summary, { total: 0, counts: {} });
		assert.ok((await vscode.commands.getCommands()).includes(RECORDED_EVENT_SUMMARY_COMMAND));
	});
});
