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
	test('status distinguishes configured but unpaired Rails from missing configuration', () => {
		const configured = formatAssessmentStatus({ state: 'unpaired', mode: 'rails', uploadConsent: false });
		assert.ok(configured.includes('Rails assessment API configured. Use Pair Assessment to connect.'));
		assert.equal(configured.includes('Configure assessment.apiOrigin'), false);
		assert.equal(configured.includes('Rails assessment connected'), false);
		assert.ok(formatAssessmentStatus({ state: 'unpaired', uploadConsent: false }).includes('Configure assessment.apiOrigin'));
		assert.ok(formatAssessmentStatus({ state: 'unpaired', mode: 'mock', uploadConsent: false }).includes('LOCAL MOCK ONLY'));
	});
	test('registers the assessment origin in the active manifest and reads the user setting through the activation key', async () => {
		const extension = vscode.extensions.all.find(candidate => candidate.packageJSON.name === 'ai-developer-tracker');
		assert.ok(extension);
		const contributed = extension.packageJSON.contributes.configuration.properties['ai-developer-tracker.assessment.apiOrigin'];
		assert.equal(contributed.type, 'string'); assert.equal(contributed.scope, 'machine'); assert.equal(contributed.restricted, true);
		const configuration = vscode.workspace.getConfiguration('ai-developer-tracker.assessment');
		assert.equal(configuration.inspect<string>('apiOrigin')?.defaultValue, '');
		const previous = configuration.inspect<string>('apiOrigin')?.globalValue;
		try {
			await configuration.update('apiOrigin', 'https://assessment.invalid', vscode.ConfigurationTarget.Global);
			assert.equal(vscode.workspace.getConfiguration('ai-developer-tracker.assessment').inspect<string>('apiOrigin')?.globalValue, 'https://assessment.invalid');
		} finally { await configuration.update('apiOrigin', previous, vscode.ConfigurationTarget.Global); }
	});
});
