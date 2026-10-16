import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ClaudeCaptureUi, START_CLAUDE_CAPTURE_COMMAND, REVOKE_CLAUDE_CAPTURE_COMMAND, type ClaudeCapturePrompts } from '../claudeCaptureUi';
import { RecordingController } from '../recording';
import type { FileTracker } from '../fileTracker';
import type { ClaudeCapture } from '../claudeCapture';

suite('Claude capture consent UI', () => {
	let recording: RecordingController; let ui: ClaudeCaptureUi; let consent: boolean; let available: boolean;
	let created: number; let launched: number; let notices: string[]; let prompts: ClaudeCapturePrompts;
	setup(async () => {
		created = 0; launched = 0; notices = []; consent = false; available = true;
		recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => true);
		const folder = { uri: vscode.Uri.file('/approved'), name: 'approved', index: 0 };
		prompts = { pick: async () => folder, available: async () => available ? '/node' : undefined,
			consent: async () => consent, launch: () => { launched++; } };
		const capture = { create: async () => { created++; return { root: '/approved', pluginDirectory: '/private-runtime', sourceSessionId: 'dummy' }; }, revoke: async () => {}, dispose: async () => {} };
		ui = new ClaudeCaptureUi(recording, { getApprovedFolders: () => [folder] } as unknown as FileTracker,
			() => capture as unknown as ClaudeCapture, reason => notices.push(reason), prompts);
		await recording.start();
	});
	teardown(async () => { await ui.dispose(); recording.dispose(); });
	test('recording consent does not grant Claude consent; explicit refusal launches nothing', async () => {
		await ui.start(); assert.equal(created, 0); assert.equal(launched, 0);
		consent = true; await ui.start(); assert.equal(created, 1); assert.equal(launched, 1); assert.equal(recording.isRecording, true);
	});
	test('missing Claude installation reports a safe category and never creates hooks', async () => {
		available = false; consent = true; await ui.start(); assert.equal(created, 0); assert.deepEqual(notices, ['unavailable']);
	});
	test('revocation invalidates delayed consent without stopping recording', async () => {
		let approve!: (yes: boolean) => void; let open!: () => void; const opened = new Promise<void>(resolve => { open = resolve; });
		prompts.consent = () => { open(); return new Promise(resolve => { approve = resolve; }); };
		const starting = ui.start(); await opened; await ui.revoke(); approve(true); await starting;
		assert.equal(created, 0); assert.equal(launched, 0); assert.equal(recording.isRecording, true);
	});
	test('stopping or disposing during consent cannot launch a late Claude session', async () => {
		prompts.consent = async () => { recording.stop(); return true; }; await ui.start(); assert.equal(launched, 0);
	});
	test('commands are registered without accessing real Claude sessions', async function () {
		this.timeout(15000); await vscode.commands.executeCommand('ai-developer-tracker.showQueueHealth');
		const commands = await vscode.commands.getCommands(); assert.ok(commands.includes(START_CLAUDE_CAPTURE_COMMAND)); assert.ok(commands.includes(REVOKE_CLAUDE_CAPTURE_COMMAND));
	});
});
