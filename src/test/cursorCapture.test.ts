import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorCapture, type CursorCaptureState } from '../cursorCapture';
import { RecordingController } from '../recording';
import type { ActivityWriter } from '../jsonlWriter';
import type { TrackerEvent } from '../eventSchema';

suite('Cursor Capture Controller', () => {
	let testDir: string;
	let workspaceDir: string;
	let cursorUserDir: string;
	let stateDbPath: string;

	class MockWriter implements ActivityWriter {
		readonly written: TrackerEvent[] = [];
		async write(event: TrackerEvent): Promise<void> {
			this.written.push(event);
		}
		async flush(): Promise<void> {}
	}

	setup(async () => {
		testDir = join(tmpdir(), `cursor-capture-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		workspaceDir = join(testDir, 'my-candidate-project');
		cursorUserDir = join(testDir, 'Cursor', 'User');

		const workspaceStorage = join(cursorUserDir, 'workspaceStorage', 'hash-test-ws');
		await mkdir(workspaceDir, { recursive: true });
		await mkdir(workspaceStorage, { recursive: true });

		await writeFile(
			join(workspaceStorage, 'workspace.json'),
			JSON.stringify({ folder: `file://${workspaceDir}` })
		);

		stateDbPath = join(workspaceStorage, 'state.vscdb');
		const db = new DatabaseSync(stateDbPath);
		db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
		const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
		insert.run('aiService.prompts', '[]');
		insert.run('aiService.generations', '[]');
		db.close();
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

	test('transitions to unavailable when appName is not Cursor', async () => {
		const recording = createRecording();
		const writer = new MockWriter();
		const states: CursorCaptureState[] = [];

		const capture = new CursorCapture(recording, writer, {
			workspacePath: workspaceDir,
			appName: 'Visual Studio Code',
			onStateChange: s => states.push(s)
		});

		await recording.start();
		assert.equal(capture.getState(), 'unavailable');
		capture.dispose();
	});

	test('activates, starts polling, and processes events in Cursor environment', async () => {
		const recording = createRecording();
		const writer = new MockWriter();
		const states: CursorCaptureState[] = [];

		const capture = new CursorCapture(recording, writer, {
			workspacePath: workspaceDir,
			appName: 'Cursor',
			cursorUserDir,
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

		// Inject new generation into state.vscdb
		const db = new DatabaseSync(stateDbPath);
		const genUUID = randomUUID();
		const update = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
		update.run(
			'aiService.generations',
			JSON.stringify([
				{
					unixMs: Date.now() + 50,
					generationUUID: genUUID,
					type: 'composer',
					textDescription: 'Add user authentication endpoint'
				}
			])
		);
		db.close();

		// Wait for poller to read and parser to write
		await new Promise(r => setTimeout(r, 100));

		assert.equal(writer.written.length, 1);
		assert.equal(writer.written[0].eventType, 'ai.response.completed');
		assert.equal(writer.written[0].source, 'cursor');
		assert.equal(writer.written[0].sourceSessionId, genUUID);

		// Stop recording
		await recording.stop();
		assert.equal(capture.getState(), 'stopped');
		assert.equal(capture.getReader(), undefined);
		assert.equal(capture.getParser(), undefined);

		capture.dispose();
	});

	test('transitions to interrupted if state.vscdb is missing', async () => {
		const emptyProjectDir = join(testDir, 'empty-project');
		await mkdir(emptyProjectDir, { recursive: true });

		const recording = createRecording();
		const writer = new MockWriter();

		const capture = new CursorCapture(recording, writer, {
			workspacePath: emptyProjectDir,
			appName: 'Cursor',
			cursorUserDir
		});

		await recording.start();
		await capture.waitForReady();
		assert.equal(capture.getState(), 'interrupted');
		capture.dispose();
	});
});
