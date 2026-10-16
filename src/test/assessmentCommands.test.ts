import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ASSESSMENT_STATUS_COMMAND, PAIR_ASSESSMENT_COMMAND, START_ASSESSMENT_COMMAND, SUBMIT_ASSESSMENT_COMMAND, formatAssessmentStatus } from '../assessmentCommands';
import type { AssessmentView } from '../assessmentController';

suite('Assessment VS Code commands', () => {
	test('registers all four commands and defaults to an unpaired non-recording state without a backend', async function () {
		this.timeout(15000); const view = await vscode.commands.executeCommand<AssessmentView>(ASSESSMENT_STATUS_COMMAND);
		assert.equal(view!.state, 'unpaired'); assert.equal(view!.uploadConsent, false);
		const commands = await vscode.commands.getCommands();
		for (const command of [ASSESSMENT_STATUS_COMMAND, PAIR_ASSESSMENT_COMMAND, START_ASSESSMENT_COMMAND, SUBMIT_ASSESSMENT_COMMAND]) { assert.ok(commands.includes(command)); }
	});
	test('status text makes pending submission and mock timing limitations explicit without connection identifiers', () => {
		const text = formatAssessmentStatus({ state: 'submission_pending', mode: 'mock', uploadConsent: false, pendingEvents: 2,
			serverTime: '2030-01-01T00:00:00Z', deadline: '2030-01-01T01:00:00Z' });
		assert.ok(text.includes('LOCAL MOCK ONLY')); assert.ok(text.includes('Submission is not complete'));
		assert.ok(text.includes('offline time is unverified')); assert.equal(text.includes('codingSessionId'), false);
	});
});
