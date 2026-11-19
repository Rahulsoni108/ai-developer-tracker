import * as assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorSqliteReader, type CursorReaderDiagnostic } from '../cursorSqliteReader';

suite('Cursor SQLite Reader', () => {
	let testDir: string;
	let testDbPath: string;

	setup(async () => {
		testDir = join(tmpdir(), `cursor-reader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(testDir, { recursive: true });
		testDbPath = join(testDir, 'state.vscdb');
	});

	teardown(async () => {
		try {
			await rm(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	function createMockCursorDb(
		prompts: { text: string; commandType?: number }[] = [],
		generations: { unixMs: number; generationUUID: string; type: string; textDescription: string }[] = []
	): void {
		const db = new DatabaseSync(testDbPath);
		db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
		const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
		insert.run('aiService.prompts', JSON.stringify(prompts));
		insert.run('aiService.generations', JSON.stringify(generations));
		db.close();
	}

	function updateMockCursorDb(
		prompts?: { text: string; commandType?: number }[],
		generations?: { unixMs: number; generationUUID: string; type: string; textDescription: string }[]
	): void {
		const db = new DatabaseSync(testDbPath);
		if (prompts !== undefined) {
			const update = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
			update.run('aiService.prompts', JSON.stringify(prompts));
		}
		if (generations !== undefined) {
			const update = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
			update.run('aiService.generations', JSON.stringify(generations));
		}
		db.close();
	}

	test('ignores historical generations before assessment start timestamp', async () => {
		const startTime = 1000000;
		const historical = [
			{ unixMs: 500000, generationUUID: 'gen-old-1', type: 'composer', textDescription: 'old prompt 1' },
			{ unixMs: 999999, generationUUID: 'gen-old-2', type: 'composer', textDescription: 'old prompt 2' }
		];
		createMockCursorDb([], historical);

		const reader = new CursorSqliteReader({
			stateDbPath: testDbPath,
			startTimestampMs: startTime
		});

		const batch = await reader.readOnce();
		assert.equal(batch.generations.length, 0);
		reader.dispose();
	});

	test('captures new prospective generations and deduplicates them', async () => {
		const startTime = 1000000;
		const generations = [
			{ unixMs: 500000, generationUUID: 'gen-old', type: 'composer', textDescription: 'old prompt' },
			{ unixMs: 1000050, generationUUID: 'gen-new-1', type: 'composer', textDescription: 'create login page' }
		];
		createMockCursorDb([], generations);

		const reader = new CursorSqliteReader({
			stateDbPath: testDbPath,
			startTimestampMs: startTime
		});

		const firstBatch = await reader.readOnce();
		assert.equal(firstBatch.generations.length, 1);
		assert.equal(firstBatch.generations[0].generationUUID, 'gen-new-1');
		assert.equal(firstBatch.generations[0].textDescription, 'create login page');
		assert.equal(firstBatch.generations[0].unixMs, 1000050);

		// Subsequent read with same data returns no duplicate generations
		const secondBatch = await reader.readOnce();
		assert.equal(secondBatch.generations.length, 0);

		// Add another prospective generation
		generations.push({
			unixMs: 1000100,
			generationUUID: 'gen-new-2',
			type: 'composer',
			textDescription: 'write tests for login'
		});
		updateMockCursorDb(undefined, generations);

		const thirdBatch = await reader.readOnce();
		assert.equal(thirdBatch.generations.length, 1);
		assert.equal(thirdBatch.generations[0].generationUUID, 'gen-new-2');
		assert.equal(thirdBatch.generations[0].textDescription, 'write tests for login');

		reader.dispose();
	});

	test('treats existing prompts as baseline and emits only newly added prompts', async () => {
		const initialPrompts = [
			{ text: 'existing prompt 1', commandType: 4 },
			{ text: 'existing prompt 2', commandType: 4 }
		];
		createMockCursorDb(initialPrompts, []);

		let currentTime = 2000000;
		const reader = new CursorSqliteReader({
			stateDbPath: testDbPath,
			now: () => currentTime
		});

		// First read establishes baseline
		const baselineBatch = await reader.readOnce();
		assert.equal(baselineBatch.prompts.length, 0);

		// Add new prompt
		currentTime = 2000100;
		const updatedPrompts = [
			...initialPrompts,
			{ text: 'how to fix the memory leak?', commandType: 4 }
		];
		updateMockCursorDb(updatedPrompts, undefined);

		const newBatch = await reader.readOnce();
		assert.equal(newBatch.prompts.length, 1);
		assert.equal(newBatch.prompts[0].text, 'how to fix the memory leak?');
		assert.equal(newBatch.prompts[0].index, 2);
		assert.equal(newBatch.prompts[0].timestampMs, 2000100);

		// Another read without additions yields 0 prompts
		const emptyBatch = await reader.readOnce();
		assert.equal(emptyBatch.prompts.length, 0);

		reader.dispose();
	});

	test('handles missing database file with diagnostic without throwing', async () => {
		const diagnostics: CursorReaderDiagnostic[] = [];
		const reader = new CursorSqliteReader({
			stateDbPath: join(testDir, 'non-existent.vscdb'),
			onDiagnostic: diag => diagnostics.push(diag)
		});

		const batch = await reader.readOnce();
		assert.equal(batch.prompts.length, 0);
		assert.equal(batch.generations.length, 0);
		assert.ok(diagnostics.includes('db_not_found'));

		reader.dispose();
	});

	test('handles corrupted JSON in ItemTable with diagnostic without throwing', async () => {
		const db = new DatabaseSync(testDbPath);
		db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
		const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
		insert.run('aiService.prompts', 'invalid-json{{{');
		insert.run('aiService.generations', 'invalid-json{{{');
		db.close();

		const diagnostics: CursorReaderDiagnostic[] = [];
		const reader = new CursorSqliteReader({
			stateDbPath: testDbPath,
			onDiagnostic: diag => diagnostics.push(diag)
		});

		const batch = await reader.readOnce();
		assert.equal(batch.prompts.length, 0);
		assert.equal(batch.generations.length, 0);
		assert.ok(diagnostics.includes('json_parse_error'));

		reader.dispose();
	});

	test('starts and stops interval polling correctly', async () => {
		createMockCursorDb([], []);
		const reader = new CursorSqliteReader({
			stateDbPath: testDbPath,
			pollIntervalMs: 50
		});

		const batches: string[] = [];
		reader.startPolling(batch => {
			if (batch.generations.length > 0) {
				batches.push(batch.generations[0].generationUUID);
			}
		});

		// Wait briefly, then inject new generation
		await new Promise(r => setTimeout(r, 60));
		updateMockCursorDb(undefined, [
			{ unixMs: Date.now() + 10, generationUUID: 'polled-gen-1', type: 'composer', textDescription: 'test' }
		]);

		// Wait for next poll
		await new Promise(r => setTimeout(r, 150));
		assert.ok(batches.includes('polled-gen-1'));

		reader.stopPolling();
		reader.dispose();
		assert.equal(reader.isDisposed(), true);
	});

	test('works cleanly against real Cursor database if present', async () => {
		const realDb = '/Users/rails/Library/Application Support/Cursor/User/workspaceStorage/759331f1502cc79884e8686ee42d87aa/state.vscdb';
		// Historical test starting from 0 to verify it reads existing records without throwing
		const reader = new CursorSqliteReader({
			stateDbPath: realDb,
			startTimestampMs: 0
		});

		const batch = await reader.readOnce();
		// If real DB exists, verify generations are returned as objects
		assert.ok(Array.isArray(batch.generations));
		assert.ok(Array.isArray(batch.prompts));
		reader.dispose();
	});
});
