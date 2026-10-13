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
