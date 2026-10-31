import { constants, type Dir } from 'node:fs';
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { RecordingController, RecordingLifecycle } from './recording';
import { readSessionMetadata, type MetadataResult } from './codexMetadata';

export type DiscoveryStatus = 'eligible' | 'confirmed' | 'rejected' | 'ambiguous';
export const DISCOVERY_REASONS = ['recent_workspace_match', 'selected_workspace_match', 'multiple_matches', 'user_confirmed', 'user_rejected', 'historical', 'outside_workspace', 'future_timestamp', 'creation_time_unverified', 'invalid_metadata', 'missing_metadata', 'incomplete_metadata', 'oversized_metadata', 'working_directory_unverified', 'duplicate_source_id', 'metadata_changed', 'filename_mismatch'] as const;
export type DiscoveryReason = typeof DISCOVERY_REASONS[number];

/** Sanitized registry: no absolute cwd, transcript paths, account IDs, or content. */
export interface CodexSessionRegistration {
	recordingSessionId: string;
	sourceSessionId?: string;
	workspaceId?: string;
	sourceFileId: string;
	sourceFileReference: string;
	createdAt?: string;
	workspaceRelativeCwd?: string;
	codexVersion?: string;
	status: DiscoveryStatus;
	reason: DiscoveryReason;
}
export interface ApprovedWorkspace { workspaceId: string; path: string; }
/** A guarded open file, granted only to a confirmed session in the current recording. */
export interface ConfirmedCodexFile {
	registration: CodexSessionRegistration;
	handle: FileHandle;
	isCurrent(): boolean;
	verify(): Promise<boolean>;
}
interface Disposable { dispose(): void; }
export type DiscoveryDiagnostic = 'missing_directory' | 'unsafe_directory' | 'read_failed' | 'scan_limit' | 'registry_limit' | 'watcher_unavailable';
export interface DiscoveryOptions {
	/** Candidate-selected exact record only; never a global historical scan. */
	selectedSessionFile?: string;
	sessionsDirectory?: string;
	pollIntervalMs?: number;
	maxMetadataBytes?: number;
	maxEntriesPerScan?: number;
	maxRegistryEntries?: number;
	now?: () => Date;
	watch?: (root: string, created: (file: string) => void, changed: (file: string) => void) => Disposable;
	onCandidatesChanged?: (candidates: readonly CodexSessionRegistration[]) => void;
	onDiagnostic?: (diagnostic: DiscoveryDiagnostic) => void;
}
/** Counts/fixed codes only. Never includes source IDs, paths, cwd, timestamps or content. */
export interface CodexDiscoverySummary {
	recordingActive: boolean;
	directorySource: 'user_setting' | 'default_home';
	directoryStatus: 'not_checked' | 'ready' | 'missing' | 'unsafe';
	codexHome: 'unset' | 'matches' | 'differs' | 'invalid';
	approvedWorkspaceCount: number; inspectedFileCount: number; candidateCount: number; confirmedCount: number;
	reasons: Partial<Record<DiscoveryReason, number>>;
	diagnostics: DiscoveryDiagnostic[];
}
interface WorkspaceScope extends ApprovedWorkspace { canonical: string; }
interface FileIdentity { dev: number; ino: number; birthtimeMs: number; }
interface FileCache { relativePath: string; fingerprint: string; complete: boolean; confirmedIdentity?: FileIdentity; }
interface DirectoryCache { fingerprint: string; cursor?: Dir; }
interface Run {
	id: string; startMs: number; root?: string; scopes: WorkspaceScope[];
	files: Map<string, FileCache>; directories: Map<string, DirectoryCache>;
	sourceIds: Map<string, string>; diagnostics: Set<DiscoveryDiagnostic>;
	candidateSignature: string;
}
const DAY = 86400000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root: string, path: string) => {
	const part = relative(root, path);
	return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
};
const fingerprint = (stat: Awaited<ReturnType<typeof lstat>>) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.birthtimeMs}`;

export function codexSessionsDirectory(configured?: string): string {
	const path = configured?.trim() || join(homedir(), '.codex', 'sessions');
	const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
	if (!isAbsolute(expanded) || expanded.includes('\0')) { throw new Error('Invalid session directory'); }
	return normalize(expanded);
}

export class CodexSessionDiscovery implements RecordingLifecycle, Disposable {
	private readonly registration: Disposable;
	private readonly registry = new Map<string, CodexSessionRegistration>();
	private run: Run | undefined;
	private pending: Promise<void> = Promise.resolve();
	private timer: ReturnType<typeof setInterval> | undefined;
	private watcher: Disposable | undefined;
	private disposed = false;
	private readonly now: () => Date;
	private readonly maxMetadataBytes: number;
	private readonly maxEntries: number;
	private readonly maxRegistry: number;
	private readonly interval: number;

	constructor(
		private readonly recording: RecordingController,
		private readonly approvedWorkspaces: () => readonly ApprovedWorkspace[],
		private readonly options: DiscoveryOptions = {}
	) {
		this.now = options.now ?? (() => new Date());
		this.maxMetadataBytes = options.maxMetadataBytes ?? 65536;
		this.maxEntries = options.maxEntriesPerScan ?? 500;
		this.maxRegistry = options.maxRegistryEntries ?? 1000;
		this.interval = options.pollIntervalMs ?? 2000;
		for (const value of [this.maxMetadataBytes, this.maxEntries, this.maxRegistry]) {
			if (!Number.isSafeInteger(value) || value <= 0) { throw new Error('Invalid discovery limits'); }
		}
		if (!Number.isSafeInteger(this.interval) || this.interval < 0) { throw new Error('Invalid discovery interval'); }
		this.registration = recording.addLifecycleListener(this);
	}

	async prepare(): Promise<void> {} // Never access Codex files before recording becomes active.
	started(sessionId: string): void {
		this.stopRun();
		this.registry.clear();
		const run: Run = { id: sessionId, startMs: Date.parse(this.recording.startedAt!), scopes: [],
			files: new Map(), directories: new Map(), sourceIds: new Map(), diagnostics: new Set(), candidateSignature: '' };
		this.run = run;
		this.enqueue(run, async () => {
			for (const workspace of this.approvedWorkspaces()) {
				if (!this.current(run)) { return; }
				try { run.scopes.push({ ...workspace, path: resolve(workspace.path), canonical: await realpath(workspace.path) });
				} catch { /* A removed/unavailable approved workspace cannot establish ownership. */ }
			}
			await this.scan(run);
		});
		if (this.interval) { this.timer = setInterval(() => { void this.scanNow(); }, this.interval); }
	}
	stopped(sessionId: string): void { if (this.run?.id === sessionId) { this.stopRun(); } }
	cancelled(sessionId: string): void { this.stopped(sessionId); }
	private current(run: Run): boolean {
		return !this.disposed && this.run === run && this.recording.isRecording && this.recording.sessionId === run.id;
	}

	getRegistry(): CodexSessionRegistration[] { return [...this.registry.values()].map(entry => ({ ...entry })); }
	getDiagnostics(): CodexDiscoverySummary {
		const active = this.run && this.current(this.run) ? this.run : undefined;
		let codexHome: CodexDiscoverySummary['codexHome'] = 'unset';
		if (process.env.CODEX_HOME) {
			try { codexHome = samePath(codexSessionsDirectory(join(process.env.CODEX_HOME, 'sessions')), codexSessionsDirectory(this.options.sessionsDirectory)) ? 'matches' : 'differs'; }
			catch { codexHome = 'invalid'; }
		}
		const entries = active ? this.getRegistry().filter(entry => entry.recordingSessionId === active.id) : [];
		const reasons: CodexDiscoverySummary['reasons'] = {};
		for (const reason of DISCOVERY_REASONS) { const count = entries.filter(entry => entry.reason === reason).length; if (count) { reasons[reason] = count; } }
		return { recordingActive: !!active, directorySource: this.options.sessionsDirectory?.trim() ? 'user_setting' : 'default_home',
			directoryStatus: active?.root ? 'ready' : active?.diagnostics.has('unsafe_directory') ? 'unsafe' : active?.diagnostics.has('missing_directory') ? 'missing' : 'not_checked',
			codexHome, approvedWorkspaceCount: active?.scopes.length ?? 0, inspectedFileCount: active?.files.size ?? 0,
			candidateCount: active ? this.getConfirmationCandidates().length : 0,
			confirmedCount: entries.filter(entry => entry.status === 'confirmed' && entry.reason === 'user_confirmed').length,
			reasons, diagnostics: active ? [...active.diagnostics] : [] };
	}
	clearStoppedRegistry(): void {
		if (this.recording.isRecording || this.recording.isStarting) { throw new Error('Cannot clear active session associations.'); }
		this.registry.clear();
	}
	getConfirmationCandidates(): CodexSessionRegistration[] {
		return this.getRegistry().filter(entry => entry.recordingSessionId === this.recording.sessionId
			&& (['recent_workspace_match', 'multiple_matches', 'selected_workspace_match'].includes(entry.reason)));
	}
	isConfirmed(sourceFileId: string, recordingSessionId: string, sourceSessionId: string): boolean {
		const run = this.run;
		const entry = this.registry.get(sourceFileId);
		return !!run && this.current(run) && run.id === recordingSessionId
			&& entry?.status === 'confirmed' && entry.reason === 'user_confirmed'
			&& entry.sourceSessionId === sourceSessionId;
	}

	private invalidateConfirmedFile(run: Run, sourceFileId: string, file: FileCache): void {
		if (!this.current(run)) { return; }
		const entry = this.registry.get(sourceFileId);
		if (entry) { entry.status = 'ambiguous'; entry.reason = 'metadata_changed'; }
		file.confirmedIdentity = undefined;
		file.complete = false; file.fingerprint = '';
		this.publish(run);
	}

	/** Does not expose filesystem paths. Replacement requires a fresh discovery/confirmation. */
	async openConfirmedSession(sourceFileId: string): Promise<ConfirmedCodexFile | undefined> {
		const run = this.run;
		const entry = this.registry.get(sourceFileId);
		if (!run || !entry?.sourceSessionId || !this.isConfirmed(sourceFileId, run.id, entry.sourceSessionId)) { return undefined; }
		const file = [...run.files.values()].find(candidate => this.fileId(run, candidate.relativePath) === sourceFileId);
		const expected = file?.confirmedIdentity;
		if (!file || !expected) { return undefined; }
		const sourceSessionId = entry.sourceSessionId;
		const isCurrent = () => this.isConfirmed(sourceFileId, run.id, sourceSessionId)
			&& file.confirmedIdentity === expected;
		const sameIdentity = (stat: FileIdentity) => stat.dev === expected.dev && stat.ino === expected.ino
			&& stat.birthtimeMs === expected.birthtimeMs;
		const verify = async () => {
			if (!isCurrent()) { return false; }
			try {
				const stat = await this.safePath(run, file.relativePath, false);
				if (!stat || !sameIdentity(stat)) { this.invalidateConfirmedFile(run, sourceFileId, file); return false; }
				return isCurrent();
			} catch (error) {
				// A temporarily missing file retains its grant, but no bytes are read.
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.invalidateConfirmedFile(run, sourceFileId, file); }
				return false;
			}
		};
		if (!await verify()) { return undefined; }
		let handle: FileHandle | undefined;
		try {
			if (!isCurrent()) { return undefined; }
			handle = await open(join(run.root!, file.relativePath), constants.O_RDONLY | constants.O_NOFOLLOW);
			const opened = await handle.stat();
			if (!sameIdentity(opened) || !isCurrent() || !await verify()) {
				await handle.close(); return undefined;
			}
			return { registration: { ...entry }, handle, isCurrent, verify };
		} catch {
			await handle?.close().catch(() => {});
			return undefined;
		}
	}

	/** After a truncate/rewrite, verify metadata before the reader restarts at byte zero. */
	async revalidateConfirmedSession(sourceFileId: string): Promise<boolean> {
		const run = this.run;
		const entry = this.registry.get(sourceFileId);
		if (!run || !entry?.sourceSessionId || !this.isConfirmed(sourceFileId, run.id, entry.sourceSessionId)) { return false; }
		const file = [...run.files.values()].find(candidate => this.fileId(run, candidate.relativePath) === sourceFileId);
		if (!file) { return false; }
		try {
			const result = await this.read(run, file.relativePath);
			if (!this.current(run)) { return false; }
			const match = result.kind === 'valid' ? await this.workspace(run, result.metadata.cwd) : 'unverified';
			if (result.kind !== 'valid' || typeof match === 'string'
				|| result.metadata.sourceSessionId !== entry.sourceSessionId || result.metadata.createdAt !== entry.createdAt
				|| match.scope.workspaceId !== entry.workspaceId || match.relativeCwd !== entry.workspaceRelativeCwd) {
				this.invalidateConfirmedFile(run, sourceFileId, file); return false;
			}
			return this.isConfirmed(sourceFileId, run.id, entry.sourceSessionId);
		} catch { return false; }
	}
	async scanNow(): Promise<void> {
		const run = this.run;
		if (run && this.current(run)) { this.enqueue(run, () => this.scan(run)); }
		await this.flush();
	}
	async flush(): Promise<void> {
		let pending: Promise<void>;
		do { pending = this.pending; await pending; } while (pending !== this.pending);
	}

	private diagnostic(run: Run, diagnostic: DiscoveryDiagnostic): void {
		if (!this.current(run) || run.diagnostics.has(diagnostic)) { return; }
		run.diagnostics.add(diagnostic);
		this.options.onDiagnostic?.(diagnostic);
	}
	private enqueue(run: Run, operation: () => Promise<void>): void {
		this.pending = this.pending.then(async () => {
			if (this.current(run)) { await operation(); }
		}).catch(() => { this.diagnostic(run, 'read_failed'); });
	}

	private async initializeRoot(run: Run): Promise<boolean> {
		if (run.root) { return true; }
		try {
			const configured = codexSessionsDirectory(this.options.sessionsDirectory);
			const stat = await lstat(configured);
			if (!stat.isDirectory() || stat.isSymbolicLink()) { this.diagnostic(run, 'unsafe_directory'); return false; }
			const canonical = await realpath(configured);
			// Reject root/ancestor aliases as well as symlinked children. No implicit relocation.
			if (!samePath(configured, canonical)) {
				this.diagnostic(run, 'unsafe_directory'); return false;
			}
			if (!this.current(run)) { return false; }
			run.root = canonical;
			if (this.options.watch) {
				try {
					this.watcher = this.options.watch(canonical,
						file => this.changed(run, file, false), file => this.changed(run, file, true));
				} catch { this.diagnostic(run, 'watcher_unavailable'); }
			}
			return true;
		} catch (error) {
			this.diagnostic(run, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing_directory' : 'unsafe_directory');
			return false;
		}
	}

	private dateDirectories(run: Run): string[] {
		// Adjacent UTC days accommodate date folders created using a local timezone.
		const end = Math.floor(this.now().getTime() / DAY) + 1;
		const start = Math.max(Math.floor(run.startMs / DAY) - 1, end - 31);
		const days: string[] = [];
		for (let day = start; day <= end; day++) {
			days.push(new Date(day * DAY).toISOString().slice(0, 10).replace(/-/g, '/'));
		}
		return days;
	}
	private layoutAllowed(run: Run, path: string): boolean {
		if (this.options.selectedSessionFile) { return !!run.root && path.endsWith('.jsonl') && samePath(resolve(run.root, path), resolve(this.options.selectedSessionFile)); }
		const parts = path.split(sep);
		return path.endsWith('.jsonl') && (parts.length === 1
			|| (parts.length === 4 && this.dateDirectories(run).includes(parts.slice(0, 3).join('/'))));
	}

	private async safePath(run: Run, part: string, directory: boolean) {
		if (!run.root || !inside(run.root, join(run.root, part))) { return undefined; }
		let path = run.root;
		let stat = await lstat(path);
		if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(await realpath(path), path)) { return undefined; }
		const parts = part ? part.split(sep) : [];
		for (let i = 0; i < parts.length; i++) {
			if (!parts[i] || parts[i] === '.' || parts[i] === '..') { return undefined; }
			path = join(path, parts[i]); stat = await lstat(path);
			if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) { return undefined; }
		}
		if (!samePath(await realpath(path), path) || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) { return undefined; }
		return stat;
	}

	private async scan(run: Run): Promise<void> {
		if (!run.scopes.length || !this.current(run) || !await this.initializeRoot(run)) { return; }
		if (this.options.selectedSessionFile) {
			const selected = resolve(this.options.selectedSessionFile);
			if (!isAbsolute(this.options.selectedSessionFile) || !inside(run.root!, selected)) { this.diagnostic(run, 'unsafe_directory'); return; }
			const part = relative(run.root!, selected);
			if (!this.layoutAllowed(run, part)) { this.diagnostic(run, 'unsafe_directory'); return; }
			await this.inspect(run, part); this.publish(run); return;
		}
		let budget = this.maxEntries;
		for (const part of ['', ...this.dateDirectories(run).map(day => day.split('/').join(sep))]) {
			if (!this.current(run) || budget <= 0) { break; }
			try {
				const stat = await this.safePath(run, part, true);
				if (!stat) { continue; }
				let cache = run.directories.get(part);
				const signature = `${stat.dev}:${stat.ino}:${stat.mtimeMs}`;
				if (cache && !cache.cursor && cache.fingerprint === signature) { continue; }
				if (!cache?.cursor) {
					cache = { fingerprint: signature, cursor: await opendir(join(run.root!, part)) };
					run.directories.set(part, cache);
					if (!await this.safePath(run, part, true)) { await cache.cursor!.close(); cache.cursor = undefined; continue; }
				}
				while (budget > 0 && this.current(run)) {
					const entry = await cache.cursor!.read();
					if (!entry) { await cache.cursor!.close(); cache.cursor = undefined; break; }
					budget--;
					if (entry.isFile() && entry.name.endsWith('.jsonl')) { await this.inspect(run, join(part, entry.name)); }
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.diagnostic(run, 'read_failed'); }
			}
		}
		// Retry only partial/unverified headers whose file signature actually changed.
		for (const cache of run.files.values()) {
			if (!this.current(run) || budget <= 0) { break; }
			if (!cache.complete) { budget--; await this.inspect(run, cache.relativePath); }
		}
		if (budget <= 0) { this.diagnostic(run, 'scan_limit'); }
		this.publish(run);
	}

	private changed(run: Run, path: string, append: boolean): void {
		if (!this.current(run) || !run.root || !inside(run.root, path)) { return; }
		const part = relative(run.root, path);
		if (!this.layoutAllowed(run, part) || (append && run.files.get(part)?.complete)) { return; }
		this.enqueue(run, async () => { await this.inspect(run, part); this.publish(run); });
	}

	private fileId(run: Run, part: string): string { return hash(`${run.root}\0${part}`); }
	private entry(run: Run, part: string, status: DiscoveryStatus, reason: DiscoveryReason, fields: Partial<CodexSessionRegistration> = {}): void {
		if (!this.current(run)) { return; }
		const sourceFileId = this.fileId(run, part);
		if (!this.registry.has(sourceFileId) && this.registry.size >= this.maxRegistry) { this.diagnostic(run, 'registry_limit'); return; }
		this.registry.set(sourceFileId, { recordingSessionId: run.id, sourceFileId,
			sourceFileReference: `codex-file:${sourceFileId}`, ...fields, status, reason });
	}

	private async read(run: Run, part: string): Promise<MetadataResult> {
		const before = await this.safePath(run, part, false);
		if (!before || !this.current(run)) { return { kind: 'stopped' }; }
		const handle = await open(join(run.root!, part), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const opened = await handle.stat();
			if (opened.dev !== before.dev || opened.ino !== before.ino || !await this.safePath(run, part, false)) { return { kind: 'invalid' }; }
			const result = await readSessionMetadata(handle, () => this.current(run), this.maxMetadataBytes);
			const after = await this.safePath(run, part, false);
			return after && after.dev === opened.dev && after.ino === opened.ino ? result : { kind: 'invalid' };
		} finally { await handle.close(); }
	}

	private async workspace(run: Run, cwd: string): Promise<{ scope: WorkspaceScope; relativeCwd: string } | 'outside' | 'unverified'> {
		const path = resolve(cwd);
		const scopes = run.scopes.filter(scope => inside(scope.path, path) || inside(scope.canonical, path)).sort((a, b) => b.path.length - a.path.length);
		if (!scopes.length) { return 'outside'; }
		const scope = scopes[0];
		const part = relative(inside(scope.path, path) ? scope.path : scope.canonical, path);
		let candidate = scope.canonical;
		try {
			for (const segment of part ? part.split(sep) : []) {
				candidate = join(candidate, segment);
				const stat = await lstat(candidate);
				if (stat.isSymbolicLink() || !stat.isDirectory()) { return 'unverified'; }
			}
			if (!inside(scope.canonical, await realpath(candidate))) { return 'unverified'; }
			return { scope, relativeCwd: part.split(sep).join('/') || '.' };
		} catch { return 'unverified'; }
	}

	private async inspect(run: Run, part: string): Promise<void> {
		if (!this.current(run) || !this.layoutAllowed(run, part)) { return; }
		try {
			const stat = await this.safePath(run, part, false);
			if (!stat || !this.current(run)) { return; }
			const signature = fingerprint(stat);
			if (run.files.get(part)?.fingerprint === signature) { return; }
			const existing = run.files.get(part);
			const identity = existing?.confirmedIdentity;
			// Directory rescans must not revoke a grant merely because its journal appended.
			// The incremental reader detects/revalidates in-place resets; replacement still
			// changes identity and must go through discovery and explicit confirmation.
			if (existing && identity && stat.dev === identity.dev && stat.ino === identity.ino
				&& stat.birthtimeMs === identity.birthtimeMs && this.registry.get(this.fileId(run, part))?.status === 'confirmed') {
				existing.fingerprint = signature; return;
			}
			if (run.files.size >= this.maxRegistry && !run.files.has(part)) { this.diagnostic(run, 'registry_limit'); return; }
			const cache: FileCache = { relativePath: part, fingerprint: signature, complete: false };
			run.files.set(part, cache);
			// Old files (including old sessions appended during recording) are never opened.
			if (!this.options.selectedSessionFile && stat.birthtimeMs > 0 && stat.birthtimeMs < run.startMs) {
				cache.complete = true; this.entry(run, part, 'rejected', 'historical'); return;
			}
			const result = await this.read(run, part);
			if (!this.current(run) || result.kind === 'stopped') { return; }
			if (result.kind !== 'valid') {
				this.entry(run, part, 'ambiguous', `${result.kind}_metadata` as DiscoveryReason); return;
			}
			cache.complete = true;
			const metadata = result.metadata;
			const created = Date.parse(metadata.createdAt);
			if (!this.options.selectedSessionFile && created < run.startMs) { this.entry(run, part, 'rejected', 'historical'); return; }
			if (created > this.now().getTime()) { this.entry(run, part, 'ambiguous', 'future_timestamp'); return; }
			const match = await this.workspace(run, metadata.cwd);
			if (match === 'outside') { this.entry(run, part, 'rejected', 'outside_workspace'); return; }
			if (match === 'unverified') { this.entry(run, part, 'ambiguous', 'working_directory_unverified'); return; }
			const filenameId = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i.exec(basename(part))?.[1];
			if (filenameId && filenameId.toLowerCase() !== metadata.sourceSessionId) { this.entry(run, part, 'ambiguous', 'filename_mismatch'); return; }
			const id = this.fileId(run, part);
			const previousFile = run.sourceIds.get(metadata.sourceSessionId);
			if (previousFile && previousFile !== id) {
				const previous = this.registry.get(previousFile);
				if (previous) { previous.status = 'ambiguous'; previous.reason = 'duplicate_source_id'; }
				this.registry.delete(id); return;
			}
			run.sourceIds.set(metadata.sourceSessionId, id);
			this.entry(run, part, this.options.selectedSessionFile || stat.birthtimeMs > 0 ? 'eligible' : 'ambiguous',
				this.options.selectedSessionFile ? 'selected_workspace_match' : stat.birthtimeMs > 0 ? 'recent_workspace_match' : 'creation_time_unverified', {
				sourceSessionId: metadata.sourceSessionId, workspaceId: match.scope.workspaceId,
				createdAt: metadata.createdAt, workspaceRelativeCwd: match.relativeCwd, codexVersion: metadata.codexVersion
			});
		} catch { this.diagnostic(run, 'read_failed'); }
	}

	private publish(run: Run): void {
		if (!this.current(run)) { return; }
		const matches = [...this.registry.values()].filter(entry => ['recent_workspace_match', 'selected_workspace_match', 'multiple_matches', 'user_confirmed'].includes(entry.reason));
		for (const entry of matches) {
			if (entry.status !== 'confirmed') {
				entry.status = matches.length > 1 ? 'ambiguous' : 'eligible';
				entry.reason = this.options.selectedSessionFile ? 'selected_workspace_match' : matches.length > 1 ? 'multiple_matches' : 'recent_workspace_match';
			}
		}
		const candidates = this.getConfirmationCandidates();
		const signature = candidates.map(entry => `${entry.sourceFileId}:${entry.status}`).sort().join(',');
		if (signature !== run.candidateSignature) {
			run.candidateSignature = signature;
			this.options.onCandidatesChanged?.(candidates);
		}
	}

	async confirm(sourceFileId: string): Promise<boolean> {
		const run = this.run;
		let confirmed = false;
		if (!run || !this.current(run)) { return false; }
		this.enqueue(run, async () => {
			const entry = this.getConfirmationCandidates().find(entry => entry.sourceFileId === sourceFileId);
			const file = [...run.files.values()].find(file => this.fileId(run, file.relativePath) === sourceFileId);
			if (!entry || !file) { return; }
			const before = await this.safePath(run, file.relativePath, false);
			const result = await this.read(run, file.relativePath);
			if (!this.current(run)) { return; }
			const match = result.kind === 'valid' ? await this.workspace(run, result.metadata.cwd) : 'unverified';
			const after = await this.safePath(run, file.relativePath, false);
			if (!before || !after || before.dev !== after.dev || before.ino !== after.ino || before.birthtimeMs !== after.birthtimeMs
				|| result.kind !== 'valid' || typeof match === 'string'
				|| result.metadata.sourceSessionId !== entry.sourceSessionId || result.metadata.createdAt !== entry.createdAt
				|| match.scope.workspaceId !== entry.workspaceId || match.relativeCwd !== entry.workspaceRelativeCwd) {
				this.entry(run, file.relativePath, 'ambiguous', 'metadata_changed');
			} else if (this.current(run)) {
				file.confirmedIdentity = { dev: after.dev, ino: after.ino, birthtimeMs: after.birthtimeMs };
				this.registry.get(sourceFileId)!.status = 'confirmed';
				this.registry.get(sourceFileId)!.reason = 'user_confirmed'; confirmed = true;
			}
			this.publish(run);
		});
		await this.flush(); return confirmed;
	}
	reject(sourceFileId: string): void {
		const run = this.run;
		const entry = this.registry.get(sourceFileId);
		if (run && this.current(run) && entry) { entry.status = 'rejected'; entry.reason = 'user_rejected'; this.publish(run); }
	}

	private stopRun(): void {
		const run = this.run; this.run = undefined;
		if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
		this.watcher?.dispose(); this.watcher = undefined;
		if (run) {
			// Close cursors after an in-flight scan finishes, avoiding concurrent Dir.read/close.
			this.pending = this.pending.then(async () => {
				for (const cache of run.directories.values()) {
					if (cache.cursor) { await cache.cursor.close().catch(() => {}); cache.cursor = undefined; }
				}
			});
		}
	}
	dispose(): void { this.stopRun(); this.disposed = true; this.registration.dispose(); }
}
