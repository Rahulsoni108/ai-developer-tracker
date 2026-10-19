import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { EventPersistence } from '../eventPersistence';
import { EventBatchManager } from '../eventBatchManager';
import { EventUploader } from '../eventUploader';
import { createFileEvent, createCodexEvent, type TrackerEvent } from '../eventSchema';
import { canonicalSha256 } from '../canonicalJson';
import { validAssessmentEventApproval, type AssessmentApprovalBinding } from '../assessmentEventApproval';
import { serializeUploadBatch } from '../uploadBatchSerialization';
import type { EvidenceConsentState } from '../evidenceConsent';
import { openTestWorkerQueue, testSecrets } from './queueTestKeys';
import type { UploadPrivacyContext } from '../uploadPrivacyContext';
import { LOCAL_QUEUE_FILENAME } from '../localEventQueue';
import { EvidenceCipher } from '../evidenceEncryption';
import { supplyEvidenceKeys } from '../evidenceKeyStorage';
import type { EvidenceApproval } from '../evidenceApproval';

const workspaceId = 'a'.repeat(64);
const now = '2030-01-01T10:00:01.000Z';
const deadline = '2030-01-01T11:00:00.000Z';
suite('Versioned assessment event approval contract', function () {
	this.timeout(15000);
	let root: string; let queue: AsyncLocalEventQueue; let writer: EventPersistence; let sessionId: string;
	let state: EvidenceConsentState; let binding: AssessmentApprovalBinding; let privacy: UploadPrivacyContext;
	const storage = () => ({ scheme: 'file', fsPath: join(root, 'queue') });
	const file = () => createFileEvent({ eventType: 'file.modified', sessionId, workspaceId, source: 'vscode',
		timestamp: new Date(now), payload: { relativePath: 'src/app.ts' } });
	const openWriter = () => new EventPersistence(queue, { write: async () => {}, flush: async () => {} }, undefined, { context: () => privacy });
	const batch = (events: TrackerEvent[]) => ({ batchId: randomUUID(), createdAt: now, byteSize: Buffer.byteLength(JSON.stringify(events)), events });
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'event-approval-v1-')); sessionId = randomUUID(); queue = await openTestWorkerQueue(storage(), []);
		const receiptId = randomUUID();
		state = { version: 1, codingSessionId: '42', origin: 'https://assessment.invalid', deadline, locallyRevoked: false, captureClosed: false,
			request: { request_id: randomUUID(), local_recording_session_id: sessionId, approval_action: 'approve_upload', consent_version: 'assessment-evidence.v1',
				scope: 'assessment_evidence', approved_workspace_ids: [workspaceId], event_types: ['file.modified', 'ai.prompt.submitted'] },
			receipt: { consent_id: receiptId, local_recording_session_id: sessionId, consent_version: 'assessment-evidence.v1', scope: 'assessment_evidence',
				approved_workspace_ids: [workspaceId], event_types: ['file.modified', 'ai.prompt.submitted'], destination_origin: 'https://assessment.invalid',
				consented_at: now, expires_at: deadline, server_time: now, state: 'active', evidence_window: { starts_at: now, ends_at: deadline },
				upload_authorized: false, privacy_authorization: 'unverified' } };
		await queue.setEvidenceConsent(state);
		binding = { codingSessionId: '42', origin: state.origin, consentReceiptId: receiptId, serverTime: now };
		privacy = { recordingActive: true, sessionId, approvedWorkspaceIds: [workspaceId], codexContentConsent: true,
			confirmedCodexSessions: [{ sourceSessionId: 'approved-source', workspaceId }] };
		writer = openWriter();
	});
	teardown(async () => { await writer.close(); await queue.close(); await rm(root, { recursive: true, force: true }); });

	test('captures an encrypted canonical digest and public reference atomically; lookup never mutates the approval', async () => {
		const event = file(); await writer.write(event);
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		try {
			const before = db.prepare('SELECT approval_json FROM event_approvals WHERE event_id = ?').get(event.eventId)!.approval_json;
			const context = (await queue.getAssessmentUploadContext(event, binding))!; const proof = context.assessmentEventApproval!;
			assert.equal(proof.approvalProtocolVersion, 1); assert.equal(proof.canonicalization, 'RFC8785');
			assert.equal(proof.eventDigest, canonicalSha256(event)); assert.equal(proof.consentReceiptId, state.receipt!.consent_id);
			assert.equal(proof.eventId, event.eventId); assert.equal(proof.localRecordingSessionId, sessionId); assert.equal(proof.workspaceId, workspaceId);
			assert.equal(validAssessmentEventApproval(proof, event, binding), true);
			assert.equal(db.prepare('SELECT approval_json FROM event_approvals WHERE event_id = ?').get(event.eventId)!.approval_json, before);
			assert.equal(String(before).includes('captureApprovalReference'), false);
			assert.equal(await queue.getUploadPrivacyContext(event), undefined); // Generic path stays blocked.
		} finally { db.close(); }
	});
	test('prepares one envelope per unchanged event with the digest excluding the envelope and batch', async () => {
		const events = [file(), file()]; for (const event of events) { await writer.write(event); }
		const contexts = await Promise.all(events.map(event => queue.getAssessmentUploadContext(event, binding)));
		const prepared = serializeUploadBatch(batch(events), contexts as UploadPrivacyContext[], 1024 * 1024);
		const body = JSON.parse(prepared.body); assert.equal(prepared.includesAssessmentApprovals, true);
		assert.deepEqual(Object.keys(body), ['contractVersion', 'batchId', 'events', 'eventApprovals']); assert.deepEqual(body.events, events);
		for (let index = 0; index < events.length; index++) {
			assert.equal(body.eventApprovals[index].eventId, events[index].eventId);
			assert.equal(body.eventApprovals[index].eventDigest, canonicalSha256(body.events[index]));
			assert.equal(Object.hasOwn(body.eventApprovals[index], 'context'), false);
			assert.equal(Object.hasOwn(body.events[index], 'approval'), false);
		}
		assert.notEqual(body.eventApprovals[0].captureApprovalReference, body.eventApprovals[1].captureApprovalReference);
		const retry = JSON.parse(serializeUploadBatch(batch(events), contexts as UploadPrivacyContext[], 1024 * 1024).body);
		assert.deepEqual(retry.eventApprovals, body.eventApprovals);
		assert.throws(() => serializeUploadBatch(batch(events), contexts as UploadPrivacyContext[], Buffer.byteLength(prepared.body) - 1), RangeError);
	});
	test('redacted content binds only the sanitized version, and rejected content gets no envelope', async () => {
		const event = createCodexEvent({ sessionId, workspaceId, sourceSessionId: 'approved-source', timestamp: new Date(now), eventType: 'ai.prompt.submitted',
			payload: { text: 'password="dummy-sensitive-password"', sourceRecord: { sourceFileReference: 'codex-file:' + 'b'.repeat(64),
				recordIndex: 1, generation: 0, byteOffset: 0, byteLength: 200, recordType: 'event_msg' } } });
		await writer.write(event); const [sanitized] = await queue.getPending(1);
		assert.equal(JSON.stringify(sanitized).includes('dummy-sensitive-password'), false);
		const context = (await queue.getAssessmentUploadContext(sanitized, binding))!;
		assert.equal(context.assessmentEventApproval!.eventDigest, canonicalSha256(sanitized));
		assert.equal(await queue.getAssessmentUploadContext(event, binding), undefined);
		const rejected = file(); rejected.payload.relativePath = '.env'; await assert.rejects(writer.write(rejected));
		assert.equal(await queue.getAssessmentUploadContext(rejected, binding), undefined);
	});
	test('preserves capture references and approval bytes across duplicate capture and storage-worker restart', async () => {
		const event = file(); await writer.write(event); const before = (await queue.getAssessmentUploadContext(event, binding))!;
		await writer.close(); queue = await openTestWorkerQueue(storage(), []); writer = openWriter(); await writer.write(event);
		assert.deepEqual(await queue.getAssessmentUploadContext(event, binding), before); assert.equal(await queue.getPendingCount(), 1);
		const copy = (await queue.getAssessmentUploadContext(event, binding))!; copy.assessmentEventApproval!.consentReceiptId = randomUUID();
		assert.deepEqual(await queue.getAssessmentUploadContext(event, binding), before);
	});
	test('never upgrades old v1 capture approvals to protocol approvals during lookup or retry', async () => {
		const event = file(); await writer.write(event);
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		try {
			const keys = db.prepare('SELECT key_id FROM queue_encryption_keys').all().map(row => String(row.key_id));
			const cipher = new EvidenceCipher(await supplyEvidenceKeys(testSecrets, { keyIds: keys }));
			try {
				const saved = db.prepare('SELECT approval_json FROM event_approvals WHERE event_id = ?').get(event.eventId)!;
				const legacy = cipher.decrypt(event.eventId, JSON.parse(String(saved.approval_json)), 'approval') as EvidenceApproval;
				legacy.version = 1; delete legacy.assessmentEventApproval;
				const encrypted = JSON.stringify(cipher.encrypt(event.eventId, JSON.stringify(legacy), 'approval'));
				db.prepare('UPDATE event_approvals SET approval_json = ? WHERE event_id = ?').run(encrypted, event.eventId);
				assert.equal(await queue.getAssessmentUploadContext(event, binding), undefined);
				await queue.enqueueApproved(event, privacy); assert.equal(await queue.getAssessmentUploadContext(event, binding), undefined);
				assert.equal(db.prepare('SELECT approval_json FROM event_approvals WHERE event_id = ?').get(event.eventId)!.approval_json, encrypted);
			} finally { cipher.dispose(); }
		} finally { db.close(); }
		const old = file(); await queue.enqueue(old); await writer.write(old); assert.equal(await queue.getAssessmentUploadContext(old, binding), undefined);
	});
	test('rejects incorrect consent, assessment, origin, workspace, recording and exact-event references', async () => {
		const event = file(); await writer.write(event);
		for (const target of [{ ...binding, consentReceiptId: randomUUID() }, { ...binding, codingSessionId: '43' },
			{ ...binding, origin: 'https://other.invalid' }, { ...binding, serverTime: 'bad' }]) {
			assert.equal(await queue.getAssessmentUploadContext(event, target), undefined);
		}
		for (const altered of [{ ...event, eventId: randomUUID() }, { ...event, sessionId: randomUUID() },
			{ ...event, workspaceId: 'b'.repeat(64) }, { ...event, payload: { relativePath: 'other.ts' } }]) {
			assert.equal(await queue.getAssessmentUploadContext(altered, binding), undefined);
		}
		await writer.write({ ...file(), eventType: 'file.saved' }); // Captured locally; not in upload consent category scope.
		const saved = (await queue.getPending(10)).find(input => input.eventType === 'file.saved')!;
		assert.equal(await queue.getAssessmentUploadContext(saved, binding), undefined);
	});
	test('revocation and pending consent mutations survive restart without acknowledging or deleting evidence', async () => {
		const event = file(); await writer.write(event);
		await queue.setEvidenceConsent({ ...state, locallyRevoked: true, captureClosed: true, pendingAction: 'revoke' });
		assert.equal(await queue.getAssessmentUploadContext(event, binding), undefined);
		await writer.close(); queue = await openTestWorkerQueue(storage(), []); writer = openWriter();
		assert.equal(await queue.getAssessmentUploadContext(event, binding), undefined); assert.equal(await queue.getPendingCount(), 1);
	});
	test('honors server expiry and stopped capture windows without using local time to extend them', async () => {
		const event = file(); await writer.write(event);
		assert.equal(await queue.getAssessmentUploadContext(event, { ...binding, serverTime: deadline }), undefined);
		assert.equal(await queue.getAssessmentUploadContext(event, { ...binding, serverTime: '2030-01-01T10:00:00.000Z' }), undefined);
		state.captureClosed = true; state.pendingAction = 'stop'; await queue.setEvidenceConsent(state);
		assert.equal(await queue.getAssessmentUploadContext(event, binding), undefined);
		state.pendingAction = undefined; state.receipt = { ...state.receipt!, state: 'stopped', server_time: '2030-01-01T10:00:03.000Z',
			evidence_window: { starts_at: now, ends_at: '2030-01-01T10:00:03.000Z', stopped_at: '2030-01-01T10:00:03.000Z' } };
		await queue.setEvidenceConsent(state);
		assert.ok(await queue.getAssessmentUploadContext(event, { ...binding, serverTime: '2030-01-01T10:00:04.000Z' }));
	});
	test('rejects tampered wire envelopes, mixed batches and unauthenticated storage before formatting', async () => {
		const event = file(); await writer.write(event); const context = (await queue.getAssessmentUploadContext(event, binding))!;
		const proof = context.assessmentEventApproval!;
		for (const changed of [{ ...proof, approvalProtocolVersion: 2 }, { ...proof, canonicalization: 'custom' }, { ...proof, eventDigest: '0'.repeat(64) },
			{ ...proof, eventId: randomUUID() }, { ...proof, consentReceiptId: randomUUID() }, { ...proof, consentReceiptId: null }, { ...proof, extra: true }]) {
			assert.equal(validAssessmentEventApproval(changed, event, binding), false);
			assert.throws(() => serializeUploadBatch(batch([event]), [{ ...context, assessmentEventApproval: changed as typeof proof }], 1000000));
		}
		assert.throws(() => serializeUploadBatch(batch([event, event]), [context, context], 1000000));
		const second = file(); await writer.write(second); const other = (await queue.getAssessmentUploadContext(second, binding))!;
		delete other.assessmentEventApproval;
		assert.throws(() => serializeUploadBatch(batch([second]), [other], 1000000));
		assert.throws(() => serializeUploadBatch(batch([event, second]), [context, other], 1000000));
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		try { db.prepare('UPDATE event_approvals SET approval_json = ? WHERE event_id = ?').run('{"private":"dummy"}', event.eventId);
			await assert.rejects(queue.getAssessmentUploadContext(event, binding)); }
		finally { db.close(); }
	});
	test('the uploader never sends an assessment request through the unsupported Rails contract', async () => {
		const event = file(); await writer.write(event); let sent = 0;
		const uploader = new EventUploader(new EventBatchManager(queue), queue, { get: async () => 'dummy-token' }, {
			endpoint: 'https://assessment.invalid/api/v2/coding_session/extension/events', confirmUpload: async () => true,
			privacyContext: input => queue.getAssessmentUploadContext(input, binding)
		}, { send: async () => { sent++; throw new Error('Transport must not be called'); } });
		try {
			await uploader.enable(); assert.equal(await uploader.uploadOnce(), 'protocol'); assert.equal(sent, 0);
			assert.equal(await queue.getPendingCount(), 1); assert.equal((await queue.getDeliveryStatus()).claimedEvents, 0);
		} finally { await uploader.dispose(); }
	});
	test('legacy non-assessment request format stays exactly three keys', () => {
		const event = file(); const prepared = serializeUploadBatch(batch([event]), [privacy], 1000000);
		assert.equal(prepared.includesAssessmentApprovals, false);
		assert.deepEqual(Object.keys(JSON.parse(prepared.body)), ['contractVersion', 'batchId', 'events']);
	});
});
