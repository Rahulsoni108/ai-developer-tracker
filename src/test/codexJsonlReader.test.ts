import { MemoryEventJournal } from './memoryEventJournal';
import * as assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RecordingController } from '../recording';
import { CodexSessionDiscovery } from '../codexSessionDiscovery';
import { CodexJsonlReader, type CodexReaderDiagnostic, type CodexReaderOptions, type CodexRecordMetadata } from '../codexJsonlReader';
import { CodexEventParser } from '../codexEventParser';
import { JsonlWriter } from '../jsonlWriter';
import { validateEvent, type CodexMessagePayload } from '../eventSchema';

suite('Incremental Codex JSONL reader', () => {
	let temporary: string;
	let root: string;
	let workspace: string;
	let startMs: number;
	let recording: RecordingController;
	let discovery: CodexSessionDiscovery;
	let reader: CodexJsonlReader;
	let records: Readonly<CodexRecordMetadata>[];
	let diagnostics: Readonly<CodexReaderDiagnostic>[];
	let capture: CodexEventParser | undefined;
	const privateText = 'PRIVATE_CONTENT_DO_NOT_EMIT';

	function record(type = 'event_msg', payloadType = 'user_message', timestamp: unknown = undefined): string {
		return JSON.stringify({ type, payload: { type: payloadType, message: privateText, arguments: privateText },
			...(timestamp !== undefined ? { timestamp } : {}) }) + '\n';
	}
	function registry() {
		return {
			getRegistry: () => discovery.getRegistry(),
			isConfirmed: discovery.isConfirmed.bind(discovery),
			openConfirmedSession: discovery.openConfirmedSession.bind(discovery),
			revalidateConfirmedSession: discovery.revalidateConfirmedSession.bind(discovery)
		};
	}
	async function configure(options: CodexReaderOptions = {}, source = registry(), waitForInitialTick = true): Promise<void> {
		reader?.dispose(); await reader?.flush();
		reader = new CodexJsonlReader(recording, source, {
			pollIntervalMs: 0, onRecord: entry => records.push(entry), onDiagnostic: issue => diagnostics.push(issue), ...options
		});
		if (waitForInitialTick) { await reader.flush(); }
	}
	async function session(body = '', confirm = true, ordinal = false) {
		const id = randomUUID();
		const path = join(root, id + '.jsonl');
		const metadata = { id, cwd: workspace, timestamp: new Date(startMs + 100).toISOString(), cli_version: '0.162.1' };
		const header = JSON.stringify({ timestamp: metadata.timestamp, ...(ordinal ? { ordinal: 0 } : {}), type: 'session_meta', payload: metadata }) + '\n';
		await writeFile(path, header + body);
		await discovery.scanNow();
		const entry = discovery.getRegistry().find(candidate => candidate.sourceSessionId === id)!;
		if (confirm) { assert.equal(await discovery.confirm(entry.sourceFileId), true); }
		return { id, path, metadata, header, fileId: entry.sourceFileId };
	}
	async function drain(path: string): Promise<void> {
		for (let count = 0; count < 100; count++) {
			await reader.readNow();
			const size = (await stat(path)).size;
			if (reader.getProgress().some(cursor => cursor.byteOffset === size)) { return; }
		}
		assert.fail('Reader did not drain within its bounded test ticks');
	}
	setup(async () => {
		temporary = await realpath(await mkdtemp(join(tmpdir(), 'codex-reader-test-')));
		root = join(temporary, 'sessions'); workspace = join(temporary, 'workspace');
		await mkdir(root); await mkdir(workspace);
		startMs = Date.now() - 1000;
		records = []; diagnostics = []; capture = undefined;
		recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} },
			async () => true, () => new Date(startMs));
		discovery = new CodexSessionDiscovery(recording, () => [{ path: workspace, workspaceId: 'approved' }], {
			sessionsDirectory: root, pollIntervalMs: 0, now: () => new Date(startMs + 10000)
		});
		await configure();
		await recording.start(); await discovery.flush(); await reader.flush();
	});
	teardown(async () => {
		recording.stop(); reader.dispose(); discovery.dispose();
		await reader.flush(); capture?.dispose(); await capture?.flush(); await discovery.flush(); recording.dispose();
		await rm(temporary, { recursive: true, force: true });
	});

	test('native prospective mode reads only the EOF delimiter before new authorized data and never replays a reset', async () => {
		const file = await session(record()); const end = (await stat(file.path)).size;
		const reads: { position: number; length: number }[] = []; let approved = false; let initialized = 0;
		const source = registry();
		await configure({ prospectiveOnly: true, canCaptureContent: () => approved, onInitialized: () => { initialized++; } }, {
			...source, openConfirmedSession: async id => {
				const opened = await source.openConfirmedSession(id); if (!opened) { return undefined; }
				const original = opened.handle;
				return { ...opened, handle: { stat: () => original.stat(), close: () => original.close(),
					read: async (buffer: Buffer, offset: number, length: number, position: number) => {
						reads.push({ position, length }); return original.read(buffer, offset, length, position);
					} } as unknown as FileHandle };
			}
		});
		assert.equal(reads.length, 0); assert.equal(initialized, 0);
		approved = true; await reader.readNow();
		assert.deepEqual(reads, [{ position: end - 1, length: 1 }]); assert.equal(initialized, 1); assert.equal(records.length, 0);
		await appendFile(file.path, record()); await reader.readNow();
		assert.equal(records.length, 1); assert.ok(reads.slice(2).every(r => r.position >= end));
		approved = false; reads.length = 0; await appendFile(file.path, record()); await reader.readNow();
		assert.equal(reads.length, 0); assert.equal(records.length, 1);
		approved = true; await writeFile(file.path, file.header); await reader.readNow();
		assert.ok(diagnostics.some(d => d.reason === 'stream_reset')); assert.equal(records.length, 1);
	});

	test('native permission withdrawal during async verification prevents subsequent content reads', async () => {
		const file = await session(record()); let approved = true; let withdraw = false; let reads = 0;
		const source = registry();
		await configure({ prospectiveOnly: true, canCaptureContent: () => approved }, {
			...source, openConfirmedSession: async id => {
				const opened = await source.openConfirmedSession(id); if (!opened) { return undefined; }
				const original = opened.handle;
				return { ...opened, verify: async () => { const valid = await opened.verify(); if (withdraw) { approved = false; } return valid; },
					handle: { stat: () => original.stat(), close: () => original.close(),
						read: async (buffer: Buffer, offset: number, length: number, position: number) => { reads++; return original.read(buffer, offset, length, position); }
					} as unknown as FileHandle };
			}
		});
		reads = 0; withdraw = true; await appendFile(file.path, record()); await reader.readNow();
		// One bounded anchor integrity check can precede the await; no appended evidence is read.
		assert.ok(reads <= 1); assert.equal(records.length, 0);
	});

	test('reads a single confirmed record and emits only safe metadata', async () => {
		const file = await session();
		await reader.readNow();
		assert.deepEqual(records, [{
			sourceSessionId: file.id, recordIndex: 1, eventType: 'session_meta', payloadType: null,
			timestamp: file.metadata.timestamp
		}]);
		assert.equal(reader.getProgress()[0].byteOffset, Buffer.byteLength(file.header));
		assert.ok(Object.isFrozen(records[0]));
		assert.ok(!JSON.stringify(records).includes(workspace));
	});

	test('ordinal journals remain unread until confirmed and then retain incremental ordering without diagnostic content', async () => {
		const file = await session(record(), false, true); await reader.readNow(); assert.equal(records.length, 0);
		assert.equal(await discovery.confirm(file.fileId), true); await reader.readNow();
		assert.deepEqual(records.map(entry => entry.eventType), ['session_meta', 'event_msg']);
		assert.deepEqual(records.map(entry => entry.recordIndex), [1, 2]);
		assert.equal(JSON.stringify(records).includes(privateText), false); assert.equal(JSON.stringify(records).includes(workspace), false);
		await reader.readNow(); assert.equal(records.length, 2);
	});
	test('reads multiple appends in file order and advances byte offsets', async () => {
		const file = await session(); await reader.readNow();
		const firstOffset = reader.getProgress()[0].byteOffset;
		const body = record() + record('response_item', 'message', '2026-10-13T12:00:00+05:30');
		await appendFile(file.path, body); await reader.readNow();
		assert.deepEqual(records.map(entry => entry.recordIndex), [1, 2, 3]);
		assert.deepEqual(records.map(entry => entry.eventType), ['session_meta', 'event_msg', 'response_item']);
		assert.equal(records[2].timestamp, '2026-10-13T06:30:00.000Z');
		assert.equal(reader.getProgress()[0].byteOffset, firstOffset + Buffer.byteLength(body));
	});

	test('buffers an incomplete line until a newline completes it, including split UTF-8', async () => {
		await configure({ chunkBytes: 7 });
		const file = await session(); await reader.readNow();
		const bytes = Buffer.from(JSON.stringify({ type: 'response_item', payload: { type: 'message', text: '项目 ' + privateText } }) + '\n');
		const split = bytes.indexOf(Buffer.from('项目')) + 1;
		await appendFile(file.path, bytes.subarray(0, split)); await reader.readNow();
		assert.equal(records.length, 1); assert.ok(reader.getProgress()[0].bufferedBytes > 0);
		await appendFile(file.path, bytes.subarray(split, bytes.length - 1)); await reader.readNow();
		assert.equal(records.length, 1);
		await appendFile(file.path, '\n'); await reader.readNow();
		assert.equal(records.length, 2); assert.equal(records[1].recordIndex, 2);
		assert.equal(reader.getProgress()[0].bufferedBytes, 0);
	});

	test('skips invalid JSON, primitives, arrays and missing type without losing later records', async () => {
		const file = await session('{bad private JSON}\n42\n[]\n{"payload":{"text":"secret"}}\n\n' + record());
		await reader.readNow();
		assert.deepEqual(records.map(entry => entry.recordIndex), [1, 7]);
		assert.equal(diagnostics.filter(issue => issue.reason === 'invalid_record').length, 4);
		assert.ok(!JSON.stringify(diagnostics).includes('secret'));
		await reader.readNow();
		assert.equal(diagnostics.filter(issue => issue.reason === 'invalid_record').length, 4);
		assert.equal((await stat(file.path)).size, reader.getProgress()[0].byteOffset);
	});

	test('rejects malformed UTF-8 while preserving a following valid record', async () => {
		const file = await session();
		await appendFile(file.path, Buffer.concat([Buffer.from('{"type":"'), Buffer.from([0xff]), Buffer.from('"}\n' + record())]));
		await reader.readNow();
		assert.deepEqual(records.map(entry => entry.recordIndex), [1, 3]);
		assert.ok(diagnostics.some(issue => issue.reason === 'invalid_record'));
	});

	test('coalesces concurrent reads and never duplicates unchanged records', async () => {
		const file = await session(record());
		await Promise.all([reader.readNow(), reader.readNow(), reader.readNow()]);
		await reader.readNow(); await reader.readNow();
		assert.deepEqual(records.map(entry => entry.recordIndex), [1, 2]);
		await appendFile(file.path, record());
		await Promise.all([reader.readNow(), reader.readNow()]);
		assert.deepEqual(records.map(entry => entry.recordIndex), [1, 2, 3]);
	});

	test('does not deduplicate legitimately repeated appended records', async () => {
		const file = await session(record()); await reader.readNow();
		await appendFile(file.path, record()); await reader.readNow();
		assert.deepEqual(records.map(entry => entry.recordIndex), [1, 2, 3]);
	});

	test('reads only appended bytes plus a small boundary check, and performs no reads when idle', async () => {
		const reads: { position: number; length: number }[] = [];
		const source = registry();
		await configure({}, { ...source, openConfirmedSession: async id => {
			const opened = await source.openConfirmedSession(id);
			if (!opened) { return undefined; }
			const original = opened.handle;
			return { ...opened, handle: {
				stat: () => original.stat(), close: () => original.close(),
				read: async (buffer: Buffer, offset: number, length: number, position: number) => {
					reads.push({ position, length }); return original.read(buffer, offset, length, position);
				}
			} as unknown as FileHandle };
		} });
		const file = await session(record()); await reader.readNow();
		const previousEnd = reader.getProgress()[0].byteOffset;
		reads.length = 0;
		await reader.readNow();
		assert.equal(reads.length, 0);
		await appendFile(file.path, record()); await reader.readNow();
		assert.equal(reads[0].position + reads[0].length, previousEnd);
		assert.ok(reads[0].length <= 64);
		assert.ok(reads.slice(1).every(read => read.position >= previousEnd));
		assert.equal(reads.slice(1).reduce((sum, read) => sum + read.length, 0), Buffer.byteLength(record()));
	});

	test('continues a large backlog over bounded ticks instead of rereading the file', async () => {
		await configure({ chunkBytes: 32, maxBytesPerSessionTick: 64, maxBytesPerTick: 64 });
		const file = await session(record() + record());
		await reader.readNow();
		assert.equal(reader.getProgress()[0].byteOffset, 64);
		await drain(file.path);
		assert.deepEqual(records.map(entry => entry.recordIndex), [1, 2, 3]);
	});

	test('handles truncation by revalidating identity, discarding partial data and recording a reset', async () => {
		const file = await session(record() + '{"type":"event_msg","payload":'); await reader.readNow();
		await writeFile(file.path, file.header + record('response_item', 'message'));
		await reader.readNow();
		assert.deepEqual(records.map(entry => entry.recordIndex), [1, 2, 3, 4]);
		assert.equal(records[3].payloadType, 'message');
		assert.ok(diagnostics.some(issue => issue.reason === 'stream_reset'));
		assert.equal(reader.getProgress()[0].bufferedBytes, 0);
	});

	test('detects truncate-and-regrow between polls using a bounded boundary fingerprint', async () => {
		const file = await session(record()); await reader.readNow();
		await writeFile(file.path, file.header + record('response_item', 'message') + record() + record());
		await reader.readNow();
		assert.deepEqual(records.map(entry => entry.recordIndex), [1, 2, 3, 4, 5, 6]);
		assert.ok(diagnostics.some(issue => issue.reason === 'stream_reset'));
	});

	test('does not read a rewritten file with a different source session identity', async () => {
		const file = await session(record()); await reader.readNow();
		records = [];
		const header = JSON.stringify({ type: 'session_meta', payload: { ...file.metadata, id: randomUUID() } }) + '\n';
		await writeFile(file.path, header + record('response_item', 'message'));
		await reader.readNow();
		assert.deepEqual(records, []);
		assert.equal(discovery.getRegistry()[0].status, 'ambiguous');
	});

	test('requires fresh confirmation for replacement and then safely starts the new file generation', async () => {
		const file = await session(record()); await reader.readNow();
		const replacement = join(root, 'replacement.tmp');
		await writeFile(replacement, file.header + record('response_item', 'message'));
		await rename(replacement, file.path);
		await reader.readNow();
		assert.equal(records.length, 2);
		assert.equal(discovery.getRegistry()[0].status, 'ambiguous');
		await discovery.scanNow();
		assert.equal(await discovery.confirm(file.fileId), true);
		await reader.readNow();
		assert.deepEqual(records.map(entry => entry.recordIndex), [1, 2, 3, 4]);
		assert.ok(diagnostics.some(issue => issue.reason === 'stream_reset'));
	});

	test('retains the offset while the original file is temporarily unavailable', async () => {
		const file = await session(); await reader.readNow();
		const parked = join(temporary, 'temporarily-missing.jsonl');
		await rename(file.path, parked); await reader.readNow();
		assert.equal(discovery.getRegistry()[0].status, 'confirmed');
		assert.ok(diagnostics.some(issue => issue.reason === 'file_unavailable'));
		await reader.readNow();
		assert.equal(diagnostics.filter(issue => issue.reason === 'file_unavailable').length, 1);
		await rename(parked, file.path); await appendFile(file.path, record()); await reader.readNow();
		assert.deepEqual(records.map(entry => entry.recordIndex), [1, 2]);
	});

	test('discards oversized records across polls and recovers at the next newline', async () => {
		await configure({ maxRecordBytes: 512, chunkBytes: 64, maxBytesPerSessionTick: 1024 });
		const oversized = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', text: privateText.repeat(200) } });
		const file = await session(oversized);
		await drain(file.path);
		assert.equal(records.length, 1); assert.equal(reader.getProgress()[0].bufferedBytes, 0);
		assert.equal(diagnostics.filter(issue => issue.reason === 'record_too_large').length, 1);
		await appendFile(file.path, '\n' + record()); await reader.readNow();
		assert.deepEqual(records.map(entry => entry.recordIndex), [1, 3]);
		assert.ok(!JSON.stringify(diagnostics).includes(privateText));
	});

	test('bounds total partial-line memory across confirmed sessions', async () => {
		await configure({ maxRecordBytes: 1024, maxBufferedBytes: 512, chunkBytes: 128 });
		const partial = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', text: 'x'.repeat(350) } });
		const first = await session(partial); const second = await session(partial);
		await reader.readNow();
		assert.ok(reader.getProgress().reduce((sum, cursor) => sum + cursor.bufferedBytes, 0) <= 512);
		assert.ok(diagnostics.some(issue => issue.reason === 'memory_limit'));
		await appendFile(first.path, '\n'); await appendFile(second.path, '\n'); await reader.readNow();
		assert.equal(records.filter(entry => entry.recordIndex === 2).length, 1);
		assert.ok(reader.getProgress().every(cursor => cursor.bufferedBytes === 0));
	});

	test('tracks independent offsets and order for multiple confirmed sessions fairly', async () => {
		await configure({ maxBytesPerSessionTick: 256, maxBytesPerTick: 256 });
		const first = await session(record() + record());
		const second = await session(record('response_item', 'message'));
		for (let index = 0; index < 10; index++) { await reader.readNow(); }
		assert.deepEqual(records.filter(entry => entry.sourceSessionId === first.id).map(entry => entry.recordIndex), [1, 2, 3]);
		assert.deepEqual(records.filter(entry => entry.sourceSessionId === second.id).map(entry => entry.recordIndex), [1, 2]);
		await appendFile(second.path, record()); await reader.readNow(); await reader.readNow();
		assert.equal(records.filter(entry => entry.sourceSessionId === second.id).length, 3);
	});

	test('preserves an existing confirmation when its file appends and discovery finds a new session', async () => {
		const first = await session(); await reader.readNow();
		await appendFile(first.path, record());
		const second = await session();
		assert.equal(discovery.getRegistry().find(entry => entry.sourceFileId === first.fileId)?.status, 'confirmed');
		await reader.readNow();
		assert.deepEqual(records.filter(entry => entry.sourceSessionId === first.id).map(entry => entry.recordIndex), [1, 2]);
		assert.equal(records.filter(entry => entry.sourceSessionId === second.id).length, 1);
	});

	test('never opens eligible, ambiguous, rejected or unrelated session files', async () => {
		let opened = 0;
		const source = registry();
		await configure({}, { ...source, openConfirmedSession: async id => { opened++; return source.openConfirmedSession(id); } });
		const eligible = await session(record(), false); await reader.readNow();
		assert.equal(opened, 0); assert.deepEqual(records, []);
		const ambiguous = await session(record(), false); await reader.readNow();
		assert.ok(discovery.getRegistry().every(entry => entry.status === 'ambiguous'));
		discovery.reject(eligible.fileId); discovery.reject(ambiguous.fileId);
		await reader.readNow();
		assert.equal(opened, 0);
		await writeFile(join(root, 'unrelated.jsonl'), JSON.stringify({ type: 'session_meta', payload: {
			id: randomUUID(), cwd: temporary, timestamp: new Date(startMs + 100).toISOString()
		} }) + '\n' + record());
		await discovery.scanNow(); await reader.readNow();
		assert.equal(opened, 0); assert.deepEqual(records, []);
	});

	test('stops immediately, clears private partial buffers and does not reuse old confirmation', async () => {
		const file = await session('{"type":"response_item","payload":'); await reader.readNow();
		assert.ok(reader.getProgress()[0].bufferedBytes > 0);
		recording.stop();
		assert.deepEqual(reader.getProgress(), []);
		await appendFile(file.path, '{"type":"message"}}\n' + record()); await reader.readNow();
		assert.equal(records.length, 1);
		startMs += 20000;
		await recording.start(); await discovery.flush(); await reader.flush(); await reader.readNow();
		assert.equal(records.length, 1);
		assert.deepEqual(reader.getProgress(), []);
	});

	test('ignores an in-flight read completed after recording stops and closes its handle', async () => {
		await session(record());
		let release!: () => void; let reached!: () => void; let closed = false;
		const gate = new Promise<void>(done => { release = done; });
		const reading = new Promise<void>(done => { reached = done; });
		const source = registry();
		await configure({}, { ...source, openConfirmedSession: async id => {
			const opened = await source.openConfirmedSession(id);
			if (!opened) { return undefined; }
			const original = opened.handle;
			return { ...opened, handle: {
				stat: () => original.stat(),
				close: async () => { closed = true; await original.close(); },
				read: async (buffer: Buffer, offset: number, length: number, position: number) => {
					reached(); await gate; return original.read(buffer, offset, length, position);
				}
			} as unknown as FileHandle };
		} }, false);
		await reading;
		recording.stop();
		release();
		await reader.flush();
		assert.equal(closed, true);
		assert.deepEqual(records, []);
		assert.deepEqual(reader.getProgress(), []);
	});

	test('removes revoked confirmation before reading another append', async () => {
		const file = await session(record()); await reader.readNow();
		discovery.reject(file.fileId);
		await appendFile(file.path, record()); await reader.readNow();
		assert.equal(records.length, 2); assert.deepEqual(reader.getProgress(), []);
	});

	test('rejects an in-flight record when confirmation is revoked before its read completes', async () => {
		const file = await session(record());
		let release!: () => void; let reached!: () => void;
		const gate = new Promise<void>(done => { release = done; });
		const reading = new Promise<void>(done => { reached = done; });
		const source = registry();
		await configure({}, { ...source, openConfirmedSession: async id => {
			const opened = await source.openConfirmedSession(id);
			if (!opened) { return undefined; }
			const original = opened.handle;
			return { ...opened, handle: {
				stat: () => original.stat(), close: () => original.close(),
				read: async (buffer: Buffer, offset: number, length: number, position: number) => {
					reached(); await gate; return original.read(buffer, offset, length, position);
				}
			} as unknown as FileHandle };
		} }, false);
		await reading;
		discovery.reject(file.fileId);
		release(); await reader.flush(); await reader.readNow();
		assert.deepEqual(records, []);
		assert.deepEqual(reader.getProgress(), []);
	});

	test('does not restore or read previous confirmations after extension restart', async () => {
		const file = await session(record()); await reader.readNow();
		reader.dispose(); discovery.dispose(); await reader.flush(); await discovery.flush(); recording.dispose();
		recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true);
		discovery = new CodexSessionDiscovery(recording, () => [{ path: workspace, workspaceId: 'approved' }], {
			sessionsDirectory: root, pollIntervalMs: 0
		});
		await configure();
		await reader.readNow();
		await recording.start(); await discovery.flush(); await reader.flush(); await reader.readNow();
		assert.equal(records.length, 2); assert.deepEqual(reader.getProgress(), []);
		assert.equal(discovery.getRegistry().find(entry => entry.sourceFileId === file.fileId)?.status, 'rejected');
	});

	test('does not follow a symlink substituted for a confirmed file', async () => {
		const file = await session(); await reader.readNow();
		const unrelated = join(temporary, 'unrelated-private.jsonl');
		await writeFile(unrelated, file.header + record());
		await rm(file.path); await symlink(unrelated, file.path);
		await reader.readNow();
		assert.equal(records.length, 1);
		assert.equal(discovery.getRegistry()[0].status, 'ambiguous');
	});

	test('sanitizes arbitrary type values and timestamps without exposing private strings', async () => {
		await session(record(privateText, privateText, privateText) + record('response_item', 'message', '2026-02-30T00:00:00Z'));
		await reader.readNow();
		assert.equal(records[1].eventType, 'unknown'); assert.equal(records[1].payloadType, 'unknown');
		assert.equal(records[1].timestamp, undefined); assert.equal(records[2].timestamp, undefined);
		assert.ok(!JSON.stringify(records).includes(privateText));
		assert.ok(!JSON.stringify(diagnostics).includes(temporary));
	});

	test('continues after a record consumer fails without replaying the delivered line', async () => {
		let calls = 0;
		await configure({ onRecord: () => { calls++; if (calls === 2) { throw new Error(privateText); } } });
		await session(record() + record()); await reader.readNow(); await reader.readNow();
		assert.equal(calls, 3); assert.ok(diagnostics.some(issue => issue.reason === 'delivery_failed'));
		assert.ok(!JSON.stringify(diagnostics).includes(privateText));
	});

	test('validates safety limits before registering any recording listener', () => {
		for (const options of [{ chunkBytes: 0 }, { maxRecordBytes: 2097152 }, { maxBufferedBytes: 33554432 }, { pollIntervalMs: -1 }]) {
			assert.throws(() => new CodexJsonlReader(recording, discovery, options));
		}
	});

	test('integrates confirmed discovery, incremental reading and normalized local capture with byte references', async () => {
		const log = new MemoryEventJournal(join(temporary, 'events.v1.jsonl'));
		capture = new CodexEventParser(recording, discovery, log);
		capture.grantContentConsent(recording.sessionId!);
		await configure({ canCaptureContent: entry => capture!.canCapture(entry), onSourceRecord: (value, reference) => capture!.handle(value, reference) });
		const prompt = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
			content: [{ type: 'input_text', text: 'Dummy assessment prompt' }] } }) + '\n';
		const mirror = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Dummy assessment prompt' } }) + '\n';
		const response = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant',
			content: [{ type: 'output_text', text: 'Dummy assessment response' }] } }) + '\n';
		const file = await session(prompt + mirror);
		await reader.readNow(); await appendFile(file.path, response); await reader.readNow();
		await capture.flush();
		const stored = log.captured;
		assert.deepEqual(stored.map(event => event.eventType), ['ai.prompt.submitted', 'ai.response.completed']);
		assert.ok(stored.every(event => validateEvent(event).valid));
		assert.equal((stored[0].payload as CodexMessagePayload).sourceRecord.byteOffset, Buffer.byteLength(file.header));
		assert.equal((stored[0].payload as CodexMessagePayload).sourceRecord.byteLength, Buffer.byteLength(prompt));
		assert.equal((stored[1].payload as CodexMessagePayload).sourceRecord.byteOffset, Buffer.byteLength(file.header + prompt + mirror));
		assert.ok(!JSON.stringify(records).includes('Dummy assessment'));
	});

	test('does not deliver raw records or create a conversation log without content consent', async () => {
		const log = new MemoryEventJournal(join(temporary, 'events.v1.jsonl'));
		capture = new CodexEventParser(recording, discovery, log);
		let delivered = 0;
		await configure({ canCaptureContent: entry => capture!.canCapture(entry), onSourceRecord: async (value, reference) => {
			delivered++; await capture!.handle(value, reference);
		} });
		const file = await session(record());
		await reader.readNow();
		assert.equal(delivered, 0); await assert.rejects(stat(log.filePath), { code: 'ENOENT' });
		capture.grantContentConsent(recording.sessionId!);
		await appendFile(file.path, record()); await reader.readNow();
		assert.equal(delivered, 1);
		const stored = log.captured[0];
		assert.equal(stored.eventType, 'ai.prompt.submitted'); assert.equal(stored.payload.sourceRecord.recordIndex, 3);
	});

	test('awaits content persistence and prevents a later record from being admitted after Stop', async () => {
		const log = new MemoryEventJournal(join(temporary, 'events.v1.jsonl'));
		let release!: () => void; let reached!: () => void;
		const gate = new Promise<void>(done => { release = done; });
		const writing = new Promise<void>(done => { reached = done; });
		capture = new CodexEventParser(recording, discovery, {
			write: async event => { reached(); await gate; await log.write(event); },
			flush: () => log.flush()
		});
		capture.grantContentConsent(recording.sessionId!);
		await configure({ canCaptureContent: entry => capture!.canCapture(entry), onSourceRecord: (value, reference) => capture!.handle(value, reference) });
		await session(record() + record('event_msg', 'agent_message'));
		const reading = reader.readNow();
		await writing; recording.stop(); release(); await reading; await capture.flush();
		const stored = log.captured;
		assert.equal(stored.length, 1); assert.equal((stored[0].payload as CodexMessagePayload).text, privateText);
		assert.equal(capture.hasContentConsent(stored[0].sessionId), false);
	});
});
