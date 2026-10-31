import { createHash, randomUUID } from 'node:crypto';
import type { SecretStorage } from 'vscode';
import type { RecordingController } from './recording';
import { AssessmentApiError, type AssessmentAuthentication, type AssessmentServerStatus } from './assessmentApiClient';
import { assessmentArchiveKey } from './assessmentStorage';
import { canonicalSha256 } from './canonicalJson';
import { NATIVE_SESSION_VERSION, nativeIdentityDigest, validNativeSourceBundle, type NativeSessionIdentity, type NativeSourceBundle } from './assessmentNativeSession';
import { PRIVACY_EVENT_TYPES } from './privacyFilter';
import type { LocalEventQueue } from './localEventQueue';
import type { ProcessingState } from './processingConsent';
import { RailsWorkflowConsentClient, type WorkflowReceipts } from './railsWorkflowConsentClient';
import { validWorkflowStartBundle, validWorkflowPolicy, workflowConsentNotice, WORKFLOW_CONSENT_VERSION,
 validWorkflowSourceBundle, type WorkflowPolicy, type WorkflowProvider, type WorkflowStartBundle, type WorkflowSourceBundle } from './assessmentWorkflowContract';

type Queue = Pick<LocalEventQueue, 'getEvidenceConsent' | 'setEvidenceConsent' | 'setDisclosureConsent' | 'confirmDisclosureConsent' | 'suspendDisclosureCapture'>;
interface Ledger { credentialDigest: string; bundle: WorkflowStartBundle; policy: WorkflowPolicy; locallyRevoked: boolean }
interface Live { auth: AssessmentAuthentication; recordingId: string; ledger: Ledger; confirmedAt: bigint }
export interface AssessmentWorkflowLifecycle {
 prepare(auth: AssessmentAuthentication, signal: AbortSignal): Promise<void>;
 start(auth: AssessmentAuthentication, id: string, signal: AbortSignal): Promise<AssessmentServerStatus>;
 recover(auth: AssessmentAuthentication, ids: readonly string[], signal: AbortSignal): Promise<void>;
}
export function createWorkflowBundle(id: string, policy: WorkflowPolicy, workspaces: readonly string[]): WorkflowStartBundle {
 const uploadId = randomUUID(); const workspaceIds = [...workspaces].sort();
 const common = { local_recording_session_id: id, upload_request_id: uploadId, approved_workspace_ids: workspaceIds,
  categories: ['code_changes' as const], approved_source_sessions: [] };
 return { intent: { request_id: id, local_recording_session_id: id, consent_version: WORKFLOW_CONSENT_VERSION, approval_action: 'approve_assessment_workflow',
   approved_workspace_ids: workspaceIds, providers: [...policy.providers].sort(), processing_policy_digest: policy.processor_policy.policy_digest },
  upload: { request_id: uploadId, local_recording_session_id: id, approval_action: 'approve_upload', consent_version: 'assessment-evidence.v1', scope: 'assessment_evidence',
   approved_workspace_ids: workspaceIds, event_types: [...PRIVACY_EVENT_TYPES].sort() },
  disclosure: { ...common, request_id: randomUUID(), approval_action: 'approve_recruiter_disclosure', consent_version: 'assessment-disclosure.v1', audience: 'job_owning_recruiter', purpose: 'assessment_review' },
  processing: { ...common, request_id: randomUUID(), approval_action: 'approve_assessment_ai_processing', consent_version: 'assessment-ai-processing.v2',
   purpose: 'assessment_performance_evaluation', retention_policy_version: 'assessment-report-retention.v1', external_processing_permitted: true,
   processor_scope: policy.processor_policy.processor_scope, processing_policy_digest: policy.processor_policy.policy_digest } };
}
/** No recording flag here: live capability is bound to RecordingController and never restored from disk. */
export class AssessmentWorkflowConsent implements AssessmentWorkflowLifecycle {
 private prepared?: { auth: AssessmentAuthentication; policy: WorkflowPolicy; workspaces: string[]; approved: boolean };
 private live?: Live;
 private generation = 0;
 private timer?: ReturnType<typeof setTimeout>;
 private pending: Promise<unknown> = Promise.resolve();
 private readonly listener: { dispose(): void };
 constructor(private readonly recording: RecordingController, private readonly queue: Queue,
  private readonly secrets: Pick<SecretStorage, 'get' | 'store'>, private readonly client: RailsWorkflowConsentClient,
  private readonly workspaceIds: () => string[], private readonly confirm: (notice: string) => Promise<boolean>,
  private readonly recordProcessing: (auth: AssessmentAuthentication, state: ProcessingState) => Promise<void>,
  private readonly notice: (code: 'ready' | 'unavailable' | 'source_ready' | 'source_blocked' | 'withdrawn') => void = () => {},
  private readonly availableProviders: () => Promise<WorkflowProvider[]> = async () => ['claude', 'codex']) {
  this.listener = recording.addLifecycleListener({ prepare: async () => {}, started: () => this.schedule(), stopped: () => this.clear(), cancelled: () => this.clear() });
 }
 async prepare(auth: AssessmentAuthentication, signal: AbortSignal): Promise<void> {
  this.clear(); const generation = this.generation; const policy = await this.client.policy(auth, signal);
  const available = await this.availableProviders();
  if (!available.includes('codex')) {
   const native = await this.client.sessionCapabilities(auth, signal);
   if (native?.modes.native_confirmed.includes('codex')) { available.push('codex'); }
  }
  policy.providers = policy.providers.filter(provider => available.includes(provider));
  if (!policy.providers.length) { throw new AssessmentApiError('unavailable'); }
  if (generation !== this.generation || signal.aborted || !validWorkflowPolicy(policy, auth.connection.codingSessionId)) { throw new AssessmentApiError('cancelled'); }
  this.prepared = { auth, policy, workspaces: [...this.workspaceIds()].sort(), approved: false };
 }
 async confirmRecording(current: () => boolean): Promise<boolean> {
  const prepared = this.prepared; if (!prepared || !current()) { return false; }
  const accepted = await this.confirm(workflowConsentNotice(prepared.policy, prepared.auth.connection.codingSessionId,
   new URL(prepared.auth.connection.uploadEndpoint).hostname, prepared.workspaces.length));
  if (!accepted || !current() || prepared !== this.prepared || canonicalSha256(prepared.workspaces) !== canonicalSha256([...this.workspaceIds()].sort())) { return false; }
  prepared.approved = true; return true;
 }
 async start(auth: AssessmentAuthentication, id: string, signal: AbortSignal): Promise<AssessmentServerStatus> {
  const prepared = this.prepared; const generation = this.generation;
  if (!prepared?.approved || canonicalSha256(auth) !== canonicalSha256(prepared.auth)
   || canonicalSha256(prepared.workspaces) !== canonicalSha256([...this.workspaceIds()].sort())) { throw new AssessmentApiError('consent_required'); }
  const bundle = createWorkflowBundle(id, prepared.policy, prepared.workspaces);
  if (!validWorkflowStartBundle(bundle)) { throw new AssessmentApiError('protocol'); }
  const ledger: Ledger = { credentialDigest: this.digest(auth), bundle, policy: prepared.policy, locallyRevoked: false };
  await this.save(auth, id, ledger); // Intent before network; never log or persist credentials.
  if (generation !== this.generation || signal.aborted) { throw new AssessmentApiError('cancelled'); }
  const requestedAt = process.hrtime.bigint(); const result = await this.client.start(auth, bundle, signal);
  await this.persist(auth, result, ledger.policy);
  if (result.state !== 'active' || generation !== this.generation || signal.aborted) { throw new AssessmentApiError('consent_required'); }
  await this.confirmReceipts(result, requestedAt);
  this.live = { auth, recordingId: id, ledger, confirmedAt: requestedAt }; this.notice('ready');
  return result.status;
 }
 async recover(auth: AssessmentAuthentication, ids: readonly string[], signal: AbortSignal): Promise<void> {
  for (const id of ids) {
   const ledger = await this.load(auth, id); if (!ledger) { continue; }
   const result = await this.client.recover(auth, ledger.bundle, signal);
   await this.persist(auth, result, ledger.policy); // Stored receipts do NOT restore live capture permission.
  }
 }
 permits(id: string | undefined, provider: WorkflowProvider): boolean {
  return !!id && !!this.live && this.live.recordingId === id && this.recording.isRecording && this.recording.sessionId === id
   && !this.live.ledger.locallyRevoked && this.live.ledger.bundle.intent.providers.includes(provider)
   && Number(process.hrtime.bigint() - this.live.confirmedAt) / 1000000 < 5000
   && canonicalSha256([...this.workspaceIds()].sort()) === canonicalSha256(this.live.ledger.bundle.intent.approved_workspace_ids);
 }
 enroll(provider: WorkflowProvider, sourceId: string, workspaceId: string): Promise<string> { return this.enrollSource(provider, sourceId, workspaceId); }
 async supportsNative(): Promise<boolean> {
  const live = this.live;
  if (!live || !this.permits(live.recordingId, 'codex')) { return false; }
  const capability = await this.client.sessionCapabilities(live.auth, AbortSignal.timeout(10000));
  return !!capability && this.live === live && this.permits(live.recordingId, 'codex');
 }
 async enrollNative(identity: NativeSessionIdentity, confirm: (notice: string) => Promise<boolean>): Promise<string | undefined> {
  const live = this.live; const generation = this.generation;
  if (!live || !live.ledger.bundle.intent.approved_workspace_ids.includes(identity.workspaceId) || !await this.supportsNative()) { throw new AssessmentApiError('unavailable'); }
  const policy = live.ledger.policy.processor_policy;
  const accepted = await confirm(`Connect only this verified native Codex assessment session (ending ${identity.sourceSessionId.slice(-8)}, created ${identity.createdAt})? `
   + 'Confirm that this exact conversation belongs to your current assessment workspace. Only activity appended after authorization will be captured; previous history, unrelated chats and private reasoning are excluded. '
   + `This separately approves local prompt/visible-response/tool capture, scoped uploads to ${new URL(live.auth.connection.apiOrigin).hostname}, recruiter review, and external assessment evaluation by ${policy.processor.name} (${policy.processor_scope.model}) for this one session. `
   + `Reports are retained for ${policy.terms.report_retention_days} days. Disclosure withdrawal is prospective; processing withdrawal blocks undispatched work and does not delete already processed data. Declining makes no grant.`);
  if (!accepted) { return undefined; }
  if (this.live !== live || generation !== this.generation || !this.permits(live.recordingId, 'codex')) { throw new AssessmentApiError('cancelled'); }
  return this.enrollSource('codex', identity.sourceSessionId, identity.workspaceId, identity);
 }
 private enrollSource(provider: WorkflowProvider, sourceId: string, workspaceId: string, native?: NativeSessionIdentity): Promise<string> {
  const operation = this.pending.then(async () => {
   const live = this.live; const generation = this.generation;
   if (!live || !this.permits(live.recordingId, provider) || !live.ledger.bundle.intent.approved_workspace_ids.includes(workspaceId)) { throw new AssessmentApiError('consent_required'); }
   const parent = await this.client.recover(live.auth, live.ledger.bundle, AbortSignal.timeout(10000));
   if (parent.state !== 'active' || generation !== this.generation) { throw new AssessmentApiError('consent_required'); }
   const common = { local_recording_session_id: live.recordingId, upload_consent_id: parent.upload.receipt!.consent_id,
    categories: ['ai_interactions' as const, 'tool_activity' as const], approved_workspace_ids: [workspaceId], approved_source_sessions: [{ source: provider, source_session_id: sourceId }] };
   const policy = live.ledger.policy.processor_policy;
   let bundle: WorkflowSourceBundle = { intent: { workflow_consent_id: live.ledger.bundle.intent.request_id, request_id: randomUUID(), source: provider, source_session_id: sourceId, workspace_id: workspaceId },
    disclosure: { ...common, request_id: randomUUID(), approval_action: 'approve_recruiter_disclosure', consent_version: 'assessment-disclosure.v1', audience: 'job_owning_recruiter', purpose: 'assessment_review' },
    processing: { ...common, request_id: randomUUID(), approval_action: 'approve_assessment_ai_processing', consent_version: 'assessment-ai-processing.v2', purpose: 'assessment_performance_evaluation',
     external_processing_permitted: true, retention_policy_version: 'assessment-report-retention.v1', processor_scope: policy.processor_scope, processing_policy_digest: policy.policy_digest } };
   // Preserve unresolved source intent, too. A lost response never authorizes capture.
   if (native) {
    const next: NativeSourceBundle = { ...bundle, intent: { ...bundle.intent, authorization_version: NATIVE_SESSION_VERSION, connection_mode: 'native_confirmed' as const,
     approval_action: 'approve_native_assessment_session' as const, source_identity: { source_file_reference: native.sourceFileReference, created_at: native.createdAt }, identity_digest: '' } };
    next.intent.identity_digest = nativeIdentityDigest(live.auth.connection.codingSessionId, next); bundle = next;
   }
   const key = this.key(live.auth, live.recordingId) + (native ? '.native.codex.' : '.source.') + sourceId;
   const prior = await this.secrets.get(key);
   if (prior) {
    if (Buffer.byteLength(prior) > 16384) { throw new AssessmentApiError('storage'); }
    const saved = JSON.parse(prior) as WorkflowSourceBundle;
    if (!(native ? validNativeSourceBundle(saved) : validWorkflowSourceBundle(saved)) || saved.intent.source !== provider || saved.intent.source_session_id !== sourceId
     || saved.intent.workspace_id !== workspaceId || saved.intent.workflow_consent_id !== live.ledger.bundle.intent.request_id
     || saved.disclosure.local_recording_session_id !== live.recordingId || saved.disclosure.upload_consent_id !== parent.upload.receipt!.consent_id
     || saved.processing.processing_policy_digest !== policy.policy_digest
     || native && (!validNativeSourceBundle(saved) || canonicalSha256(saved.intent.source_identity) !== canonicalSha256({ source_file_reference: native.sourceFileReference, created_at: native.createdAt })
      || nativeIdentityDigest(live.auth.connection.codingSessionId, saved) !== saved.intent.identity_digest)) { throw new AssessmentApiError('storage'); }
    bundle = saved;
   } else { await this.secrets.store(key, JSON.stringify(bundle)); }
   const requestedAt = process.hrtime.bigint(); const result = native ? await this.client.enrollNative(live.auth, bundle as NativeSourceBundle, AbortSignal.timeout(10000)) : await this.client.enroll(live.auth, bundle, AbortSignal.timeout(10000));
   await this.persist(live.auth, result, live.ledger.policy);
   if (result.state !== 'active' || generation !== this.generation || !this.recording.isRecording) { throw new AssessmentApiError('consent_required'); }
   await this.confirmReceipts(result, requestedAt); live.confirmedAt = requestedAt; this.notice('source_ready');
   return [result.disclosure.receipt!.consented_at, result.processing.receipt!.consented_at].sort().at(-1)!;
  });
  this.pending = operation.catch(() => { this.notice('source_blocked'); }); return operation;
 }
 async revoke(auth: AssessmentAuthentication, id: string): Promise<void> {
  const ledger = await this.load(auth, id); if (!ledger) { throw new AssessmentApiError('consent_required'); }
  this.clear(); if (this.recording.sessionId === id) { this.recording.stop(); }
  await this.queue.suspendDisclosureCapture(id, undefined, true);
  ledger.locallyRevoked = true; await this.save(auth, id, ledger);
  const result = await this.client.revoke(auth, ledger.bundle, AbortSignal.timeout(10000)); await this.persist(auth, result, ledger.policy); this.notice('withdrawn');
 }
 private schedule(): void { clearTimeout(this.timer); if (this.live) { this.timer = setTimeout(() => { void this.refresh(); }, 2000); this.timer.unref?.(); } }
 private refresh(): Promise<void> {
  const work = this.pending.then(() => this.refreshNow()); this.pending = work.catch(() => {}); return work;
 }
 private async refreshNow(): Promise<void> {
  const live = this.live; if (!live || !this.recording.isRecording) { return; }
  const generation = this.generation;
  try {
   const requestedAt = process.hrtime.bigint(); const result = await this.client.recover(live.auth, live.ledger.bundle, AbortSignal.timeout(2500));
   if (generation !== this.generation) { return; }
   if (result.state !== 'active') { throw new AssessmentApiError('consent_required'); }
   await this.confirmReceipts(result, requestedAt); live.confirmedAt = requestedAt;
  } catch { if (generation === this.generation) { this.clear(); await this.queue.suspendDisclosureCapture(live.recordingId); if (this.recording.sessionId === live.recordingId) { this.recording.stop(); } this.notice('unavailable'); } }
  finally { if (generation === this.generation) { this.schedule(); } }
 }
 private async confirmReceipts(result: WorkflowReceipts, requestedAt: bigint): Promise<void> {
  for (const state of result.confirmations) { await this.queue.confirmDisclosureConsent({ state, requestedAt }); }
 }
 private async persist(auth: AssessmentAuthentication, result: WorkflowReceipts, policy: WorkflowPolicy): Promise<void> {
  const previous = await this.queue.getEvidenceConsent(result.upload.request.local_recording_session_id);
  await this.queue.setEvidenceConsent({ ...result.upload, captureClosed: result.upload.captureClosed || !!previous?.captureClosed,
   locallyRevoked: result.upload.locallyRevoked || !!previous?.locallyRevoked,
   ...(previous?.pendingAction && previous.pendingAction !== 'register' ? { pendingAction: previous.pendingAction } : {}) });
  for (const state of result.confirmations) { await this.queue.setDisclosureConsent(state); }
  await this.recordProcessing(auth, { ...result.processing, policy: policy.processor_policy });
 }
 async flush(): Promise<void> { await this.pending; }
 get scopedRecordingId(): string | undefined { return this.live?.recordingId; }
 private clear(): void { ++this.generation; this.prepared = undefined; this.live = undefined; clearTimeout(this.timer); }
 private digest(auth: AssessmentAuthentication): string { return createHash('sha256').update(auth.credential).digest('hex'); }
 private key(auth: AssessmentAuthentication, id: string): string { return 'ai-developer-tracker.workflow.v1.' + assessmentArchiveKey(auth.connection) + '.' + id; }
 private async save(auth: AssessmentAuthentication, id: string, ledger: Ledger): Promise<void> { try { await this.secrets.store(this.key(auth, id), JSON.stringify(ledger)); } catch { throw new AssessmentApiError('storage'); } }
 private async load(auth: AssessmentAuthentication, id: string): Promise<Ledger | undefined> {
  try {
   const json = await this.secrets.get(this.key(auth, id)); if (!json) { return undefined; }
   if (Buffer.byteLength(json) > 32768) { throw new Error(); } const ledger = JSON.parse(json) as Ledger;
   if (!validWorkflowStartBundle(ledger.bundle) || !validWorkflowPolicy(ledger.policy, auth.connection.codingSessionId)
    || ledger.bundle.intent.processing_policy_digest !== ledger.policy.processor_policy.policy_digest
    || ledger.bundle.intent.providers.some(provider => !ledger.policy.providers.includes(provider))
    || ledger.bundle.intent.local_recording_session_id !== id || ledger.credentialDigest !== this.digest(auth) || typeof ledger.locallyRevoked !== 'boolean') { throw new Error(); }
   return ledger;
  } catch { throw new AssessmentApiError('storage'); }
 }
 dispose(): void { this.clear(); this.listener.dispose(); this.client.dispose(); }
}
