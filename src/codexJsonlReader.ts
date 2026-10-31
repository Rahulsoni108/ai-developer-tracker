import { createHash } from 'node:crypto';
import type { RecordingController, RecordingLifecycle } from './recording';
import type { CodexSessionDiscovery, CodexSessionRegistration, ConfirmedCodexFile } from './codexSessionDiscovery';

/** The default verification callback receives only safe metadata, never record bodies. */
export interface CodexRecordMetadata {
	sourceSessionId: string;
	recordIndex: number;
	eventType: string;
	payloadType: string | null;
	timestamp?: string;
}
export interface CodexRecordContext {
	sessionId: string;
	sourceSessionId: string;
	workspaceId: string;
	sourceFileId: string;
	sourceFileReference: string;
	recordIndex: number;
	generation: number;
	byteOffset: number;
	byteLength: number;
	timestamp?: string;
}
export type ReaderDiagnosticReason = 'file_unavailable' | 'stream_reset' | 'invalid_record'
	| 'record_too_large' | 'memory_limit' | 'session_limit' | 'read_failed' | 'delivery_failed';
export interface CodexReaderDiagnostic {
	reason: ReaderDiagnosticReason;
	sourceSessionId?: string;
	recordIndex?: number;
}
export interface CodexReaderOptions {
	/** Explicit native connection: skip all earlier bytes; never replay on reset. */
	prospectiveOnly?: boolean;
	initialGeneration?: number;
	onInitialized?: (registration: Readonly<CodexSessionRegistration>) => void;
	pollIntervalMs?: number;
	chunkBytes?: number;
	maxRecordBytes?: number;
	maxBufferedBytes?: number;
	maxBytesPerSessionTick?: number;
	maxBytesPerTick?: number;
	maxSessions?: number;
	onRecord?: (record: Readonly<CodexRecordMetadata>) => void;
	/** Raw delivery is opt-in and additionally gated by content consent. Never use for diagnostics. */
	canCaptureContent?: (registration: Readonly<CodexSessionRegistration>) => boolean;
	onSourceRecord?: (record: Readonly<Record<string, unknown>>, context: Readonly<CodexRecordContext>) => Promise<void>;
	onDiagnostic?: (diagnostic: Readonly<CodexReaderDiagnostic>) => void;
}
type DiscoveryRegistry = Pick<CodexSessionDiscovery, 'getRegistry' | 'isConfirmed'
	| 'openConfirmedSession' | 'revalidateConfirmedSession'>;
interface Cursor {
	sourceFileId: string;
	sourceSessionId: string;
	offset: number;
	recordIndex: number;
	partial: Buffer;
	dropping: boolean;
	lastSize?: number;
	lastMtime?: number;
	fileIdentity?: string;
	anchorHash?: string;
	anchorLength: number;
	lineStartOffset: number;
	generation: number;
	diagnostics: Set<ReaderDiagnosticReason>;
}
interface Run {
	sessionId: string;
	cursors: Map<string, Cursor>;
	bufferedBytes: number;
	nextSession: number;
	sessionLimitReported: boolean;
}

// Unknown values become "unknown"; arbitrary type fields could themselves contain private text.
const eventTypes = new Set(['session_meta', 'response_item', 'event_msg', 'turn_context', 'compacted']);
const payloadTypes = new Set([
	'message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call',
	'custom_tool_call_output', 'web_search_call', 'local_shell_call', 'image_generation_call',
	'user_message', 'agent_message', 'agent_reasoning', 'assistant_message', 'token_count',
	'task_started', 'task_complete', 'turn_aborted', 'context_compacted', 'error',
	'warning', 'item_started', 'item_completed', 'exec_command_begin', 'exec_command_end',
	'patch_apply_begin', 'patch_apply_end'
]);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function safeTimestamp(value: unknown): string | undefined {
	if (typeof value !== 'string') { return undefined; }
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
	if (!match || +match[2] < 1 || +match[2] > 12 || +match[3] < 1
		|| +match[3] > new Date(Date.UTC(+match[1], +match[2], 0)).getUTCDate()
		|| +match[4] > 23 || +match[5] > 59 || +match[6] > 59 || !Number.isFinite(Date.parse(value))) { return undefined; }
	return new Date(value).toISOString();
}

export class CodexJsonlReader implements RecordingLifecycle {
	private readonly lifecycle: { dispose(): void };
	private readonly limits: Required<Omit<CodexReaderOptions, 'onRecord' | 'onDiagnostic' | 'canCaptureContent' | 'onSourceRecord' | 'prospectiveOnly' | 'initialGeneration' | 'onInitialized'>>;
	private run: Run | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private pending: Promise<void> = Promise.resolve();
	private scheduledRun: Run | undefined;
	private disposed = false;

	constructor(
		private readonly recording: RecordingController,
		private readonly discovery: DiscoveryRegistry,
		private readonly options: CodexReaderOptions = {}
	) {
		if (options.initialGeneration !== undefined && (!Number.isSafeInteger(options.initialGeneration) || options.initialGeneration < 0 || options.initialGeneration > 1000000)) { throw new Error('Invalid reader generation'); }
		this.limits = {
			pollIntervalMs: options.pollIntervalMs ?? 1000, chunkBytes: options.chunkBytes ?? 16384,
			maxRecordBytes: options.maxRecordBytes ?? 262144, maxBufferedBytes: options.maxBufferedBytes ?? 2097152,
			maxBytesPerSessionTick: options.maxBytesPerSessionTick ?? 131072,
			maxBytesPerTick: options.maxBytesPerTick ?? 1048576, maxSessions: options.maxSessions ?? 1000
		};
		for (const [name, value] of Object.entries(this.limits)) {
			if (!Number.isSafeInteger(value) || value < (name === 'pollIntervalMs' ? 0 : 1)) { throw new Error('Invalid reader limits'); }
		}
		if (this.limits.maxRecordBytes > 1048576 || this.limits.chunkBytes > 65536
			|| this.limits.maxBufferedBytes > 16777216 || this.limits.maxSessions > 1000) { throw new Error('Reader limits exceed safety bounds'); }
		this.lifecycle = recording.addLifecycleListener(this);
		if (recording.isRecording && recording.sessionId) { this.started(recording.sessionId); }
	}

	async prepare(): Promise<void> {} // Consent and discovery own all session eligibility.
	started(sessionId: string): void {
		this.stopRun();
		this.run = { sessionId, cursors: new Map(), bufferedBytes: 0, nextSession: 0, sessionLimitReported: false };
		void this.readNow();
		if (this.limits.pollIntervalMs) { this.timer = setInterval(() => { void this.readNow(); }, this.limits.pollIntervalMs); }
	}
	stopped(sessionId: string): void { if (this.run?.sessionId === sessionId) { this.stopRun(); } }
	cancelled(sessionId: string): void { this.stopped(sessionId); }
	private current(run: Run): boolean {
		return !this.disposed && this.run === run && this.recording.isRecording && this.recording.sessionId === run.sessionId;
	}
	private authorized(run: Run, cursor: Cursor): boolean {
		return this.current(run) && this.discovery.isConfirmed(cursor.sourceFileId, run.sessionId, cursor.sourceSessionId);
	}

	/** Calls from timers/watchers/tests coalesce; file reads cannot overlap or duplicate offsets. */
	readNow(): Promise<void> {
		const run = this.run;
		if (run && this.current(run) && this.scheduledRun !== run) {
			this.scheduledRun = run;
			this.pending = this.pending.then(async () => {
				try { if (this.current(run)) { await this.tick(run); }
				} catch { this.diagnostic(run, 'read_failed');
				} finally { if (this.scheduledRun === run) { this.scheduledRun = undefined; } }
			});
		}
		return this.pending;
	}
	async flush(): Promise<void> {
		let pending: Promise<void>;
		do { pending = this.pending; await pending; } while (pending !== this.pending);
	}

	/** Sanitized counters for verification, never partial bytes or transcript paths. */
	getProgress(): ReadonlyArray<{ sourceSessionId: string; byteOffset: number; recordIndex: number; bufferedBytes: number }> {
		return this.run ? [...this.run.cursors.values()].map(cursor => ({
			sourceSessionId: cursor.sourceSessionId, byteOffset: cursor.offset,
			recordIndex: cursor.recordIndex, bufferedBytes: cursor.partial.length
		})) : [];
	}
	private diagnostic(run: Run, reason: ReaderDiagnosticReason, cursor?: Cursor, once = false): void {
		if (!this.current(run) || (once && cursor?.diagnostics.has(reason))) { return; }
		if (once) { cursor?.diagnostics.add(reason); }
		try {
			this.options.onDiagnostic?.({ reason, ...(cursor ? { sourceSessionId: cursor.sourceSessionId, recordIndex: cursor.recordIndex + 1 } : {}) });
		} catch { /* Diagnostics must never turn a file problem into an extension failure. */ }
	}
	private clearPartial(run: Run, cursor: Cursor): void {
		run.bufferedBytes -= cursor.partial.length;
		cursor.partial.fill(0); cursor.partial = Buffer.alloc(0);
	}
	private newCursor(entry: CodexSessionRegistration): Cursor {
		return { sourceFileId: entry.sourceFileId, sourceSessionId: entry.sourceSessionId!,
			offset: 0, recordIndex: 0, partial: Buffer.alloc(0), dropping: false,
			anchorLength: 0, lineStartOffset: 0, generation: this.options.initialGeneration ?? 0, diagnostics: new Set() };
	}

	private async tick(run: Run): Promise<void> {
		const entries = this.discovery.getRegistry().filter(entry => entry.recordingSessionId === run.sessionId
			&& entry.status === 'confirmed' && entry.reason === 'user_confirmed' && !!entry.sourceSessionId);
		const approved = new Set(entries.map(entry => entry.sourceFileId));
		for (const [id, cursor] of run.cursors) {
			if (!approved.has(id)) { this.clearPartial(run, cursor); run.cursors.delete(id); }
		}
		if (entries.length > this.limits.maxSessions && !run.sessionLimitReported) {
			run.sessionLimitReported = true; this.diagnostic(run, 'session_limit');
		}
		const sessions = entries.slice(0, this.limits.maxSessions);
		let budget = this.limits.maxBytesPerTick;
		const start = sessions.length ? run.nextSession % sessions.length : 0;
		for (let index = 0; index < sessions.length && budget > 0 && this.current(run); index++) {
			const position = (start + index) % sessions.length;
			const entry = sessions[position];
			let cursor = run.cursors.get(entry.sourceFileId);
			if (!cursor || cursor.sourceSessionId !== entry.sourceSessionId) {
				if (cursor) { this.clearPartial(run, cursor); }
				cursor = this.newCursor(entry); run.cursors.set(entry.sourceFileId, cursor);
			}
			budget -= await this.readSession(run, cursor, Math.min(budget, this.limits.maxBytesPerSessionTick));
			run.nextSession = (position + 1) % sessions.length;
		}
	}

	private async readSession(run: Run, cursor: Cursor, budget: number): Promise<number> {
		if (!this.authorized(run, cursor)) { return 0; }
		const file = await this.discovery.openConfirmedSession(cursor.sourceFileId);
		if (!file) { this.diagnostic(run, 'file_unavailable', cursor, true); return 0; }
		const buffer = Buffer.alloc(this.limits.chunkBytes);
		const contentAllowed = () => !this.options.prospectiveOnly || !!this.options.canCaptureContent?.(file.registration);
		let consumed = 0;
		try {
			if (!this.authorized(run, cursor) || !file.isCurrent()) { return 0; }
			if (this.options.prospectiveOnly && !this.options.canCaptureContent?.(file.registration)) { return 0; }
			const stat = await file.handle.stat();
			if (!this.authorized(run, cursor) || !file.isCurrent()) { return 0; }
			cursor.diagnostics.delete('file_unavailable');
			const identity = stat.dev + ':' + stat.ino + ':' + stat.birthtimeMs;
			if (this.options.prospectiveOnly && cursor.fileIdentity === undefined) {
				if (!this.options.canCaptureContent?.(file.registration) || !await file.verify() || !this.authorized(run, cursor)) { return 0; }
				const delimiter = Buffer.alloc(1);
				try {
					if (!contentAllowed()) { return 0; }
					if (stat.size && (await file.handle.read(delimiter, 0, 1, stat.size - 1)).bytesRead !== 1) { throw new Error('Reader boundary unavailable'); }
					if (!file.isCurrent() || !await file.verify() || !this.authorized(run, cursor) || !contentAllowed()) { return 0; }
					cursor.offset = stat.size; cursor.lineStartOffset = stat.size; cursor.dropping = stat.size > 0 && delimiter[0] !== 10;
					cursor.fileIdentity = identity; cursor.lastSize = stat.size; cursor.lastMtime = stat.mtimeMs;
					cursor.anchorLength = stat.size ? 1 : 0; cursor.anchorHash = stat.size ? digest(delimiter) : undefined;
					this.options.onInitialized?.(Object.freeze({ ...file.registration }));
				} finally { delimiter.fill(0); }
				return 0;
			}
			let reset = (cursor.fileIdentity !== undefined && cursor.fileIdentity !== identity)
				|| stat.size < cursor.offset || (cursor.lastSize !== undefined && stat.size < cursor.lastSize)
				|| (cursor.lastSize === stat.size && cursor.lastMtime !== stat.mtimeMs);
			if (!reset && cursor.offset === stat.size && stat.size === cursor.lastSize && stat.mtimeMs === cursor.lastMtime) { return 0; }
			if (!reset && cursor.anchorHash) {
				const anchor = Buffer.alloc(cursor.anchorLength);
				try {
					if (!this.authorized(run, cursor) || !file.isCurrent() || !contentAllowed()) { return 0; }
					const result = await file.handle.read(anchor, 0, anchor.length, cursor.offset - anchor.length);
					if (!this.authorized(run, cursor) || !file.isCurrent()) { return 0; }
					reset = result.bytesRead !== anchor.length || digest(anchor) !== cursor.anchorHash;
				} finally { anchor.fill(0); }
			}
			if (reset) {
				if (this.options.prospectiveOnly) { this.diagnostic(run, 'stream_reset', cursor, true); return 0; }
				if (!await this.discovery.revalidateConfirmedSession(cursor.sourceFileId)
					|| !this.authorized(run, cursor) || !file.isCurrent() || !await file.verify()) { return 0; }
				this.clearPartial(run, cursor); cursor.dropping = false; cursor.offset = 0;
				cursor.anchorHash = undefined; cursor.anchorLength = 0;
				cursor.lineStartOffset = 0; cursor.generation++;
				this.diagnostic(run, 'stream_reset', cursor);
			}
			// Snapshot EOF: continuous appenders cannot monopolize one tick.
			const end = stat.size;
			while (consumed < budget && cursor.offset < end && this.authorized(run, cursor) && file.isCurrent()
				&& (!this.options.prospectiveOnly || this.options.canCaptureContent?.(file.registration))) {
				if (!await file.verify() || !this.authorized(run, cursor) || !contentAllowed()) { break; }
				const length = Math.min(buffer.length, budget - consumed, end - cursor.offset);
				const result = await file.handle.read(buffer, 0, length, cursor.offset);
				if (!this.authorized(run, cursor) || !file.isCurrent() || !await file.verify() || !contentAllowed()) { break; }
				if (!result.bytesRead) { break; }
				const bytes = buffer.subarray(0, result.bytesRead);
				cursor.offset += bytes.length; consumed += bytes.length;
				cursor.anchorLength = Math.min(64, bytes.length);
				cursor.anchorHash = digest(bytes.subarray(bytes.length - cursor.anchorLength));
				await this.consume(run, cursor, file, bytes);
				buffer.fill(0);
			}
			cursor.lastSize = stat.size; cursor.lastMtime = stat.mtimeMs;
			cursor.fileIdentity = identity;
		} catch { this.diagnostic(run, 'read_failed', cursor, true);
		} finally {
			buffer.fill(0);
			await file.handle.close().catch(() => {});
		}
		return consumed;
	}

	private async consume(run: Run, cursor: Cursor, file: ConfirmedCodexFile, bytes: Buffer): Promise<void> {
		let start = 0;
		while (start < bytes.length && this.authorized(run, cursor) && file.isCurrent()) {
			const newline = bytes.indexOf(10, start);
			const end = newline === -1 ? bytes.length : newline;
			const segment = bytes.subarray(start, end);
			if (!cursor.dropping) {
				const length = cursor.partial.length + segment.length;
				const reason = length > this.limits.maxRecordBytes ? 'record_too_large'
					: run.bufferedBytes + segment.length > this.limits.maxBufferedBytes ? 'memory_limit' : undefined;
				if (reason) {
					this.diagnostic(run, reason, cursor); this.clearPartial(run, cursor); cursor.dropping = true;
				} else if (segment.length) {
					const combined = Buffer.concat([cursor.partial, segment]);
					this.clearPartial(run, cursor); cursor.partial = combined; run.bufferedBytes += combined.length;
				}
			}
			if (newline === -1) { break; }
			if (!cursor.dropping) {
				await this.emitLine(run, cursor, file, cursor.offset - bytes.length + newline + 1 - cursor.lineStartOffset);
			}
			this.clearPartial(run, cursor); cursor.dropping = false; cursor.recordIndex++;
			cursor.lineStartOffset = cursor.offset - bytes.length + newline + 1;
			start = newline + 1;
		}
	}

	private async emitLine(run: Run, cursor: Cursor, file: ConfirmedCodexFile, byteLength: number): Promise<void> {
		let value: unknown;
		try {
			const text = new TextDecoder('utf-8', { fatal: true }).decode(cursor.partial);
			if (!text.trim()) { return; }
			value = JSON.parse(text);
		} catch { this.diagnostic(run, 'invalid_record', cursor); return; }
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			this.diagnostic(run, 'invalid_record', cursor); return;
		}
		const record = value as Record<string, unknown>;
		if (typeof record.type !== 'string') { this.diagnostic(run, 'invalid_record', cursor); return; }
		const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
			? record.payload as Record<string, unknown> : undefined;
		const type = payload?.type;
		const timestamp = safeTimestamp(record.timestamp);
		const metadata: CodexRecordMetadata = {
			sourceSessionId: cursor.sourceSessionId, recordIndex: cursor.recordIndex + 1,
			eventType: eventTypes.has(record.type) ? record.type : 'unknown',
			payloadType: typeof type === 'string' ? (payloadTypes.has(type) ? type : 'unknown') : null,
			...(timestamp ? { timestamp } : {})
		};
		if (!this.authorized(run, cursor)) { return; }
		try { this.options.onRecord?.(Object.freeze(metadata));
		} catch { this.diagnostic(run, 'delivery_failed', cursor); }
		if (this.authorized(run, cursor) && file.isCurrent() && this.options.onSourceRecord
			&& this.options.canCaptureContent?.(file.registration) && file.registration.workspaceId) {
			try {
				await this.options.onSourceRecord(record, {
					sessionId: run.sessionId, sourceSessionId: cursor.sourceSessionId, workspaceId: file.registration.workspaceId,
					sourceFileId: cursor.sourceFileId, sourceFileReference: file.registration.sourceFileReference,
					recordIndex: cursor.recordIndex + 1, generation: cursor.generation,
					byteOffset: cursor.lineStartOffset, byteLength, ...(timestamp ? { timestamp } : {})
				});
			} catch { this.diagnostic(run, 'delivery_failed', cursor); }
		}
	}

	private stopRun(): void {
		const run = this.run; this.run = undefined;
		if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
		if (run) {
			for (const cursor of run.cursors.values()) { this.clearPartial(run, cursor); }
			run.cursors.clear();
		}
	}
	dispose(): void { this.stopRun(); this.disposed = true; this.lifecycle.dispose(); }
}
