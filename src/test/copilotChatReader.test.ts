import * as assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CopilotChatReader,
	extractPromptText,
	extractResponseText,
	type CopilotReadBatch
} from '../copilotChatReader';

suite('Copilot Chat Reader', () => {
	let testDir: string;

	setup(async () => {
		testDir = join(tmpdir(), `copilot-reader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(testDir, { recursive: true });
	});

	teardown(async () => {
		try {
			await rm(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	suite('extractPromptText', () => {
		test('extracts text from plain string message', () => {
			assert.equal(extractPromptText('Hello Copilot'), 'Hello Copilot');
		});

		test('extracts text from message object with text property', () => {
			assert.equal(extractPromptText({ text: 'Explain this function' }), 'Explain this function');
		});

		test('extracts and joins text from parts array', () => {
			const message = {
				parts: [
					{ text: 'First line', kind: 'text' },
					{ text: 'Second line', kind: 'text' }
				]
			};
			assert.equal(extractPromptText(message), 'First line\nSecond line');
		});

		test('returns empty string for undefined or empty message', () => {
			assert.equal(extractPromptText(undefined), '');
			assert.equal(extractPromptText('   '), '');
			assert.equal(extractPromptText({}), '');
		});
	});

	suite('extractResponseText', () => {
		test('extracts text from string response', () => {
			assert.equal(extractResponseText('Here is your answer'), 'Here is your answer');
		});

		test('extracts and joins values from response items array', () => {
			const response = [
				{ kind: 'mcpServersStarting', didStartServerIds: [] },
				{ value: 'Here is step 1.' },
				{ kind: 'markdownContent', content: { value: 'Here is code.' } }
			];
			assert.equal(extractResponseText(response), 'Here is step 1.\nHere is code.');
		});

		test('extracts nested value objects', () => {
			const response = [
				{ value: { value: 'Nested text content' } }
			];
			assert.equal(extractResponseText(response), 'Nested text content');
		});

		test('returns empty string for empty or missing response', () => {
			assert.equal(extractResponseText(undefined), '');
			assert.equal(extractResponseText([]), '');
			assert.equal(extractResponseText([{ kind: 'mcpServersStarting' }]), '');
		});
	});

	suite('Session file reading & prospective filtering', () => {
		test('ignores historical chat turns created before assessment start time', async () => {
			const assessmentStart = 10_000;
			const sessionFile = join(testDir, 'session-1.jsonl');

			const line = JSON.stringify({
				kind: 0,
				v: {
					sessionId: 'session-1',
					requests: [
						{
							requestId: 'req-old',
							timestamp: 5_000,
							message: { text: 'Old historical prompt' },
							response: [{ value: 'Old historical answer' }],
							responseId: 'resp-old',
							modelState: { completedAt: 6_000 }
						}
					]
				}
			});

			await writeFile(sessionFile, line + '\n');

			const reader = new CopilotChatReader({
				chatSessionsDir: testDir,
				startTimestampMs: assessmentStart
			});

			const batch = await reader.readOnce();
			assert.equal(batch.prompts.length, 0);
			assert.equal(batch.responses.length, 0);
			reader.dispose();
		});

		test('captures prospective chat turns and deduplicates across subsequent reads', async () => {
			const assessmentStart = 10_000;
			const sessionFile = join(testDir, 'session-2.jsonl');

			const line = JSON.stringify({
				kind: 0,
				v: {
					sessionId: 'session-2',
					requests: [
						{
							requestId: 'req-new',
							timestamp: 12_000,
							message: { text: 'How do I sort an array?' },
							response: [{ value: 'Use Array.prototype.sort().' }],
							responseId: 'resp-new',
							modelState: { completedAt: 13_000 }
						}
					]
				}
			});

			await writeFile(sessionFile, line + '\n');

			const reader = new CopilotChatReader({
				chatSessionsDir: testDir,
				startTimestampMs: assessmentStart
			});

			const batch1 = await reader.readOnce();
			assert.equal(batch1.prompts.length, 1);
			assert.equal(batch1.prompts[0].requestId, 'req-new');
			assert.equal(batch1.prompts[0].text, 'How do I sort an array?');
			assert.equal(batch1.prompts[0].timestampMs, 12_000);

			assert.equal(batch1.responses.length, 1);
			assert.equal(batch1.responses[0].responseId, 'resp-new');
			assert.equal(batch1.responses[0].text, 'Use Array.prototype.sort().');
			assert.equal(batch1.responses[0].timestampMs, 13_000);

			// Subsequent read should not re-emit the same prompt or response
			const batch2 = await reader.readOnce();
			assert.equal(batch2.prompts.length, 0);
			assert.equal(batch2.responses.length, 0);

			reader.dispose();
		});

		test('handles response arriving in delta patch (kind 1) after prompt', async () => {
			const assessmentStart = 10_000;
			const sessionFile = join(testDir, 'session-delta.jsonl');

			// Line 1: Request sent with no response yet
			const line1 = JSON.stringify({
				kind: 0,
				v: {
					sessionId: 'session-delta',
					requests: [
						{
							requestId: 'req-delta-1',
							timestamp: 11_000,
							message: { text: 'Write a binary search' },
							response: []
						}
					]
				}
			});

			await writeFile(sessionFile, line1 + '\n');

			const reader = new CopilotChatReader({
				chatSessionsDir: testDir,
				startTimestampMs: assessmentStart
			});

			// Pass 1: Captures prompt, but response has no text yet
			const batch1 = await reader.readOnce();
			assert.equal(batch1.prompts.length, 1);
			assert.equal(batch1.prompts[0].requestId, 'req-delta-1');
			assert.equal(batch1.responses.length, 0);

			// Append Line 2: Delta patch updates response
			const line2 = JSON.stringify({
				kind: 1,
				k: ['requests', 0, 'response'],
				v: [{ value: 'function binarySearch() { ... }' }]
			});
			const line3 = JSON.stringify({
				kind: 1,
				k: ['requests', 0, 'modelState'],
				v: { value: 1, completedAt: 12_500 }
			});

			await writeFile(sessionFile, `${line1}\n${line2}\n${line3}\n`);

			// Pass 2: Captures completed response
			const batch2 = await reader.readOnce();
			assert.equal(batch2.prompts.length, 0); // prompt already emitted
			assert.equal(batch2.responses.length, 1);
			assert.equal(batch2.responses[0].text, 'function binarySearch() { ... }');
			assert.equal(batch2.responses[0].timestampMs, 12_500);

			reader.dispose();
		});
	});

	suite('Resilience & Diagnostics', () => {
		test('handles missing chatSessions directory with diagnostic without throwing', async () => {
			const diagnostics: string[] = [];
			const reader = new CopilotChatReader({
				chatSessionsDir: join(testDir, 'does-not-exist'),
				onDiagnostic: (diag) => diagnostics.push(diag)
			});

			const batch = await reader.readOnce();
			assert.equal(batch.prompts.length, 0);
			assert.equal(batch.responses.length, 0);
			assert.ok(diagnostics.includes('directory_not_found'));

			reader.dispose();
		});

		test('handles corrupted JSON lines gracefully with diagnostic without throwing', async () => {
			const sessionFile = join(testDir, 'corrupt.jsonl');
			await writeFile(sessionFile, 'NOT_VALID_JSON\n{"kind": 0, "v": {"requests": []}}\n');

			const diagnostics: string[] = [];
			const reader = new CopilotChatReader({
				chatSessionsDir: testDir,
				onDiagnostic: (diag) => diagnostics.push(diag)
			});

			const batch = await reader.readOnce();
			assert.equal(batch.prompts.length, 0);
			assert.ok(diagnostics.includes('json_parse_error'));

			reader.dispose();
		});

		test('starts and stops interval polling cleanly', async () => {
			const batches: CopilotReadBatch[] = [];
			const sessionFile = join(testDir, 'poll.jsonl');

			const reader = new CopilotChatReader({
				chatSessionsDir: testDir,
				startTimestampMs: 0,
				pollIntervalMs: 20
			});

			reader.start((batch) => batches.push(batch));

			await writeFile(sessionFile, JSON.stringify({
				kind: 0,
				v: {
					sessionId: 'poll-sess',
					requests: [{
						requestId: 'r-poll',
						timestamp: 50,
						message: { text: 'Ping' },
						response: [{ value: 'Pong' }]
					}]
				}
			}) + '\n');

			// Wait for poller to pick it up
			await new Promise((r) => setTimeout(r, 60));

			reader.stop();
			assert.ok(batches.length >= 1);
			assert.equal(batches[0].prompts[0].text, 'Ping');
			assert.equal(batches[0].responses[0].text, 'Pong');

			reader.dispose();
		});
	});
});
