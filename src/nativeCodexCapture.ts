import { isAbsolute, relative, resolve } from 'node:path';
import type { RecordingController } from './recording';
import type { ActivityWriter } from './jsonlWriter';
import type { AssessmentWorkflowConsent } from './assessmentWorkflowConsent';
import { CodexSessionDiscovery, type ApprovedWorkspace } from './codexSessionDiscovery';
import { CodexJsonlReader } from './codexJsonlReader';
import { CodexEventParser } from './codexEventParser';
import { isSensitivePath } from './privacyFilter';

interface Capture { recordingId: string; sourceId: string; fileReference: string; createdAt: string; workspaceId: string; fileId: string;
	discovery: CodexSessionDiscovery; parser: CodexEventParser; reader?: CodexJsonlReader; ready: boolean; failed: boolean }
/** Explicit exact-file native connector. No global conversation scan or credentials/CLI access. */
export class NativeCodexCapture {
	private readonly captures: Capture[] = [];
	private readonly listener: { dispose(): void };
	private connecting = false;
	private generation = 0;
	private streamGeneration = 0;
	constructor(private readonly recording: RecordingController, private readonly writer: ActivityWriter,
		private readonly workflow: Pick<AssessmentWorkflowConsent, 'permits' | 'supportsNative' | 'enrollNative'>,
		private readonly notice: (state: 'initializing' | 'ready' | 'interrupted' | 'unavailable' | 'declined') => void) {
		this.listener = recording.addLifecycleListener({ prepare: async () => {}, started: () => {}, stopped: () => { ++this.generation; }, cancelled: () => { ++this.generation; } });
	}
	getApprovals(id: string): { sourceSessionId: string; workspaceId: string }[] {
		return this.captures.filter(c => c.recordingId === id && c.ready && !c.failed && this.workflow.permits(id, 'codex')
			&& c.discovery.isConfirmed(c.fileId, id, c.sourceId)).map(c => ({ sourceSessionId: c.sourceId, workspaceId: c.workspaceId }));
	}
	async connect(file: string, sessionsDirectory: string, workspaces: readonly ApprovedWorkspace[], confirm: (notice: string) => Promise<boolean>): Promise<boolean> {
		if (this.connecting) { return false; } this.connecting = true;
		const id = this.recording.sessionId; const generation = this.generation;
		let discovery: CodexSessionDiscovery | undefined; let parser: CodexEventParser | undefined; let capture: Capture | undefined;
		try {
			for (const old of this.captures.filter(c => c.recordingId !== id)) { old.discovery.dispose(); old.reader?.dispose(); await old.reader?.flush(); old.parser.dispose(); await old.parser.flush(); this.captures.splice(this.captures.indexOf(old), 1); }
			if (!id || !this.workflow.permits(id, 'codex') || !await this.workflow.supportsNative() || this.captures.filter(c => c.recordingId === id).length >= 8) { throw new Error(); }
			const current = () => generation === this.generation && this.recording.sessionId === id && this.recording.isRecording && this.workflow.permits(id, 'codex');
			this.notice('initializing');
			discovery = new CodexSessionDiscovery(this.recording, () => workspaces, { sessionsDirectory, selectedSessionFile: file, pollIntervalMs: 1000, maxRegistryEntries: 4,
				onDiagnostic: () => { if (capture) { capture.failed = true; capture.ready = false; this.notice('interrupted'); } } });
			discovery.started(id); await discovery.flush();
			const candidates = discovery.getConfirmationCandidates();
			if (!current() || candidates.length !== 1) { throw new Error(); }
			const candidate = candidates[0];
			if (!candidate.sourceSessionId || !candidate.workspaceId || !candidate.createdAt || !await discovery.confirm(candidate.sourceFileId)) { throw new Error(); }
			const duplicate = this.captures.find(c => c.recordingId === id && c.sourceId === candidate.sourceSessionId && c.ready && !c.failed);
			if (duplicate) {
				if (duplicate.fileReference !== candidate.sourceFileReference || duplicate.createdAt !== candidate.createdAt || duplicate.workspaceId !== candidate.workspaceId || !await duplicate.discovery.revalidateConfirmedSession(duplicate.fileId)) { throw new Error(); }
				const opened = await duplicate.discovery.openConfirmedSession(duplicate.fileId); if (!opened) { throw new Error(); } await opened.handle.close();
				discovery.dispose(); this.notice('ready'); return true;
			}
			const startsAt = await this.workflow.enrollNative({ sourceSessionId: candidate.sourceSessionId, workspaceId: candidate.workspaceId,
				sourceFileReference: candidate.sourceFileReference, createdAt: candidate.createdAt }, confirm);
			if (!startsAt) { discovery.dispose(); this.notice('declined'); return false; }
			if (!current() || !await discovery.revalidateConfirmedSession(candidate.sourceFileId)) { throw new Error(); }
			parser = new CodexEventParser(this.recording, discovery, this.writer, { isExcludedPath: isSensitivePath,
				onDiagnostic: reason => { if (capture && reason === 'write_failed') { capture.failed = true; capture.ready = false; this.notice('interrupted'); } },
				resolveToolPath: (path, context) => {
					const workspace = workspaces.find(w => w.workspaceId === context.workspaceId); if (!workspace || !path || /[\x00-\x1f\x7f]/.test(path)) { return undefined; }
					const target = resolve(workspace.path, candidate.workspaceRelativeCwd ?? '.', path); const part = relative(workspace.path, target).replace(/\\/g, '/');
					return part && part !== '..' && !part.startsWith('../') && !isAbsolute(part) ? part : undefined;
				} });
			parser.grantContentConsent(id);
			capture = { recordingId: id, sourceId: candidate.sourceSessionId, fileReference: candidate.sourceFileReference, createdAt: candidate.createdAt, workspaceId: candidate.workspaceId,
				fileId: candidate.sourceFileId, discovery, parser, ready: false, failed: false };
			const connected = capture;
			const reader = new CodexJsonlReader(this.recording, discovery, { prospectiveOnly: true, initialGeneration: this.streamGeneration++,
				canCaptureContent: registration => current() && !connected.failed && connected.parser.canCapture(registration),
				onInitialized: () => { if (current() && !connected.failed) { connected.ready = true; this.notice('ready'); } },
				onDiagnostic: () => { if (!connected.failed) { connected.failed = true; connected.ready = false; this.notice('interrupted'); } },
				onSourceRecord: (record, context) => current() && connected.ready && !connected.failed && context.timestamp && Date.parse(context.timestamp) >= Date.parse(startsAt)
					? connected.parser.handle(record, context) : Promise.resolve() });
			connected.reader = reader; this.captures.push(connected);
			await reader.readNow(); if (!connected.ready || !current()) { throw new Error(); }
			return true;
		} catch {
			if (capture) { capture.failed = true; capture.ready = false; capture.reader?.dispose(); }
			discovery?.dispose(); parser?.dispose(); this.notice('unavailable'); return false;
		} finally { this.connecting = false; }
	}
	async flush(): Promise<void> { for (const capture of this.captures) { await capture.reader?.flush(); await capture.parser.flush(); } }
	async dispose(): Promise<void> { ++this.generation; this.listener.dispose(); for (const capture of this.captures) { capture.discovery.dispose(); capture.reader?.dispose(); await capture.reader?.flush(); capture.parser.dispose(); await capture.parser.flush(); } }
}
