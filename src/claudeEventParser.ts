import { ClaudeTranscriptReader } from './claudeTranscriptReader';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createClaudeEvent, type ClaudeSourceRecord, type CodexToolPayload, type ClaudeActivityEvent } from './eventSchema';
import type { RecordingController } from './recording';
import type { ActivityWriter } from './jsonlWriter';
import { isSensitivePath } from './privacyFilter';

export const CLAUDE_HOOKS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'MessageDisplay', 'Stop'] as const;
export interface ClaudeApproval { sourceSessionId: string; workspaceId: string; root: string; recordingSessionId: string }
interface Run extends ClaudeApproval {
	canonicalRoot: string; index: number; generation: number; closed: boolean; seen: Set<string>; turn: number;
	transcript: ClaudeTranscriptReader; hookResponses: boolean; messages: Map<string, { next: number; text: string }>; calls: Map<string, { eventId: string; payload: CodexToolPayload }>;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const withinClaudeRoot = (root: string, path: string) => {
	const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part);
};
/** Only explicitly launched/approved sessions are registered. Never scans a global conversation directory. */
export class ClaudeEventParser {
	private readonly runs = new Map<string, Run>();
	private readonly lifecycle: { dispose(): void };
	private pending: Promise<void> = Promise.resolve();
	private disposed = false;
	private queued = 0;
	constructor(private readonly recording: RecordingController, private readonly writer: ActivityWriter,
		private readonly onDiagnostic: (reason: 'malformed' | 'unverified' | 'write_failed' | 'limit') => void = () => {},
		private readonly transcriptRoot = join(homedir(), '.claude', 'projects')) {
		this.lifecycle = recording.addLifecycleListener({ prepare: async () => {}, started: () => { this.runs.clear(); },
			stopped: () => { this.revoke(); }, cancelled: () => {} });
	}
	private diagnostic(reason: 'malformed' | 'unverified' | 'write_failed' | 'limit'): void {
		try { this.onDiagnostic(reason); } catch { /* Never propagate diagnostics or raw source data. */ }
	}

	async approve(approval: ClaudeApproval): Promise<void> {
		if (!this.recording.isRecording || this.recording.sessionId !== approval.recordingSessionId || this.disposed || this.runs.size >= 16) { throw new Error('Claude capture unavailable.'); }
		const canonicalRoot = await realpath(approval.root);
		if (!this.recording.isRecording || this.recording.sessionId !== approval.recordingSessionId) { throw new Error('Claude capture unavailable.'); }
		this.runs.set(approval.sourceSessionId, { ...approval, root: resolve(approval.root), canonicalRoot, index: 0, generation: 0,
			closed: false, hookResponses: false, messages: new Map(), seen: new Set(), transcript: new ClaudeTranscriptReader(this.transcriptRoot, approval.sourceSessionId), calls: new Map(), turn: 0 });
	}
	getApprovals(sessionId: string): { sourceSessionId: string; workspaceId: string }[] {
		return [...this.runs.values()].filter(run => run.recordingSessionId === sessionId).map(({ sourceSessionId, workspaceId }) => ({ sourceSessionId, workspaceId }));
	}
	canCapture(sourceSessionId: string): boolean {
		const run = this.runs.get(sourceSessionId);
		return !this.disposed && !!run && !run.closed && this.recording.isRecording && this.recording.sessionId === run.recordingSessionId;
	}
	revoke(): void { for (const run of this.runs.values()) { run.closed = true; run.messages.clear(); } }
	handle(sourceSessionId: string, value: unknown): Promise<void> {
		if (!this.canCapture(sourceSessionId)) { return Promise.resolve(); }
		if (this.queued >= 32) { this.diagnostic('limit'); return Promise.resolve(); }
		let snapshot: Record<string, unknown>;
		try { const text = JSON.stringify(value); if (Buffer.byteLength(text) > 1024 * 1024) { throw new Error(); } snapshot = JSON.parse(text); }
		catch { this.diagnostic('malformed'); return Promise.resolve(); }
		this.queued++;
		const processing = this.pending.then(async () => {
			if (!this.canCapture(sourceSessionId)) { return; }
			const run = this.runs.get(sourceSessionId)!;
			try { await this.process(run, snapshot); }
			catch { run.closed = true; this.diagnostic('write_failed'); }
		}).finally(() => { this.queued--; });
		this.pending = processing.catch(() => {}); return processing;
	}
	private async process(run: Run, hook: Record<string, unknown>): Promise<void> {
		if (!hook || hook.session_id !== run.sourceSessionId || typeof hook.cwd !== 'string' || hook.agent_id
			|| !(CLAUDE_HOOKS as readonly unknown[]).includes(hook.hook_event_name)) { this.diagnostic('unverified'); return; }
		let cwd: string;
		try { cwd = await realpath(hook.cwd); } catch { this.diagnostic('unverified'); return; }
		if (!withinClaudeRoot(run.root, resolve(hook.cwd)) || !withinClaudeRoot(run.canonicalRoot, cwd) || !this.canCapture(run.sourceSessionId)) { this.diagnostic('unverified'); return; }
		if (run.index >= 10000) { run.closed = true; this.diagnostic('limit'); return; }
		const kind = hook.hook_event_name as string;
		const reference: ClaudeSourceRecord = { sourceFileReference: 'claude-file:' + digest(run.sourceSessionId), recordIndex: ++run.index,
			generation: run.generation, byteOffset: 0, byteLength: Buffer.byteLength(JSON.stringify(hook)), recordType: 'claude_hook' };
		const base = { sessionId: run.recordingSessionId, workspaceId: run.workspaceId, sourceSessionId: run.sourceSessionId, attribution: 'unknown' as const };
		const write = async (event: ClaudeActivityEvent) => { if (this.canCapture(run.sourceSessionId)) { await this.writer.write(event); } };
		const once = (key: string) => { if (run.seen.has(key)) { return false; } run.seen.add(key); return true; };
		if (kind === 'SessionStart') {
			if (run.index === 1) { await run.transcript.baseline(hook.transcript_path); }
			if (run.index > 1) { await this.incomplete(run, 'stream_reset'); run.generation++; run.messages.clear(); reference.generation = run.generation; }
			await write(createClaudeEvent({ ...base, eventType: 'ai.session.started', payload: { sourceRecord: reference, status: hook.source === 'resume' ? 'resumed' : 'started' } })); return;
		}
		if (kind === 'UserPromptSubmit') {
			if (typeof hook.prompt !== 'string' || /<(?:system-reminder|system_instructions|developer_instructions|task-notification|teammate-message)\b/i.test(hook.prompt) || !hook.prompt.trim() || Buffer.byteLength(hook.prompt) > 262144) { this.diagnostic('malformed'); return; }
			const key = typeof hook.prompt_id === 'string' ? 'prompt:' + hook.prompt_id : 'prompt-hook:' + run.index;
			if (!once(key)) { return; } run.turn++;
			await write(createClaudeEvent({ ...base, eventType: 'ai.prompt.submitted', payload: { text: hook.prompt, sourceRecord: reference } })); return;
		}
		if (kind === 'MessageDisplay') {
			if (typeof hook.message_id !== 'string' || hook.message_id.length > 256 || typeof hook.delta !== 'string'
				|| !Number.isSafeInteger(hook.index) || Number(hook.index) < 0 || typeof hook.final !== 'boolean') { this.diagnostic('malformed'); return; }
			const key = run.generation + ':' + hook.message_id;
			if (!once('display:' + key + ':' + hook.index)) { return; }
			let message = run.messages.get(key);
			if (!message) {
				if (hook.index !== 0 || run.messages.size >= 16) { this.diagnostic('unverified'); return; }
				message = { next: 0, text: '' }; run.messages.set(key, message);
			}
			if (message.next !== hook.index || Buffer.byteLength(message.text) + Buffer.byteLength(hook.delta) > 262144) {
				run.messages.delete(key); this.diagnostic('limit'); return;
			}
			message.next++; message.text += hook.delta; run.hookResponses = true;
			if (hook.final) {
				run.messages.delete(key); const text = message.text;
				if (text.trim() && once('response:' + run.turn + ':' + digest(text))) {
					await write(createClaudeEvent({ ...base, eventType: 'ai.response.completed', payload: { text, sourceRecord: reference } }));
				}
			} return;
		}
		if (kind === 'Stop') {
			let texts: { text: string; byteOffset?: number; byteLength?: number; recordIndex?: number }[] = [];
			if (typeof hook.last_assistant_message === 'string') { run.hookResponses = true; texts = [{ text: hook.last_assistant_message }]; }
			else if (!run.hookResponses) { try { texts = await run.transcript.read(() => this.canCapture(run.sourceSessionId)); } catch { this.diagnostic('unverified'); } }
			for (const message of texts) {
				const text = message.text;
				if (text.trim() && Buffer.byteLength(text) <= 262144 && once('response:' + run.turn + ':' + digest(text))) {
					await write(createClaudeEvent({ ...base, eventType: 'ai.response.completed', payload: { text, sourceRecord: {
						...reference, ...(message.byteOffset !== undefined ? { byteOffset: message.byteOffset, byteLength: message.byteLength!, recordIndex: message.recordIndex! } : {}),
						recordType: typeof hook.last_assistant_message === 'string' ? 'claude_hook' : 'claude_transcript' } } }));
				}
			} return;
		}

		if (kind === 'SessionEnd') {
			await this.incomplete(run, 'turn_aborted');
			await write(createClaudeEvent({ ...base, eventType: 'ai.session.ended', payload: { sourceRecord: reference, status: 'ended' } })); run.closed = true; run.messages.clear(); return;
		}
		if (typeof hook.tool_name !== 'string' || !/^[\w.-]{1,128}$/.test(hook.tool_name) || typeof hook.tool_use_id !== 'string' || !/^[\w.-]{1,256}$/.test(hook.tool_use_id)) { this.diagnostic('malformed'); return; }
		const callId = hook.tool_use_id;
		const candidate = run.calls.get(callId);
		// A conflicting name is not this call's result. Do not consume its deduplication key or pending start.
		if (candidate && candidate.payload.toolName !== hook.tool_name) { this.diagnostic('unverified'); return; }
		if (!once('tool:' + run.generation + ':' + kind + ':' + callId)) { return; }
		const start = candidate?.payload.toolName === hook.tool_name ? candidate : undefined;
		if (kind === 'PreToolUse' && run.calls.size >= 128) { this.diagnostic('limit'); return; }
		const serialized = (input: unknown) => {
			if (input === undefined) { return undefined; } const json = JSON.stringify(input);
			if (Buffer.byteLength(json) > 262144) { throw new Error('Claude event limit.'); } return json;
		};
		const payload: CodexToolPayload = { toolName: hook.tool_name, callId, sourceRecord: reference,
			status: kind === 'PreToolUse' ? 'running' : kind === 'PostToolUseFailure' ? 'failed' : 'succeeded',
			matched: !!start, timestampOrigin: 'capture', input: serialized(hook.tool_input),
			...(kind === 'PreToolUse' ? {} : { output: serialized(kind === 'PostToolUseFailure' ? hook.error : hook.tool_response), ...(start ? { startedEventId: start.eventId } : {}) }) };
		// Interpret only documented structured file-tool arguments; never commands, shell text or guessed paths.
		const input = hook.tool_input as Record<string, unknown> | undefined;
		if (['Edit', 'Write', 'Read'].includes(hook.tool_name) && typeof input?.file_path === 'string') {
			let path = resolve(cwd, input.file_path);
			if (withinClaudeRoot(run.root, path)) { path = resolve(run.canonicalRoot, relative(run.root, path)); }
			let parent: string;
			try { parent = await realpath(path); } catch {
				try { parent = await realpath(resolve(path, '..')); } catch { this.diagnostic('unverified'); return; }
			}
			const relativePath = relative(run.canonicalRoot, path).replace(/\\/g, '/');
			if (!withinClaudeRoot(run.canonicalRoot, parent) || !withinClaudeRoot(run.canonicalRoot, path) || !relativePath || isSensitivePath(relativePath)) { this.diagnostic('unverified'); return; }
			payload.fileEvidence = [{ relativePath, kind: 'declared', operation: hook.tool_name === 'Read' ? 'read' : 'edit', origin: 'structured_arguments' }];
		}
		const event = createClaudeEvent({ ...base, correlationId: callId,
			eventType: kind === 'PreToolUse' ? 'ai.tool.started' : kind === 'PostToolUseFailure' ? 'ai.tool.failed' : 'ai.tool.completed', payload });
		await write(event);
		if (kind === 'PreToolUse') { run.calls.set(callId, { eventId: event.eventId, payload: { toolName: payload.toolName, callId, sourceRecord: payload.sourceRecord, status: 'running', matched: false } }); } else { run.calls.delete(callId); }
	}
	private async incomplete(run: Run, reason: 'stream_reset' | 'turn_aborted' | 'recording_stopped'): Promise<void> {
		for (const [callId, call] of run.calls) {
			const event = createClaudeEvent({ sessionId: run.recordingSessionId, workspaceId: run.workspaceId, sourceSessionId: run.sourceSessionId,
				correlationId: callId, eventType: 'ai.tool.incomplete', payload: { toolName: call.payload.toolName, callId,
					sourceRecord: { ...call.payload.sourceRecord, recordIndex: ++run.index }, status: 'incomplete', matched: true,
					startedEventId: call.eventId, incompleteReason: reason, timestampOrigin: 'capture' } });
			await this.writer.write(event);
		} run.calls.clear();
	}
	async flush(): Promise<void> { await this.pending; }
	async finishRecording(): Promise<void> {
		const finishing = this.pending.then(async () => {
			for (const run of this.runs.values()) { try { await this.incomplete(run, 'recording_stopped'); } catch { this.diagnostic('write_failed'); } }
		});
		this.pending = finishing.catch(() => {}); await finishing;
	}
	dispose(): void { this.disposed = true; this.revoke(); this.lifecycle.dispose(); }
}
