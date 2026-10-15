import { eventDiagnostic, type SafeEventDiagnostic } from '../jsonlWriter';
import * as assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { EvidenceCipher, EvidenceEncryptionError, type EncryptedEvidence, type EncryptionKeys } from '../evidenceEncryption';
import { EVIDENCE_KEY_SECRET, supplyEvidenceKeys, type EvidenceSecretStorage } from '../evidenceKeyStorage';
import { createCodexEvent, type TrackerEvent } from '../eventSchema';
import { EventPersistence } from '../eventPersistence';
import { JsonlWriter } from '../jsonlWriter';
import { LOCAL_QUEUE_FILENAME, LocalEventQueue, LocalEventQueueError } from '../localEventQueue';

class Secrets implements EvidenceSecretStorage {
	readonly values = new Map<string, string>();
	stores = 0;
	async get(name: string) { return this.values.get(name); }
	async store(name: string, value: string) { this.stores++; this.values.set(name, value); }
}
const dummyContent = 'dummy private conversation and source code: const value = 7;';
const input = () => createCodexEvent({ sessionId: randomUUID(), workspaceId: 'workspace', sourceSessionId: 'confirmed-source',
	correlationId: 'turn-1', eventType: 'ai.prompt.submitted', payload: { text: dummyContent,
		sourceRecord: { sourceFileReference: 'codex-file:' + 'a'.repeat(64), recordIndex: 1, generation: 0, byteOffset: 0, byteLength: 200, recordType: 'event_msg' } } });
function material(keyId: string = randomUUID()): EncryptionKeys {
	const bytes = new ArrayBuffer(32); new Uint8Array(bytes).set(randomBytes(32));
	return { activeKeyId: keyId, keys: [{ keyId, bytes }] };
}
function safeFailure(code: string) {
	return (error: unknown) => {
		assert.ok(error instanceof LocalEventQueueError); assert.equal(error.code, code);
		assert.equal(error.cause, undefined); assert.ok(!/dummy|PRIVATE|const value/.test(error.message)); return true;
	};
}

suite('Authenticated evidence encryption', () => {
	test('round-trips AES-256-GCM with fresh 96-bit nonces and full 128-bit tags', () => {
		const keys = material(); const cipher = new EvidenceCipher(keys); const event = input();
		try {
			assert.ok(new Uint8Array(keys.keys[0].bytes).every(byte => byte === 0));
			const nonces = new Set<string>();
			for (let index = 0; index < 100; index++) {
				const encrypted = cipher.encrypt(event.eventId, JSON.stringify(event));
				assert.equal(encrypted.encryptionVersion, 1); assert.equal(encrypted.algorithm, 'AES-256-GCM');
				assert.equal(Buffer.from(encrypted.nonce, 'base64').length, 12); assert.equal(Buffer.from(encrypted.tag, 'base64').length, 16);
				assert.equal(nonces.has(encrypted.nonce), false); nonces.add(encrypted.nonce);
				assert.deepEqual(cipher.decrypt(event.eventId, encrypted), event);
			}
		} finally { cipher.dispose(); }
	});

	test('authenticates event ID, algorithm, version, key ID, nonce, ciphertext and tag', () => {
		const cipher = new EvidenceCipher(material()); const event = input(); const original = cipher.encrypt(event.eventId, JSON.stringify(event));
		try {
			for (const field of ['nonce', 'ciphertext', 'tag'] as const) {
				const bytes = Buffer.from(original[field], 'base64'); bytes[0] ^= 1;
				assert.throws(() => cipher.decrypt(event.eventId, { ...original, [field]: bytes.toString('base64') }), EvidenceEncryptionError);
			}
			for (const changed of [{ ...original, encryptionVersion: 2 }, { ...original, algorithm: 'AES-128-GCM' },
				{ ...original, keyId: randomUUID() }, { ...original, extra: 'dummy private contents' }]) {
				assert.throws(() => cipher.decrypt(event.eventId, changed), EvidenceEncryptionError);
			}
			assert.throws(() => cipher.decrypt(randomUUID(), original), EvidenceEncryptionError);
		} finally { cipher.dispose(); }
	});

	test('wrong key material cannot produce plaintext and errors carry no content or cause', () => {
		const keys = material(); const right = new EvidenceCipher(keys); const wrong = new EvidenceCipher(material(keys.activeKeyId)); const event = input();
		try {
			const encrypted = right.encrypt(event.eventId, JSON.stringify(event));
			assert.throws(() => wrong.decrypt(event.eventId, encrypted), error => {
				assert.ok(error instanceof EvidenceEncryptionError); assert.equal(error.code, 'authentication_failed');
				assert.equal(error.message, 'Local evidence encryption failed.'); assert.equal(error.cause, undefined); return true;
			});
		} finally { right.dispose(); wrong.dispose(); }
	});

	test('rejects invalid key length, malformed envelopes, invalid Base64 and unauthenticated JSON', () => {
		assert.throws(() => new EvidenceCipher({ activeKeyId: randomUUID(), keys: [{ keyId: randomUUID(), bytes: new ArrayBuffer(31) }] }), EvidenceEncryptionError);
		const cipher = new EvidenceCipher(material()); const id = randomUUID(); const encrypted = cipher.encrypt(id, '{"private":"dummy"');
		try {
			for (const changed of [null, {}, { ...encrypted, nonce: 'bad' }, { ...encrypted, tag: '=' },
				{ ...encrypted, ciphertext: '@@@@' }, encrypted]) { assert.throws(() => cipher.decrypt(id, changed), EvidenceEncryptionError); }
		} finally { cipher.dispose(); }
	});
});

suite('Encrypted SQLite queue and SecretStorage', () => {
	let root: string;
	let secrets: Secrets;
	let queues: AsyncLocalEventQueue[];
	const storage = () => ({ scheme: 'file', fsPath: root });
	const path = () => join(root, LOCAL_QUEUE_FILENAME);
	async function open() { const queue = await AsyncLocalEventQueue.open(storage(), [], {}, secrets); queues.push(queue); return queue; }
	function stored() {
		const database = new DatabaseSync(path());
		try { return database.prepare('SELECT event_id, event_json, payload_format, acknowledged FROM queued_events ORDER BY sequence').all(); }
		finally { database.close(); }
	}
	setup(async () => { root = await mkdtemp(join(tmpdir(), 'ai-encrypted-')); secrets = new Secrets(); queues = []; });
	teardown(async () => { for (const queue of queues) { await queue.close(); } await rm(root, { recursive: true, force: true }); });

	test('stores only ciphertext for new events, including in SQLite WAL, without persisting key material', async () => {
		const queue = await open(); const event = input(); await queue.enqueue(event);
		assert.deepEqual(await queue.getPending(10), [event]); assert.equal(stored()[0].payload_format, 1);
		const envelope = JSON.parse(String(stored()[0].event_json)) as EncryptedEvidence;
		assert.equal(envelope.encryptionVersion, 1); assert.ok(!String(stored()[0].event_json).includes(dummyContent));
		const ring = JSON.parse((await secrets.get(EVIDENCE_KEY_SECRET))!);
		for (const suffix of ['', '-wal', '-shm', '-journal']) {
			const bytes = await readFile(path() + suffix).catch(() => Buffer.alloc(0));
			assert.equal(bytes.includes(Buffer.from(dummyContent)), false);
			assert.equal(bytes.includes(Buffer.from(ring.keys[0].key)), false);
		}
		assert.equal(secrets.stores, 1);
	});

	test('restart preserves IDs, sessions, ordering, deduplication and acknowledgment tombstones', async () => {
		let queue = await open(); const events = [input(), input()];
		await queue.enqueue(events[0]); await queue.enqueue(events[1]); await queue.enqueue(events[0]);
		await queue.markAcknowledged([events[0].eventId]); await queue.close(); queue = await open();
		await queue.enqueue(events[0]); assert.deepEqual(await queue.getPending(10), [events[1]]);
		assert.equal(await queue.getPendingCount(), 1); assert.equal(stored()[0].event_json, null); assert.equal(secrets.stores, 1);
	});

	test('missing keys block reopen and are never regenerated, including after all payloads are acknowledged', async () => {
		const queue = await open(); const event = input(); await queue.enqueue(event); await queue.close();
		secrets.values.clear(); const writes = secrets.stores;
		await assert.rejects(open(), safeFailure('key_missing')); assert.equal(secrets.stores, writes);
		const database = new DatabaseSync(path());
		try { database.prepare('UPDATE queued_events SET acknowledged = 1, event_json = NULL').run(); } finally { database.close(); }
		await assert.rejects(open(), safeFailure('key_missing')); assert.equal(secrets.stores, writes);
	});

	test('damaged encryption markers never trigger replacement key creation', async () => {
		const queue = await open(); await queue.enqueue(input()); await queue.close(); const writes = secrets.stores;
		const database = new DatabaseSync(path());
		try { database.exec('DELETE FROM queue_encryption_keys; UPDATE queued_events SET payload_format = 0;'); } finally { database.close(); }
		secrets.values.clear(); await assert.rejects(open(), safeFailure('corrupt')); assert.equal(secrets.stores, writes);
	});

	test('wrong, malformed or incomplete keyrings fail safely without replacing keys or records', async () => {
		const queue = await open(); await queue.enqueue(input()); await queue.close(); const before = stored();
		const saved = (await secrets.get(EVIDENCE_KEY_SECRET))!; const ring = JSON.parse(saved);
		ring.keys[0].key = randomBytes(32).toString('base64'); secrets.values.set(EVIDENCE_KEY_SECRET, JSON.stringify(ring));
		await assert.rejects(open(), safeFailure('authentication_failed'));
		secrets.values.set(EVIDENCE_KEY_SECRET, 'PRIVATE INVALID KEYRING'); await assert.rejects(open(), safeFailure('key_invalid'));
		ring.keys[0].keyId = randomUUID(); ring.activeKeyId = ring.keys[0].keyId;
		secrets.values.set(EVIDENCE_KEY_SECRET, JSON.stringify(ring)); await assert.rejects(open(), safeFailure('key_missing'));
		assert.deepEqual(stored(), before); assert.equal(secrets.stores, 1);
		secrets.values.set(EVIDENCE_KEY_SECRET, saved); assert.equal(await (await open()).getPendingCount(), 1);
	});

	test('unavailable SecretStorage and failed write/readback never enable plaintext collection', async () => {
		await assert.rejects(AsyncLocalEventQueue.open(storage(), []), safeFailure('key_storage_unavailable'));
		for (const backend of [
			{ get: async () => { throw new Error('PRIVATE KEYCHAIN ERROR'); }, store: async () => {} },
			{ get: async () => undefined, store: async () => { throw new Error('PRIVATE KEYCHAIN ERROR'); } },
			{ get: async () => undefined, store: async () => {} }
		]) { await assert.rejects(AsyncLocalEventQueue.open(storage(), [], {}, backend), safeFailure('key_storage_unavailable')); }
		const database = new DatabaseSync(path());
		try { assert.equal(database.prepare('SELECT COUNT(*) AS count FROM queued_events').get()?.count, 0); } finally { database.close(); }
	});

	test('direct legacy queue access cannot enqueue new plaintext without keys', async () => {
		const queue = await LocalEventQueue.open(storage(), []);
		try { await assert.rejects(queue.enqueue(input()), safeFailure('key_storage_unavailable')); assert.equal(await queue.getPendingCount(), 0); }
		finally { await queue.close(); }
	});

	test('tampered encrypted payloads and indexing metadata fail authentication without a plaintext fallback', async () => {
		const queue = await open(); const event = input(); await queue.enqueue(event);
		const database = new DatabaseSync(path()); const original = stored()[0].event_json;
		try {
			database.prepare('UPDATE queued_events SET event_id = ?').run(randomUUID());
			await assert.rejects(queue.getPending(10), safeFailure('authentication_failed'));
			database.prepare('UPDATE queued_events SET event_id = ?, event_json = ?').run(event.eventId, JSON.stringify(event));
			await assert.rejects(queue.getPending(10), safeFailure('authentication_failed'));
			database.prepare('UPDATE queued_events SET event_json = ?, payload_format = 0').run(original!);
			await assert.rejects(queue.getPending(10), safeFailure('corrupt'));
			database.prepare('UPDATE queued_events SET payload_format = 1').run();
			assert.deepEqual(await queue.getPending(10), [event]);
		} finally { database.close(); }
	});

	test('worker interruption recovers encrypted committed events and interrupted sessions', async () => {
		const queue = await open(); const event = input(); await queue.beginSession(event.sessionId); await queue.enqueue(event);
		await (queue as unknown as { worker: Worker }).worker.terminate(); await queue.close();
		const recovered = await open(); assert.deepEqual(await recovered.getPending(10), [event]); await recovered.enqueue(event);
		assert.equal(await recovered.getPendingCount(), 1); assert.equal((await recovered.getRecordingSessions())[0].status, 'interrupted');
	});

	test('reads mixed historical plaintext and new ciphertext without rewriting old records', async () => {
		const legacy = input(); const original = JSON.stringify(legacy); const database = new DatabaseSync(path());
		database.exec(`CREATE TABLE queued_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
			event_json TEXT, acknowledged INTEGER NOT NULL DEFAULT 0) STRICT;
			CREATE INDEX pending_events ON queued_events(sequence) WHERE acknowledged = 0; PRAGMA user_version = 1;`);
		database.prepare('INSERT INTO queued_events(event_id, event_json) VALUES (?, ?)').run(legacy.eventId, original); database.close();
		const queue = await open(); const next = input(); await queue.enqueue(next);
		assert.deepEqual(await queue.getPending(10), [legacy, next]); assert.equal(stored()[0].event_json, original);
		assert.equal(stored()[0].payload_format, 0); assert.equal(stored()[1].payload_format, 1);
	});

	test('versioned key identifiers support reading older keys while a different active key encrypts new events', async () => {
		let queue = await open(); const first = input(); await queue.enqueue(first); await queue.close();
		const ring = JSON.parse((await secrets.get(EVIDENCE_KEY_SECRET))!); const oldId = ring.activeKeyId;
		ring.activeKeyId = randomUUID(); ring.keys.push({ keyId: ring.activeKeyId, key: randomBytes(32).toString('base64') });
		secrets.values.set(EVIDENCE_KEY_SECRET, JSON.stringify(ring)); queue = await open(); const next = input(); await queue.enqueue(next);
		assert.deepEqual(await queue.getPending(10), [first, next]);
		assert.equal(JSON.parse(String(stored()[0].event_json)).keyId, oldId);
		assert.equal(JSON.parse(String(stored()[1].event_json)).keyId, ring.activeKeyId);
	});

	test('simultaneous first opens serialize key provisioning and use one SecretStorage key', async () => {
		const [first, second] = await Promise.all([open(), open()]); const events = [input(), input()];
		await first.beginSession(events[0].sessionId); await second.beginSession(events[1].sessionId);
		await first.enqueue(events[0]); await second.enqueue(events[1]);
		assert.deepEqual(await first.getPending(10), events); assert.equal(secrets.stores, 1);
		await (first as unknown as { worker: Worker }).worker.terminate(); await first.close();
		const recovered = await open(); const sessions = await recovered.getRecordingSessions();
		assert.equal(sessions.find(session => session.sessionId === events[0].sessionId)!.status, 'interrupted');
		assert.equal(sessions.find(session => session.sessionId === events[1].sessionId)!.status, 'active');
	});

	test('JSONL contains safe metadata only while SQLite retains encrypted event evidence', async () => {
		const queue = await open(); const event = input(); const jsonl = new JsonlWriter(join(root, 'events.v1.jsonl'));
		const writer = new EventPersistence(queue, jsonl, undefined, { context: () => ({ recordingActive: true, sessionId: event.sessionId,
			approvedWorkspaceIds: [event.workspaceId!], confirmedCodexSessions: [{ sourceSessionId: event.sourceSessionId!, workspaceId: event.workspaceId! }], codexContentConsent: true }) });
		await writer.write(event); await writer.close();
		assert.deepEqual(JSON.parse((await readFile(jsonl.filePath, 'utf8')).trim()), eventDiagnostic(event));
		assert.equal(stored()[0].payload_format, 1); assert.ok(!String(stored()[0].event_json).includes(dummyContent));
	});

	test('secure key provisioning validates buffers and preserves already stored keys', async () => {
		const keys = await supplyEvidenceKeys(secrets, { keyIds: [] }); const active = keys.activeKeyId;
		new EvidenceCipher(keys).dispose(); assert.ok(keys.keys.every(key => new Uint8Array(key.bytes).every(byte => byte === 0)));
		const again = await supplyEvidenceKeys(secrets, { keyIds: [active] }); assert.equal(again.activeKeyId, active);
		new EvidenceCipher(again).dispose(); assert.equal(secrets.stores, 1);
	});
});
