import { canonicalSha256 } from '../canonicalJson';
import { PROCESSING_DISPATCH_LIMITATIONS, RailsProcessorPolicyClient, validAssessmentProcessorPolicy, type AssessmentProcessorPolicy } from '../processorPolicy';
import * as assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { AssessmentApiError, type AssessmentAuthentication } from '../assessmentApiClient';
import type { DisclosureContext } from '../assessmentDisclosureConsent';
import { AssessmentProcessingConsent, PROCESSOR_UNAVAILABLE, type TrustedProcessorPolicy } from '../assessmentProcessingConsent';
import { CONFIGURE_PROCESSING_COMMAND, STATUS_PROCESSING_COMMAND, REVOKE_PROCESSING_COMMAND, PROCESSING_NOTICE,
	chooseProcessing, performProcessingAction, type ProcessingUI } from '../assessmentProcessingCommands';
import { RailsProcessingConsentClient } from '../railsProcessingConsentClient';
import { PROCESSING_LIMITATIONS, PROCESSING_PURPOSE, PROCESSING_RETENTION, PROCESSING_VERSION,
	validProcessingReceipt, validProcessingRequest, validProcessorScope, type ProcessingRequest, type ProcessingReceipt, type ProcessorScope } from '../processingConsent';
import type { EvidenceConsentState } from '../evidenceConsent';
import type { UploadHttpRequest, UploadHttpResponse } from '../httpsEventTransport';
import { createFileEvent } from '../eventSchema';
import { openTestWorkerQueue } from './queueTestKeys';

// Synthetic policy injection models future trusted deployment provisioning, NOT a production discovery API.
const processor: ProcessorScope = { backend: 'direct', provider: 'openai_compatible', model: 'synthetic-model', origin: 'https://processor.invalid', configuration_digest: 'b'.repeat(64) };
const workspaceId = 'a'.repeat(64); const source = { source: 'codex' as const, source_session_id: 'synthetic-ai-session' };
const now = '2030-01-01T10:00:01.000Z'; const deadline = '2030-01-01T11:00:00.000Z';
const auth: AssessmentAuthentication = { credential: 'synthetic-bearer', connection: { mode: 'rails', codingSessionId: '42',
	apiOrigin: 'https://assessment.invalid', uploadEndpoint: 'https://assessment.invalid/api/v2/coding_session/extension/events', credentialExpiresAt: deadline } };
const signal = () => AbortSignal.timeout(5000);
const selection = () => ({ categories: ['code_changes' as const], workspaceIds: [workspaceId], sourceSessions: [] });
function receipt(request: ProcessingRequest): ProcessingReceipt {
	return { consent_id: randomUUID(), local_recording_session_id: request.local_recording_session_id, upload_consent_id: request.upload_consent_id,
		consent_version: request.consent_version, purpose: PROCESSING_PURPOSE, retention_policy_version: request.retention_policy_version,
		...(request.processing_policy_digest ? { processing_policy_digest: request.processing_policy_digest } : {}),
		external_processing_permitted: request.external_processing_permitted, processor_scope: request.processor_scope,
		categories: request.categories, approved_workspace_ids: request.approved_workspace_ids, approved_source_sessions: request.approved_source_sessions,
		consented_at: now, capture_until: deadline, expires_at: '2030-01-02T10:00:01.000Z', revoked_at: null,
		external_processing_enabled: false, limitations: request.processing_policy_digest ? PROCESSING_DISPATCH_LIMITATIONS : PROCESSING_LIMITATIONS, state: request.external_processing_permitted ? 'preparation_only' : 'declined' };
}

suite('Assessment AI processing consent', () => {
	let manager: AssessmentProcessingConsent; let context: DisclosureContext; let upload: EvidenceConsentState;
	let calls: UploadHttpRequest[]; let secrets: Map<string, string>; let offline: boolean; let responseStatus: number;
	let malformed: (r: ProcessingReceipt) => unknown; let live: boolean; let policy: TrustedProcessorPolicy;
	let sources: { workspaceId: string; session: typeof source }[]; let server: Map<string, ProcessingReceipt>;
	let afterSend: (() => Promise<void>) | undefined;
	const client = () => new RailsProcessingConsentClient({ send: async input => {
		calls.push(input); if (offline) { throw new Error('PRIVATE dummy credential, evidence and path'); }
		if (responseStatus !== 200) { return { status: responseStatus, contentType: 'application/json', body: '{"error":"PRIVATE"}' }; }
		const body = JSON.parse(input.body); let r = server.get(body.request_id ?? body.consent_id);
		if (!r) { r = receipt(body); server.set(body.request_id, r); server.set(r.consent_id, r); }
		if (input.method === 'DELETE') { r = { ...r, revoked_at: now, state: 'revoked' }; server.set(r.consent_id, r); }
		await afterSend?.();
		return { status: 200, contentType: 'application/json', body: JSON.stringify({ data: malformed(r) }) };
	} });
	const coordinator = (trusted?: TrustedProcessorPolicy) => new AssessmentProcessingConsent({ get: async k => secrets.get(k), store: async (k, v) => { secrets.set(k, v); } },
		{ getEvidenceConsent: async () => structuredClone(upload) }, client(), () => sources, trusted);
	function ui(answers: unknown[][] = [], confirm = true) {
		const messages: string[] = []; let selections = 0; let confirmations = 0;
		const result: ProcessingUI = { message: m => { messages.push(m); }, choose: async states => states[0],
			select: async (_title, choices) => { selections++; assert.ok(choices.every(c => c.picked === false)); return answers.shift() as never; },
			confirm: async notice => { confirmations++; assert.ok(!notice.includes(auth.credential)); return confirm; } };
		return { result, messages, selections: () => selections, confirmations: () => confirmations };
	}
	setup(() => {
		const id = randomUUID(); context = { auth: structuredClone(auth), localSessionIds: [id], currentRecording: id, current: () => live };
		calls = []; secrets = new Map(); server = new Map(); offline = false; responseStatus = 200; malformed = r => r; live = true; afterSend = undefined;
		policy = async () => structuredClone(processor); sources = [{ workspaceId, session: source }];
		upload = { version: 1, codingSessionId: '42', origin: auth.connection.apiOrigin, credentialDigest: createHash('sha256').update(auth.credential).digest('hex'),
			deadline, locallyRevoked: false, captureClosed: false, request: { request_id: randomUUID(), local_recording_session_id: id,
				approval_action: 'approve_upload', consent_version: 'assessment-evidence.v1', scope: 'assessment_evidence',
				approved_workspace_ids: [workspaceId], event_types: ['file.diff', 'ai.prompt.submitted', 'ai.tool.started'] },
			receipt: { consent_id: randomUUID(), local_recording_session_id: id, consent_version: 'assessment-evidence.v1', scope: 'assessment_evidence',
				approved_workspace_ids: [workspaceId], event_types: ['file.diff', 'ai.prompt.submitted', 'ai.tool.started'], destination_origin: auth.connection.apiOrigin,
				consented_at: now, expires_at: deadline, server_time: now, state: 'active', evidence_window: { starts_at: now, ends_at: deadline },
				upload_authorized: false, privacy_authorization: 'unverified' } };
		manager = coordinator(policy);
	});
	test('production default has no trusted processor; configure sends nothing and does not ask for arbitrary values', async () => {
		const unavailable = coordinator(); const choice = ui();
		await performProcessingAction('grant', context, unavailable, choice.result, signal());
		assert.deepEqual(choice.messages, [PROCESSOR_UNAVAILABLE]); assert.equal(choice.selections(), 0); assert.equal(calls.length, 0); assert.equal(secrets.size, 0);
		await assert.rejects(unavailable.grant(context, selection(), processor, signal()));
	});
	test('explicit grant uses exact Rails fields, trusted processor and a durable pre-network intent', async () => {
		afterSend = async () => { const ledger = JSON.parse([...secrets.values()][0]); assert.equal(ledger[0].pendingAction, 'grant'); assert.equal(ledger[0].receipt, undefined); };
		const choice = ui([['code_changes'], [workspaceId]]);
		await performProcessingAction('grant', context, manager, choice.result, signal());
		assert.equal(choice.confirmations(), 1); assert.equal(calls.length, 1);
		const state = (await manager.list(context))[0]; assert.ok(validProcessingRequest(state.request));
		assert.deepEqual(JSON.parse(calls[0].body), state.request); assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].token, auth.credential);
		assert.equal(calls[0].endpoint.href, auth.connection.apiOrigin + '/api/v2/coding_session/extension/processing_consents');
		for (const privateField of [auth.credential, 'coding_session_id', 'payload', 'prompt']) { assert.equal(calls[0].body.includes(privateField), false); }
		assert.ok(choice.messages[0].includes('preparation_only')); assert.ok(choice.messages[0].includes('disabled'));
	});
	test('cancel, empty selection and explicit denial never grant or silently retry', async () => {
		for (const answers of [[], [[]], [['code_changes'], []]]) {
			await performProcessingAction('grant', context, manager, ui(answers).result, signal());
		}
		await performProcessingAction('grant', context, manager, ui([['code_changes'], [workspaceId]], false).result, signal());
		assert.equal(calls.length, 0); assert.equal(secrets.size, 0);
		for (const term of ['external AI service', 'separate', 'old evidence', 'Withdrawal blocks future preparation', 'provider retention']) { assert.ok(PROCESSING_NOTICE.includes(term)); }
	});
	test('AI categories require explicit content-approved source selection and never include unrelated sessions', async () => {
		const scope = await manager.choices(context);
		assert.equal(await chooseProcessing(ui([['ai_interactions'], [workspaceId], []]).result, processor, scope), undefined);
		const chosen = await chooseProcessing(ui([['ai_interactions', 'tool_activity'], [workspaceId], [source]]).result, processor, scope);
		assert.deepEqual(chosen!.sourceSessions, [source]);
		await manager.grant(context, chosen!, processor, signal()); assert.equal(calls.length, 1);
		sources = []; await assert.rejects(manager.grant(context, chosen!, processor, signal())); assert.equal(calls.length, 1);
	});
	test('status and revoke use known receipt and exact scoped body; withdrawal is separate from deletion', async () => {
		const state = await manager.grant(context, selection(), processor, signal()); const original = structuredClone(upload);
		await manager.inspect(context, state, signal());
		const message = ui(); await performProcessingAction('revoke', context, manager, message.result, signal());
		assert.equal(calls[1].method, 'POST'); assert.ok(calls[1].endpoint.pathname.endsWith('/status')); assert.equal(calls[2].method, 'DELETE');
		for (const call of calls.slice(1)) { assert.deepEqual(JSON.parse(call.body), { consent_id: state.receipt!.consent_id, local_recording_session_id: context.currentRecording }); }
		assert.deepEqual(upload, original); assert.ok(message.messages[0].includes('revoked')); assert.ok(message.messages[0].includes('locally withdrawn'));
	});
	test('status without local receipt is not a fabricated denial or a server-wide search', async () => {
		const message = ui(); await performProcessingAction('status', context, manager, message.result, signal());
		assert.equal(calls.length, 0); assert.ok(message.messages[0].includes('not a server-wide')); assert.equal(secrets.size, 0);
	});
	test('revoke cancellation makes no request or local state change', async () => {
		await manager.grant(context, selection(), processor, signal()); const before = [...secrets];
		await performProcessingAction('revoke', context, manager, ui([], false).result, signal()); assert.equal(calls.length, 1); assert.deepEqual([...secrets], before);
	});
	test('restart never replays grants; explicit same-scope retry uses original idempotency key', async () => {
		offline = true; await assert.rejects(manager.grant(context, selection(), processor, signal()));
		const requestId = (await manager.list(context))[0].request.request_id;
		manager = coordinator(policy); assert.equal(calls.length, 1); offline = false;
		const state = await manager.grant(context, selection(), processor, signal()); assert.equal(state.request.request_id, requestId);
		assert.equal(new Set(calls.map(c => JSON.parse(c.body).request_id)).size, 1);
	});
	test('offline withdrawal survives restart; unknown receipts are never recovered by replaying a grant', async () => {
		offline = true; await assert.rejects(manager.grant(context, selection(), processor, signal()));
		const state = (await manager.list(context))[0]; await assert.rejects(manager.revoke(context, state, signal()));
		manager = coordinator(policy); offline = false; const restored = (await manager.list(context))[0];
		assert.equal(restored.locallyRevoked, true); assert.equal(restored.pendingAction, 'revoke');
		await manager.inspect(context, restored, signal()); await assert.rejects(manager.grant(context, selection(), processor, signal()));
		assert.equal(calls.length, 1);
	});
	test('known receipt revoke retries after restart without new consent or altered identity', async () => {
		const state = await manager.grant(context, selection(), processor, signal()); offline = true;
		await assert.rejects(manager.revoke(context, state, signal())); assert.equal((await manager.list(context))[0].pendingAction, 'revoke');
		manager = coordinator(); offline = false; // Revoke does not need processor discovery or active capture.
		const revoked = await manager.revoke({ ...context, currentRecording: undefined }, state, signal());
		assert.equal(revoked.receipt!.consent_id, state.receipt!.consent_id); assert.equal(revoked.receipt!.state, 'revoked');
		assert.equal(revoked.pendingAction, undefined);
	});
	test('unsupported or changed trusted configuration and forged processor values fail closed', async () => {
		for (const wrong of [{ ...processor, provider: 'unknown' }, { ...processor, origin: 'http://processor.invalid' },
			{ ...processor, configuration_digest: 'invalid' }, { ...processor, extra: true }]) { assert.equal(validProcessorScope(wrong), false); }
		await assert.rejects(manager.grant(context, selection(), { ...processor, model: 'unapproved-model' }, signal()));
		manager = coordinator(async () => ({ ...processor, provider: 'unknown' }) as never);
		await assert.rejects(manager.processor(context)); assert.equal(calls.length, 0);
	});
	test('malformed, oversized and unsupported grant scopes are rejected before storage or transmission', async () => {
		for (const wrong of [{ ...selection(), categories: [] }, { ...selection(), categories: ['unknown'] },
			{ ...selection(), categories: ['code_changes', 'code_changes'] }, { ...selection(), sourceSessions: [source] },
			{ ...selection(), categories: ['tool_activity'], sourceSessions: [{ ...source, source_session_id: 'unrelated' }] }]) {
			await assert.rejects(manager.grant(context, wrong as ReturnType<typeof selection>, processor, signal()));
		}
		sources = Array.from({ length: 32 }, (_, i) => ({ workspaceId, session: { source: 'codex', source_session_id: `${i}`.padStart(256, 'x') } }));
		await assert.rejects(manager.grant(context, { ...selection(), categories: ['ai_interactions'], sourceSessions: sources.map(s => s.session) }, processor, signal()));
		assert.equal(calls.length, 0); assert.equal(secrets.size, 0);
	});
	test('wrong assessment, recording, workspace, credential generation and archived context are isolated', async () => {
		for (const wrong of [{ ...context, auth: { ...auth, connection: { ...auth.connection, codingSessionId: '43' } } },
			{ ...context, auth: { ...auth, credential: 'different-credential' } }, { ...context, localSessionIds: [randomUUID()] },
			{ ...context, current: () => false }, { ...context, currentRecording: undefined }]) {
			await assert.rejects(manager.grant(wrong, selection(), processor, signal()));
		}
		await assert.rejects(manager.grant(context, { ...selection(), workspaceIds: ['c'.repeat(64)] }, processor, signal()));
		assert.equal(calls.length, 0);
		const old = await manager.grant(context, selection(), processor, signal());
		const other = { ...context, auth: { ...auth, connection: { ...auth.connection, codingSessionId: '43' } } };
		assert.deepEqual(await manager.list(other), []); await assert.rejects(manager.revoke(other, old, signal())); assert.equal(calls.length, 1);
	});
	test('stopped/revoked upload scope cannot grant but never destroys existing local evidence', async () => {
		for (const invalid of [{ ...upload, locallyRevoked: true }, { ...upload, captureClosed: true }, { ...upload, receipt: undefined }]) {
			upload = invalid; await assert.rejects(manager.grant(context, selection(), processor, signal()));
		}
		assert.equal(calls.length, 0);
	});
	test('network, expired authentication and server rejections produce fixed safe codes only', async () => {
		for (const status of [401, 403, 409, 422, 429, 503]) {
			responseStatus = status;
			await assert.rejects(manager.grant(context, selection(), processor, signal()), e => e instanceof AssessmentApiError
				&& !e.message.includes('PRIVATE') && (status !== 401 || e.code === 'authentication'));
		}
		offline = true; await assert.rejects(manager.grant(context, selection(), processor, signal()), AssessmentApiError);
		assert.equal((await manager.list(context))[0].receipt, undefined);
	});
	test('invalid, overpermissive, mismatched, incomplete and immutable-changed receipts are rejected', async () => {
		const state = await manager.grant(context, selection(), processor, signal());
		for (const change of [{ consent_id: randomUUID() }, { upload_consent_id: randomUUID() }, { local_recording_session_id: randomUUID() },
			{ processor_scope: { ...processor, model: 'changed' } }, { external_processing_enabled: true }, { consent_version: 'unknown' },
			{ approved_workspace_ids: ['c'.repeat(64)] }, { categories: ['ai_interactions'] }, { expires_at: deadline },
			{ revoked_at: now, state: 'preparation_only' }, { capture_until: now }, { limitations: {} }, { purpose: undefined }, { extra: true }]) {
			assert.equal(validProcessingReceipt({ ...state.receipt!, ...change }, state.request, deadline, state.receipt), false);
		}
		malformed = r => ({ ...r, external_processing_enabled: true }); await assert.rejects(manager.inspect(context, state, signal()));
		assert.deepEqual((await manager.list(context))[0], JSON.parse(JSON.stringify(state)));
	});
	test('server-declined and expired receipts never imply active processing; capture and processing expiry differ', async () => {
		const state = await manager.grant(context, selection(), processor, signal());
		assert.ok(Date.parse(state.receipt!.expires_at) > Date.parse(deadline)); // Exact R5.0C 24h policy, not assessment deadline.
		assert.ok(validProcessingReceipt(receipt({ ...state.request, external_processing_permitted: false }), { ...state.request, external_processing_permitted: false }, deadline));
		malformed = r => ({ ...r, state: 'expired' }); assert.equal((await manager.inspect(context, state, signal())).receipt!.state, 'expired');
	});
	test('redirects, duplicate JSON keys, malformed JSON, media and size failures never reveal response bodies', async () => {
		const state = await manager.grant(context, selection(), processor, signal());
		const responses: UploadHttpResponse[] = [{ status: 302, body: 'PRIVATE' }, { status: 200, contentType: 'text/html', body: 'PRIVATE' },
			{ status: 200, contentType: 'application/json', body: '{"data":{},"data":{}}' }, { status: 200, contentType: 'application/json', body: 'PRIVATE' },
			{ status: 200, contentType: 'application/json', body: ' '.repeat(32769) }];
		for (const response of responses) { await assert.rejects(new RailsProcessingConsentClient({ send: async () => response }).send(auth, state, 'status', signal()),
			e => e instanceof AssessmentApiError && !e.message.includes('PRIVATE')); }
	});
	test('HTTP client rejects bad auth, insecure origins and wrong owner before network', async () => {
		const state = await manager.grant(context, selection(), processor, signal()); const count = calls.length;
		for (const wrong of [{ ...auth, credential: '' }, { ...auth, credential: 'other' }, { ...auth, connection: { ...auth.connection, mode: 'mock' as const } },
			{ ...auth, connection: { ...auth.connection, codingSessionId: '43' } }, { ...auth, connection: { ...auth.connection, apiOrigin: 'http://assessment.invalid' } }]) {
			await assert.rejects(client().send(wrong, state, 'status', signal()));
		}
		assert.equal(calls.length, count);
	});
	test('receipt capture window cannot outlast the authenticated credential, even if assessment deadline is later', async () => {
		const state = await manager.grant(context, selection(), processor, signal());
		await assert.rejects(client().send({ ...auth, connection: { ...auth.connection, credentialExpiresAt: now } }, state, 'status', signal()),
			e => e instanceof AssessmentApiError && e.code === 'protocol');
	});
	test('revocation racing a grant never restores local permission', async () => {
		let entered!: () => void; let release!: () => void;
		const waiting = new Promise<void>(resolve => { entered = resolve; });
		afterSend = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
		const granting = manager.grant(context, selection(), processor, signal()); await waiting;
		const stored = JSON.parse([...secrets.values()][0])[0]; const revoking = manager.revoke(context, stored, signal());
		afterSend = undefined; release(); await granting; const revoked = await revoking;
		assert.equal(revoked.locallyRevoked, true); assert.equal(revoked.receipt!.state, 'revoked');
	});
	test('scope change while dialog/request is open fails closed without contaminating the new assessment', async () => {
		afterSend = async () => { live = false; };
		await assert.rejects(manager.grant(context, selection(), processor, signal()));
		live = true; const state = (await manager.list(context))[0]; assert.equal(state.pendingAction, 'grant'); assert.equal(state.receipt, undefined);
	});
	test('SecretStorage corruption/failure fails closed before network and never logs raw state', async () => {
		const broken = new AssessmentProcessingConsent({ get: async () => undefined, store: async () => { throw new Error('PRIVATE'); } },
			{ getEvidenceConsent: async () => upload }, client(), () => sources, policy);
		await assert.rejects(broken.grant(context, selection(), processor, signal()), e => e instanceof AssessmentApiError && e.code === 'storage');
		assert.equal(calls.length, 0); await manager.grant(context, selection(), processor, signal());
		secrets.set([...secrets.keys()][0], 'PRIVATE'); await assert.rejects(manager.list(context), AssessmentApiError);
	});
	test('new controls cannot mutate or upgrade historical encrypted events, upload/disclosure scopes or delivery state', async function () {
		this.timeout(15000); const root = await mkdtemp(join(tmpdir(), 'processing-consent-')); const queue = await openTestWorkerQueue({ scheme: 'file', fsPath: root }, []);
		try {
			const event = createFileEvent({ sessionId: context.currentRecording!, workspaceId, source: 'vscode', eventType: 'file.saved', payload: { relativePath: 'synthetic.ts' } });
			await queue.enqueue(event); const before = await queue.getPending(10); const originalUpload = structuredClone(upload);
			await manager.grant(context, selection(), processor, signal()); const state = (await manager.list(context))[0]; await manager.revoke(context, state, signal());
			assert.deepEqual(await queue.getPending(10), before); assert.equal(await queue.getPendingCount(), 1); assert.deepEqual(upload, originalUpload);
			assert.equal(await queue.getUploadPrivacyContext(event), undefined);
		} finally { await queue.close(); await rm(root, { recursive: true, force: true }); }
	});

	test('authenticated policy discovery grants version-2 consent and preserves immutable policy after restart', async () => {
		const policy = syntheticPolicy(); const policyCalls: UploadHttpRequest[] = [];
		const discovery = new RailsProcessorPolicyClient({ send: async input => { policyCalls.push(input); return { status: 200, contentType: 'application/json', body: JSON.stringify({ data: policy }) }; } });
		manager = coordinator(c => discovery.get(c.auth, signal()));
		const choice = ui([['code_changes'], [workspaceId]]); await performProcessingAction('grant', context, manager, choice.result, signal());
		assert.equal(policyCalls.length, 2); // Fetch for display and fresh pre-grant verification.
		assert.ok(policyCalls.every(c => c.method === 'GET' && c.body === '' && c.endpoint.origin === auth.connection.apiOrigin && c.token === auth.credential));
		assert.ok(policyCalls.every(c => c.endpoint.pathname === '/api/v2/coding_session/extension/processor_policy'));
		let state = (await manager.list(context))[0]; assert.equal(state.request.consent_version, 'assessment-ai-processing.v2');
		assert.equal(state.request.processing_policy_digest, policy.policy_digest); assert.equal(state.policy!.processor.name, 'Synthetic Processor');
		manager = coordinator(); state = (await manager.list(context))[0];
		assert.equal((await manager.inspect(context, state, signal())).receipt!.processing_policy_digest, policy.policy_digest);
		assert.equal((await manager.revoke(context, state, signal())).receipt!.state, 'revoked');
	});
	test('new disclosure notice displays exact processor, categories and prospective withdrawal/report terms without preselection', async () => {
		const notices: string[] = []; const choice = ui([['ai_interactions'], [workspaceId], [source]]);
		choice.result.confirm = async text => { notices.push(text); return false; };
		assert.equal(await chooseProcessing(choice.result, syntheticPolicy(), await manager.choices(context)), undefined);
		for (const term of ['Synthetic Processor', 'synthetic-model', 'assessment-ai-processing.v2', 'cannot be recalled', '30-day', 'ai_interactions', 'Historical evidence gains no permission']) { assert.ok(notices[0].includes(term)); }
		assert.equal(calls.length, 0);
	});
	test('discovery rejects wrong assessment, modified terms/digests, unknown versions, private extra fields and authentication failures', async () => {
		for (const data of [{ ...syntheticPolicy(), coding_session_id: '43' }, { ...syntheticPolicy(), version: 'unknown' },
			{ ...syntheticPolicy(), api_key: 'PRIVATE' }, { ...syntheticPolicy(), processor: { ...syntheticPolicy().processor, name: 'Different Processor' } },
			{ ...syntheticPolicy(), terms: { ...syntheticPolicy().terms, reports_after_withdrawal: 'forever' } }]) {
			await assert.rejects(new RailsProcessorPolicyClient({ send: async () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) }) }).get(auth, signal()), AssessmentApiError);
		}
		for (const status of [401, 403, 302, 503]) { await assert.rejects(new RailsProcessorPolicyClient({ send: async () => ({ status, body: 'PRIVATE' }) }).get(auth, signal()), e => e instanceof AssessmentApiError && !e.message.includes('PRIVATE')); }
	});
	test('unavailable trusted policy never turns into a grant or an arbitrary provider choice', async () => {
		const discovery = new RailsProcessorPolicyClient({ send: async () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: {
			version: 'assessment-processor-policy.v1', available: false, reason: 'processor_policy_unavailable', evaluation_enabled: false, server_time: now, coding_session_id: '42'
		} }) }) });
		manager = coordinator(c => discovery.get(c.auth, signal())); const choice = ui();
		await performProcessingAction('grant', context, manager, choice.result, signal());
		assert.equal(choice.selections(), 0); assert.equal(calls.length, 0);
	});
	test('changed policy between display and grant cannot broaden consent or silently fall back to legacy', async () => {
		const shown = syntheticPolicy(); const changed = syntheticPolicy(false); manager = coordinator(async () => changed);
		await assert.rejects(manager.grant(context, selection(), shown, signal())); assert.equal(calls.length, 0); assert.equal(secrets.size, 0);
		assert.equal(validAssessmentProcessorPolicy(shown), true);
	});
	function syntheticPolicy(enabled = true): AssessmentProcessorPolicy {
		const body = { version: 'assessment-processor-policy.v1' as const, available: true as const, purpose: 'assessment_performance_evaluation' as const,
			consent_version: 'assessment-ai-processing.v2' as const, retention_policy_version: 'assessment-report-retention.v1' as const,
			processor: { id: 'synthetic-operator', name: 'Synthetic Processor', description: 'Synthetic test provider', external: true as const },
			processor_scope: processor, categories: ['ai_interactions', 'code_changes', 'tool_activity'], evaluation_enabled: enabled,
			terms: { provider_data_policy: 'operator_approved_no_training' as const, withdrawal: 'blocks_undispatched_requests' as const,
				reports_after_withdrawal: 'retain_until_expiry' as const, report_retention_days: 30, prepared_input_persistence: 'none' as const, prospective_only: true as const } };
		return { ...body, policy_digest: canonicalSha256(body), coding_session_id: '42', server_time: now };
	}
	test('all processing commands are contributed and registered without automatically enabling consent', async function () {
		this.timeout(15000); const extension = vscode.extensions.all.find(e => e.packageJSON.name === 'ai-developer-tracker'); assert.ok(extension); await extension.activate();
		const commands = await vscode.commands.getCommands();
		for (const command of [CONFIGURE_PROCESSING_COMMAND, STATUS_PROCESSING_COMMAND, REVOKE_PROCESSING_COMMAND]) {
			assert.ok(commands.includes(command)); assert.ok(extension.packageJSON.contributes.commands.some((c: { command: string }) => c.command === command));
		}
	});
});
