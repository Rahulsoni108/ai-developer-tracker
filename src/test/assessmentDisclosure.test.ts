import * as assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AssessmentApiError, type AssessmentAuthentication } from '../assessmentApiClient';
import { AssessmentDisclosureConsent, type DisclosureContext, type DisclosureSelection } from '../assessmentDisclosureConsent';
import { CATEGORY_CHOICES, DISCLOSURE_NOTICE, chooseDisclosure, type DisclosureChoiceUI } from '../assessmentDisclosureChoices';
import { validDisclosureRequest, validDisclosureReceipt, type DisclosureReceipt, type DisclosureState } from '../assessmentDisclosure';
import { RailsDisclosureConsentClient } from '../railsDisclosureConsentClient';
import type { UploadHttpRequest } from '../httpsEventTransport';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { LOCAL_QUEUE_FILENAME } from '../localEventQueue';
import type { EvidenceConsentState } from '../evidenceConsent';
import { createFileEvent } from '../eventSchema';
import { EventPersistence } from '../eventPersistence';
import { openTestWorkerQueue } from './queueTestKeys';

const workspaceId = 'a'.repeat(64);
const now = '2030-01-01T10:00:01.000Z'; const deadline = '2030-01-01T11:00:00.000Z';
const source = { source: 'codex' as const, source_session_id: 'dummy-private-session' };
const auth: AssessmentAuthentication = { credential: 'adt_ext_' + 'a'.repeat(43), connection: { codingSessionId: '42', apiOrigin: 'https://assessment.invalid',
	uploadEndpoint: 'https://assessment.invalid/api/v2/coding_session/extension/events', mode: 'rails' } };
const signal = () => AbortSignal.timeout(2000);

suite('Independent disclosure choices', () => {
	const scope = { workspaceIds: [workspaceId], sources: [{ workspaceId, session: source }] };
	function ui(answers: unknown[][], confirm = true): DisclosureChoiceUI {
		return { select: async (_title, choices) => { assert.ok(choices.every(c => c.picked === false)); return answers.shift() as never; }, confirm: async notice => {
			assert.ok(notice.includes('job') || notice.includes('recruiter')); return confirm;
		} };
	}
	test('all three independent categories are unselected and notice scopes audience/purpose separately', () => {
		assert.equal(CATEGORY_CHOICES.length, 3); assert.ok(CATEGORY_CHOICES.every(c => !c.picked));
		for (const text of ['assessment-disclosure.v1', 'assessment review', 'Recording, upload and disclosure', 'Existing events']) { assert.ok(DISCLOSURE_NOTICE.includes(text)); }
	});
	test('empty, cancelled, and final declined choices never grant', async () => {
		for (const answers of [[[]], [], [['code_changes'], []]]) { assert.equal(await chooseDisclosure(ui(answers), scope), undefined); }
		assert.equal(await chooseDisclosure(ui([['code_changes'], [workspaceId]], false), scope), undefined);
	});
	test('code-only consent never silently selects AI sessions', async () => {
		assert.deepEqual(await chooseDisclosure(ui([['code_changes'], [workspaceId]]), scope), { categories: ['code_changes'], workspaceIds: [workspaceId], sourceSessions: [] });
	});
	test('AI interactions and tools require explicit confirmed source selection, separately from code', async () => {
		for (const category of ['ai_interactions', 'tool_activity']) {
			assert.equal(await chooseDisclosure(ui([[category], [workspaceId], []]), scope), undefined);
			assert.deepEqual((await chooseDisclosure(ui([[category], [workspaceId], [source]]), scope))!.sourceSessions, [source]);
		}
	});
	test('no AI sources or sources in another workspace cannot be silently approved', async () => {
		await assert.rejects(chooseDisclosure(ui([['ai_interactions'], [workspaceId]]), { ...scope, sources: [] }));
		await assert.rejects(chooseDisclosure(ui([['tool_activity'], ['b'.repeat(64)]]), scope));
	});
});

suite('Rails disclosure lifecycle and encrypted worker storage', function () {
	this.timeout(15000);
	let root: string; let queue: AsyncLocalEventQueue; let context: DisclosureContext; let consent: AssessmentDisclosureConsent;
	let calls: UploadHttpRequest[]; let upload: EvidenceConsentState; let offline: boolean; let status: number;
	let transform: (receipt: DisclosureReceipt) => DisclosureReceipt; let receipts: Map<string, DisclosureReceipt>;
	let sources: { workspaceId: string; session: typeof source }[];
	const storage = () => ({ scheme: 'file', fsPath: join(root, 'queue') });
	const selection = (): DisclosureSelection => ({ categories: ['code_changes'], workspaceIds: [workspaceId], sourceSessions: [] });
	const api = () => new RailsDisclosureConsentClient({ send: async request => {
		calls.push(request); if (offline) { throw new Error('PRIVATE: token, path and conversation must never escape'); }
		if (status !== 200) { return { status, contentType: 'application/json', body: '{"error":"PRIVATE"}' }; }
		assert.equal(request.token, auth.credential); const body = JSON.parse(request.body);
		let receipt = receipts.get(body.request_id ?? body.consent_id);
		if (!receipt) {
			receipt = { consent_id: randomUUID(), local_recording_session_id: body.local_recording_session_id, upload_consent_id: body.upload_consent_id,
				consent_version: body.consent_version, audience: body.audience, purpose: body.purpose, categories: body.categories,
				approved_workspace_ids: body.approved_workspace_ids, approved_source_sessions: body.approved_source_sessions,
				consented_at: now, expires_at: deadline, revoked_at: null, server_time: now, state: 'active', upload_scope_state: 'active',
				raw_disclosure_enabled: false, event_authorization: 'capture_approval_contract_required' };
			receipts.set(body.request_id, receipt); receipts.set(receipt.consent_id, receipt);
		}
		if (request.method === 'DELETE') { receipt = { ...receipt, state: 'revoked', revoked_at: now }; receipts.set(receipt.consent_id, receipt); }
		return { status: 200, contentType: 'application/json', body: JSON.stringify({ data: transform(receipt) }) };
	} });
	const coordinator = () => new AssessmentDisclosureConsent(queue, api(), () => sources);
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'disclosure-')); queue = await openTestWorkerQueue(storage(), []);
		const localId = randomUUID(); calls = []; receipts = new Map(); offline = false; status = 200; transform = v => v;
		sources = [{ workspaceId, session: source }];
		context = { auth, localSessionIds: [localId], currentRecording: localId, current: () => true };
		upload = { version: 1, credentialDigest: createHash('sha256').update(auth.credential).digest('hex'), codingSessionId: '42', origin: auth.connection.apiOrigin,
			deadline, locallyRevoked: false, captureClosed: false, request: { request_id: randomUUID(), local_recording_session_id: localId, approval_action: 'approve_upload', consent_version: 'assessment-evidence.v1',
				scope: 'assessment_evidence', approved_workspace_ids: [workspaceId], event_types: ['file.modified', 'file.diff', 'ai.prompt.submitted', 'ai.response.completed', 'ai.tool.started'] } };
		upload.receipt = { consent_id: randomUUID(), local_recording_session_id: localId, consent_version: 'assessment-evidence.v1', scope: 'assessment_evidence',
			approved_workspace_ids: [workspaceId], event_types: upload.request.event_types, destination_origin: upload.origin, consented_at: now, expires_at: deadline,
			server_time: now, state: 'active', evidence_window: { starts_at: now, ends_at: deadline }, upload_authorized: false, privacy_authorization: 'unverified' };
		await queue.setEvidenceConsent(upload); consent = coordinator();
	});
	teardown(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });

	test('grant uses exact versioned Rails body without caller ownership IDs or bearer in payload', async () => {
		const state = await consent.grant(context, selection(), signal());
		assert.equal(calls.length, 1); assert.equal(calls[0].method, 'POST');
		assert.equal(calls[0].endpoint.href, auth.connection.apiOrigin + '/api/v2/coding_session/extension/disclosure_consents');
		assert.deepEqual(JSON.parse(calls[0].body), state.request); assert.ok(validDisclosureRequest(state.request));
		assert.equal(calls[0].body.includes(auth.credential), false); assert.equal(calls[0].body.includes('coding_session_id'), false);
		assert.equal(state.receipt!.raw_disclosure_enabled, false); assert.equal(state.pendingAction, undefined);
		assert.deepEqual(await queue.getEvidenceConsent(context.currentRecording!), upload);
	});
	test('status and prospective revoke use body-only scoped lookup and leave upload consent untouched', async () => {
		const state = await consent.grant(context, selection(), signal());
		await consent.inspect(context, state, signal()); const revoked = await consent.revoke(context, state, signal());
		assert.equal(revoked.locallyRevoked, true); assert.equal(revoked.receipt!.state, 'revoked');
		for (const call of calls.slice(1)) { assert.deepEqual(JSON.parse(call.body), { consent_id: state.receipt!.consent_id, local_recording_session_id: context.currentRecording }); assert.equal(call.endpoint.search, ''); }
		assert.ok(calls[1].endpoint.pathname.endsWith('/status')); assert.equal(calls[1].method, 'POST'); assert.equal(calls[2].method, 'DELETE');
		assert.deepEqual(await queue.getEvidenceConsent(context.currentRecording!), upload);
	});
	test('private source scope and receipt survive restart encrypted, never become an event approval', async () => {
		const state = await consent.grant(context, { ...selection(), categories: ['ai_interactions'], sourceSessions: [source] }, signal());
		await queue.close(); const bytes = await readFile(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		assert.equal(bytes.includes(Buffer.from(source.source_session_id)), false); assert.equal(bytes.includes(Buffer.from(auth.credential)), false);
		queue = await openTestWorkerQueue(storage(), []); consent = coordinator();
		assert.deepEqual(await consent.list(context), JSON.parse(JSON.stringify([state]))); assert.equal((await consent.inspect(context, state, signal())).receipt!.state, 'active');
		assert.equal(await queue.getPendingCount(), 0);
	});
	test('lost grant response retains durable intent and explicit retry reuses original request ID after restart', async () => {
		offline = true; await assert.rejects(consent.grant(context, selection(), signal()));
		const intent = (await consent.list(context))[0]; assert.equal(intent.pendingAction, 'grant');
		await queue.close(); queue = await openTestWorkerQueue(storage(), []); consent = coordinator(); offline = false;
		const restored = await consent.grant(context, selection(), signal()); assert.equal(restored.request.request_id, intent.request.request_id);
		assert.equal(new Set(calls.map(c => JSON.parse(c.body).request_id)).size, 1);
	});
	test('unknown outcome withdrawal is durable and never replays registration to discover a receipt', async () => {
		offline = true; await assert.rejects(consent.grant(context, selection(), signal())); const state = (await consent.list(context))[0]; offline = false;
		await assert.rejects(consent.revoke(context, state, signal()), e => e instanceof AssessmentApiError && e.code === 'recovery_required');
		await queue.close(); queue = await openTestWorkerQueue(storage(), []); consent = coordinator();
		const stored = (await consent.list(context))[0]; assert.equal(stored.locallyRevoked, true); assert.equal(stored.pendingAction, 'revoke');
		await consent.inspect(context, stored, signal()); await assert.rejects(consent.revoke(context, stored, signal())); assert.equal(calls.length, 1);
	});
	test('offline revoke denies locally first and retry after restart uses same receipt', async () => {
		const state = await consent.grant(context, selection(), signal()); offline = true;
		await assert.rejects(consent.revoke(context, state, signal())); assert.equal((await consent.list(context))[0].locallyRevoked, true);
		await queue.close(); queue = await openTestWorkerQueue(storage(), []); consent = coordinator(); offline = false;
		const revoked = await consent.revoke(context, state, signal()); assert.equal(revoked.receipt!.consent_id, state.receipt!.consent_id); assert.equal(revoked.pendingAction, undefined);
		await assert.rejects(queue.setDisclosureConsent({ ...revoked, locallyRevoked: false }));
	});
	test('stopped capture, revoked upload, and missing upload receipt cannot grant', async () => {
		await assert.rejects(consent.grant({ ...context, currentRecording: undefined }, selection(), signal()));
		await queue.setEvidenceConsent({ ...upload, captureClosed: true }); await assert.rejects(consent.grant(context, selection(), signal())); assert.equal(calls.length, 0);
	});
	test('cross-assessment, credential-generation and workspace isolation before transmission', async () => {
		for (const wrong of [{ ...context, auth: { ...auth, connection: { ...auth.connection, codingSessionId: '43' } } },
			{ ...context, auth: { ...auth, credential: 'different-dummy-token' } }, { ...context, localSessionIds: [randomUUID()] }, { ...context, current: () => false }]) {
			await assert.rejects(consent.grant(wrong, selection(), signal()));
		}
		await assert.rejects(consent.grant(context, { ...selection(), workspaceIds: ['b'.repeat(64)] }, signal())); assert.equal(calls.length, 0);
	});
	test('AI sessions must remain confirmed and in a selected approved workspace', async () => {
		for (const session of [{ ...source, source_session_id: 'unrelated' }, { ...source, source: 'claude' as const }]) {
			await assert.rejects(consent.grant(context, { ...selection(), categories: ['ai_interactions'], sourceSessions: [session] }, signal()));
		}
		sources = [{ workspaceId: 'b'.repeat(64), session: source }];
		await assert.rejects(consent.grant(context, { ...selection(), categories: ['tool_activity'], sourceSessions: [source] }, signal())); assert.equal(calls.length, 0);
	});
	test('code-only AI wildcard, empty choices and duplicate categories reject', async () => {
		for (const invalid of [{ ...selection(), sourceSessions: [source] }, { ...selection(), categories: [] },
			{ ...selection(), categories: ['code_changes', 'code_changes'] as const },
			{ ...selection(), categories: ['ai_interactions'] as const, sourceSessions: [] }]) { await assert.rejects(consent.grant(context, invalid as DisclosureSelection, signal())); }
		assert.equal(calls.length, 0);
	});
	test('4096-byte and 32-source limits reject before storage/network even with approved dummy sources', async () => {
		sources = Array.from({ length: 32 }, (_, i) => ({ workspaceId, session: { source: 'codex' as const, source_session_id: String(i).padStart(256, 'x') } }));
		await assert.rejects(consent.grant(context, { ...selection(), categories: ['ai_interactions'], sourceSessions: sources.map(s => s.session) }, signal()));
		assert.equal(calls.length, 0); assert.deepEqual(await consent.list(context), []);
	});

	test('storage failure preserves prior state and never makes a grant request', async () => {
		const broken = new AssessmentDisclosureConsent({ getDisclosureConsents: id => queue.getDisclosureConsents(id), getEvidenceConsent: id => queue.getEvidenceConsent(id),
			setDisclosureConsent: async () => { throw new Error('PRIVATE storage failure'); } }, api(), () => sources);
		await assert.rejects(broken.grant(context, selection(), signal())); assert.equal(calls.length, 0); assert.deepEqual(await consent.list(context), []);
	});

	test('unsupported media, redirects, duplicate JSON keys, unknown fields and oversized responses fail closed', async () => {
		const state = await consent.grant(context, selection(), signal());
		for (const response of [
			{ status: 302, contentType: 'application/json', body: '{}' },
			{ status: 200, contentType: 'text/html', body: '{}' },
			{ status: 200, contentType: 'application/json', body: '{"data":{},"data":{}}' },
			{ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { ...state.receipt, extra: true } }) },
			{ status: 200, contentType: 'application/json', body: 'x'.repeat(32769) }
		]) { await assert.rejects(new RailsDisclosureConsentClient({ send: async () => response }).send(auth, state, 'status', signal()), AssessmentApiError); }
	});

	test('schema v10 upgrade preserves event bytes and never invents disclosure grants', async () => {
		const event = createFileEvent({ sessionId: context.currentRecording!, workspaceId, source: 'vscode', eventType: 'file.saved', payload: { relativePath: 'example.ts' } });
		await queue.enqueue(event); await queue.close();
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		try { db.exec('DROP TABLE disclosure_consents; PRAGMA user_version = 10;'); } finally { db.close(); }
		queue = await openTestWorkerQueue(storage(), []); consent = coordinator();
		assert.deepEqual(await consent.list(context), []); assert.deepEqual(await queue.getPending(10), [event]);
	});

	test('expired or revoked receipts never claim active permission, mismatches fail closed', async () => {
		const state = await consent.grant(context, selection(), signal());
		for (const changed of [{ ...state.receipt!, consent_id: 'not-a-uuid' }, { ...state.receipt!, upload_consent_id: randomUUID() },
			{ ...state.receipt!, approved_workspace_ids: ['b'.repeat(64)] }, { ...state.receipt!, server_time: deadline },
			{ ...state.receipt!, expires_at: '2030-01-01T12:00:00.000Z' }, { ...state.receipt!, raw_disclosure_enabled: true }]) {
			assert.equal(validDisclosureReceipt(changed as DisclosureReceipt, state), false);
		}
		transform = v => ({ ...v, state: 'expired', server_time: deadline });
		assert.equal((await consent.inspect(context, state, signal())).receipt!.state, 'expired');
	});
	test('malformed, unsupported and overpermissive control responses are never persisted', async () => {
		transform = v => ({ ...v, event_authorization: 'allow_all' } as unknown as DisclosureReceipt);
		await assert.rejects(consent.grant(context, selection(), signal()), e => e instanceof AssessmentApiError && e.code === 'protocol');
		assert.equal((await consent.list(context))[0].receipt, undefined);
	});
	test('authentication, network and server failures disclose only fixed codes', async () => {
		for (const code of [401, 403, 409, 422, 429, 503]) {
			status = code;
			await assert.rejects(consent.grant(context, selection(), signal()), e => e instanceof AssessmentApiError && !e.message.includes('PRIVATE'));
		}
		offline = true; await assert.rejects(consent.grant(context, selection(), signal()), e => e instanceof AssessmentApiError && !e.message.includes('PRIVATE'));
	});
	test('immutable receipt and request cannot change scope, owner, deadline or backdate consent', async () => {
		const state = await consent.grant(context, selection(), signal());
		for (const changed of [{ ...state, codingSessionId: '43' }, { ...state, origin: 'https://other.invalid' },
			{ ...state, credentialDigest: 'b'.repeat(64) }, { ...state, receipt: undefined },
			{ ...state, request: { ...state.request, categories: ['tool_activity'] as const, approved_source_sessions: [source] } },
			{ ...state, receipt: { ...state.receipt!, consented_at: '2030-01-01T10:00:00.000Z' } }]) { await assert.rejects(queue.setDisclosureConsent(changed as DisclosureState)); }
	});
	test('AES-GCM detects tampering with encrypted disclosure state after reopening', async () => {
		const state = await consent.grant(context, selection(), signal()); await queue.close();
		const db = new DatabaseSync(join(storage().fsPath, LOCAL_QUEUE_FILENAME));
		try { const row = db.prepare('SELECT state_json FROM disclosure_consents WHERE request_id = ?').get(state.request.request_id)!;
			const envelope = JSON.parse(String(row.state_json)); envelope.tag = Buffer.alloc(16).toString('base64');
			db.prepare('UPDATE disclosure_consents SET state_json = ? WHERE request_id = ?').run(JSON.stringify(envelope), state.request.request_id);
		} finally { db.close(); }
		queue = await openTestWorkerQueue(storage(), []); consent = coordinator(); await assert.rejects(consent.list(context));
	});
	test('a grant leaves old and new protocol-1 evidence unchanged; privacy filtering still precedes storage', async () => {
		await queue.beginSession(context.currentRecording!);
		const event = createFileEvent({ sessionId: context.currentRecording!, workspaceId, source: 'vscode', eventType: 'file.modified', timestamp: new Date(now), payload: { relativePath: 'src/example.ts' } });
		await queue.enqueue(event); const old = await queue.getPending(10);
		await consent.grant(context, selection(), signal()); assert.deepEqual(await queue.getPending(10), old);
		const writer = new EventPersistence(queue, { write: async () => {}, flush: async () => {} }, undefined, { context: () => ({ recordingActive: true,
			sessionId: context.currentRecording!, approvedWorkspaceIds: [workspaceId], confirmedCodexSessions: [], codexContentConsent: false }) });
		assert.equal(await writer.resolveUploadPrivacyContext(event), undefined);
		await assert.rejects(writer.write({ ...event, eventId: randomUUID(), payload: { relativePath: '.env' } })); await writer.flush();
		const next = { ...event, eventId: randomUUID() }; await writer.write(next); await writer.flush();
		assert.equal(JSON.stringify(await queue.getPending(10)).includes('disclosureConsentReceiptId'), false);
		assert.equal(await queue.getPendingCount(), 2); assert.equal((await queue.getPending(1))[0].eventId, event.eventId);
	});
});
