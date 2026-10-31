import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile, appendFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSha256 } from '../canonicalJson';
import { RecordingController } from '../recording';
import { AssessmentController } from '../assessmentController';
import { AssessmentConnectionStore } from '../assessmentStorage';
import { AssessmentWorkflowConsent, createWorkflowBundle } from '../assessmentWorkflowConsent';
import { RailsWorkflowConsentClient } from '../railsWorkflowConsentClient';
import { validWorkflowStartBundle, validWorkflowSourceBundle, type WorkflowPolicy } from '../assessmentWorkflowContract';
import { validNativeSourceBundle, nativeIdentityDigest, NATIVE_SESSION_VERSION } from '../assessmentNativeSession';
import { PROCESSING_DISPATCH_LIMITATIONS } from '../processorPolicy';
import { NativeCodexCapture } from '../nativeCodexCapture';
import { EventPersistence } from '../eventPersistence';
import { createFileEvent, createCodexEvent } from '../eventSchema';
import { openTestWorkerQueue } from './queueTestKeys';
import type { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import type { AssessmentApiClient, AssessmentAuthentication, AssessmentServerStatus } from '../assessmentApiClient';
import { AssessmentApiError } from '../assessmentApiClient';
import type { UploadTransport } from '../httpsEventTransport';
import type { DisclosureRequest } from '../assessmentDisclosure';
import type { ProcessingRequest } from '../processingConsent';
import type { WorkflowStartBundle, WorkflowSourceBundle } from '../assessmentWorkflowContract';

const W = 'a'.repeat(64); const START = '2030-01-01T10:00:00.000Z'; const END = '2030-01-01T11:00:00.000Z';
const origin = 'https://assessment.invalid';
function policy(): WorkflowPolicy {
 const body = { version: 'assessment-processor-policy.v1' as const, available: true as const, purpose: 'assessment_performance_evaluation' as const,
  consent_version: 'assessment-ai-processing.v2' as const, retention_policy_version: 'assessment-report-retention.v1' as const,
  processor: { id: 'synthetic', name: 'Synthetic Processor', description: 'Synthetic only', external: true as const },
  processor_scope: { backend: 'direct' as const, provider: 'openai_compatible' as const, model: 'synthetic-model', origin: 'https://synthetic.invalid', configuration_digest: 'b'.repeat(64) },
  categories: ['ai_interactions', 'code_changes', 'tool_activity'], evaluation_enabled: true,
  terms: { provider_data_policy: 'operator_approved_no_training' as const, withdrawal: 'blocks_undispatched_requests' as const,
   reports_after_withdrawal: 'retain_until_expiry' as const, report_retention_days: 30, prepared_input_persistence: 'none' as const, prospective_only: true as const } };
 return { consent_version: 'assessment-workflow.v1', source_mode: 'extension_launched_only', providers: ['claude','codex'],
  processor_policy: { ...body, policy_digest: canonicalSha256(body), coding_session_id: '42', server_time: START } };
}

suite('Explicit workflow consent integration', () => {
 let root: string; let queue: AsyncLocalEventQueue; let recording: RecordingController; let workflow: AssessmentWorkflowConsent;
 let controller: AssessmentController; let writer: EventPersistence; let auth: AssessmentAuthentication;
 let secrets: Map<string,string>; let memory: Map<string,unknown>; let status: AssessmentServerStatus;
 let accepted: boolean; let dialogs: number; let oldUploadDialogs: number; let requests: string[]; let fail: string | undefined;
 let initial: WorkflowStartBundle | undefined; let uploadId: string; let revoked: boolean; let windowsClosed: boolean;
 let disclosures: { request: DisclosureRequest; receipt: Record<string,unknown> }[];
 let processing: Map<string,{ request: ProcessingRequest; receipt: Record<string,unknown> }>;
 let workspaceIds: string[]; let mutation: ((value: unknown) => unknown) | undefined;
 let nativeSupported: boolean; let nativeSources: { sourceSessionId: string; workspaceId: string }[];
 const json = (data: unknown) => ({ status: 200, headers: {}, contentType: 'application/json', body: JSON.stringify({ data: mutation ? mutation(data) : data }) });
 function response(bundle: WorkflowStartBundle | WorkflowSourceBundle) {
  const localId = 'upload' in bundle ? bundle.intent.local_recording_session_id : bundle.disclosure.local_recording_session_id;
  const d = disclosures.find(d => d.request.request_id === bundle.disclosure.request_id)!;
  const p = processing.get(bundle.processing.request_id)!;
  return { consent_version: 'assessment-workflow.v1', workflow_consent_id: initial!.intent.request_id, coding_session_id: '42',
   state: revoked || windowsClosed ? 'blocked' : 'active', server_time: START, request: bundle,
   status: { coding_session_id: '42', state: 'active', server_time: START, local_recording_session_ids: status.localRecordingSessionIds, started_at: START, deadline: END },
   upload: { request: initial!.upload, receipt: { consent_id: uploadId, local_recording_session_id: localId, consent_version: 'assessment-evidence.v1', scope: 'assessment_evidence',
    approved_workspace_ids: initial!.upload.approved_workspace_ids, event_types: initial!.upload.event_types, destination_origin: origin, consented_at: START,
    expires_at: END, server_time: START, state: revoked ? 'revoked' : windowsClosed ? 'stopped' : 'active', ...(revoked ? { revoked_at: START } : {}),
    evidence_window: { starts_at: START, ends_at: windowsClosed ? START : END, ...(windowsClosed ? { stopped_at: START } : {}) }, upload_authorized: false, privacy_authorization: 'unverified' } },
   disclosure: d, processing: p, confirmations: disclosures.filter(item => item.request.local_recording_session_id === localId) };
 }
 function addScopes(bundle: WorkflowStartBundle | WorkflowSourceBundle) {
  const resolve = (purpose: 'disclosure' | 'processing') => {
   const r = { ...bundle[purpose] } as unknown as Record<string,unknown>; delete r.upload_request_id; r.upload_consent_id = uploadId; return r;
  };
  const d = resolve('disclosure') as unknown as DisclosureRequest;
  if (!disclosures.some(s => s.request.request_id === d.request_id)) {
   const { request_id, approval_action, ...scope } = d; void request_id; void approval_action;
   disclosures.push({ request: d, receipt: { ...scope, consent_id: randomUUID(), consented_at: START, expires_at: END, revoked_at: null, server_time: START,
    state: 'active', upload_scope_state: 'active', raw_disclosure_enabled: false, event_authorization: 'capture_approval_contract_required' } });
  }
  const p = resolve('processing') as unknown as ProcessingRequest;
  if (!processing.has(p.request_id)) {
   const { request_id, approval_action, ...scope } = p; void request_id; void approval_action;
   processing.set(p.request_id, { request: p, receipt: { ...scope, consent_id: randomUUID(), consented_at: START, capture_until: END,
    expires_at: '2030-01-02T10:00:00.000Z', revoked_at: null, external_processing_enabled: false, limitations: PROCESSING_DISPATCH_LIMITATIONS, state: 'preparation_only' } });
  }
 }
 const transport: UploadTransport = { send: async request => {
  assert.equal(request.endpoint.origin, origin); assert.equal(request.token, auth.credential);
  const path = request.endpoint.pathname.split('/').at(-1)!; requests.push(path);
  if (path === fail) { throw new Error('Synthetic network failure'); }
  const body = request.body ? JSON.parse(request.body) : {};
  if (path === 'policy') { assert.equal(request.method, 'GET'); return json(policy()); }
  if (path === 'session_capabilities') { return nativeSupported ? json({ authorization_version: NATIVE_SESSION_VERSION, coding_session_id: '42', server_time: START,
   modes: { extension_launched: ['codex','claude'], native_confirmed: ['codex'] }, requires_explicit_confirmation: true, prospective_only: true })
   : { status: 404, headers: {}, contentType: 'application/json', body: '{"error":"Unavailable"}' }; }
  if (path === 'start') {
   assert.ok(validWorkflowStartBundle(body)); initial = body; addScopes(body); status = { ...status, state: 'active', startedAt: START, deadline: END, localRecordingSessionIds: [...status.localRecordingSessionIds, body.intent.local_recording_session_id] };
   return json(response(body));
  }
  if (path === 'sources') { assert.ok(validWorkflowSourceBundle(body)); addScopes(body); return json(response(body)); }
  if (path === 'native_sources') { assert.ok(validNativeSourceBundle(body)); assert.equal(nativeIdentityDigest('42', body), body.intent.identity_digest); addScopes(body);
   return json({ authorization_version: NATIVE_SESSION_VERSION, connection_mode: 'native_confirmed', identity_digest: body.intent.identity_digest, authorization: response(body) }); }
  if (path === 'status') { assert.deepEqual(body, { workflow_consent_id: initial!.intent.request_id }); return json(response(initial!)); }
  if (request.method === 'DELETE') {
   revoked = true; for (const d of disclosures) { d.receipt.state = 'revoked'; d.receipt.revoked_at = START; d.receipt.upload_scope_state = 'revoked'; }
   for (const p of processing.values()) { p.receipt.state = 'revoked'; p.receipt.revoked_at = START; } return json(response(initial!));
  }
  throw new Error('Unexpected synthetic route');
 } };
 setup(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'workflow-'))); queue = await openTestWorkerQueue({ scheme: 'file', fsPath: root }, []);
  secrets = new Map(); memory = new Map(); accepted = true; dialogs = 0; oldUploadDialogs = 0; requests = []; initial = undefined;
  uploadId = randomUUID(); revoked = false; windowsClosed = false; disclosures = []; processing = new Map(); workspaceIds = [W]; mutation = undefined; fail = undefined; nativeSupported = false; nativeSources = [];
  auth = { connection: { mode: 'rails', apiOrigin: origin, codingSessionId: '42', uploadEndpoint: origin + '/api/v2/coding_session/extension/events', credentialExpiresAt: END }, credential: 'adt_ext_' + 'a'.repeat(43) };
  status = { codingSessionId: '42', state: 'paired', serverTime: START, localRecordingSessionIds: [] };
  recording = new RecordingController({ text: '', tooltip: '', command: '', show() {}, dispose() {} }, current => workflow.confirmRecording(current));
  writer = new EventPersistence(queue, { write: async () => {}, flush: async () => {} });
  writer.attachRecording(recording, () => ({ approvedWorkspaceIds: [W], confirmedCodexSessions: nativeSources, codexContentConsent: nativeSources.length > 0 }));
  workflow = new AssessmentWorkflowConsent(recording, queue, { get: async key => secrets.get(key), store: async (key,value) => { secrets.set(key,value); } },
   new RailsWorkflowConsentClient(transport), () => workspaceIds, async notice => { dialogs++; assert.ok(notice.includes('Synthetic Processor')); return accepted; }, async () => {});
  const api: AssessmentApiClient = { mode: 'rails', pair: async () => ({ ...auth, status }), getStatus: async () => status,
   startOrResume: async () => { throw new Error('Legacy start must not be called'); }, submit: async () => { throw new Error('Not a finalization test'); } };
  const store = new AssessmentConnectionStore({ get: <T>(key: string, fallback?: T) => (memory.get(key) ?? fallback) as T,
   update: async (key,value) => { memory.set(key, structuredClone(value)); } }, { get: async key => secrets.get(key), store: async (key,value) => { secrets.set(key,value); } });
  controller = new AssessmentController(api, store, recording, { flushStopped: async id => { await writer.flush(); await writer.completeSession(id); },
   getStatus: ids => queue.getSessionEvidenceStatus(ids), disableDevelopmentUploads: async () => {} }, async () => { oldUploadDialogs++; return true; }, () => {}, 2000, undefined, undefined, () => {}, workflow);
  await controller.initialize(); await controller.pair('SYNTHETIC-PAIR');
 });
 teardown(async () => { await controller.dispose(); workflow.dispose(); recording.dispose(); await writer.close(); await queue.close(); await rm(root, { recursive: true, force: true }); });
 test('one explicit notice starts after all independent server receipts and persists protocol-2 code approvals', async () => {
  await controller.start(); assert.equal(controller.view.state, 'active', JSON.stringify(controller.view)); assert.equal(dialogs, 1); assert.equal(oldUploadDialogs, 0);
  assert.deepEqual(requests, ['policy','start']);
  const event = createFileEvent({ sessionId: recording.sessionId!, source: 'vscode', workspaceId: W, eventType: 'file.modified', timestamp: new Date(START), payload: { relativePath: 'src/synthetic.ts' } });
  await writer.write(event);
  const proof = await queue.getAssessmentUploadContext(event, { codingSessionId: '42', origin, consentReceiptId: uploadId, serverTime: START });
  assert.equal(proof?.assessmentEventApproval?.approvalProtocolVersion, 2);
  assert.ok(await queue.getPendingCount());
  assert.equal([...secrets.values()].some(s => s.includes(auth.credential) && s.startsWith('{')), false);
 });
 test('realistic independent serialization times still activate recording and encrypted protocol-2 capture', async () => {
  mutation = value => {
   const copy = JSON.parse(JSON.stringify(value));
   if (copy.disclosure) { copy.disclosure.receipt.server_time = new Date(Date.parse(START) + 7).toISOString(); }
   return copy;
  };
  await controller.start(); assert.equal(controller.view.state, 'active', JSON.stringify(controller.view));
  const event = createFileEvent({ sessionId: recording.sessionId!, source: 'vscode', workspaceId: W, eventType: 'file.modified', timestamp: new Date(START), payload: { relativePath: 'synthetic.ts' } });
  await writer.write(event);
  const proof = await queue.getAssessmentUploadContext(event, { codingSessionId: '42', origin, consentReceiptId: uploadId, serverTime: START });
  assert.equal(proof?.assessmentEventApproval?.approvalProtocolVersion, 2);
 });
 test('stop drains the final admitted checkpoint before capture sealing without losing its approval', async () => {
  await controller.start(); const id = recording.sessionId!; recording.stop();
  const event = createFileEvent({ sessionId: id, source: 'vscode', workspaceId: W, eventType: 'file.modified', timestamp: new Date(START), payload: { relativePath: 'final-checkpoint.ts' } });
  await writer.write(event); await writer.flush();
  const proof = await queue.getAssessmentUploadContext(event, { codingSessionId: '42', origin, consentReceiptId: uploadId, serverTime: START });
  assert.equal(proof?.assessmentEventApproval?.approvalProtocolVersion, 2);
  await writer.completeSession(id); await queue.suspendDisclosureCapture(id, undefined, true);
  const count = await queue.getPendingCount(); await assert.rejects(writer.write({ ...event, eventId: randomUUID() }));
  assert.equal(await queue.getPendingCount(), count);
 });
 test('denial sends no start or grant and does not activate recording', async () => {
  accepted = false; await controller.start(); assert.equal(recording.isRecording, false); assert.equal(initial, undefined); assert.deepEqual(requests, ['policy']);
  assert.equal(controller.view.state, 'paired');
 });
 test('no supported installed provider fails preflight before consent or server start', async () => {
  const unavailable = new AssessmentWorkflowConsent(recording, queue, { get: async key => secrets.get(key), store: async (key,value) => { secrets.set(key,value); } },
   new RailsWorkflowConsentClient(transport), () => [W], async () => { throw new Error('No consent without supported capture'); }, async () => {}, () => {}, async () => []);
  try { await assert.rejects(unavailable.prepare(auth, AbortSignal.timeout(1000))); assert.equal(initial, undefined); assert.equal(dialogs, 0); }
  finally { unavailable.dispose(); }
 });
 test('source retries reuse the original explicit requests without granting on a lost response', async () => {
  await controller.start(); const sourceId = randomUUID(); fail = 'sources';
  await assert.rejects(workflow.enroll('codex', sourceId, W));
  const before = [...secrets.entries()].find(([key]) => key.endsWith('.source.' + sourceId))!;
  assert.ok(before); assert.equal(disclosures.length, 1); fail = undefined;
  await workflow.enroll('codex', sourceId, W); assert.equal(secrets.get(before[0]), before[1]); assert.equal(disclosures.length, 2);
 });
 test('offline withdrawal stays locally denied and retries after recording has stopped', async () => {
  await controller.start(); const id = recording.sessionId!; fail = 'workflow_consents';
  await assert.rejects(workflow.revoke(auth, id)); assert.equal(recording.isRecording, false); assert.equal(workflow.permits(id, 'codex'), false);
  fail = undefined; await workflow.revoke(auth, id); assert.equal(revoked, true);
 });
 test('missing capability, changed policy or offline preflight fails closed before timer start', async () => {
  fail = 'policy'; await controller.start(); assert.equal(initial, undefined); assert.equal(recording.isRecording, false);
 });
 test('new source scopes are explicit, independent and bound to current workspace/provider', async () => {
  await controller.start(); const sourceId = randomUUID(); await workflow.enroll('codex', sourceId, W);
  assert.equal(disclosures.length, 2); assert.equal(processing.size, 2); assert.equal(workflow.permits(recording.sessionId, 'codex'), true);
  await assert.rejects(workflow.enroll('codex', randomUUID(), 'd'.repeat(64)), AssessmentApiError);
  assert.equal(requests.filter(p => p === 'sources').length, 1);
  const states = await queue.getDisclosureConsents(recording.sessionId!); assert.equal(states.length, 2);
  assert.ok(states.every(s => s.workflowConsentId === initial!.intent.request_id));
 });
 test('native capability does not reinterpret an old grant or issue authorization without exact confirmation', async () => {
  await controller.start(); const identity = { sourceSessionId: randomUUID(), workspaceId: W, sourceFileReference: 'codex-file:' + 'c'.repeat(64), createdAt: START };
  let confirmations = 0;
  await assert.rejects(workflow.enrollNative(identity, async () => { confirmations++; return true; })); assert.equal(confirmations, 0);
  nativeSupported = true; assert.equal(await workflow.enrollNative(identity, async () => { confirmations++; return false; }), undefined);
  assert.equal(confirmations, 1); assert.equal(disclosures.length, 1); assert.equal(requests.includes('native_sources'), false);
 });
 test('a newly confirmed native source receives durable protocol-2 approvals without modifying the parent or prior events', async () => {
  await controller.start(); const parent = structuredClone(initial); nativeSupported = true;
  const sourceId = randomUUID(); const identity = { sourceSessionId: sourceId, workspaceId: W, sourceFileReference: 'codex-file:' + 'c'.repeat(64), createdAt: START };
  const nativeAt = await workflow.enrollNative(identity, async notice => { assert.match(notice, /separately approves/); return true; }); assert.equal(nativeAt, START);
  assert.deepEqual(initial, parent); assert.equal(disclosures.length, 2); assert.equal(processing.size, 2);
  nativeSources = [{ sourceSessionId: sourceId, workspaceId: W }];
  const event = createCodexEvent({ sessionId: recording.sessionId!, workspaceId: W, sourceSessionId: sourceId, eventType: 'ai.prompt.submitted', timestamp: new Date(START),
   payload: { text: 'Synthetic native assessment prompt', sourceRecord: { sourceFileReference: identity.sourceFileReference, recordIndex: 1, generation: 0, byteOffset: 5000, byteLength: 128, recordType: 'event_msg' } } });
  await writer.write(event);
  const proof = await queue.getAssessmentUploadContext(event, { codingSessionId: '42', origin, consentReceiptId: uploadId, serverTime: START });
  assert.equal(proof?.assessmentEventApproval?.approvalProtocolVersion, 2); assert.equal((await queue.getPending(10))[0].eventId, event.eventId);
 });
 test('native authorization retries preserve original explicit requests and never authorize a different identity', async () => {
  await controller.start(); nativeSupported = true;
  const identity = { sourceSessionId: randomUUID(), workspaceId: W, sourceFileReference: 'codex-file:' + 'c'.repeat(64), createdAt: START };
  fail = 'native_sources'; await assert.rejects(workflow.enrollNative(identity, async () => true));
  const entry = [...secrets.entries()].find(([key]) => key.includes('.native.codex.'))!; assert.ok(entry); assert.equal(disclosures.length, 1);
  fail = undefined; await workflow.enrollNative(identity, async () => true); assert.equal(secrets.get(entry[0]), entry[1]);
  await assert.rejects(workflow.enrollNative({ ...identity, sourceFileReference: 'codex-file:' + 'd'.repeat(64) }, async () => true));
  assert.equal(disclosures.length, 2);
 });
 test('native reader sends only future sanitized events into encrypted storage with durable protocol-2 approval', async () => {
  nativeSupported = true; await controller.start();
  const workspace = join(root, 'workspace'); const sessions = join(root, 'provider-sessions'); await mkdir(workspace); await mkdir(sessions);
  const id = randomUUID(); const file = join(sessions, id + '.jsonl'); const createdAt = new Date(Date.now() - 10000).toISOString();
  const line = (text: string) => JSON.stringify({ type: 'event_msg', timestamp: START, payload: { type: 'user_message', message: text } }) + '\n';
  await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd: workspace, timestamp: createdAt } }) + '\n' + line('PRIVATE old history'));
  const native = new NativeCodexCapture(recording, writer, workflow, () => {});
  try {
   assert.equal(await native.connect(file, sessions, [{ path: workspace, workspaceId: W }], async () => true), true);
   nativeSources = native.getApprovals(recording.sessionId!);
   const secret = 'sk-' + 'x'.repeat(32); await appendFile(file, line('Synthetic new prompt token ' + secret));
   const timeout = Date.now() + 5000;
   while (await queue.getPendingCount() === 0 && Date.now() < timeout) { await new Promise(resolve => setTimeout(resolve, 20)); }
   await native.flush(); await writer.flush();
   const pending = await queue.getPending(10); assert.equal(pending.length, 1);
   const event = pending[0]; assert.equal(event.eventType, 'ai.prompt.submitted');
   assert.equal(JSON.stringify(event).includes(secret), false); assert.equal(JSON.stringify(event).includes('PRIVATE old history'), false);
   const proof = await queue.getAssessmentUploadContext(event, { codingSessionId: '42', origin, consentReceiptId: uploadId, serverTime: START });
   assert.equal(proof?.assessmentEventApproval?.approvalProtocolVersion, 2);
   assert.equal(proof?.assessmentEventApproval?.eventId, event.eventId);
   const states = await queue.getDisclosureConsents(recording.sessionId!);
   recording.stop(); await native.dispose(); await writer.flush();
   await queue.close(); queue = await openTestWorkerQueue({ scheme: 'file', fsPath: root }, []);
   const restored = await queue.getPending(10); assert.deepEqual(restored, pending);
   assert.equal(await queue.getAssessmentUploadContext(event, { codingSessionId: '42', origin, consentReceiptId: uploadId, serverTime: START }), undefined);
   // Simulate a fresh validated server observation, never trust the persisted receipt alone.
   for (const state of states) { await queue.confirmDisclosureConsent({ state, requestedAt: process.hrtime.bigint() }); }
   assert.ok(await queue.getAssessmentUploadContext(event, { codingSessionId: '42', origin, consentReceiptId: uploadId, serverTime: START }));
   assert.equal(native.getApprovals(event.sessionId).length, 0);
  } finally { await native.dispose(); }
 });
 test('native-only capability permits preflight without a CLI but does not create a source grant', async () => {
  nativeSupported = true;
  const nativeOnly = new AssessmentWorkflowConsent(recording, queue, { get: async key => secrets.get(key), store: async (key,value) => { secrets.set(key,value); } },
   new RailsWorkflowConsentClient(transport), () => [W], async () => true, async () => {}, () => {}, async () => []);
  try { await nativeOnly.prepare(auth, AbortSignal.timeout(1000)); assert.equal(initial, undefined); assert.equal(disclosures.length, 0); }
  finally { nativeOnly.dispose(); }
 });
 test('invalid receipts never activate local recording or fabricate approval', async () => {
  mutation = value => { if (value && typeof value === 'object' && 'workflow_consent_id' in value) { return { ...value, workflow_consent_id: randomUUID() }; } return value; };
  await controller.start(); assert.equal(recording.isRecording, false); assert.equal(controller.view.reason, 'protocol');
 });
 test('retry after an uncertain start recovers prior receipts before requesting a fresh recording', async () => {
  mutation = value => value && typeof value === 'object' && 'workflow_consent_id' in value ? { ...value, workflow_consent_id: randomUUID() } : value;
  await controller.start(); assert.equal(recording.isRecording, false); const previous = initial!.intent.local_recording_session_id;
  mutation = undefined; await controller.start(); assert.equal(controller.view.state, 'active', JSON.stringify(controller.view));
  assert.deepEqual(requests, ['policy', 'start', 'status', 'policy', 'start']);
  assert.notEqual(recording.sessionId, previous); assert.equal(controller.view.deadline, END);
 });
 test('workspace changes after consent prevent start and cross-assessment enrollment', async () => {
  await workflow.prepare(auth, AbortSignal.timeout(1000)); await workflow.confirmRecording(() => true); workspaceIds = ['d'.repeat(64)];
  await assert.rejects(workflow.start(auth, randomUUID(), AbortSignal.timeout(1000)), AssessmentApiError);
  assert.equal(initial, undefined);
 });
 test('withdrawal blocks future capture and source enrollment without deleting evidence', async () => {
  await controller.start(); const id = recording.sessionId!;
  const event = createFileEvent({ sessionId: id, source: 'vscode', workspaceId: W, eventType: 'file.modified', timestamp: new Date(START), payload: { relativePath: 'synthetic.ts' } }); await writer.write(event);
  const before = await queue.getPendingCount(); await workflow.revoke(auth, id);
  assert.equal(recording.isRecording, false); assert.equal(workflow.permits(id, 'codex'), false); assert.equal(await queue.getPendingCount(), before);
  await assert.rejects(workflow.enroll('codex', randomUUID(), W));
 });
 test('restart recovery loads receipts without restoring live recording or source permission', async () => {
  await controller.start(); const id = recording.sessionId!; recording.stop();
  const fresh = new AssessmentWorkflowConsent(recording, queue, { get: async key => secrets.get(key), store: async (key,value) => { secrets.set(key,value); } },
   new RailsWorkflowConsentClient(transport), () => [W], async () => { throw new Error('No automatic consent'); }, async () => {});
  try { await fresh.recover(auth, [id], AbortSignal.timeout(1000)); assert.equal(recording.isRecording, false); assert.equal(fresh.permits(id, 'codex'), false); }
  finally { fresh.dispose(); }
 });
 test('bundle cannot be broadened to AI categories or another processor before authorization', () => {
  const bundle = createWorkflowBundle(randomUUID(), policy(), [W]); assert.ok(validWorkflowStartBundle(bundle));
  assert.equal(validWorkflowStartBundle({ ...bundle, disclosure: { ...bundle.disclosure, categories: ['ai_interactions'] } }), false);
  assert.equal(validWorkflowStartBundle({ ...bundle, processing: { ...bundle.processing, approval_action: 'approve_upload' } }), false);
  assert.equal(validWorkflowStartBundle({ ...bundle, upload: undefined }), false);
 });
});
