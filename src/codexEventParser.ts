import { createHash } from 'node:crypto';
import { createCodexEvent, MAX_CODEX_CONTENT_BYTES, validateEvent, type CodexActivityEvent,
	type CodexMessagePayload, type CodexSourceRecord, type CodexToolPayload } from './eventSchema';
import { extractToolFileEvidence, relativeToolPath } from './toolFileEvidence';
import type { CodexRecordContext } from './codexJsonlReader';
import type { CodexSessionDiscovery, CodexSessionRegistration } from './codexSessionDiscovery';
import type { ActivityWriter } from './jsonlWriter';
import type { RecordingController, RecordingLifecycle } from './recording';

export type CodexParserDiagnostic = 'invalid_record' | 'content_limit' | 'privacy_filtered' | 'write_failed' | 'state_limit';
export interface CodexParserOptions {
	now?: () => Date;
	isExcludedPath?: (path: string) => boolean;
	maxHistory?: number;
	maxOpenCalls?: number;
	maxSources?: number;
	onDiagnostic?: (reason: CodexParserDiagnostic) => void;
	resolveToolPath?: (path: string, context: CodexRecordContext) => string | undefined;
}
interface Mirror { origin: string; index: number; timestamp: number; turnId?: string; paired: boolean; }
interface Call {
	context: CodexRecordContext; sourceRecord: CodexSourceRecord;
	name: string; callId?: string; startedEventId?: string;
	closed: boolean; blocked: boolean; status?: CodexToolPayload['status']; outputHash?: string;
}
interface SourceState {
	generation: number;
	seenRecords: Set<string>;
	messageIds: Set<string>;
	mirrors: Map<string, Mirror[]>;
	calls: Map<string, Call>;
	turnId?: string;
}
interface Run { id: string; consented: boolean; failed: boolean; sources: Map<string, SourceState>; limitReported: boolean; }
type Registry = Pick<CodexSessionDiscovery, 'isConfirmed' | 'getRegistry'>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0
	&& value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
function object(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) { return undefined; }
	const result: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value')) { return undefined; }
		result[key] = descriptor.value;
	}
	return result;
}
const instructionTags = 'environment_context|user_instructions|developer_instructions|system_instructions|instructions|skills_instructions|apps_instructions|plugins_instructions';
function promptText(text: string): string | undefined {
	const marker = '## My request for Codex:';
	if (text.includes(marker)) { text = text.slice(text.indexOf(marker) + marker.length).trim(); }
	if (/^\s*#\s*AGENTS\.md instructions\b/i.test(text)) { return undefined; }
	const cleaned = text.replace(new RegExp('<(' + instructionTags + ')\\b[^>]*>[\\s\\S]*?<\\/\\1>', 'gi'), '');
	if (new RegExp('<\\/?(' + instructionTags + ')\\b', 'i').test(cleaned)) { return undefined; }
	return cleaned.trim() ? (cleaned === text ? text : cleaned.trim()) : undefined;
}
function textParts(value: unknown, role: 'user' | 'assistant' | 'tool'): string[] | undefined {
	if (!Array.isArray(value) || value.length > 1024) { return undefined; }
	const result: string[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !Object.hasOwn(descriptor, 'value')) { return undefined; }
		const part = object(descriptor.value);
		if (!part) { return undefined; }
		const allowed = role === 'user' ? ['input_text', 'text'] : role === 'assistant' ? ['output_text', 'text'] : ['input_text', 'output_text', 'text'];
		if (allowed.includes(part.type as string)) {
			if (!visible(part)) { continue; }
			if (typeof part.text !== 'string') { return undefined; }
			const text = role === 'user' ? promptText(part.text) : part.text;
			if (text?.trim()) { result.push(text); }
		}
	}
	return result;
}
function visible(payload: Record<string, unknown>): boolean {
	return (payload.channel === undefined || ['final', 'commentary'].includes(payload.channel as string))
		&& (payload.phase === undefined || ['final_answer', 'commentary', 'final'].includes(payload.phase as string))
		&& (payload.recipient === undefined || ['all', 'user'].includes(payload.recipient as string))
		&& (payload.status === undefined || payload.status === 'completed');
}
function commandInput(value: unknown): string | undefined {
	if (!Array.isArray(value) || value.length > 1024) { return undefined; }
	const parts: string[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') { return undefined; }
		parts.push(descriptor.value);
	}
	return JSON.stringify(parts);
}
function sourceRecord(context: CodexRecordContext, type: 'response_item' | 'event_msg'): CodexSourceRecord {
	return { sourceFileReference: context.sourceFileReference, recordIndex: context.recordIndex, generation: context.generation,
		byteOffset: context.byteOffset, byteLength: context.byteLength, recordType: type };
}

export class CodexEventParser implements RecordingLifecycle {
	private readonly lifecycle: { dispose(): void };
	private run: Run | undefined;
	private pending: Promise<void> = Promise.resolve();
	private disposed = false;
	private readonly maxHistory: number;
	private readonly maxOpenCalls: number;
	private readonly maxSources: number;
	private readonly now: () => Date;

	constructor(private readonly recording: RecordingController, private readonly discovery: Registry,
		private readonly writer: ActivityWriter, private readonly options: CodexParserOptions = {}) {
		this.now = options.now ?? (() => new Date());
		this.maxHistory = options.maxHistory ?? 2048; this.maxOpenCalls = options.maxOpenCalls ?? 256;
		this.maxSources = options.maxSources ?? 64;
		if (![this.maxHistory, this.maxOpenCalls].every(value => Number.isSafeInteger(value) && value > 0 && value <= 4096)) {
			throw new Error('Invalid parser limits');
		}
		if (!Number.isSafeInteger(this.maxSources) || this.maxSources < 1 || this.maxSources > 256) { throw new Error('Invalid source limit'); }
		this.lifecycle = recording.addLifecycleListener(this);
		if (recording.isRecording && recording.sessionId) { this.started(recording.sessionId); }
	}
	async prepare(): Promise<void> {}
	started(sessionId: string): void {
		this.run = { id: sessionId, consented: false, failed: false, sources: new Map(), limitReported: false };
	}
	/** Called only after the separate content-consent dialog succeeds for this recording. */
	grantContentConsent(sessionId: string): void {
		if (!this.disposed && this.run?.id === sessionId && this.recording.isRecording && this.recording.sessionId === sessionId && !this.run.failed) {
			this.run.consented = true;
		}
	}
	hasContentConsent(sessionId: string | undefined): boolean {
		return !!sessionId && !this.disposed && this.run?.id === sessionId && this.run.consented && !this.run.failed
			&& this.recording.isRecording && this.recording.sessionId === sessionId;
	}
	/** Trusted lifecycle snapshot only; ingestion still requires hasContentConsent/isRecording. */
	hasAdmittedContentConsent(sessionId: string): boolean {
		return !this.disposed && this.run?.id === sessionId && this.run.consented && !this.run.failed;
	}
	canCapture(registration: Readonly<CodexSessionRegistration>): boolean {
		return this.hasContentConsent(registration.recordingSessionId) && registration.status === 'confirmed'
			&& registration.reason === 'user_confirmed' && !!registration.sourceSessionId && !!registration.workspaceId
			&& this.discovery.isConfirmed(registration.sourceFileId, registration.recordingSessionId, registration.sourceSessionId);
	}
	private authorized(context: CodexRecordContext): boolean {
		return this.hasContentConsent(context.sessionId)
			&& this.discovery.isConfirmed(context.sourceFileId, context.sessionId, context.sourceSessionId)
			&& this.discovery.getRegistry().some(entry => entry.sourceFileId === context.sourceFileId
				&& entry.workspaceId === context.workspaceId && entry.sourceFileReference === context.sourceFileReference);
	}
	private diagnostic(reason: CodexParserDiagnostic): void {
		try { this.options.onDiagnostic?.(reason); } catch { /* Never log supplied values or exceptions. */ }
	}
	private remember<T>(set: Set<T>, value: T): void {
		set.add(value); if (set.size > this.maxHistory) { set.delete(set.values().next().value!); }
	}
	private state(run: Run, context: CodexRecordContext): SourceState | undefined {
		const key = context.sourceFileId + ':' + context.sourceSessionId;
		let state = run.sources.get(key);
		if (!state) {
			if (run.sources.size >= this.maxSources) {
				if (!run.limitReported) { run.limitReported = true; this.diagnostic('state_limit'); }
				return undefined;
			}
			state = { generation: context.generation, seenRecords: new Set(), messageIds: new Set(), mirrors: new Map(), calls: new Map() };
			run.sources.set(key, state);
		}
		if (state.generation !== context.generation) {
			this.closeCalls(run, state, 'stream_reset');
			state.generation = context.generation; state.turnId = undefined; state.mirrors.clear();
		}
		return state;
	}

	async handle(value: unknown, contextValue: Readonly<CodexRecordContext>): Promise<void> {
		try {
			const context = object(contextValue) as unknown as CodexRecordContext | undefined;
			if (!context || !this.authorized(context) || !this.run) { return; }
			const record = object(value);
			const payload = object(record?.payload);
			if (!record || !payload || !['response_item', 'event_msg'].includes(record.type as string) || typeof payload.type !== 'string') { return; }
			const run = this.run;
			const reference = sourceRecord(context, record.type as 'response_item' | 'event_msg');
			// Validate references before retaining identifiers or processing sensitive content.
			const probe = createCodexEvent({ sessionId: run.id, workspaceId: context.workspaceId, sourceSessionId: context.sourceSessionId,
				eventType: 'ai.prompt.submitted', payload: { text: 'reference validation', sourceRecord: reference } });
			if (!validateEvent(probe).valid) { this.diagnostic('invalid_record'); return; }
			const state = this.state(run, context);
			if (!state) { return; }
			const recordKey = context.generation + ':' + context.recordIndex;
			if (state.seenRecords.has(recordKey)) { return; }
			this.remember(state.seenRecords, recordKey);
			if (identifier(payload.turn_id)) { state.turnId = payload.turn_id; }
			if (record.type === 'event_msg' && payload.type === 'task_started') { return; }
			if (record.type === 'event_msg' && payload.type === 'turn_aborted') {
				this.closeCalls(run, state, 'turn_aborted'); await this.flush(); return;
			}
			if (record.type === 'response_item' && payload.type === 'message' && ['user', 'assistant'].includes(payload.role as string)) {
				if (!visible(payload)) { return; }
				const role = payload.role as 'user' | 'assistant';
				const parts = textParts(payload.content, role);
				if (parts === undefined) { this.diagnostic('invalid_record'); return; }
				this.message(run, state, context, reference, payload, role, parts, 'response_item');
			} else if (record.type === 'event_msg' && ['user_message', 'agent_message'].includes(payload.type)) {
				if (!visible(payload) || typeof payload.message !== 'string') { return; }
				const role = payload.type === 'user_message' ? 'user' : 'assistant';
				if (payload.role !== undefined && payload.role !== role) { return; }
				const text = role === 'user' ? promptText(payload.message) : payload.message;
				if (text?.trim()) { this.message(run, state, context, reference, payload, role, [text], 'event_msg'); }
			} else {
				this.tool(run, state, context, reference, record.type as string, payload);
			}
			await this.flush();
		} catch { this.diagnostic('invalid_record'); }
	}

	private message(run: Run, state: SourceState, context: CodexRecordContext, reference: CodexSourceRecord,
		payload: Record<string, unknown>, role: 'user' | 'assistant', parts: string[], origin: string): void {
		if (!parts.length) { return; }
		const messageId = identifier(payload.id) ? payload.id : identifier(payload.item_id) ? payload.item_id : undefined;
		const messageKey = role + ':' + messageId;
		if (messageId && state.messageIds.has(messageKey)) { return; }
		const timestamp = context.timestamp ? Date.parse(context.timestamp) : this.now().getTime();
		const text = parts.join('\n');
		if (Buffer.byteLength(text) > MAX_CODEX_CONTENT_BYTES) { this.diagnostic('content_limit'); return; }
		const keys = parts.map(text => role + ':' + hash(text));
		const compatible = (mirror: Mirror) => !mirror.paired && mirror.origin !== origin
			&& context.recordIndex - mirror.index <= 64 && Math.abs(timestamp - mirror.timestamp) <= 10000
			&& (!mirror.turnId || !state.turnId || mirror.turnId === state.turnId);
		const aggregateKey = role + ':' + hash(text);
		const aggregateMirror = state.mirrors.get(aggregateKey)?.find(compatible);
		if (aggregateMirror) {
			aggregateMirror.paired = true;
			if (messageId) { this.remember(state.messageIds, messageKey); }
			return;
		}
		// Match one opposite-origin occurrence per part; repeated same-origin prompts are retained.
		const selected = new Set<Mirror>();
		const mirrors = keys.map(key => {
			const mirror = state.mirrors.get(key)?.find(mirror => compatible(mirror) && !selected.has(mirror));
			if (mirror) { selected.add(mirror); } return mirror;
		});
		if (mirrors.every(Boolean)) {
			for (const mirror of mirrors) { mirror!.paired = true; }
			if (messageId) { this.remember(state.messageIds, messageKey); }
			return;
		}
		const normalized: CodexMessagePayload = { text, sourceRecord: reference,
			...(parts.length > 1 ? { partLengths: parts.map(part => part.length) } : {}),
			...(messageId ? { messageId } : {}),
			...(['commentary', 'final_answer', 'final'].includes(payload.phase as string)
				? { phase: payload.phase === 'commentary' ? 'commentary' as const : 'final_answer' as const } : {})
		};
		this.write(run, this.event(context, role === 'user' ? 'ai.prompt.submitted' : 'ai.response.completed', normalized, state.turnId ?? messageId));
		if (messageId) { this.remember(state.messageIds, messageKey); }
		for (const key of [...keys, ...(parts.length > 1 ? [aggregateKey] : [])]) {
			const history = state.mirrors.get(key) ?? [];
			history.push({ origin, index: context.recordIndex, timestamp, turnId: state.turnId, paired: false });
			if (history.length > 8) { history.shift(); }
			state.mirrors.set(key, history);
		}
		while (state.mirrors.size > this.maxHistory) { state.mirrors.delete(state.mirrors.keys().next().value!); }
	}

	private privacyFiltered(text: string | undefined): boolean {
		if (!text || !this.options.isExcludedPath) { return false; }
		// Only examine explicit path-like tokens; do not open referenced files or directories.
		const tokens = text.match(/[a-zA-Z0-9_.~\/\\-]+/g) ?? [];
		if (tokens.some(token => (/[\/\\.]/.test(token) || /^(credentials|secrets?|id_rsa|id_ed25519)$/i.test(token))
			&& this.options.isExcludedPath!(token))) { return true; }
		// Bare directory names such as "build" are filtered only in explicit path fields,
		// rather than treating an ordinary command like "npm run build" as a file read.
		const inspect = (value: unknown, pathField = false, depth = 0): boolean => {
			if (depth > 8) { return true; }
			if (typeof value === 'string') { return pathField && this.options.isExcludedPath!(value); }
			if (Array.isArray(value)) { return value.some(child => inspect(child, pathField, depth + 1)); }
			const data = object(value);
			return !!data && Object.entries(data).some(([key, child]) =>
				inspect(child, /^(path|file_path|filename|file|files|cwd|workdir|directory|target_file)$/i.test(key), depth + 1));
		};
		try { return inspect(JSON.parse(text)); } catch { return false; }
	}
	private tool(run: Run, state: SourceState, context: CodexRecordContext, reference: CodexSourceRecord,
		type: string, payload: Record<string, unknown>): void {
		const start = type === 'response_item' && ['function_call', 'custom_tool_call'].includes(payload.type as string)
			|| type === 'event_msg' && ['exec_command_begin', 'patch_apply_begin'].includes(payload.type as string);
		const end = type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(payload.type as string)
			|| type === 'event_msg' && ['exec_command_end', 'patch_apply_end'].includes(payload.type as string);
		if (!start && !end) { return; }
		const callId = identifier(payload.call_id) ? payload.call_id : undefined;
		const key = callId ?? 'unmatched:' + context.generation + ':' + context.recordIndex;
		let call = state.calls.get(key);
		const name = identifier(payload.name) ? payload.name
			: (payload.type as string).startsWith('exec_command_') ? 'exec_command'
				: (payload.type as string).startsWith('patch_apply_') ? 'apply_patch' : call?.name ?? 'unknown';
		const fileEvidence = (applied: boolean) => extractToolFileEvidence(payload, raw => {
			if (this.options.resolveToolPath) { return this.options.resolveToolPath(raw, context); }
			const cwd = this.discovery.getRegistry().find(entry => entry.sourceFileId === context.sourceFileId)?.workspaceRelativeCwd;
			return relativeToolPath(raw, cwd);
		}, this.options.isExcludedPath ?? (() => false), applied);
		if (start) {
			if (call?.startedEventId) {
				const effects = fileEvidence(false);
				if (effects.length) {
					const metadata: CodexToolPayload = { toolName: call.name, status: 'running', matched: !!callId, sourceRecord: reference,
						fileEvidence: effects, timestampOrigin: context.timestamp ? 'source' : 'capture', statusUpdate: true,
						startedEventId: call.startedEventId, ...(callId ? { callId } : {}) };
					this.write(run, this.event(context, 'ai.tool.started', metadata, callId));
				}
				return;
			}
			let input = typeof payload.arguments === 'string' ? payload.arguments : typeof payload.input === 'string' ? payload.input : undefined;
			if (payload.type === 'exec_command_begin') { input = commandInput(payload.command); }
			const blocked = this.privacyFiltered(input) || this.privacyFiltered(typeof payload.cwd === 'string' ? payload.cwd : undefined)
				|| payload.type === 'patch_apply_begin'; // Never copy structured path-keyed patches wholesale.
			if (input !== undefined && Buffer.byteLength(input) > MAX_CODEX_CONTENT_BYTES) { this.diagnostic('content_limit'); input = undefined; }
			if (blocked) { this.diagnostic('privacy_filtered'); }
			const normalized: CodexToolPayload = { toolName: name, status: 'running', matched: !!callId, sourceRecord: reference,
				fileEvidence: fileEvidence(false), timestampOrigin: context.timestamp ? 'source' : 'capture',
				...(callId ? { callId } : {}), ...(blocked ? { contentOmitted: 'privacy_filter' } : input !== undefined ? { input } : {}) };
			const event = this.event(context, 'ai.tool.started', normalized, callId);
			this.write(run, event);
			call = { context: { ...context }, sourceRecord: reference, name, callId, startedEventId: event.eventId,
				closed: call?.closed ?? false, blocked: blocked || (call?.blocked ?? false), status: call?.status, outputHash: call?.outputHash };
			state.calls.set(key, call);
		} else {
			let output = typeof payload.output === 'string' ? payload.output
				: Array.isArray(payload.output) ? textParts(payload.output, 'tool')?.join('\n') : undefined;
			if (typeof payload.aggregated_output === 'string') { output = payload.aggregated_output; }
			if (payload.type === 'patch_apply_end') {
				const parts = [payload.stdout, payload.stderr].filter((part): part is string => typeof part === 'string');
				output = parts.join('\n');
			}
			const blocked = !!call?.blocked || this.privacyFiltered(output);
			if (blocked) { this.diagnostic('privacy_filtered'); output = undefined; }
			if (output !== undefined && Buffer.byteLength(output) > MAX_CODEX_CONTENT_BYTES) { this.diagnostic('content_limit'); output = undefined; }
			let outputStatus: Record<string, unknown> | undefined;
			if (output !== undefined) {
				try { outputStatus = object(JSON.parse(output)); } catch { /* Plain-text output is supported. */ }
			}
			const printedExit = output && /^Process exited with code (-?\d+)\s*$/m.exec(output);
			const reportedExit = payload.exit_code ?? outputStatus?.exit_code ?? (printedExit ? Number(printedExit[1]) : undefined);
			const exitCode = Number.isSafeInteger(reportedExit) ? reportedExit as number : undefined;
			const status: CodexToolPayload['status'] = payload.success === false || payload.is_error === true || outputStatus?.success === false
				|| ['failed', 'declined', 'error', 'cancelled'].includes((payload.status ?? outputStatus?.status) as string) || (exitCode !== undefined && exitCode !== 0)
				? 'failed' : payload.success === true || outputStatus?.success === true || payload.status === 'completed' || exitCode === 0 ? 'succeeded' : 'unknown';
			const outputHash = output !== undefined ? hash(output) : undefined;
			const effects = fileEvidence(status === 'succeeded');
			if (call?.closed && !effects.length && (call.status === status || (status === 'unknown' && call.status !== 'unknown'))) { return; }
			const update = !!call?.closed;
			const normalized: CodexToolPayload = {
				toolName: call?.name ?? name, sourceRecord: reference, status, matched: !!call?.startedEventId,
				fileEvidence: effects, timestampOrigin: context.timestamp ? 'source' : 'capture',
				...(callId ? { callId } : {}), ...(call?.startedEventId ? { startedEventId: call.startedEventId } : {}),
				...(exitCode !== undefined ? { exitCode } : {}),
				...(blocked ? { contentOmitted: 'privacy_filter' } : output !== undefined && (!update || call?.outputHash !== outputHash) ? { output } : {}),
				...(update ? { statusUpdate: true } : {})
			};
			this.write(run, this.event(context, status === 'failed' ? 'ai.tool.failed' : 'ai.tool.completed', normalized, callId));
			call = call ?? { context: { ...context }, sourceRecord: reference, name, callId, blocked, closed: false };
			call.closed = true; call.status = status; call.outputHash = outputHash; call.blocked = blocked;
			state.calls.set(key, call);
		}
		while (state.calls.size > this.maxOpenCalls) {
			const [oldestKey, oldest] = state.calls.entries().next().value!;
			if (!oldest.closed) { this.incomplete(run, oldest, 'capacity_limit'); }
			state.calls.delete(oldestKey); this.diagnostic('state_limit');
		}
	}

	private event(context: CodexRecordContext, type: CodexActivityEvent['eventType'],
		payload: CodexMessagePayload | CodexToolPayload, correlationId?: string): CodexActivityEvent {
		return createCodexEvent({ sessionId: context.sessionId, sourceSessionId: context.sourceSessionId,
			workspaceId: context.workspaceId, eventType: type, payload,
			...(correlationId ? { correlationId } : {}),
			timestamp: context.timestamp ? new Date(context.timestamp) : this.now() });
	}
	private write(run: Run, event: CodexActivityEvent): void {
		if (!validateEvent(event).valid) { this.diagnostic('invalid_record'); return; }
		this.pending = this.pending.then(async () => {
			if (run.failed) { return; }
			try { await this.writer.write(event); }
			catch { run.failed = true; run.consented = false; this.diagnostic('write_failed'); }
		});
	}
	private incomplete(run: Run, call: Call, reason: NonNullable<CodexToolPayload['incompleteReason']>): void {
		if (call.closed || !call.startedEventId) { return; }
		call.closed = true;
		const payload: CodexToolPayload = { toolName: call.name, sourceRecord: call.sourceRecord,
			status: 'incomplete', matched: !!call.callId, startedEventId: call.startedEventId, incompleteReason: reason,
			...(call.callId ? { callId: call.callId } : {}) };
		this.write(run, this.event({ ...call.context, timestamp: this.now().toISOString() }, 'ai.tool.incomplete', payload, call.callId));
	}
	private closeCalls(run: Run, state: SourceState, reason: NonNullable<CodexToolPayload['incompleteReason']>): void {
		for (const call of state.calls.values()) { this.incomplete(run, call, reason); }
		state.calls.clear();
	}
	private closeRun(reason: 'recording_stopped' | 'capture_disposed'): void {
		const run = this.run; this.run = undefined;
		if (!run) { return; }
		const confirmed = this.discovery.getRegistry().filter(entry => entry.recordingSessionId === run.id
			&& entry.status === 'confirmed' && entry.reason === 'user_confirmed');
		for (const [key, state] of run.sources) {
			if (run.consented && confirmed.some(entry => key === entry.sourceFileId + ':' + entry.sourceSessionId)) { this.closeCalls(run, state, reason); }
			state.calls.clear(); state.mirrors.clear(); state.messageIds.clear(); state.seenRecords.clear();
		}
		run.consented = false; run.sources.clear();
	}
	stopped(sessionId: string): void { if (this.run?.id === sessionId) { this.closeRun('recording_stopped'); } }
	cancelled(sessionId: string): void { this.stopped(sessionId); }
	async flush(): Promise<void> {
		let pending: Promise<void>;
		do { pending = this.pending; await pending; } while (pending !== this.pending);
		await this.writer.flush();
	}
	dispose(): void { this.closeRun('capture_disposed'); this.disposed = true; this.lifecycle.dispose(); }
}
