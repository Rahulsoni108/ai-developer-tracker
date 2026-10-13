import * as assert from 'assert';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createFileEvent, EVENT_LOG_FILENAME, EventValidationError, isUuid,
	LEGACY_EVENT_LOG_FILENAME, SCHEMA_VERSION, validateEvent,
	type EventSource, type FileEventType
} from '../eventSchema';
import { JsonlWriter } from '../jsonlWriter';

function event() {
	return createFileEvent({
		source: 'vscode', eventType: 'file.modified', sessionId: randomUUID(),
		workspaceId: 'workspace-id', payload: { relativePath: 'src/app.ts' },
		timestamp: new Date('2026-10-12T12:00:00.000Z')
	});
}

suite('Common event schema', () => {
	test('generates a versioned event with a UUID and UTC timestamp', () => {
		const created = event();
		assert.strictEqual(created.schemaVersion, SCHEMA_VERSION);
		assert.strictEqual(SCHEMA_VERSION, 1);
		assert.strictEqual(created.timestamp, '2026-10-12T12:00:00.000Z');
		assert.ok(isUuid(created.eventId));
		assert.ok(isUuid(created.sessionId));
		assert.strictEqual(created.attribution, 'unknown');
		assert.strictEqual(validateEvent(created).valid, true);
		const automatic = createFileEvent({ source: 'vscode', eventType: 'file.saved', sessionId: randomUUID(), workspaceId: 'workspace-id', payload: { relativePath: 'app.ts' } });
		assert.strictEqual(automatic.timestamp, new Date(automatic.timestamp).toISOString());
	});

	test('generates distinct UUID v4 event IDs', () => {
		const ids = Array.from({ length: 100 }, () => event().eventId);
		assert.ok(ids.every(isUuid));
		assert.strictEqual(new Set(ids).size, ids.length);
	});

	test('supports the reserved sources, file event types, and optional metadata', () => {
		for (const source of ['vscode', 'codex', 'claude'] satisfies EventSource[]) {
			for (const eventType of ['file.created', 'file.modified', 'file.saved', 'file.deleted'] satisfies FileEventType[]) {
				const created = createFileEvent({ ...event(), source, eventType, sourceSessionId: 'provider-session', correlationId: 'operation-123', attribution: 'ai_confirmed', timestamp: new Date() });
				assert.strictEqual(validateEvent(created).valid, true);
			}
		}
		const noAttribution = { ...event() };
		delete noAttribution.attribution;
		assert.strictEqual(validateEvent(noAttribution).valid, true);
		assert.strictEqual(validateEvent({ ...event(), attribution: 'human_confirmed' }).valid, true);
	});

	test('rejects every missing required field and unsupported schema versions', () => {
		for (const field of ['schemaVersion', 'eventId', 'timestamp', 'source', 'eventType', 'sessionId', 'workspaceId', 'payload']) {
			const malformed: Record<string, unknown> = { ...event() };
			delete malformed[field];
			assert.strictEqual(validateEvent(malformed).valid, false, field);
		}
		for (const schemaVersion of [0, 2, '1', null]) {
			assert.strictEqual(validateEvent({ ...event(), schemaVersion }).valid, false);
		}
	});

	test('rejects invalid UUIDs, non-UTC timestamps, sources, types, and optional fields', () => {
		const invalidFields = [
			{ eventId: 'not-a-uuid' }, { sessionId: 'not-a-uuid' },
			{ eventId: '00000000-0000-0000-0000-000000000000' },
			{ timestamp: '2026-10-12T17:30:00.000+05:30' }, { timestamp: 'invalid' },
			{ timestamp: '2026-02-30T12:00:00.000Z' }, { timestamp: 123 },
			{ source: 'other' }, { eventType: 'file.changed' }, { workspaceId: '' },
			{ sourceSessionId: '' }, { correlationId: 42 }, { attribution: 'ai_inferred' }
		];
		for (const fields of invalidFields) {
			assert.strictEqual(validateEvent({ ...event(), ...fields }).valid, false, JSON.stringify(fields));
		}
	});

	test('rejects absolute and traversal paths, arbitrary payload fields, and contents', () => {
		for (const relativePath of ['', '/etc/passwd', '../app.ts', 'src/../app.ts', './app.ts', 'src//app.ts', 'C:\\secret.txt', 'C:/secret.txt', 'file:///secret.txt', 'app\u0000.ts']) {
			assert.strictEqual(validateEvent({ ...event(), payload: { relativePath } }).valid, false, relativePath);
		}
		for (const fields of [{ text: 'private source code' }, { diff: 'private diff' }, { token: 'secret' }]) {
			assert.strictEqual(validateEvent({ ...event(), payload: { relativePath: 'app.ts', ...fields } }).valid, false);
			assert.strictEqual(validateEvent({ ...event(), ...fields }).valid, false);
		}
	});

	test('gracefully rejects non-data objects without executing getters or exposing their values', () => {
		for (const input of [undefined, null, 'text', [], new Date()]) {
			assert.strictEqual(validateEvent(input).valid, false);
		}
		const getter = { ...event() };
		Object.defineProperty(getter, 'payload', { enumerable: true, get: () => { throw new Error('private source code'); } });
		const result = validateEvent(getter);
		assert.strictEqual(result.valid, false);
		assert.ok(!JSON.stringify(result).includes('private source code'));
		const hidden = { ...event() };
		Object.defineProperty(hidden, 'sessionId', { enumerable: false, value: hidden.sessionId });
		assert.strictEqual(validateEvent(hidden).valid, false);
		assert.strictEqual(validateEvent(new Proxy({}, { getPrototypeOf: () => { throw new Error('secret'); } })).valid, false);
	});

	test('rejects invalid writes before creating JSONL, then accepts a valid event', async () => {
		const temporary = await mkdtemp(join(tmpdir(), 'schema-test-'));
		try {
			const filePath = join(temporary, EVENT_LOG_FILENAME);
			const writer = new JsonlWriter(filePath);
			await assert.rejects(writer.write({ ...event(), payload: { relativePath: 'app.ts', contents: 'secret' } }), EventValidationError);
			await assert.rejects(stat(filePath), { code: 'ENOENT' });
			await writer.write(event());
			const before = await readFile(filePath, 'utf8');
			await assert.rejects(writer.write({ ...event(), schemaVersion: 999 }), EventValidationError);
			await writer.flush();
			assert.strictEqual(await readFile(filePath, 'utf8'), before);
			await writer.write(event());
			assert.strictEqual((await readFile(filePath, 'utf8')).trim().split('\n').length, 2);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test('snapshots validated metadata before an asynchronous append', async () => {
		const temporary = await mkdtemp(join(tmpdir(), 'snapshot-test-'));
		try {
			const writer = new JsonlWriter(join(temporary, EVENT_LOG_FILENAME));
			const created = event();
			const writing = writer.write(created);
			created.payload.relativePath = 'different.ts';
			await writing;
			assert.strictEqual(JSON.parse(await readFile(writer.filePath, 'utf8')).payload.relativePath, 'src/app.ts');
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test('keeps legacy v0 records untouched and writes normalized v1 records separately', async () => {
		const temporary = await mkdtemp(join(tmpdir(), 'legacy-test-'));
		try {
			const legacy = { eventType: 'save', timestamp: '2026-10-12T12:00:00.000Z', relativePath: 'src/app.ts', workspaceId: 'workspace-id' };
			const legacyLine = JSON.stringify(legacy) + '\n';
			const legacyPath = join(temporary, LEGACY_EVENT_LOG_FILENAME);
			await writeFile(legacyPath, legacyLine);
			assert.notStrictEqual(EVENT_LOG_FILENAME, LEGACY_EVENT_LOG_FILENAME);
			const writer = new JsonlWriter(join(temporary, EVENT_LOG_FILENAME));
			await assert.rejects(writer.write(legacy), EventValidationError);
			await writer.write(event());
			assert.strictEqual(await readFile(legacyPath, 'utf8'), legacyLine);
			assert.strictEqual(JSON.parse(await readFile(writer.filePath, 'utf8')).schemaVersion, SCHEMA_VERSION);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
});
