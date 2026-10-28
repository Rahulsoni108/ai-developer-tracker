import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openTestWorkerQueue, testSecrets } from './queueTestKeys';
import type { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { LOCAL_QUEUE_FILENAME } from '../localEventQueue';
import { EventPersistence } from '../eventPersistence';
import { createFileEvent, createCodexEvent, createClaudeEvent, createRelationshipEvent, type TrackerEvent } from '../eventSchema';
import { canonicalSha256 } from '../canonicalJson';
import { validAssessmentEventApproval, type AssessmentApprovalBinding } from '../assessmentEventApproval';
import type { DisclosureState } from '../assessmentDisclosure';
import type { EvidenceConsentState } from '../evidenceConsent';
import type { EvidenceApproval } from '../evidenceApproval';
import { EvidenceCipher } from '../evidenceEncryption';
import { supplyEvidenceKeys } from '../evidenceKeyStorage';
import { disclosureCoversEvent, DISCLOSURE_CONFIRMATION_MS } from '../disclosureCapture';
import { PRIVACY_EVENT_TYPES } from '../privacyFilter';
import type { UploadPrivacyContext } from '../uploadPrivacyContext';
import { serializeUploadBatch } from '../uploadBatchSerialization';

const A = 'a'.repeat(64); const B = 'b'.repeat(64);
const START = '2030-01-01T10:00:00.000Z'; const GRANT = '2030-01-01T10:00:01.000Z';
const END = '2030-01-01T11:00:00.000Z'; const LATER = '2030-01-01T10:00:02.000Z';
const sourceRecord = (provider: string) => ({ sourceFileReference: provider + '-file:' + 'f'.repeat(64), recordIndex: 1,
	generation: 0, byteOffset: 0, byteLength: 100, recordType: provider === 'codex' ? 'response_item' as const : 'claude_hook' as const });

suite('Protocol-2 atomic capture and authenticated recovery', function () {
	this.timeout(15000);
	let root: string; let queue: AsyncLocalEventQueue; let writer: EventPersistence; let id: string;
	let upload: EvidenceConsentState; let grant: DisclosureState; let binding: AssessmentApprovalBinding; let privacy: UploadPrivacyContext;
	const storage = () => ({ scheme: 'file', fsPath: join(root, 'queue') });
	const file = (workspaceId = A) => createFileEvent({ sessionId: id, source: 'vscode', workspaceId, eventType: 'file.modified', timestamp: new Date(GRANT), payload: { relativePath: 'src/example.ts' } });
	const newWriter = () => new EventPersistence(queue, { write: async () => {}, flush: async () => {} }, undefined, { context: () => privacy });
	async function confirm(state = grant): Promise<void> { await queue.confirmDisclosureConsent({ state, requestedAt: process.hrtime.bigint() }); }
	async function saved(event: TrackerEvent): Promise<EvidenceApproval> {
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		const cipher = new EvidenceCipher(await supplyEvidenceKeys(testSecrets, { keyIds: db.prepare('SELECT key_id FROM queue_encryption_keys').all().map(r => String(r.key_id)) }));
		try { const row = db.prepare('SELECT approval_json FROM event_approvals WHERE event_id = ?').get(event.eventId)!;
			return cipher.decrypt(event.eventId, JSON.parse(String(row.approval_json)), 'approval') as EvidenceApproval;
		} finally { cipher.dispose(); db.close(); }
	}
	const protocol = async (event: TrackerEvent) => (await saved(event)).assessmentEventApproval!.approvalProtocolVersion;
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'capture-disclosure-')); queue = await openTestWorkerQueue(storage(), []); id = randomUUID();
		upload = { version: 1, codingSessionId: '42', origin: 'https://assessment.invalid', credentialDigest: 'c'.repeat(64), deadline: END, locallyRevoked: false, captureClosed: false,
			request: { request_id: randomUUID(), local_recording_session_id: id, approval_action: 'approve_upload', consent_version: 'assessment-evidence.v1',
				scope: 'assessment_evidence', approved_workspace_ids: [A, B], event_types: [...PRIVACY_EVENT_TYPES] },
			receipt: { consent_id: randomUUID(), local_recording_session_id: id, consent_version: 'assessment-evidence.v1', scope: 'assessment_evidence',
				approved_workspace_ids: [A, B], event_types: [...PRIVACY_EVENT_TYPES], destination_origin: 'https://assessment.invalid', consented_at: START,
				expires_at: END, server_time: GRANT, state: 'active', evidence_window: { starts_at: START, ends_at: END }, upload_authorized: false, privacy_authorization: 'unverified' } };
		grant = { version: 1, codingSessionId: '42', origin: upload.origin, credentialDigest: upload.credentialDigest!, deadline: END, locallyRevoked: false,
			request: { request_id: randomUUID(), local_recording_session_id: id, upload_consent_id: upload.receipt!.consent_id,
				approval_action: 'approve_recruiter_disclosure', consent_version: 'assessment-disclosure.v1', audience: 'job_owning_recruiter', purpose: 'assessment_review',
				categories: ['code_changes'], approved_workspace_ids: [A], approved_source_sessions: [] } };
		grant.receipt = { consent_id: randomUUID(), upload_consent_id: grant.request.upload_consent_id, local_recording_session_id: id,
			consent_version: grant.request.consent_version, audience: grant.request.audience, purpose: grant.request.purpose,
			categories: grant.request.categories, approved_workspace_ids: [A], approved_source_sessions: [], consented_at: GRANT, expires_at: END, revoked_at: null,
			server_time: GRANT, state: 'active', upload_scope_state: 'active', raw_disclosure_enabled: false, event_authorization: 'capture_approval_contract_required' };
		privacy = { recordingActive: true, sessionId: id, approvedWorkspaceIds: [A, B], codexContentConsent: true, claudeContentConsent: true,
			confirmedCodexSessions: [{ sourceSessionId: 'codex-approved', workspaceId: A }, { sourceSessionId: 'codex-other', workspaceId: A }],
			confirmedClaudeSessions: [{ sourceSessionId: 'claude-approved', workspaceId: A }] };
		binding = { codingSessionId: '42', origin: upload.origin, consentReceiptId: upload.receipt!.consent_id, serverTime: GRANT };
		await queue.beginSession(id); await queue.setEvidenceConsent(upload); writer = newWriter();
	});
	teardown(async () => { await writer.close(); await queue.close(); await rm(root, { recursive: true, force: true }); });

	test('creates exactly eleven protocol-2 fields atomically over sanitized canonical event bytes', async () => {
		await confirm(); const event = file(); await writer.write(event);
		const proof = (await queue.getAssessmentUploadContext(event, binding))!.assessmentEventApproval!;
		assert.equal(proof.approvalProtocolVersion, 2); assert.equal(Object.keys(proof).length, 11);
		if (proof.approvalProtocolVersion !== 2) { assert.fail(); }
		assert.equal(proof.disclosureConsentReceiptId, grant.receipt!.consent_id); assert.equal(proof.disclosureCategory, 'code_changes');
		assert.equal(proof.disclosureContractVersion, 'assessment-disclosure.v1'); assert.equal(proof.consentReceiptId, upload.receipt!.consent_id);
		assert.equal(proof.eventDigest, canonicalSha256(event)); assert.ok(validAssessmentEventApproval(proof, event));
		assert.equal((await saved(event)).disclosureRequestId, grant.request.request_id);
		assert.deepEqual(await queue.getPending(10), [event]);
	});
	test('absent consent or a receipt merely loaded from storage keeps new events protocol 1', async () => {
		const absent = file(); await writer.write(absent); await queue.setDisclosureConsent(grant);
		const storedOnly = file(); await writer.write(storedOnly);
		assert.equal(await protocol(absent), 1); assert.equal(await protocol(storedOnly), 1);
	});
	test('never upgrades retained protocol-1 events when later consent is granted or the event is retried', async () => {
		const event = file(); await writer.write(event); const original = await saved(event);
		await confirm(); await queue.enqueueApproved(event, { ...privacy, approvedWorkspaceIds: [A], confirmedCodexSessions: [], confirmedClaudeSessions: [] });
		assert.deepEqual(await saved(event), original); assert.equal(await protocol(event), 1);
	});
	test('queued admission predating confirmation cannot retroactively acquire protocol 2', async () => {
		const capturedAt = process.hrtime.bigint(); await confirm();
		const event = file(); await queue.enqueueApproved(event, { ...privacy, approvedWorkspaceIds: [A], confirmedCodexSessions: [], confirmedClaudeSessions: [] }, capturedAt);
		assert.equal(await protocol(event), 1);
		const current = file(); await writer.write(current); assert.equal(await protocol(current), 2);
	});
	test('enforces consent start, exclusive end, category and approved workspace while preserving upload-only capture', async () => {
		await confirm();
		const early = { ...file(), timestamp: START }; const otherWorkspace = file(B);
		await writer.write(early); await writer.write(otherWorkspace); assert.equal(await protocol(early), 1); assert.equal(await protocol(otherWorkspace), 1);
		const atEnd = { ...file(), timestamp: END }; assert.equal(disclosureCoversEvent(grant, upload, atEnd), false);
		const prompt = createCodexEvent({ sessionId: id, workspaceId: A, sourceSessionId: 'codex-approved', eventType: 'ai.prompt.submitted', timestamp: new Date(GRANT),
			payload: { text: 'An approved local prompt, without disclosure scope.', sourceRecord: sourceRecord('codex') } });
		await writer.write(prompt); assert.equal(await protocol(prompt), 1);
	});
	test('Codex/Claude prompts, visible responses, tools and lifecycle require exact independently approved AI sessions', async () => {
		grant.request.categories = ['ai_interactions', 'tool_activity']; grant.request.approved_source_sessions = [
			{ source: 'codex', source_session_id: 'codex-approved' }, { source: 'claude', source_session_id: 'claude-approved' }];
		grant.receipt = { ...grant.receipt!, categories: grant.request.categories, approved_source_sessions: grant.request.approved_source_sessions };
		await confirm();
		const prompt = createCodexEvent({ sessionId: id, workspaceId: A, sourceSessionId: 'codex-approved', eventType: 'ai.prompt.submitted', timestamp: new Date(GRANT),
			payload: { text: 'Explain this change.', sourceRecord: sourceRecord('codex') } });
		const answer = createClaudeEvent({ sessionId: id, workspaceId: A, sourceSessionId: 'claude-approved', eventType: 'ai.response.completed', timestamp: new Date(GRANT),
			payload: { text: 'Visible answer.', sourceRecord: sourceRecord('claude') } });
		const tool = createClaudeEvent({ sessionId: id, workspaceId: A, sourceSessionId: 'claude-approved', eventType: 'ai.tool.started', timestamp: new Date(GRANT),
			payload: { toolName: 'Edit', callId: 'dummy-call', input: 'An example edit', status: 'running', matched: false, sourceRecord: sourceRecord('claude') } });
		const lifecycle = createClaudeEvent({ sessionId: id, workspaceId: A, sourceSessionId: 'claude-approved', eventType: 'ai.session.started', timestamp: new Date(GRANT),
			payload: { status: 'started', sourceRecord: { ...sourceRecord('claude'), recordType: 'claude_hook' } } });
		for (const event of [prompt, answer, tool, lifecycle]) { await writer.write(event); assert.equal(await protocol(event), 2); }
		const other = { ...prompt, eventId: randomUUID(), sourceSessionId: 'codex-other' }; await writer.write(other); assert.equal(await protocol(other), 1);
		const unrelated = { ...prompt, eventId: randomUUID(), sourceSessionId: 'unconfirmed' }; await assert.rejects(writer.write(unrelated));
	});
	test('redacted content binds only sanitized bytes, and rejected paths have no approval', async () => {
		grant.request.categories = ['ai_interactions']; grant.request.approved_source_sessions = [{ source: 'codex', source_session_id: 'codex-approved' }];
		grant.receipt = { ...grant.receipt!, categories: grant.request.categories, approved_source_sessions: grant.request.approved_source_sessions };
		await confirm();
		const event = createCodexEvent({ sessionId: id, workspaceId: A, sourceSessionId: 'codex-approved', eventType: 'ai.prompt.submitted', timestamp: new Date(GRANT),
			payload: { text: 'password="dummy-sensitive-password"', sourceRecord: sourceRecord('codex') } });
		await writer.write(event); const sanitized = (await queue.getPending(10))[0]; const proof = (await saved(sanitized)).assessmentEventApproval!;
		assert.equal(proof.approvalProtocolVersion, 2); assert.equal(proof.eventDigest, canonicalSha256(sanitized));
		assert.equal(JSON.stringify(sanitized).includes('dummy-sensitive-password'), false);
		await assert.rejects(writer.write({ ...file(), payload: { relativePath: '.env' } })); assert.equal(await queue.getPendingCount(), 1);
	});
	test('relationship events stay protocol 1 even with tool disclosure consent', async () => {
		grant.request.categories = ['tool_activity']; grant.request.approved_source_sessions = [{ source: 'codex', source_session_id: 'codex-approved' }];
		grant.receipt = { ...grant.receipt!, categories: grant.request.categories, approved_source_sessions: grant.request.approved_source_sessions }; await confirm();
		const sourceId = randomUUID(); const targetId = randomUUID();
		const event = createRelationshipEvent({ eventType: 'activity.relationship.created', sessionId: id, workspaceId: A, sourceSessionId: 'codex-approved', timestamp: new Date(GRANT), payload: {
			relationshipId: 'd'.repeat(64), sourceEventId: sourceId, targetEventId: targetId, relationshipType: 'tool_file_change', relativePath: 'src/example.ts',
			confidence: 'possible', explanationCode: 'timestamp_only', revision: 1, evidence: [{ eventId: sourceId, kind: 'tool_start' }, { eventId: targetId, kind: 'time_window' }] } });
		await writer.write(event); assert.equal(await protocol(event), 1);
	});
	test('immediate withdrawal cannot be undone by an old in-flight server confirmation', async () => {
		await confirm(); const before = file(); await writer.write(before);
		await queue.suspendDisclosureCapture(id, grant.request.request_id); await confirm();
		const after = file(); await writer.write(after); assert.equal(await protocol(before), 2); assert.equal(await protocol(after), 1);
		grant = { ...grant, locallyRevoked: true, pendingAction: 'revoke' }; await queue.setDisclosureConsent(grant);
		assert.equal(await queue.getAssessmentUploadContext(before, binding), undefined);
		grant = { ...grant, pendingAction: undefined, receipt: { ...grant.receipt!, state: 'revoked', revoked_at: LATER, server_time: LATER } };
		await confirm(); assert.ok(await queue.getAssessmentUploadContext(before, { ...binding, serverTime: LATER }));
	});
	test('revocation rejects captures at its boundary and never downgrades their immutable stored approvals', async () => {
		await confirm(); const event = file(); await writer.write(event); const original = await saved(event);
		grant = { ...grant, locallyRevoked: true, receipt: { ...grant.receipt!, state: 'revoked', revoked_at: GRANT } };
		await confirm(); assert.equal(await queue.getAssessmentUploadContext(event, binding), undefined);
		assert.deepEqual(await saved(event), original); assert.equal(await queue.getPendingCount(), 1);
	});
	test('restart restores exact encrypted approvals but no capture or upload freshness', async () => {
		await confirm(); const event = file(); await writer.write(event); const original = await saved(event);
		await writer.close(); const bytes = await readFile(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		assert.equal(bytes.includes(Buffer.from('disclosureConsentReceiptId')), false);
		queue = await openTestWorkerQueue(storage(), []); writer = newWriter();
		assert.equal(await queue.getAssessmentUploadContext(event, binding), undefined);
		const scopes = await queue.getAssessmentDisclosureConsents([event], binding); assert.equal(scopes.length, 1);
		await confirm(scopes[0]); assert.ok(await queue.getAssessmentUploadContext(event, binding));
		const fresh = file(); await writer.write(fresh); assert.equal(await protocol(fresh), 1); // Interrupted owner cannot resume capture permission.
		assert.deepEqual(await saved(event), original);
	});
	test('failed refresh or local closure pauses fresh captures without blocking recording/evidence persistence', async () => {
		await confirm(); await queue.suspendDisclosureCapture(); const event = file(); await writer.write(event); assert.equal(await protocol(event), 1);
		await confirm(); await queue.suspendDisclosureCapture(id, undefined, true); await confirm();
		const closed = file(); await writer.write(closed); assert.equal(await protocol(closed), 1);
	});
	test('invalid, cross-owner or unsupported confirmations cannot create capture authorization', async () => {
		for (const state of [{ ...grant, codingSessionId: '43' }, { ...grant, credentialDigest: 'd'.repeat(64) }, { ...grant, origin: 'https://other.invalid' },
			{ ...grant, receipt: { ...grant.receipt!, raw_disclosure_enabled: true } }, { ...grant, receipt: { ...grant.receipt!, consent_version: 'unsupported' } }]) {
			await assert.rejects(confirm(state as DisclosureState));
		}
		const event = file(); await writer.write(event); assert.equal(await protocol(event), 1);
	});
	test('a stale confirmation cannot be replayed as fresh merely because the encrypted receipt remains active', async () => {
		await assert.rejects(queue.confirmDisclosureConsent({ state: grant, requestedAt: process.hrtime.bigint() - BigInt(DISCLOSURE_CONFIRMATION_MS + 1) * 1000000n }));
		const event = file(); await writer.write(event); assert.equal(await protocol(event), 1);
	});
	test('superseding intent blocks the earlier grant even if its old response arrives later', async () => {
		await confirm(); const prior = structuredClone(grant);
		const next = { ...grant, request: { ...grant.request, request_id: randomUUID() }, receipt: undefined, pendingAction: 'grant' as const };
		await queue.setDisclosureConsent(next); await confirm(prior);
		const event = file(); await writer.write(event); assert.equal(await protocol(event), 1);
	});
	test('duplicate and acknowledged event IDs retain the original approval after revocation or retry', async () => {
		await confirm(); const event = file(); await writer.write(event); const before = await saved(event);
		await queue.markAcknowledged([event.eventId]); await queue.suspendDisclosureCapture(id, grant.request.request_id);
		await queue.enqueueApproved(event, { ...privacy, approvedWorkspaceIds: [A], confirmedCodexSessions: [], confirmedClaudeSessions: [] });
		assert.deepEqual(await saved(event), before); assert.equal(await queue.getPendingCount(), 0);
	});
	test('tampered encrypted approval references and changed event bytes never obtain an upload context', async () => {
		await confirm(); const event = file(); await writer.write(event);
		assert.equal(await queue.getAssessmentUploadContext({ ...event, payload: { relativePath: 'other.ts' } }, binding), undefined);
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		try { const row = db.prepare('SELECT approval_json FROM event_approvals WHERE event_id = ?').get(event.eventId)!;
			const encrypted = JSON.parse(String(row.approval_json)); encrypted.tag = Buffer.alloc(16).toString('base64');
			db.prepare('UPDATE event_approvals SET approval_json = ? WHERE event_id = ?').run(JSON.stringify(encrypted), event.eventId);
			await assert.rejects(queue.getAssessmentUploadContext(event, binding));
		} finally { db.close(); }
	});
	test('mixed v1/v2 batches preserve event order and eleven-field sidecars with no local approval secrets', async () => {
		const legacy = file(); await writer.write(legacy); await confirm(); const current = file(); await writer.write(current);
		const events = [legacy, current]; const contexts = await Promise.all(events.map(e => queue.getAssessmentUploadContext(e, binding)));
		const body = JSON.parse(serializeUploadBatch({ batchId: randomUUID(), createdAt: GRANT, byteSize: 100, events }, contexts as UploadPrivacyContext[], 100000).body);
		assert.deepEqual(Object.keys(body), ['contractVersion', 'batchId', 'events', 'eventApprovals']);
		assert.deepEqual(body.eventApprovals.map((p: { approvalProtocolVersion: number }) => p.approvalProtocolVersion), [1, 2]);
		assert.deepEqual(body.events, events); assert.equal(JSON.stringify(body).includes('disclosureRequestId'), false); assert.equal(JSON.stringify(body).includes('credentialDigest'), false);
	});
	test('matches the exact Rails portable Unicode/canonical digest vector and rejects metadata substitution', async () => {
		const vector = JSON.parse(await readFile(join(__dirname, '../../src/test/fixtures/rails-assessment-approval.v2.json'), 'utf8'));
		assert.equal(canonicalSha256(vector.event), vector.approval.eventDigest); assert.ok(validAssessmentEventApproval(vector.approval, vector.event));
		for (const changed of [{ ...vector.approval, disclosureCategory: 'tool_activity' }, { ...vector.approval, disclosureContractVersion: 'unsupported' },
			{ ...vector.approval, disclosureConsentReceiptId: null }, { ...vector.approval, approvalProtocolVersion: 1 }, { ...vector.approval, extra: true }]) {
			assert.equal(validAssessmentEventApproval(changed, vector.event), false);
		}
	});
});
