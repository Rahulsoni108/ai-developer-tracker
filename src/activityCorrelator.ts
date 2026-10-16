import { createHash } from 'node:crypto';
import { createRelationshipEvent, validateEvent, type CodexFileEvidence, type AiSourceRecord,
	type CodexToolPayload, type DiffEvent, type RelationshipEvidence, type RelationshipPayload, type TrackerEvent } from './eventSchema';
import { patchChangeHash } from './toolFileEvidence';
import type { ActivityWriter } from './jsonlWriter';
import type { RecordingController, RecordingLifecycle } from './recording';

export type CorrelatorDiagnostic = 'invalid_event' | 'queue_limit' | 'state_limit' | 'write_failed';
export interface ActivityCorrelatorOptions {
	approvedWorkspaces: () => readonly string[];
	isExcludedPath?: (path: string) => boolean;
	now?: () => Date;
	maxTools?: number;
	maxDiffs?: number;
	maxRelationships?: number;
	maxSeenEvents?: number;
	maxQueued?: number;
	retentionMs?: number;
	maxWindowMs?: number;
	toleranceMs?: number;
	onDiagnostic?: (reason: CorrelatorDiagnostic) => void;
}
interface ToolRecord {
	id: string; timestamp: number; sourceRecord: AiSourceRecord;
	status: CodexToolPayload['status']; effects: CodexFileEvidence[];
	timestampOrigin?: 'source' | 'capture'; startedEventId?: string;
	effectsEventId?: string; effectsSourceRecord?: AiSourceRecord;
}
interface Tool {
	key: string; sourceSessionId: string; workspaceId: string; callId?: string;
	start?: ToolRecord; result?: ToolRecord; buckets: Set<number>;
}
interface Diff {
	id: string; timestamp: number; workspaceId: string; relativePath: string;
	beforeHash: string; afterHash: string; changeHash?: string;
	changeReason: DiffEvent['payload']['changeReason']; sourceSessionId?: string;
}
interface Memo { fingerprint: string; eventId: string; revision: number; }
interface Workspace {
	tools: Map<string, Tool>; diffs: Map<string, Diff>;
	toolBuckets: Map<number, Set<string>>; diffBuckets: Map<number, Set<string>>;
	toolPaths: Map<string, Set<string>>; diffPaths: Map<string, Set<string>>;
}
interface Run {
	id: string; startedAt: number; stoppedAt?: number; scopes: Set<string>;
	workspaces: Map<string, Workspace>; seen: Set<string>; memos: Map<string, Memo>;
	toolRelationships: Map<string, Set<string>>; diffRelationships: Map<string, Set<string>>;
	watermark: number; capacityLimited: boolean; failed: boolean; diagnostics: Set<CorrelatorDiagnostic>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bucket = (timestamp: number) => Math.floor(timestamp / 1000);
const pause = () => new Promise<void>(done => setImmediate(done));
function add<K>(map: Map<K, Set<string>>, key: K, id: string): void {
	let values = map.get(key); if (!values) { values = new Set(); map.set(key, values); } values.add(id);
}
function remove<K>(map: Map<K, Set<string>>, key: K, id: string): void {
	const values = map.get(key); values?.delete(id); if (!values?.size) { map.delete(key); }
}

/** Incremental, metadata-only relationships. Never reads files or mutates attribution. */
export class ActivityCorrelator implements RecordingLifecycle {
	async clearStoppedEvidence(): Promise<void> {
		await this.flush();
		if (this.recording.isRecording || this.recording.isStarting) { throw new Error('Cannot clear active evidence.'); }
		this.runs.clear(); this.queuedIds.clear();
	}
	private readonly lifecycle: { dispose(): void };
	private readonly runs = new Map<string, Run>();
	private readonly queuedIds = new Set<string>();
	private pending: Promise<void> = Promise.resolve();
	private queued = 0;
	private disposed = false;
	private readonly now: () => Date;
	private readonly limits: Required<Pick<ActivityCorrelatorOptions, 'maxTools' | 'maxDiffs' | 'maxRelationships'
		| 'maxSeenEvents' | 'maxQueued' | 'retentionMs' | 'maxWindowMs' | 'toleranceMs'>>;

	constructor(private readonly recording: RecordingController, private readonly writer: ActivityWriter,
		private readonly options: ActivityCorrelatorOptions) {
		this.now = options.now ?? (() => new Date());
		this.limits = { maxTools: options.maxTools ?? 256, maxDiffs: options.maxDiffs ?? 1000,
			maxRelationships: options.maxRelationships ?? 4000, maxSeenEvents: options.maxSeenEvents ?? 20000,
			maxQueued: options.maxQueued ?? 32, retentionMs: options.retentionMs ?? 600000,
			maxWindowMs: options.maxWindowMs ?? 120000, toleranceMs: options.toleranceMs ?? 1000 };
		for (const [key, value] of Object.entries(this.limits)) {
			if (!Number.isSafeInteger(value) || value < (key === 'toleranceMs' ? 0 : 1)) { throw new Error('Invalid correlation limits'); }
		}
		if (this.limits.maxQueued > 128 || this.limits.maxSeenEvents > 100000 || this.limits.maxRelationships > 10000
			|| this.limits.maxTools > 1000 || this.limits.maxDiffs > 4000 || this.limits.retentionMs > 3600000
			|| this.limits.maxWindowMs > this.limits.retentionMs || this.limits.toleranceMs > 10000) { throw new Error('Correlation limits exceed safety bounds'); }
		this.lifecycle = recording.addLifecycleListener(this);
		if (recording.isRecording && recording.sessionId) { this.started(recording.sessionId); }
	}
	async prepare(): Promise<void> {}
	started(sessionId: string): void {
		if (this.disposed) { return; }
		while (this.runs.size >= 2) { this.runs.delete(this.runs.keys().next().value!); }
		this.runs.set(sessionId, { id: sessionId, startedAt: Date.parse(this.recording.startedAt!), scopes: new Set(this.options.approvedWorkspaces()),
			workspaces: new Map(), seen: new Set(), memos: new Map(), toolRelationships: new Map(), diffRelationships: new Map(),
			watermark: Date.parse(this.recording.startedAt!), capacityLimited: false, failed: false, diagnostics: new Set() });
	}
	stopped(sessionId: string): void { const run = this.runs.get(sessionId); if (run) { run.stoppedAt = this.now().getTime(); } }
	cancelled(sessionId: string): void { this.stopped(sessionId); }
	/** Called after all producers have drained their previously admitted recording events. */
	async finishSession(sessionId: string | undefined): Promise<void> {
		await this.flush(); if (sessionId) { this.runs.delete(sessionId); }
	}
	private diagnostic(run: Run, reason: CorrelatorDiagnostic): void {
		if (run.diagnostics.has(reason)) { return; }
		run.diagnostics.add(reason);
		try { this.options.onDiagnostic?.(reason); } catch { /* Never expose submitted values or exceptions. */ }
	}
	/** Feed successful, validated local writes. Relationship records are deliberately ignored. */
	observe(event: Readonly<TrackerEvent>): void {
		if (this.disposed || !event || typeof event !== 'object') { return; }
		const kind = Object.getOwnPropertyDescriptor(event, 'eventType')?.value;
		if (!['file.diff', 'ai.tool.started', 'ai.tool.completed', 'ai.tool.failed', 'ai.tool.incomplete'].includes(kind)) { return; }
		const validation = validateEvent(event);
		if (!validation.valid) {
			const id = Object.getOwnPropertyDescriptor(event, 'sessionId')?.value;
			const run = this.runs.get(id); if (run) { this.diagnostic(run, 'invalid_event'); } return;
		}
		event = validation.event;
		const run = this.runs.get(event.sessionId);
		if (!run || run.failed || !run.scopes.has(event.workspaceId!) || run.seen.has(event.eventId) || this.queuedIds.has(event.eventId)) { return; }
		const timestamp = Date.parse(event.timestamp);
		if (!Number.isFinite(timestamp) || timestamp < run.startedAt - this.limits.toleranceMs
			|| timestamp > this.now().getTime() + this.limits.toleranceMs) { return; }
		if (run.stoppedAt !== undefined && timestamp > run.stoppedAt) {
			// Synthetic incomplete records carry no new content and refer to an admitted call.
			if (event.eventType !== 'ai.tool.incomplete' || !(event.payload as CodexToolPayload).startedEventId
				|| !(run.seen.has((event.payload as CodexToolPayload).startedEventId!)
					|| this.queuedIds.has((event.payload as CodexToolPayload).startedEventId!))) { return; }
		}
		if (this.queued >= this.limits.maxQueued) { run.capacityLimited = true; this.diagnostic(run, 'queue_limit'); return; }
		this.queued++; this.queuedIds.add(event.eventId);
		this.pending = this.pending.then(async () => {
			try {
				await pause();
				if (!run.failed) { await this.process(run, event); }
			} catch { this.diagnostic(run, 'invalid_event');
			} finally { this.queued--; this.queuedIds.delete(event.eventId); }
		});
	}
	async flush(): Promise<void> {
		let pending: Promise<void>;
		do { pending = this.pending; await pending; } while (pending !== this.pending);
		await this.writer.flush();
	}
	getStats(): Readonly<{ runs: number; tools: number; diffs: number; relationships: number; seenEvents: number; queued: number }> {
		const runs = [...this.runs.values()];
		return { runs: runs.length, tools: runs.reduce((sum, run) => sum + [...run.workspaces.values()].reduce((n, workspace) => n + workspace.tools.size, 0), 0),
			diffs: runs.reduce((sum, run) => sum + [...run.workspaces.values()].reduce((n, workspace) => n + workspace.diffs.size, 0), 0),
			relationships: runs.reduce((sum, run) => sum + run.memos.size, 0),
			seenEvents: runs.reduce((sum, run) => sum + run.seen.size, 0), queued: this.queued };
	}
	private workspace(run: Run, id: string): Workspace {
		let workspace = run.workspaces.get(id);
		if (!workspace) {
			workspace = { tools: new Map(), diffs: new Map(), toolBuckets: new Map(), diffBuckets: new Map(), toolPaths: new Map(), diffPaths: new Map() };
			run.workspaces.set(id, workspace);
		}
		return workspace;
	}
	private window(tool: Tool): { start: number; end: number } {
		const start = tool.start?.timestamp ?? tool.result!.timestamp - this.limits.maxWindowMs;
		const end = tool.result?.timestamp ?? start + this.limits.maxWindowMs;
		return { start, end };
	}
	private effects(tool: Tool): CodexFileEvidence[] { return [...(tool.start?.effects ?? []), ...(tool.result?.effects ?? [])]; }
	private toolKey(event: TrackerEvent, payload: CodexToolPayload): string {
		return [event.source, event.workspaceId, event.sourceSessionId, payload.sourceRecord.sourceFileReference, payload.sourceRecord.generation,
			payload.callId ?? payload.startedEventId ?? event.eventId].join('\0');
	}
	private newer(a: ToolRecord, b: ToolRecord): boolean {
		return a.sourceRecord.recordIndex > b.sourceRecord.recordIndex || a.sourceRecord.recordIndex === b.sourceRecord.recordIndex && a.timestamp > b.timestamp;
	}
	private indexedTimes(map: Map<number, Set<string>>, start: number, end: number): Set<string> {
		const result = new Set<string>();
		const from = Math.max(start, end - this.limits.maxWindowMs - 2 * this.limits.toleranceMs);
		for (let index = bucket(from); index <= bucket(end); index++) {
			for (const id of map.get(index) ?? []) { result.add(id); }
		}
		return result;
	}
	private async process(run: Run, value: Readonly<TrackerEvent>): Promise<void> {
		const event = value;
		if (run.seen.has(event.eventId)) { return; }
		if (run.seen.size >= this.limits.maxSeenEvents) { run.capacityLimited = true; this.diagnostic(run, 'state_limit'); return; }
		run.seen.add(event.eventId);
		const workspace = this.workspace(run, event.workspaceId!);
		const timestamp = Date.parse(event.timestamp);
		run.watermark = Math.max(run.watermark, timestamp);
		this.prune(run, workspace);
		if (timestamp < run.watermark - this.limits.retentionMs) { return; }
		if (event.eventType === 'file.diff') {
			if (this.options.isExcludedPath?.(event.payload.relativePath)) { return; }
			const diff: Diff = { id: event.eventId, timestamp, workspaceId: event.workspaceId, relativePath: event.payload.relativePath,
				beforeHash: event.payload.beforeHash, afterHash: event.payload.afterHash, changeHash: patchChangeHash(event.payload.diff),
				changeReason: event.payload.changeReason, sourceSessionId: event.sourceSessionId };
			workspace.diffs.set(diff.id, diff); add(workspace.diffBuckets, bucket(timestamp), diff.id); add(workspace.diffPaths, diff.relativePath, diff.id);
			await this.evaluateDiff(run, workspace, diff);
		} else if (event.eventType.startsWith('ai.tool.')) {
			const payload = event.payload as CodexToolPayload;
			const key = this.toolKey(event, payload);
			let tool = workspace.tools.get(key);
			if (!tool) { tool = { key, sourceSessionId: event.sourceSessionId!, workspaceId: event.workspaceId!, callId: payload.callId, buckets: new Set() }; }
			this.unindexTool(workspace, tool);
			const record: ToolRecord = { id: event.eventId, timestamp, sourceRecord: { ...payload.sourceRecord },
				effects: (payload.fileEvidence ?? []).filter(item => !this.options.isExcludedPath?.(item.relativePath)).map(item => ({ ...item })),
				status: payload.status, timestampOrigin: payload.timestampOrigin, startedEventId: payload.startedEventId };
			if (event.eventType === 'ai.tool.started') {
				if (!tool.start || timestamp < tool.start.timestamp) {
					const previous = tool.start;
					if (previous?.effects.length && previous.sourceRecord.recordIndex > record.sourceRecord.recordIndex) {
						record.effects = previous.effects; record.effectsEventId = previous.effectsEventId ?? previous.id;
						record.effectsSourceRecord = previous.effectsSourceRecord ?? previous.sourceRecord;
					}
					tool.start = record;
				} else if (payload.statusUpdate) {
					tool.start.effects = record.effects; tool.start.effectsEventId = record.id; tool.start.effectsSourceRecord = record.sourceRecord;
				}
			} else if (!tool.result || this.newer(record, tool.result)) { tool.result = record; }
			workspace.tools.set(key, tool); this.indexTool(workspace, tool);
			const window = this.window(tool);
			const diffs = this.indexedTimes(workspace.diffBuckets, window.start - this.limits.toleranceMs, window.end + this.limits.toleranceMs);
			for (const effect of this.effects(tool)) { for (const id of workspace.diffPaths.get(effect.relativePath) ?? []) { diffs.add(id); } }
			for (const id of run.toolRelationships.get(key) ?? []) { diffs.add(id); }
			for (const id of diffs) {
				const diff = workspace.diffs.get(id); if (diff) { await this.evaluateDiff(run, workspace, diff); }
			}
		}
		this.prune(run, workspace);
	}
	private indexTool(workspace: Workspace, tool: Tool): void {
		const window = this.window(tool);
		const end = Math.max(window.start, window.end) + this.limits.toleranceMs;
		const start = Math.max(window.start - this.limits.toleranceMs, end - this.limits.maxWindowMs - 2 * this.limits.toleranceMs);
		for (let index = bucket(start); index <= bucket(end); index++) { tool.buckets.add(index); add(workspace.toolBuckets, index, tool.key); }
		for (const effect of this.effects(tool)) { add(workspace.toolPaths, effect.relativePath, tool.key); }
	}
	private unindexTool(workspace: Workspace, tool: Tool): void {
		for (const index of tool.buckets) { remove(workspace.toolBuckets, index, tool.key); }
		tool.buckets.clear();
		for (const effect of this.effects(tool)) { remove(workspace.toolPaths, effect.relativePath, tool.key); }
	}
	private eligible(tool: Tool, diff: Diff): boolean {
		if (diff.sourceSessionId && diff.sourceSessionId !== tool.sourceSessionId) { return false; }
		const effects = this.effects(tool);
		return !effects.length || effects.some(effect => effect.relativePath === diff.relativePath);
	}
	private overlaps(tool: Tool, diff: Diff): boolean {
		const window = this.window(tool);
		return this.eligible(tool, diff) && diff.timestamp >= window.start - this.limits.toleranceMs && diff.timestamp <= window.end + this.limits.toleranceMs;
	}
	private async evaluateDiff(run: Run, workspace: Workspace, diff: Diff): Promise<void> {
		const keys = new Set(workspace.toolBuckets.get(bucket(diff.timestamp)) ?? []);
		for (const key of workspace.toolPaths.get(diff.relativePath) ?? []) { keys.add(key); }
		for (const key of run.diffRelationships.get(diff.id) ?? []) { keys.add(key); }
		const tools = [...keys].map(key => workspace.tools.get(key)).filter((tool): tool is Tool => !!tool);
		const competing = tools.filter(tool => {
			const effects = this.effects(tool).filter(effect => effect.relativePath === diff.relativePath);
			return this.overlaps(tool, diff) && (!effects.length || !effects.every(effect => effect.operation === 'read'));
		});
		let processed = 0;
		for (const tool of tools) {
			const id = hash(run.id + '\0' + tool.workspaceId + '\0' + tool.key + '\0' + diff.id);
			const existing = run.memos.get(id);
			if ((!this.overlaps(tool, diff) || !this.eligible(tool, diff)) && !existing) { continue; }
			const payload = this.classify(tool, diff, competing.filter(other => other.key !== tool.key), run.capacityLimited);
			payload.relationshipId = id;
			const fingerprint = JSON.stringify(payload);
			if (existing?.fingerprint === fingerprint) { continue; }
			if (!existing && run.memos.size >= this.limits.maxRelationships) { run.capacityLimited = true; this.diagnostic(run, 'state_limit'); continue; }
			const event = createRelationshipEvent({ sessionId: run.id, workspaceId: tool.workspaceId, sourceSessionId: tool.sourceSessionId,
				eventType: existing ? 'activity.relationship.updated' : 'activity.relationship.created',
				correlationId: tool.callId ?? id, timestamp: this.now(),
				payload: { ...payload, revision: (existing?.revision ?? 0) + 1,
					...(existing ? { previousRelationshipEventId: existing.eventId } : {}) } });
			try {
				await this.writer.write(event);
				run.memos.set(id, { fingerprint, eventId: event.eventId, revision: event.payload.revision });
				add(run.toolRelationships, tool.key, diff.id); add(run.diffRelationships, diff.id, tool.key);
			} catch { run.failed = true; this.diagnostic(run, 'write_failed'); return; }
			if (++processed % 32 === 0) { await pause(); }
		}
	}
	private classify(tool: Tool, diff: Diff, competing: Tool[], limited: boolean): Omit<RelationshipPayload, 'revision' | 'previousRelationshipEventId'> {
		const source = tool.start ?? tool.result!;
		const evidence: RelationshipEvidence[] = [
			{ eventId: source.id, kind: tool.start ? 'tool_start' : 'tool_result', sourceRecord: { ...source.sourceRecord } },
			{ eventId: diff.id, kind: 'time_window' }
		];
		if (tool.start && tool.result) { evidence.push({ eventId: tool.result.id, kind: 'tool_result', sourceRecord: { ...tool.result.sourceRecord } }); }
		const resultEffect = tool.result?.effects.find(effect => effect.relativePath === diff.relativePath);
		const startEffect = tool.start?.effects.find(effect => effect.relativePath === diff.relativePath);
		const effect = resultEffect ?? startEffect;
		if (effect) {
			evidence.push({ eventId: resultEffect ? tool.result!.id : tool.start?.effectsEventId ?? source.id, kind: 'explicit_path',
				...(resultEffect ? { sourceRecord: tool.result!.sourceRecord } : tool.start?.effectsSourceRecord ? { sourceRecord: tool.start.effectsSourceRecord } : {}) });
		}
		const operationMatches = resultEffect?.operation === 'edit' ? !['create', 'delete'].includes(diff.changeReason)
			: resultEffect?.operation === 'create' ? diff.changeReason === 'create' : resultEffect?.operation === 'delete' && diff.changeReason === 'delete';
		const exact = !!resultEffect && operationMatches && resultEffect.kind === 'applied' && resultEffect.origin === 'patch_apply'
			&& ((!!resultEffect.changeHash && resultEffect.changeHash === diff.changeHash)
				|| (!!resultEffect.beforeHash && !!resultEffect.afterHash && resultEffect.beforeHash === diff.beforeHash && resultEffect.afterHash === diff.afterHash));
		if (exact) { evidence.push({ eventId: tool.result!.id, kind: 'applied_change' }, { eventId: diff.id, kind: 'change_hash_match' }); }
		const manual = ['edit', 'save'].includes(diff.changeReason);
		if (manual) { evidence.push({ eventId: diff.id, kind: 'editor_checkpoint' }); }
		for (const other of competing.slice(0, 8)) {
			const record = other.start ?? other.result!;
			evidence.push({ eventId: record.id, kind: 'competing_tool', sourceRecord: { ...record.sourceRecord } });
		}
		let confidence: RelationshipPayload['confidence'] = 'unknown';
		let explanationCode: RelationshipPayload['explanationCode'];
		if (!this.overlaps(tool, diff) || !this.eligible(tool, diff)) { explanationCode = 'outside_execution_window';
		} else if (!tool.start) { explanationCode = 'missing_tool_start';
		} else if (!tool.result || tool.result.status === 'incomplete') { explanationCode = 'missing_tool_result';
		} else if (tool.result.startedEventId !== tool.start.id
			|| tool.result.sourceRecord.sourceFileReference !== tool.start.sourceRecord.sourceFileReference
			|| tool.result.sourceRecord.generation !== tool.start.sourceRecord.generation || tool.result.timestamp < tool.start.timestamp) {
			explanationCode = 'source_reference_conflict';
		} else if (tool.result.status !== 'succeeded') { explanationCode = 'tool_unsuccessful';
		} else if (effect?.operation === 'read') { explanationCode = 'read_only_tool';
		} else if (tool.start.timestampOrigin !== 'source' || tool.result.timestampOrigin !== 'source') { explanationCode = 'unverified_timestamps';
		} else if (manual) { confidence = 'possible'; explanationCode = 'editor_checkpoint';
		} else if (competing.length) { confidence = 'possible'; explanationCode = 'overlapping_tools';
		} else if (exact && limited) { explanationCode = 'bounded_history';
		} else if (exact && diff.timestamp >= tool.start.timestamp && diff.timestamp <= tool.result.timestamp) {
			confidence = 'confirmed'; explanationCode = 'applied_change_matches_diff';
		} else {
			confidence = 'possible'; explanationCode = effect
				? (resultEffect?.kind === 'applied' && !exact ? 'change_evidence_mismatch' : 'explicit_path_window') : 'timestamp_only';
		}
		return { relationshipId: '', sourceEventId: source.id, targetEventId: diff.id, relationshipType: 'tool_file_change',
			relativePath: diff.relativePath, confidence, explanationCode, evidence, ...(tool.callId ? { callId: tool.callId } : {}) };
	}
	private prune(run: Run, workspace: Workspace): void {
		const cutoff = run.watermark - this.limits.retentionMs;
		for (const [key, tool] of workspace.tools) {
			if (Math.max(tool.start?.timestamp ?? 0, tool.result?.timestamp ?? 0) < cutoff) { this.unindexTool(workspace, tool); workspace.tools.delete(key); }
		}
		for (const [id, diff] of workspace.diffs) {
			if (diff.timestamp < cutoff) { remove(workspace.diffBuckets, bucket(diff.timestamp), id); remove(workspace.diffPaths, diff.relativePath, id); workspace.diffs.delete(id); }
		}
		while (workspace.tools.size > this.limits.maxTools) {
			const [key, tool] = workspace.tools.entries().next().value!;
			this.unindexTool(workspace, tool); workspace.tools.delete(key); run.capacityLimited = true; this.diagnostic(run, 'state_limit');
		}
		while (workspace.diffs.size > this.limits.maxDiffs) {
			const [id, diff] = workspace.diffs.entries().next().value!;
			remove(workspace.diffBuckets, bucket(diff.timestamp), id); remove(workspace.diffPaths, diff.relativePath, id); workspace.diffs.delete(id);
			run.capacityLimited = true; this.diagnostic(run, 'state_limit');
		}
	}
	dispose(): void { this.disposed = true; this.lifecycle.dispose(); void this.flush().then(() => this.runs.clear(), () => this.runs.clear()); }
}
