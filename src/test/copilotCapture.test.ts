import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotCapture, type CopilotCaptureState } from '../copilotCapture';
import { RecordingController } from '../recording';
import type { ActivityWriter } from '../jsonlWriter';
import type { TrackerEvent, CodexMessagePayload } from '../eventSchema';

suite('Copilot Capture Controller', () => {
	let testDir: string;
	let workspaceDir: string;
	let codeUserDir: string;
	let chatSessionsDir: string;

	class MockWriter implements ActivityWriter {
		readonly written: TrackerEvent[] = [];
		async write(event: TrackerEvent): Promise<void> {
			this.written.push(event);
		}
		async flush(): Promise<void> {}
	}

	setup(async () => {
		testDir = join(tmpdir(), `copilot-capture-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		workspaceDir = join(testDir, 'candidate-copilot-project');
		codeUserDir = join(testDir, 'Code', 'User');

		const workspaceStorage = join(codeUserDir, 'workspaceStorage', 'hash-test-copilot');
		chatSessionsDir = join(workspaceStorage, 'chatSessions');

		await mkdir(workspaceDir, { recursive: true });
		await mkdir(chatSessionsDir, { recursive: true });

		await writeFile(
			join(workspaceStorage, 'workspace.json'),
			JSON.stringify({ folder: `file://${workspaceDir}` })
		);
	});

	teardown(async () => {
		try {
			await rm(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup
		}
	});

	const createRecording = () =>
		new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => true);

	test('transitions to unavailable when Code workspaceStorage does not exist', async () => {
		const recording = createRecording();
		const writer = new MockWriter();
		const states: CopilotCaptureState[] = [];

		const capture = new CopilotCapture(recording, writer, {
			workspacePath: workspaceDir,
			codeUserDir: join(testDir, 'nonexistent-user'),
			onStateChange: s => states.push(s)
		});

		await recording.start();
		await capture.waitForReady();
		assert.equal(capture.getState(), 'unavailable');
		capture.dispose();
	});

	test('activates, starts polling, and processes chat turns into events during active recording', async () => {
		const recording = createRecording();
		const writer = new MockWriter();
		const states: CopilotCaptureState[] = [];

		const capture = new CopilotCapture(recording, writer, {
			workspacePath: workspaceDir,
			codeUserDir,
			pollIntervalMs: 25,
			onStateChange: s => states.push(s)
		});

		assert.equal(capture.getState(), 'not_started');

		// Start recording
		await recording.start();
		await capture.waitForReady();
		assert.equal(capture.getState(), 'ready');
		assert.ok(capture.getReader());
		assert.ok(capture.getParser());

		// Write a new session file into chatSessions
		const sessionFile = join(chatSessionsDir, 'live-session.jsonl');
		const line = JSON.stringify({
			kind: 0,
			v: {
				sessionId: 'live-session',
				requests: [
					{
						requestId: 'req-live-1',
						timestamp: Date.now() + 10,
						message: { text: 'How do I optimize SQL queries?' },
						response: [{ value: 'Add appropriate composite indexes.' }],
						responseId: 'resp-live-1',
						modelState: { completedAt: Date.now() + 20 }
					}
				]
			}
		});

		await writeFile(sessionFile, line + '\n');

		// Wait for poller pass
		await new Promise(r => setTimeout(r, 80));

		// Verify events were parsed and written to writer
		assert.ok(writer.written.length >= 2, `Expected at least 2 events, got ${writer.written.length}`);
		const promptEvent = writer.written.find(e => e.eventType === 'ai.prompt.submitted');
		const responseEvent = writer.written.find(e => e.eventType === 'ai.response.completed');

		assert.ok(promptEvent);
		assert.equal(promptEvent?.source, 'copilot');
		assert.equal((promptEvent?.payload as CodexMessagePayload).text, 'How do I optimize SQL queries?');

		assert.ok(responseEvent);
		assert.equal(responseEvent?.source, 'copilot');
		assert.equal((responseEvent?.payload as CodexMessagePayload).text, 'Add appropriate composite indexes.');

		// Stop recording
		await recording.stop();
		assert.equal(capture.getState(), 'stopped');

		capture.dispose();
	});

	test('transitions to interrupted if chatSessions directory is missing', async () => {
		const recording = createRecording();
		const writer = new MockWriter();
		const states: CopilotCaptureState[] = [];

		// Create workspaceStorage without chatSessions
		const altStorage = join(codeUserDir, 'workspaceStorage', 'no-chat-sessions');
		const altWorkspace = join(testDir, 'alt-project');
		await mkdir(altWorkspace, { recursive: true });
		await mkdir(altStorage, { recursive: true });
		await writeFile(join(altStorage, 'workspace.json'), JSON.stringify({ folder: altWorkspace }));

		const capture = new CopilotCapture(recording, writer, {
			workspacePath: altWorkspace,
			codeUserDir,
			onStateChange: s => states.push(s)
		});

		await recording.start();
		await capture.waitForReady();
		assert.equal(capture.getState(), 'interrupted');

		capture.dispose();
	});
});
