import * as assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { EventUploader, UPLOAD_TOKEN_SECRET, retryDelay, type EventUploaderOptions } from '../eventUploader';
import { HttpsEventTransport, validatedUploadEndpoint } from '../httpsEventTransport';
import { EventBatchManager } from '../eventBatchManager';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { createFileEvent, createCodexEvent, createChangeEvent, type TrackerEvent } from '../eventSchema';
import type { PrivacyContext } from '../privacyFilter';
import { LOCAL_QUEUE_FILENAME } from '../localEventQueue';
import { openTestWorkerQueue } from './queueTestKeys';

suite('HTTPS event uploader and durable retries', () => {
	let fixture: string; let certificate: string; let key: string;
	let root: string; let queue: AsyncLocalEventQueue; let uploader: EventUploader; let server: Server;
	let endpoint: string; let received: { contractVersion: number; batchId: string; events: TrackerEvent[] }[];
	let response: (req: IncomingMessage, res: ServerResponse, body: typeof received[number]) => void;
	let approved: Map<string, PrivacyContext>;
	const storage = () => ({ scheme: 'file', fsPath: root });
	const input = () => createFileEvent({ sessionId: randomUUID(), workspaceId: 'workspace', source: 'vscode',
		eventType: 'file.saved', payload: { relativePath: 'example.ts' } });
	const approve = async (event: TrackerEvent) => {
		approved.set(event.sessionId, { recordingActive: true, sessionId: event.sessionId, approvedWorkspaceIds: ['workspace'],
			confirmedCodexSessions: event.sourceSessionId ? [{ sourceSessionId: event.sourceSessionId, workspaceId: 'workspace' }] : [], codexContentConsent: true });
		await queue.enqueue(event);
	};
	const ack = (res: ServerResponse, body: typeof received[number], ids = body.events.map(event => event.eventId)) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ contractVersion: 1, batchId: body.batchId, durablyAcceptedEventIds: ids }));
	};
	const createUploader = (overrides: Partial<EventUploaderOptions> = {}, token: string | undefined = 'dummy-upload-token') => new EventUploader(
		new EventBatchManager(queue), queue, { get: async name => name === UPLOAD_TOKEN_SECRET ? token : undefined },
		{ endpoint, confirmUpload: async () => true, privacyContext: event => approved.get(event.sessionId),
			baseDelayMs: 100, maxDelayMs: 1000, timeoutMs: 2000, ...overrides }, new HttpsEventTransport(certificate));
	const due = () => {
		const db = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME));
		try { db.exec('UPDATE upload_retry_state SET next_attempt_at = 0'); } finally { db.close(); }
	};
	suiteSetup(async () => {
		fixture = await mkdtemp(join(tmpdir(), 'ai-https-cert-'));
		await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
			'-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(fixture, 'key.pem'), '-out', join(fixture, 'cert.pem')]);
		certificate = await readFile(join(fixture, 'cert.pem'), 'utf8'); key = await readFile(join(fixture, 'key.pem'), 'utf8');
	});
	suiteTeardown(async () => { await rm(fixture, { recursive: true, force: true }); });
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'ai-upload-')); queue = await openTestWorkerQueue(storage(), []);
		approved = new Map(); received = []; response = (_req, res, body) => ack(res, body);
		server = createServer({ key, cert: certificate }, (req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', chunk => chunks.push(chunk));
			req.on('end', () => {
				const body = JSON.parse(Buffer.concat(chunks).toString()); received.push(body); response(req, res, body);
			});
		});
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
		endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}/events`; uploader = createUploader();
	});
	teardown(async () => {
		await uploader?.dispose(); await queue?.close(); server?.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
	});

	test('disabled by default and cancelled upload consent never sends or claims', async () => {
		await approve(input()); assert.equal(await uploader.uploadOnce(), 'disabled');
		await uploader.dispose(); uploader = createUploader({ confirmUpload: async () => false });
		assert.equal(await uploader.enable(), false); assert.equal(await uploader.uploadOnce(), 'disabled');
		assert.equal(received.length, 0); assert.equal((await queue.getDeliveryStatus()).claimedEvents, 0);
	});
	test('full acknowledgment preserves event envelope identity and clears only explicitly accepted events', async () => {
		const events = [input(), input()]; for (const event of events) { await approve(event); }
		await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'delivered');
		assert.deepEqual(received[0].events, events); assert.equal(received[0].contractVersion, 1);
		assert.equal(await queue.getPendingCount(), 0); assert.equal((await queue.getUploadRetryState())?.attempts, 0);
	});
	test('partial acknowledgment releases remainder for an ordered retry with original IDs', async () => {
		const events = [input(), input()]; for (const event of events) { await approve(event); }
		response = (_req, res, body) => ack(res, body, [body.events[0].eventId]);
		await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'retry');
		assert.deepEqual(await queue.getPending(10), events.slice(1)); assert.equal((await queue.getDeliveryStatus()).claimedEvents, 0);
		due(); assert.equal(await uploader.uploadOnce(), 'delivered'); assert.deepEqual(received[1].events, events.slice(1));
	});
	test('concurrent upload calls share one request and cross-worker upload lease is exclusive', async () => {
		await approve(input()); await uploader.enable();
		const outcomes = await Promise.all([uploader.uploadOnce(), uploader.uploadOnce(), uploader.uploadOnce()]);
		assert.deepEqual(outcomes, ['delivered', 'delivered', 'delivered']); assert.equal(received.length, 1);
		const other = await openTestWorkerQueue(storage(), []);
		try {
			const hash = createHash('sha256').update(endpoint).digest('hex');
			assert.ok(await queue.claimUploadAttempt(hash, Date.now(), Date.now() + 5000));
			assert.equal(await other.claimUploadAttempt(hash, Date.now(), Date.now() + 5000), null);
			await assert.rejects(other.configureUpload(hash)); await assert.rejects(queue.acquireMaintenance());
			await queue.finishUploadAttempt(0, null, false);
		} finally { await other.close(); }
	});
	test('missing SecretStorage token pauses and never sends', async () => {
		await approve(input()); await uploader.dispose(); uploader = new EventUploader(new EventBatchManager(queue), queue, { get: async () => undefined },
			{ endpoint, confirmUpload: async () => true, privacyContext: event => approved.get(event.sessionId) });
		await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'authentication');
		assert.equal(received.length, 0); assert.equal((await queue.getUploadRetryState())?.pauseReason, 'authentication');
	});
	for (const status of [401, 403]) {
		test(`HTTP ${status} pauses across restart and retains events`, async () => {
			await approve(input()); response = (_req, res) => { res.writeHead(status); res.end('dummy-private-response'); };
			await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'authentication');
			assert.equal(await uploader.uploadOnce(), 'authentication'); assert.equal(received.length, 1); assert.equal(await queue.getPendingCount(), 1);
			await uploader.dispose(); await queue.close(); queue = await openTestWorkerQueue(storage(), []); uploader = createUploader();
			assert.equal(await uploader.uploadOnce(), 'disabled'); assert.equal((await queue.getUploadRetryState())?.pauseReason, 'authentication');
		});
	}
	for (const status of [408, 429, 500, 503]) {
		test(`HTTP ${status} retries with persisted bounded Retry-After`, async () => {
			await approve(input()); response = (_req, res) => { res.writeHead(status, { 'Retry-After': '60' }); res.end('dummy-private-response'); };
			await uploader.enable(); const before = Date.now(); assert.equal(await uploader.uploadOnce(), 'retry');
			const state = (await queue.getUploadRetryState())!; assert.equal(state.attempts, 1); assert.ok(state.nextAttemptAt >= before + 1000);
			assert.equal(await uploader.uploadOnce(), 'waiting'); assert.equal(await queue.getPendingCount(), 1);
			response = (_req, res, body) => ack(res, body); due(); assert.equal(await uploader.uploadOnce(), 'delivered');
		});
	}
	test('network disconnect retains evidence and schedules retry', async () => {
		await approve(input()); response = req => req.socket.destroy(); await uploader.enable();
		assert.equal(await uploader.uploadOnce(), 'retry'); assert.equal(await queue.getPendingCount(), 1);
		assert.ok((await queue.getUploadRetryState())!.nextAttemptAt > Date.now());
	});
	test('absolute timeout aborts a stalled response and schedules retry', async () => {
		await approve(input()); await uploader.dispose(); uploader = createUploader({ timeoutMs: 300 });
		response = () => { /* Deliberately never respond. */ }; await uploader.enable();
		assert.equal(await uploader.uploadOnce(), 'retry'); assert.equal(await queue.getPendingCount(), 1);
		assert.equal((await queue.getDeliveryStatus()).claimedEvents, 0);
	});
	test('explicit cancellation stops an in-flight request without acknowledging it', async () => {
		await approve(input()); let started!: () => void; const arrived = new Promise<void>(resolve => { started = resolve; });
		response = () => { started(); }; await uploader.enable(); const uploading = uploader.uploadOnce(); await arrived; uploader.cancel();
		assert.equal(await uploading, 'cancelled'); assert.equal(await queue.getPendingCount(), 1);
	});
	for (const malformed of ['invalid-json', 'wrong-batch', 'unknown-id', 'duplicate-id', 'no-explicit-ack', 'wrong-type', 'oversized']) {
		test(`rejects ${malformed} acknowledgments without accepting HTTP success as delivery`, async () => {
			await approve(input()); response = (_req, res, body) => {
				res.writeHead(200, { 'Content-Type': malformed === 'wrong-type' ? 'text/plain' : 'application/json' });
				if (malformed === 'invalid-json') { res.end('{'); return; }
				if (malformed === 'oversized') { res.end('x'.repeat(129 * 1024)); return; }
				res.end(JSON.stringify({ contractVersion: 1, batchId: malformed === 'wrong-batch' ? randomUUID() : body.batchId,
					durablyAcceptedEventIds: malformed === 'unknown-id' ? [randomUUID()] : malformed === 'duplicate-id'
						? [body.events[0].eventId, body.events[0].eventId] : malformed === 'no-explicit-ack' ? undefined : body.events.map(event => event.eventId) }));
			};
			await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'protocol'); assert.equal(await queue.getPendingCount(), 1);
		});
	}
	test('redirects and permanent HTTP errors pause without forwarding credentials', async () => {
		await approve(input()); response = (_req, res) => { res.writeHead(302, { Location: endpoint + '/private' }); res.end(); };
		await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'configuration'); assert.equal(received.length, 1);
		assert.equal(await queue.getPendingCount(), 1);
	});
	test('invalid HTTPS configuration and untrusted certificates fail closed', async () => {
		for (const url of ['http://example.com/events', 'https://user:dummy-secret@example.com/events', 'https://example.com/events?token=dummy', 'https://example.com/#fragment']) {
			assert.throws(() => validatedUploadEndpoint(url), error => error instanceof Error && !error.message.includes('dummy'));
		}
		await approve(input()); await uploader.dispose();
		uploader = new EventUploader(new EventBatchManager(queue), queue, { get: async () => 'dummy-token' },
			{ endpoint, confirmUpload: async () => true, privacyContext: event => approved.get(event.sessionId) });
		await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'configuration'); assert.equal(received.length, 0);
	});
	test('re-filters historical plaintext and encrypted events before transmitting dummy secrets', async () => {
		const event = createCodexEvent({ sessionId: randomUUID(), workspaceId: 'workspace', sourceSessionId: randomUUID(),
			eventType: 'ai.prompt.submitted', payload: { text: 'password=\"dummy-password\"', sourceRecord: { sourceFileReference: 'codex-file:' + 'a'.repeat(64), recordIndex: 1, generation: 0, byteOffset: 0, byteLength: 100, recordType: 'response_item' } } });
		await approve(event); const db = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME));
		try { db.prepare('UPDATE queued_events SET payload_format = 0, event_json = ? WHERE event_id = ?').run(JSON.stringify(event), event.eventId); }
		finally { db.close(); }
		await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'delivered');
		assert.equal(JSON.stringify(received).includes('dummy-password'), false);
		assert.equal(received[0].events[0].eventId, event.eventId);
	});
	test('missing historical scope and sensitive paths never reach transport', async () => {
		const event = input(); await queue.enqueue(event); await uploader.enable();
		assert.equal(await uploader.uploadOnce(), 'privacy'); assert.equal(received.length, 0);
		approved.set(event.sessionId, { recordingActive: true, sessionId: event.sessionId, approvedWorkspaceIds: ['workspace'], confirmedCodexSessions: [], codexContentConsent: false });
		const db = new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME));
		try { event.payload.relativePath = '.env'; db.prepare('UPDATE queued_events SET payload_format = 0, event_json = ?').run(JSON.stringify(event)); }
		finally { db.close(); }
		due(); await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'privacy'); assert.equal(received.length, 0);
	});
	test('historical diffs needing redaction pause instead of uploading altered reconstruction evidence', async () => {
		const event = createChangeEvent({ sessionId: randomUUID(), workspaceId: 'workspace', eventType: 'file.diff', payload: {
			relativePath: 'example.ts', diff: '--- before\n+++ after\n@@ -1 +1 @@\n-old\n+password="dummy-password"\n',
			beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64), changeReason: 'edit' } });
		await approve(event); await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'privacy');
		assert.equal(received.length, 0); assert.equal(await queue.getPendingCount(), 1);
	});
	test('tool inputs and outputs are recursively redacted before HTTPS delivery', async () => {
		const event = createCodexEvent({ sessionId: randomUUID(), workspaceId: 'workspace', sourceSessionId: randomUUID(),
			eventType: 'ai.tool.completed', payload: { toolName: 'dummy_tool', callId: 'call-dummy', input: '{"password":"dummy-tool-password"}',
				output: 'Authorization: Bearer dummy-bearer-token', status: 'succeeded', matched: false,
				sourceRecord: { sourceFileReference: 'codex-file:' + 'a'.repeat(64), recordIndex: 1, generation: 0, byteOffset: 0, byteLength: 100, recordType: 'response_item' } } });
		await approve(event); await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'delivered');
		assert.equal(JSON.stringify(received).includes('dummy-tool-password'), false);
		assert.equal(JSON.stringify(received).includes('dummy-bearer-token'), false);
	});

	test('workspace mismatch, unconfirmed source session and missing content consent fail closed', async () => {
		const event = createCodexEvent({ sessionId: randomUUID(), workspaceId: 'workspace', sourceSessionId: randomUUID(),
			eventType: 'ai.prompt.submitted', payload: { text: 'dummy prompt',
				sourceRecord: { sourceFileReference: 'codex-file:' + 'a'.repeat(64), recordIndex: 1, generation: 0, byteOffset: 0, byteLength: 100, recordType: 'response_item' } } });
		await approve(event); const base = approved.get(event.sessionId)!;
		for (const override of [{ approvedWorkspaceIds: [] }, { confirmedCodexSessions: [] }, { codexContentConsent: false }]) {
			approved.set(event.sessionId, { ...base, ...override }); if (await queue.getUploadRetryState()) { due(); } await uploader.enable();
			assert.equal(await uploader.uploadOnce(), 'privacy');
		}
		assert.equal(received.length, 0); assert.equal(await queue.getPendingCount(), 1);
	});

	test('filter failure produces only a safe status, retaining pending evidence', async () => {
		await approve(input()); const statuses: string[] = []; await uploader.dispose();
		uploader = createUploader({ privacyContext: () => { throw new Error('dummy-private-error'); }, onStatus: status => statuses.push(status) });
		await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'privacy');
		assert.deepEqual(statuses, ['privacy']); assert.equal(received.length, 0); assert.equal(await queue.getPendingCount(), 1);
	});

	test('automatic retry driver starts only after approval and stops cleanly after authentication failure', async () => {
		await approve(input()); uploader.start(); assert.equal(received.length, 0);
		let responded!: () => void; const arrived = new Promise<void>(resolve => { responded = resolve; });
		response = (_req, res) => { res.writeHead(401); res.end(); responded(); };
		await uploader.enable(); uploader.start(); await arrived;
		await uploader.uploadOnce(); assert.equal((await queue.getUploadRetryState())?.pauseReason, 'authentication');
		await uploader.disable(); assert.equal(received.length, 1);
	});

	test('crash recovery preserves retry deadlines and events, requiring fresh upload consent', async () => {
		const event = input(); await approve(event); await uploader.enable();
		const hash = createHash('sha256').update(endpoint).digest('hex'); const deadline = Date.now() + 10000;
		await queue.claimUploadAttempt(hash, Date.now(), deadline); await queue.prepareBatch(1, 10000);
		await (queue as unknown as { worker: Worker }).worker.terminate(); await uploader.dispose(); await queue.close();
		queue = await openTestWorkerQueue(storage(), []); uploader = createUploader();
		assert.equal(await uploader.uploadOnce(), 'disabled'); assert.equal(await uploader.enable(), true);
		assert.equal(await uploader.uploadOnce(), 'waiting'); assert.equal((await queue.getUploadRetryState())?.nextAttemptAt, deadline);
		assert.equal((await queue.getDeliveryStatus()).claimedEvents, 0); due(); assert.equal(await uploader.uploadOnce(), 'delivered');
		assert.equal(received[0].events[0].eventId, event.eventId);
	});
	test('stalled SecretStorage is cancellable and timeout preserves evidence', async () => {
		await approve(input()); await uploader.dispose();
		uploader = new EventUploader(new EventBatchManager(queue), queue, { get: () => new Promise(() => { /* Simulate stalled storage. */ }) },
			{ endpoint, confirmUpload: async () => true, privacyContext: event => approved.get(event.sessionId), timeoutMs: 100 });
		await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'retry'); assert.equal(received.length, 0);
		assert.equal(await queue.getPendingCount(), 1);
	});

	test('duplicate response keys cannot ambiguously establish durable acknowledgment', async () => {
		await approve(input()); response = (_req, res, body) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(`{"contractVersion":1,"batchId":"${randomUUID()}","batchId":"${body.batchId}","durablyAcceptedEventIds":["${body.events[0].eventId}"]}`);
		};
		await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'protocol'); assert.equal(await queue.getPendingCount(), 1);
	});

	test('exponential jitter and Retry-After dates stay within configured limits', () => {
		const now = Date.now();
		for (let attempt = 1; attempt < 20; attempt++) {
			const delay = retryDelay(attempt, 1000, 10000); const cap = Math.min(10000, 1000 * 2 ** (attempt - 1));
			assert.ok(delay >= cap / 2 && delay <= cap);
		}
		assert.equal(retryDelay(1, 1000, 10000, '999999999', now), 10000);
		assert.ok(retryDelay(1, 1000, 10000, new Date(now + 5000).toUTCString(), now) >= 4000);
		assert.ok(retryDelay(1, 1000, 10000, 'private-invalid-value', now) <= 1000);
	});
});
