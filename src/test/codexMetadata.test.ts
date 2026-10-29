import * as assert from 'assert';
import { mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readSessionMetadata } from '../codexMetadata';

suite('Codex metadata reader privacy', () => {
	let temporary: string;
	let path: string;
	const payload = () => ({ id: randomUUID(), timestamp: '2026-10-13T10:00:00.000Z', cwd: join(tmpdir(), 'approved'), cli_version: '0.162.1' });
	setup(async () => { temporary = await mkdtemp(join(tmpdir(), 'metadata-test-')); path = join(temporary, 'candidate.jsonl'); });
	teardown(async () => { await rm(temporary, { recursive: true, force: true }); });

	test('reads exactly the metadata line without prefetching private subsequent bytes', async () => {
		const first = JSON.stringify({ timestamp: '2026-10-13T10:00:00.000Z', type: 'session_meta', payload: payload() }) + '\n';
		await writeFile(path, first + '{"type":"response_item","payload":{"text":"private conversation"}}\n');
		const handle = await open(path, 'r'); let count = 0;
		const wrapper = { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
			assert.strictEqual(length, 1); const result = await handle.read(buffer, offset, length, position); count += result.bytesRead; return result;
		} } as unknown as FileHandle;
		try {
			assert.strictEqual((await readSessionMetadata(wrapper, () => true)).kind, 'valid');
			assert.strictEqual(count, Buffer.byteLength(first));
		} finally { await handle.close(); }
	});

	test('accepts the observed ordinal header before type without reading beyond the metadata line', async () => {
		const data = payload(); const first = JSON.stringify({ timestamp: data.timestamp, ordinal: 0, type: 'session_meta', payload: data }) + '\n';
		await writeFile(path, first + '{"ordinal":1,"type":"response_item","payload":{"text":"dummy-private-content"}}\n');
		const handle = await open(path, 'r'); let count = 0;
		try {
			const wrapped = { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
				assert.equal(length, 1); const result = await handle.read(buffer, offset, length, position); count += result.bytesRead; return result;
			} } as unknown as FileHandle;
			const result = await readSessionMetadata(wrapped, () => true); assert.equal(result.kind, 'valid'); assert.equal(count, Buffer.byteLength(first));
			if (result.kind === 'valid') { assert.equal(result.metadata.sourceSessionId, data.id); assert.equal('ordinal' in result.metadata, false); }
		} finally { await handle.close(); }
	});
	test('ordinal is a bounded non-negative integer; duplicates, arbitrary values and unknown headers stay rejected', async () => {
		for (const value of ['-1', '1.5', '1e3', '01', '9007199254740992', '"dummy-secret"', '{}', 'null', 'true']) {
			await writeFile(path, '{"ordinal":' + value + ',"type":"session_meta","payload":' + JSON.stringify(payload()) + '}\n');
			const handle = await open(path, 'r'); try { assert.notEqual((await readSessionMetadata(handle, () => true)).kind, 'valid'); } finally { await handle.close(); }
		}
		for (const prefix of ['"ordinal":0,"ordinal":1,', '"untrusted":{},']) {
			await writeFile(path, '{' + prefix + '"type":"session_meta","payload":' + JSON.stringify(payload()) + '}\n');
			const handle = await open(path, 'r'); try { assert.notEqual((await readSessionMetadata(handle, () => true)).kind, 'valid'); } finally { await handle.close(); }
		}
	});
	test('ordinal does not authorize non-metadata payloads or searching subsequent records', async () => {
		const first = '{"timestamp":"2026-10-13T10:00:00.000Z","ordinal":0,"type":"response_item","payload":{"text":"dummy-private"}}\n';
		await writeFile(path, first + JSON.stringify({ ordinal: 1, type: 'session_meta', payload: payload() }) + '\n');
		const handle = await open(path, 'r'); let count = 0;
		try {
			const wrapped = { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
				const result = await handle.read(buffer, offset, length, position); count += result.bytesRead; return result;
			} } as unknown as FileHandle;
			assert.equal((await readSessionMetadata(wrapped, () => true)).kind, 'missing'); assert.ok(count < first.indexOf('payload'));
		} finally { await handle.close(); }
	});
	test('rejects non-metadata before reading its payload', async () => {
		const line = '{"type":"response_item","payload":{"text":"private"}}\n'; await writeFile(path, line);
		const handle = await open(path, 'r'); let count = 0;
		const wrapper = { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
			const result = await handle.read(buffer, offset, length, position); count += result.bytesRead; return result;
		} } as unknown as FileHandle;
		try {
			assert.strictEqual((await readSessionMetadata(wrapper, () => true)).kind, 'missing');
			assert.ok(count < line.indexOf('payload'));
		} finally { await handle.close(); }
	});

	test('handles Unicode cwd, envelope timestamp fallback and optional version safely', async () => {
		const values: Record<string, unknown> = { ...payload(), cwd: join(tmpdir(), '项目') };
		delete values.timestamp; values.cli_version = 'private-account@example.test';
		await writeFile(path, JSON.stringify({ timestamp: '2026-10-13T15:30:00+05:30', type: 'session_meta', payload: values }) + '\n');
		const handle = await open(path, 'r');
		try {
			const result = await readSessionMetadata(handle, () => true); assert.strictEqual(result.kind, 'valid');
			if (result.kind === 'valid') {
				assert.strictEqual(result.metadata.cwd, values.cwd);
				assert.strictEqual(result.metadata.createdAt, '2026-10-13T10:00:00.000Z');
				assert.strictEqual(result.metadata.codexVersion, undefined);
			}
		} finally { await handle.close(); }
	});

	test('does not search later records for missing metadata and rejects impossible dates', async () => {
		for (const first of ['{invalid}\n', '{}\n', JSON.stringify({ type: 'session_meta', payload: { ...payload(), timestamp: '2026-02-30T10:00:00.000Z' } }) + '\n']) {
			await writeFile(path, first + JSON.stringify({ type: 'session_meta', payload: payload() }) + '\n');
			const handle = await open(path, 'r');
			try { assert.notStrictEqual((await readSessionMetadata(handle, () => true)).kind, 'valid'); } finally { await handle.close(); }
		}
	});

	test('stops reading as soon as recording becomes inactive', async () => {
		await writeFile(path, JSON.stringify({ type: 'session_meta', payload: payload() }) + '\n');
		const handle = await open(path, 'r'); let checks = 0;
		try { assert.strictEqual((await readSessionMetadata(handle, () => ++checks < 20)).kind, 'stopped'); } finally { await handle.close(); }
	});
});
