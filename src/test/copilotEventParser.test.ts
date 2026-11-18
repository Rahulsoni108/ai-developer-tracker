import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateEvent, type TrackerEvent, type CodexMessagePayload } from '../eventSchema';
import { CopilotEventParser, type CopilotParserDiagnostic } from '../copilotEventParser';
import type { ActivityWriter } from '../jsonlWriter';
import type { CopilotPromptRecord, CopilotResponseRecord } from '../copilotChatReader';

suite('Copilot Event Parser', () => {
	const sessionId = randomUUID();
	const workspaceId = 'workspace-copilot-test';
	const diagnostics: { diag: CopilotParserDiagnostic; details?: unknown }[] = [];

	class MockWriter implements ActivityWriter {
		readonly written: TrackerEvent[] = [];
		async write(event: TrackerEvent): Promise<void> {
			this.written.push(event);
		}
		async flush(): Promise<void> {
			// no-op
		}
	}

	setup(() => {
		diagnostics.length = 0;
	});

	test('parses raw prompt into valid ai.prompt.submitted event', async () => {
		const writer = new MockWriter();
		const parser = new CopilotEventParser(writer, {
			recordingSessionId: sessionId,
			workspaceId,
			onDiagnostic: (diag, details) => diagnostics.push({ diag, details })
		});

		const prompt: CopilotPromptRecord = {
			sessionId: 'sess-copilot-1',
			requestId: 'req-001',
			text: 'How do I invert a binary tree?',
			timestampMs: 1700000000000,
			source: 'copilot_prompt'
		};

		const event = await parser.handlePrompt(prompt);
		assert.ok(event);
		assert.equal(event?.eventType, 'ai.prompt.submitted');
		assert.equal(event?.source, 'copilot');
		assert.equal(event?.sessionId, sessionId);
		assert.equal(event?.workspaceId, workspaceId);
		assert.equal((event?.payload as CodexMessagePayload).text, 'How do I invert a binary tree?');
		assert.ok(event?.payload.sourceRecord.sourceFileReference.startsWith('copilot-file:'));
		assert.equal(event?.payload.sourceRecord.recordType, 'copilot_turn');
		assert.equal(event?.payload.sourceRecord.recordIndex, 1);
		assert.equal((event?.payload as CodexMessagePayload).messageId, 'req-001');

		// Validate against schema validator
		const validation = validateEvent(event!);
		if (!validation.valid) {
			assert.fail(`Validation failed: ${validation.errors.join(', ')}`);
		}

		assert.equal(writer.written.length, 1);
		assert.equal(diagnostics.some(d => d.diag === 'event_created'), true);

		parser.dispose();
	});

	test('skips empty or whitespace-only prompts', async () => {
		const writer = new MockWriter();
		const parser = new CopilotEventParser(writer, {
			recordingSessionId: sessionId,
			workspaceId,
			onDiagnostic: (diag, details) => diagnostics.push({ diag, details })
		});

		const prompt: CopilotPromptRecord = {
			sessionId: 'sess-copilot-1',
			requestId: 'req-empty',
			text: '   \n  \t  ',
			timestampMs: 1700000000000,
			source: 'copilot_prompt'
		};

		const event = await parser.handlePrompt(prompt);
		assert.equal(event, undefined);
		assert.equal(writer.written.length, 0);
		assert.equal(diagnostics.some(d => d.diag === 'empty_prompt_skipped'), true);

		parser.dispose();
	});

	test('parses response into valid ai.response.completed event', async () => {
		const writer = new MockWriter();
		const parser = new CopilotEventParser(writer, {
			recordingSessionId: sessionId,
			workspaceId,
			onDiagnostic: (diag, details) => diagnostics.push({ diag, details })
		});

		const response: CopilotResponseRecord = {
			sessionId: 'sess-copilot-1',
			requestId: 'req-001',
			responseId: 'resp-001',
			text: 'Here is the inverted binary tree solution in TypeScript.',
			timestampMs: 1700000005000,
			source: 'copilot_response'
		};

		const event = await parser.handleResponse(response);
		assert.ok(event);
		assert.equal(event?.eventType, 'ai.response.completed');
		assert.equal(event?.source, 'copilot');
		assert.equal(event?.sessionId, sessionId);
		assert.equal(event?.workspaceId, workspaceId);
		assert.equal((event?.payload as CodexMessagePayload).text, 'Here is the inverted binary tree solution in TypeScript.');
		assert.ok(event?.payload.sourceRecord.sourceFileReference.startsWith('copilot-file:'));
		assert.equal(event?.payload.sourceRecord.recordType, 'copilot_message');
		assert.equal(event?.payload.sourceRecord.recordIndex, 1);
		assert.equal((event?.payload as CodexMessagePayload).messageId, 'resp-001');

		// Validate against schema validator
		const validation = validateEvent(event!);
		if (!validation.valid) {
			assert.fail(`Validation failed: ${validation.errors.join(', ')}`);
		}

		assert.equal(writer.written.length, 1);

		parser.dispose();
	});

	test('redacts sensitive API keys and secrets in prompts and responses', async () => {
		const writer = new MockWriter();
		const parser = new CopilotEventParser(writer, {
			recordingSessionId: sessionId,
			workspaceId,
			onDiagnostic: (diag, details) => diagnostics.push({ diag, details })
		});

		const prompt: CopilotPromptRecord = {
			sessionId: 'sess-copilot-secrets',
			requestId: 'req-secret',
			text: 'Use my OpenAI key sk-proj-12345678901234567890123456789012 to make an API call',
			timestampMs: 1700000000000,
			source: 'copilot_prompt'
		};

		const event = await parser.handlePrompt(prompt);
		assert.ok(event);
		const text = (event?.payload as CodexMessagePayload).text;
		assert.ok(!text.includes('sk-proj-12345678901234567890123456789012'));
		assert.ok(text.includes('[REDACTED]'));

		const validation = validateEvent(event!);
		if (!validation.valid) {
			assert.fail(`Validation failed: ${validation.errors.join(', ')}`);
		}

		parser.dispose();
	});

	test('increments recordIndex sequentially for each processed event', async () => {
		const writer = new MockWriter();
		const parser = new CopilotEventParser(writer, {
			recordingSessionId: sessionId,
			workspaceId
		});

		const e1 = await parser.handlePrompt({
			sessionId: 's',
			requestId: 'r1',
			text: 'p1',
			timestampMs: 100,
			source: 'copilot_prompt'
		});
		const e2 = await parser.handleResponse({
			sessionId: 's',
			requestId: 'r1',
			responseId: 'resp1',
			text: 'ans1',
			timestampMs: 200,
			source: 'copilot_response'
		});
		const e3 = await parser.handlePrompt({
			sessionId: 's',
			requestId: 'r2',
			text: 'p2',
			timestampMs: 300,
			source: 'copilot_prompt'
		});

		assert.equal(e1?.payload.sourceRecord.recordIndex, 1);
		assert.equal(e2?.payload.sourceRecord.recordIndex, 2);
		assert.equal(e3?.payload.sourceRecord.recordIndex, 3);

		parser.dispose();
	});

	test('does not process events after disposal', async () => {
		const writer = new MockWriter();
		const parser = new CopilotEventParser(writer, {
			recordingSessionId: sessionId,
			workspaceId
		});

		parser.dispose();

		const event = await parser.handlePrompt({
			sessionId: 's',
			requestId: 'r',
			text: 'Hello',
			timestampMs: 100,
			source: 'copilot_prompt'
		});

		assert.equal(event, undefined);
		assert.equal(writer.written.length, 0);
	});
});
