import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openTestWorkerQueue } from './queueTestKeys';
import type { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { LOCAL_QUEUE_FILENAME } from '../localEventQueue';
import { createFileEvent } from '../eventSchema';
import type { EvidenceConsentState } from '../evidenceConsent';
import { canonicalSha256 } from '../canonicalJson';
import { validFinalizationRequest, validSubmissionReceipt, receiptMatches, type FinalizationScope } from '../assessmentFinalization';

const workspaceId = 'a'.repeat(64);
const now = '2030-01-01T10:00:00.000Z';
const end = '2030-01-01T11:00:00.000Z';
suite('Assessment frozen finalization manifests', function () {
	this.timeout(15000);
	let root: string; let queue: AsyncLocalEventQueue; let sessionId: string; let scope: FinalizationScope; let consent: EvidenceConsentState;
	const storage = () => ({ scheme: 'file', fsPath: join(root, 'queue') });
	const event = (eventId = randomUUID()) => ({ ...createFileEvent({ eventType: 'file.modified', source: 'vscode', sessionId, workspaceId,
		timestamp: new Date(now), payload: { relativePath: 'src/example.ts' } }), eventId });
	const context = () => ({ recordingActive: true, sessionId, approvedWorkspaceIds: [workspaceId], confirmedCodexSessions: [], codexContentConsent: false });
	async function closed(): Promise<void> {
		await queue.finishSession(sessionId);
		consent = { ...consent, captureClosed: true, receipt: { ...consent.receipt!, state: 'stopped', server_time: end,
			evidence_window: { starts_at: now, ends_at: end, stopped_at: end } } };
		await queue.setEvidenceConsent(consent);
	}
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'finalization-manifest-')); queue = await openTestWorkerQueue(storage(), []); sessionId = randomUUID();
		scope = { codingSessionId: '42', origin: 'https://assessment.invalid', requestId: randomUUID(), localRecordingSessionIds: [sessionId] };
		consent = { version: 1, codingSessionId: scope.codingSessionId, origin: scope.origin, deadline: end, locallyRevoked: false, captureClosed: false,
			request: { request_id: randomUUID(), local_recording_session_id: sessionId, approval_action: 'approve_upload', consent_version: 'assessment-evidence.v1',
				scope: 'assessment_evidence', approved_workspace_ids: [workspaceId], event_types: ['file.modified'] },
			receipt: { consent_id: randomUUID(), local_recording_session_id: sessionId, consent_version: 'assessment-evidence.v1', scope: 'assessment_evidence',
				approved_workspace_ids: [workspaceId], event_types: ['file.modified'], destination_origin: scope.origin, consented_at: now, expires_at: end,
				server_time: now, state: 'active', evidence_window: { starts_at: now, ends_at: end }, upload_authorized: false, privacy_authorization: 'unverified' } };
		await queue.beginSession(sessionId); await queue.setEvidenceConsent(consent);
	});
	teardown(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });

	test('matches the actual Rails sorted UUID vector and retains acknowledged tombstones', async () => {
		const captured = event('22222222-2222-4222-8222-222222222222'); await queue.enqueueApproved(captured, context());
		await queue.markAcknowledged([captured.eventId]); await closed();
		const snapshot = await queue.freezeFinalization(scope);
		assert.deepEqual(snapshot.recordings, [{ local_recording_session_id: sessionId, event_count: 1,
			event_ids_sha256: 'd95688f63f38ee887a32eaa5c73f75dec8c769dee36ba9220fc7096bec4e80da' }]);
		assert.equal(await queue.getPendingCount(), 0); assert.equal(validFinalizationRequest(snapshot), true);
	});
	test('sorts original IDs independently of capture order and counts pending plus acknowledged events', async () => {
		const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
		for (const id of ids) { await queue.enqueueApproved(event(id), context()); }
		await queue.markAcknowledged([ids[0]]); await closed();
		const frozen = await queue.freezeFinalization(scope);
		assert.equal(frozen.recordings[0].event_count, 3); assert.equal(frozen.recordings[0].event_ids_sha256, canonicalSha256([...ids].sort()));
		assert.equal(await queue.getPendingCount(), 2);
	});
	test('freezes an empty approved recording and survives restart with authenticated encrypted metadata', async () => {
		await closed(); const frozen = await queue.freezeFinalization(scope);
		assert.equal(frozen.recordings[0].event_ids_sha256, canonicalSha256([]));
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		try { const raw = String(db.prepare('SELECT snapshot_json FROM assessment_finalizations').get()!.snapshot_json);
			assert.equal(raw.includes('recordings'), false); assert.equal(raw.includes(scope.origin), false); assert.equal(raw.includes(sessionId), false); }
		finally { db.close(); }
		await queue.close(); queue = await openTestWorkerQueue(storage(), []);
		assert.deepEqual(await queue.freezeFinalization(scope, true), frozen);
	});
	test('concurrent duplicate freezing is idempotent and a new request cannot claim an already-frozen recording', async () => {
		await closed(); const snapshots = await Promise.all([queue.freezeFinalization(scope), queue.freezeFinalization(scope)]);
		assert.deepEqual(snapshots[0], snapshots[1]); await assert.rejects(queue.freezeFinalization({ ...scope, requestId: randomUUID() }));
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assessment_finalizations').get()!.count, 1); } finally { db.close(); }
	});
	test('active or unclosed capture cannot freeze, and failed freezing leaves no manifest', async () => {
		await assert.rejects(queue.freezeFinalization(scope)); await queue.finishSession(sessionId); await assert.rejects(queue.freezeFinalization(scope));
		await closed(); await assert.rejects(queue.freezeFinalization(scope, true)); await queue.freezeFinalization(scope);
	});
	test('freezing rejects historical evidence lacking capture-time approval without dropping it', async () => {
		await queue.enqueue(event()); await closed(); await assert.rejects(queue.freezeFinalization(scope)); assert.equal(await queue.getPendingCount(), 1);
	});
	test('missing sessions, cross-assessment scope, missing/revoked consent and mismatched manifests remain blocked', async () => {
		await closed();
		await assert.rejects(queue.freezeFinalization({ ...scope, localRecordingSessionIds: [randomUUID()] }));
		await assert.rejects(queue.freezeFinalization({ ...scope, codingSessionId: '99' }));
		await assert.rejects(queue.freezeFinalization({ ...scope, origin: 'https://other.invalid' }));
		await queue.freezeFinalization(scope);
		await assert.rejects(queue.freezeFinalization({ ...scope, localRecordingSessionIds: [sessionId, randomUUID()] }));
		await queue.revokeEvidenceApprovals(sessionId); await assert.rejects(queue.freezeFinalization(scope));
	});
	test('new evidence cannot enter a frozen recording, duplicate IDs remain idempotent, and acknowledgments do not change its manifest', async () => {
		const captured = event(); await queue.enqueueApproved(captured, context()); await closed(); const frozen = await queue.freezeFinalization(scope);
		await assert.rejects(queue.enqueueApproved(event(), context())); await queue.enqueueApproved(captured, context());
		await queue.markAcknowledged([captured.eventId]); assert.deepEqual(await queue.freezeFinalization(scope, true), frozen);
	});
	test('tampered encrypted manifests and missing retained evidence never produce a replacement manifest', async () => {
		await closed(); await queue.freezeFinalization(scope); const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		try { const raw = JSON.parse(String(db.prepare('SELECT snapshot_json FROM assessment_finalizations').get()!.snapshot_json));
			raw.tag = Buffer.alloc(16).toString('base64'); db.prepare('UPDATE assessment_finalizations SET snapshot_json = ?').run(JSON.stringify(raw));
			await assert.rejects(queue.freezeFinalization(scope, true)); }
		finally { db.close(); }
	});
	test('retention cannot remove frozen recordings; explicit cleanup removes the snapshot and forces recovery', async () => {
		const captured = event(); await queue.enqueueApproved(captured, context()); await queue.markAcknowledged([captured.eventId]); await closed();
		await queue.freezeFinalization(scope); await new Promise(resolve => setTimeout(resolve, 10));
		await queue.acquireMaintenance();
		try {
			const expired = await queue.expireAcknowledged(new Date().toISOString()); assert.equal(expired.deletedSessions, 0);
			const deleted = await queue.deleteEvidence('all'); assert.equal(deleted.deletedSessions, 1);
		} finally { await queue.releaseMaintenance(); }
		await assert.rejects(queue.freezeFinalization(scope, true));
	});

	test('upgrading schema v8 preserves evidence and does not manufacture frozen manifests', async () => {
		const captured = event(); await queue.enqueueApproved(captured, context()); await closed(); await queue.close();
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		db.exec('DROP TABLE finalization_recordings; DROP TABLE assessment_finalizations; PRAGMA user_version = 8;'); db.close();
		queue = await openTestWorkerQueue(storage(), []); assert.deepEqual(await queue.getPending(10), [captured]);
		await assert.rejects(queue.freezeFinalization(scope, true)); assert.equal((await queue.freezeFinalization(scope)).recordings[0].event_count, 1);
	});

	test('validates exact receipt shapes and rejects count/request/timing/unsupported request data', async () => {
		await closed(); const frozen = await queue.freezeFinalization(scope);
		const receipt = { contract_version: 1 as const, request_id: scope.requestId, event_count: 0, recording_count: 1, submitted_at: now };
		assert.equal(validFinalizationRequest({ ...frozen, request_id: '33333333-3333-1333-8333-333333333333' }), true);
		assert.equal(validFinalizationRequest({ ...frozen, request_id: '33333333-3333-0333-8333-333333333333' }), false);
		assert.equal(validSubmissionReceipt(receipt), true); assert.equal(receiptMatches(receipt, frozen), true);
		for (const modified of [{ ...receipt, request_id: randomUUID() }, { ...receipt, event_count: 1 }, { ...receipt, recording_count: 2 }]) {
			assert.equal(receiptMatches(modified, frozen), false);
		}
		assert.equal(validSubmissionReceipt({ ...receipt, extra: true }), false);
		for (const modified of [{ ...frozen, request_id: scope.requestId.toUpperCase() }, { ...frozen, contract_version: 2 },
			{ ...frozen, recordings: [...frozen.recordings, ...frozen.recordings] }, { ...frozen, ownership_id: 1 }]) { assert.equal(validFinalizationRequest(modified), false); }
	});
});
