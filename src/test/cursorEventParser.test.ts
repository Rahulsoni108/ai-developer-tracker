import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateEvent, type TrackerEvent, type CodexMessagePayload } from '../eventSchema';
import { CursorEventParser, type CursorParserDiagnostic } from '../cursorEventParser';
import type { ActivityWriter } from '../jsonlWriter';
import type { CursorPromptRecord, CursorGenerationRecord } from '../cursorSqliteReader';

suite('Cursor Event Parser', () => {
	const sessionId = randomUUID();
	const workspaceId = 'test-workspace-hash';

	class MockWriter implements ActivityWriter {
		readonly written: TrackerEvent[] = [];
		async write(event: TrackerEvent): Promise<void> {
			this.written.push(event);
		}
		async flush(): Promise<void> {
			// no-op
		}
	}

	test('parses raw prompt into valid ai.prompt.submitted event', async () => {
		const writer = new MockWriter();
		const parser = new CursorEventParser(writer, {
			recordingSessionId: sessionId,
			workspaceId
		});

		const prompt: CursorPromptRecord = {
			index: 0,
			text: 'How do I implement binary search in TypeScript?',
			commandType: 4,
			timestampMs: Date.now(),
			source: 'cursor_prompt'
		};

		const event = await parser.handlePrompt(prompt);
		assert.ok(event);
		assert.equal(event?.eventType, 'ai.prompt.submitted');
		assert.equal(event?.source, 'cursor');
		assert.equal(event?.sessionId, sessionId);
		assert.equal(event?.workspaceId, workspaceId);
		assert.equal((event?.payload as CodexMessagePayload).text, 'How do I implement binary search in TypeScript?');
		assert.equal(event?.payload.sourceRecord.recordType, 'cursor_prompt');
		assert.ok(event?.payload.sourceRecord.sourceFileReference.startsWith('cursor-file:'));

		// Strict schema validator check
		const validation = validateEvent(event!);
		if (!validation.valid) {
			assert.fail(`Validation failed: ${validation.errors.join(', ')}`);
		}
		assert.equal(validation.valid, true);
		assert.equal(writer.written.length, 1);
	});

	test('skips empty or whitespace-only prompts', async () => {
		const writer = new MockWriter();
		const diagnostics: CursorParserDiagnostic[] = [];
		const parser = new CursorEventParser(writer, {
			recordingSessionId: sessionId,
			workspaceId,
			onDiagnostic: d => diagnostics.push(d)
		});

		const emptyPrompt: CursorPromptRecord = {
			index: 0,
			text: '   \n  \t ',
			timestampMs: Date.now(),
			source: 'cursor_prompt'
		};

		const event = await parser.handlePrompt(emptyPrompt);
		assert.equal(event, undefined);
		assert.equal(writer.written.length, 0);
		assert.ok(diagnostics.includes('empty_prompt_skipped'));
	});

	test('parses generation into valid ai.response.completed event', async () => {
		const writer = new MockWriter();
		const parser = new CursorEventParser(writer, {
			recordingSessionId: sessionId,
			workspaceId
		});

		const generationUUID = randomUUID();
		const generation: CursorGenerationRecord = {
			generationUUID,
			unixMs: Date.now(),
			type: 'composer',
			textDescription: 'Refactored auth controller to use JWT validation',
			source: 'cursor_generation'
		};

		const event = await parser.handleGeneration(generation);
		assert.ok(event);
		assert.equal(event?.eventType, 'ai.response.completed');
		assert.equal(event?.source, 'cursor');
		assert.equal(event?.sessionId, sessionId);
		assert.equal(event?.sourceSessionId, generationUUID);
		assert.equal((event?.payload as CodexMessagePayload).text, 'Refactored auth controller to use JWT validation');
		assert.equal(event?.payload.sourceRecord.recordType, 'cursor_generation');

		// Strict schema validator check
		const validation = validateEvent(event!);
		if (!validation.valid) {
			assert.fail(`Validation failed: ${validation.errors.join(', ')}`);
		}
		assert.equal(validation.valid, true);
		assert.equal(writer.written.length, 1);
	});

	test('redacts sensitive API keys and secrets in prompts and generations', async () => {
		const writer = new MockWriter();
		const diagnostics: CursorParserDiagnostic[] = [];
		const parser = new CursorEventParser(writer, {
			recordingSessionId: sessionId,
			workspaceId,
			onDiagnostic: d => diagnostics.push(d)
		});

		// Secret payload
		const secretPrompt: CursorPromptRecord = {
			index: 1,
			text: 'Please connect to OpenAI using apiKey: sk-proj-123456789012345678901234567890123456789012345678',
			timestampMs: Date.now(),
			source: 'cursor_prompt'
		};

		const event = await parser.handlePrompt(secretPrompt);
		assert.ok(event);
		const payloadText = (event?.payload as CodexMessagePayload).text;
		assert.ok(!payloadText.includes('sk-proj-123456789012345678901234567890123456789012345678'));
		assert.ok(payloadText.includes('[REDACTED]'));
		assert.ok(diagnostics.includes('text_redacted'));

		const validation = validateEvent(event!);
		if (!validation.valid) {
			assert.fail(`Validation failed: ${validation.errors.join(', ')}`);
		}
		assert.equal(validation.valid, true);
	});

	test('increments recordIndex sequentially for each processed event', async () => {
		const writer = new MockWriter();
		const parser = new CursorEventParser(writer, {
			recordingSessionId: sessionId,
			workspaceId
		});

		const p1 = await parser.handlePrompt({
			index: 0,
			text: 'first prompt',
			timestampMs: Date.now(),
			source: 'cursor_prompt'
		});
		const g1 = await parser.handleGeneration({
			generationUUID: randomUUID(),
			unixMs: Date.now(),
			type: 'composer',
			textDescription: 'first answer',
			source: 'cursor_generation'
		});
		const p2 = await parser.handlePrompt({
			index: 1,
			text: 'second prompt',
			timestampMs: Date.now(),
			source: 'cursor_prompt'
		});

		assert.equal(p1?.payload.sourceRecord.recordIndex, 1);
		assert.equal(g1?.payload.sourceRecord.recordIndex, 2);
		assert.equal(p2?.payload.sourceRecord.recordIndex, 3);
	});

	test('does not process events after disposal', async () => {
		const writer = new MockWriter();
		const parser = new CursorEventParser(writer, {
			recordingSessionId: sessionId,
			workspaceId
		});

		parser.dispose();
		const event = await parser.handlePrompt({
			index: 0,
			text: 'test after disposal',
			timestampMs: Date.now(),
			source: 'cursor_prompt'
		});

		assert.equal(event, undefined);
		assert.equal(writer.written.length, 0);
	});
});
