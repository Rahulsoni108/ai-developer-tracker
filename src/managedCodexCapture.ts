import { mkdir, mkdtemp, chmod, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import type { RecordingController } from './recording';
import type { ActivityWriter } from './jsonlWriter';
import { CodexSessionDiscovery } from './codexSessionDiscovery';
import { CodexEventParser } from './codexEventParser';
import { CodexJsonlReader } from './codexJsonlReader';
import { isSensitivePath as isExcludedPath } from './privacyFilter';
import type { AssessmentWorkflowConsent } from './assessmentWorkflowConsent';

export interface ManagedCodexLaunch { home: string; root: string }
interface Capture { discovery: CodexSessionDiscovery; parser: CodexEventParser; reader: CodexJsonlReader; recordingId: string; admitted: Set<string> }
/** Assessment-only provider state, never the user's global Codex home or credentials. */
export class ManagedCodexCapture {
 private captures: Capture[] = [];
 private generation = 0;
 private launching = false;
 private readonly listener: { dispose(): void };
 constructor(private readonly recording: RecordingController, private readonly writer: ActivityWriter,
  private readonly workflow: Pick<AssessmentWorkflowConsent, 'permits' | 'enroll'>, private readonly directory: string,
  private readonly assertOutside: (path: string) => Promise<void>,
  private readonly notice: (reason: 'waiting' | 'ready' | 'unavailable' | 'pre_enrollment_omitted') => void) {
  this.listener = recording.addLifecycleListener({ prepare: async () => {}, started: () => {}, stopped: () => { ++this.generation; }, cancelled: () => { ++this.generation; } });
 }
 getApprovals(id: string): { sourceSessionId: string; workspaceId: string }[] {
  return this.captures.filter(c => c.recordingId === id).flatMap(c => c.discovery.getRegistry().filter(s => s.status === 'confirmed' && c.admitted.has(s.sourceFileId) && s.sourceSessionId && s.workspaceId)
   .map(s => ({ sourceSessionId: s.sourceSessionId!, workspaceId: s.workspaceId! })));
 }
 async create(root: string, workspaceId: string): Promise<ManagedCodexLaunch> {
  if (this.launching) { throw new Error('Assessment Codex launch already pending.'); }
  this.launching = true;
  try { return await this.build(root, workspaceId); } finally { this.launching = false; }
 }
 private async build(root: string, workspaceId: string): Promise<ManagedCodexLaunch> {
  const id = this.recording.sessionId; const generation = this.generation;
  if (!id || !this.workflow.permits(id, 'codex') || this.captures.filter(c => c.recordingId === id).length >= 8) { throw new Error('Assessment Codex unavailable.'); }
  for (const c of this.captures.filter(c => c.recordingId !== id)) { c.discovery.dispose(); c.reader.dispose(); await c.reader.flush(); c.parser.dispose(); await c.parser.flush(); }
  this.captures = this.captures.filter(c => c.recordingId === id);
  await this.assertOutside(this.directory); await mkdir(this.directory, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(this.directory, 'assessment-')); await chmod(home, 0o700); await this.assertOutside(home);
  const sessions = join(home, 'sessions'); await mkdir(sessions, { mode: 0o700 });
  if (await realpath(home) !== home || generation !== this.generation || !this.workflow.permits(id, 'codex')) { throw new Error('Assessment Codex unavailable.'); }
  let omittedWarned = false; let failureWarned = false;
  const admitted = new Map<string, { timestamp: string; offset: number }>(); const requested = new Set<string>(); let capture!: Capture;
  const discovery = new CodexSessionDiscovery(this.recording, () => [{ workspaceId, path: root }], {
   sessionsDirectory: sessions, pollIntervalMs: 1000, maxRegistryEntries: 64, maxEntriesPerScan: 128,
   onDiagnostic: () => {
    admitted.clear(); capture?.admitted.clear();
    if (!failureWarned) { failureWarned = true; this.notice('unavailable'); }
   },
   onCandidatesChanged: candidates => {
    for (const candidate of candidates) {
     if (!candidate.sourceSessionId || candidate.workspaceId !== workspaceId || requested.has(candidate.sourceFileId) || generation !== this.generation) { continue; }
     requested.add(candidate.sourceFileId);
     void (async () => {
      // This directory was newly created for this tracker launch. Workspace/time
      // checks alone never authorize a session from the global Codex directory.
      const startsAt = await this.workflow.enroll('codex', candidate.sourceSessionId!, workspaceId);
      if (generation !== this.generation || this.recording.sessionId !== id || !this.workflow.permits(id, 'codex')) { return; }
      if (!await discovery.confirm(candidate.sourceFileId)) { return; }
      const opened = await discovery.openConfirmedSession(candidate.sourceFileId); if (!opened) { return; }
      let offset: number;
      try { offset = (await opened.handle.stat()).size; } finally { await opened.handle.close(); }
      if (generation !== this.generation || !this.workflow.permits(id, 'codex')) { return; }
      admitted.set(candidate.sourceFileId, { timestamp: startsAt, offset });
      capture.parser.grantContentConsent(id); await capture.reader.readNow();
     })().catch(() => { if (!failureWarned) { failureWarned = true; this.notice('unavailable'); } });
    }
   }
  });
  const parser = new CodexEventParser(this.recording, discovery, this.writer, { isExcludedPath,
   resolveToolPath: (path, context) => {
    if (!path || context.workspaceId !== workspaceId || !isAbsolute(path)) { return undefined; }
    const part = relative(root, path).replace(/\\/g, '/');
    return part && part !== '..' && !part.startsWith('../') && !isAbsolute(part) ? part : undefined;
   }
  });
  const reader = new CodexJsonlReader(this.recording, discovery, {
   canCaptureContent: registration => this.workflow.permits(id, 'codex') && admitted.has(registration.sourceFileId) && parser.canCapture(registration),
   onRecord: metadata => {
    if (metadata.eventType !== 'session_meta' || generation !== this.generation || !this.workflow.permits(id, 'codex')) { return; }
    const entry = discovery.getRegistry().find(s => s.sourceSessionId === metadata.sourceSessionId && s.status === 'confirmed' && admitted.has(s.sourceFileId));
    if (entry && !capture.admitted.has(entry.sourceFileId)) { capture.admitted.add(entry.sourceFileId); this.notice('ready'); }
   },
   onDiagnostic: diagnostic => {
    const entries = discovery.getRegistry().filter(s => !diagnostic.sourceSessionId || s.sourceSessionId === diagnostic.sourceSessionId);
    for (const entry of entries) { admitted.delete(entry.sourceFileId); capture.admitted.delete(entry.sourceFileId); }
    if (!failureWarned) { failureWarned = true; this.notice('unavailable'); }
   },
   onSourceRecord: (record, context) => {
    const startsAt = admitted.get(context.sourceFileId);
    const timestamp = record && typeof record === 'object' ? (record as { timestamp?: unknown }).timestamp : undefined;
    if (!startsAt || context.byteOffset < startsAt.offset || typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) < Date.parse(startsAt.timestamp)) {
     if (!omittedWarned) { omittedWarned = true; this.notice('pre_enrollment_omitted'); } return Promise.resolve();
    }
    return parser.handle(record, context);
   }
  });
  capture = { discovery, parser, reader, recordingId: id, admitted: new Set() }; this.captures.push(capture);
  // These reused collectors were constructed after recording started.
  discovery.started(id); // Parser/reader constructors already attach to active recording.
  this.notice('waiting'); return { home, root };
 }
 async flush(): Promise<void> { for (const c of this.captures) { await c.discovery.flush(); await c.reader.flush(); await c.parser.flush(); } }
 async dispose(): Promise<void> {
  ++this.generation; this.listener.dispose();
  for (const c of this.captures) { c.discovery.dispose(); await c.reader.dispose(); c.parser.dispose(); }
  this.captures = [];
 }
}
