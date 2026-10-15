import * as vscode from 'vscode';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { FileTracker, type TrackedFile } from './fileTracker';
import { RecordingController, type RecordingLifecycle } from './recording';
import type { ActivityWriter } from './jsonlWriter';
import { createChangeEvent, MAX_SCHEMA_DIFF_BYTES, type ChangeReason, type GapReason } from './eventSchema';

export interface DiffOptions {
	maxFileBytes: number;
	maxDiffBytes: number;
	maxMemoryBytes: number;
	debounceMs: number;
	maxCheckpointMs: number;
	diffTimeoutMs: number;
}
export const DEFAULT_DIFF_OPTIONS: DiffOptions = {
	maxFileBytes: 256 * 1024, maxDiffBytes: 512 * 1024, maxMemoryBytes: 32 * 1024 * 1024,
	debounceMs: 300, maxCheckpointMs: 2000, diffTimeoutMs: 100
};

interface Snapshot {
	content?: string;
	hash?: string;
	exists: boolean;
	gap?: GapReason;
}
interface FileState {
	file: TrackedFile;
	snapshot: Snapshot;
	needsBaseline: boolean;
	lastGap?: GapReason;
}
interface PendingEdit {
	file: TrackedFile;
	snapshot: Promise<Snapshot>;
	timestamp: Date;
	guard: (() => Promise<boolean>) | undefined;
	idle: ReturnType<typeof setTimeout>;
	maximum: ReturnType<typeof setTimeout>;
}
interface Session {
	id: string;
	states: Map<string, FileState>;
	edits: Map<string, PendingEdit>;
	startedAt?: Date;
	memoryBytes: number;
}
type DiffWorkspace = Pick<typeof vscode.workspace, 'onDidChangeTextDocument' | 'onDidSaveTextDocument' | 'createFileSystemWatcher' | 'textDocuments' | 'fs'>;

export function contentHash(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}
const absent = (): Snapshot => ({ content: '', hash: contentHash(''), exists: false });
const key = (file: TrackedFile) => `${file.workspaceId}:${file.relativePath}`;
const bytes = (snapshot: Snapshot) => Buffer.byteLength(snapshot.content ?? '', 'utf8');
const MAX_PENDING = 64;

export class DiffTracker implements vscode.Disposable, RecordingLifecycle {
	async clearStoppedEvidence(): Promise<void> {
		await this.flush();
		if (this.recording.isRecording || this.recording.isStarting) { throw new Error('Cannot clear active evidence.'); }
		this.session?.states.clear(); this.session = undefined;
	}
	private readonly options: DiffOptions;
	private readonly subscriptions: vscode.Disposable[];
	private watchers: vscode.Disposable[] = [];
	private session: Session | undefined;
	private pending: Promise<void> = Promise.resolve();
	private queued = 0;
	private disposed = false;

	constructor(
		private readonly recording: RecordingController,
		private readonly files: FileTracker,
		private readonly writer: ActivityWriter,
		private readonly onError: (error: unknown) => void,
		options: Partial<DiffOptions> = {},
		private readonly workspace: DiffWorkspace = vscode.workspace,
		private readonly now: () => Date = () => new Date()
	) {
		this.options = { ...DEFAULT_DIFF_OPTIONS, ...options };
		for (const value of Object.values(this.options)) {
			if (!Number.isSafeInteger(value) || value <= 0) {
				throw new Error('Diff limits and checkpoint intervals must be positive integers.');
			}
		}
		if (this.options.maxDiffBytes > MAX_SCHEMA_DIFF_BYTES || this.options.maxFileBytes > 1024 * 1024
			|| this.options.maxMemoryBytes > 128 * 1024 * 1024 || this.options.diffTimeoutMs > 250
			|| this.options.debounceMs > 2000 || this.options.maxCheckpointMs > 10000
			|| this.options.maxCheckpointMs < this.options.debounceMs) {
			throw new Error('Unsupported diff limits or checkpoint intervals.');
		}
		this.subscriptions = [
			recording.addLifecycleListener(this),
			workspace.onDidChangeTextDocument(event => {
				if (event.contentChanges.length) {
					this.document(event.document, 'edit');
				}
			}),
			workspace.onDidSaveTextDocument(document => this.document(document, 'save'))
		];
	}

	async prepare(sessionId: string, isCurrentRequest: () => boolean): Promise<void> {
		await this.flush();
		if (this.disposed || !isCurrentRequest()) {
			return;
		}
		this.disposeWatchers();
		const session: Session = { id: sessionId, states: new Map(), edits: new Map(), memoryBytes: 0 };
		this.session = session;
		for (const folder of this.files.getApprovedFolders()) {
			const workspaceId = createHash('sha256').update(folder.uri.toString()).digest('hex');
			const watcher = this.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'), false, false, false);
			this.watchers.push(watcher,
				watcher.onDidCreate(uri => this.disk(uri, 'create', workspaceId)),
				watcher.onDidChange(uri => this.disk(uri, 'external', workspaceId)),
				watcher.onDidDelete(uri => this.disk(uri, 'delete', workspaceId)));
		}
		// One metadata index, reused from FileTracker. Only bounded file contents are read here.
		this.enqueue(async () => {
			for (const file of this.files.getEligibleFiles()) {
				if (!isCurrentRequest() || this.disposed) {
					break;
				}
				const document = this.workspace.textDocuments.find(document => document.uri.toString() === file.uri.toString());
				const sample = document && document.isDirty
					? await this.safeDocument(file, document, document.version)
					: await this.readDisk(file);
				if (sample) {
					this.store(session, file, sample, true);
				}
			}
		});
		await this.pending;
	}

	started(sessionId: string): void {
		const session = this.session;
		if (!session || session.id !== sessionId) {
			return;
		}
		session.startedAt = this.now();
		this.enqueue(async () => {
			for (const state of session.states.values()) {
				await this.baseline(session, state, 'create', session.startedAt!);
			}
		});
	}

	stopped(sessionId: string): void {
		if (this.session?.id === sessionId) {
			this.drainEdits(this.session);
			this.disposeWatchers();
		}
	}

	cancelled(sessionId: string): void {
		if (this.session?.id === sessionId) {
			this.drainEdits(this.session);
			this.session = undefined;
			this.disposeWatchers();
		}
	}

	private accepting(session: Session): boolean {
		return !this.disposed && (this.recording.sessionId === session.id && this.recording.isRecording || !session.startedAt);
	}

	private sampleText(document: vscode.TextDocument): Snapshot {
		// Check character count before copying the document, then enforce the UTF-8 byte limit.
		if (document.offsetAt(new vscode.Position(document.lineCount, 0)) > this.options.maxFileBytes) {
			return { exists: true, gap: 'file_size_limit' };
		}
		const content = document.getText();
		if (Buffer.byteLength(content, 'utf8') > this.options.maxFileBytes) {
			return { exists: true, gap: 'file_size_limit' };
		}
		if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) {
			return { exists: true, gap: 'binary' };
		}
		return { content, hash: contentHash(content), exists: true };
	}

	private async safeDocument(file: TrackedFile, document: vscode.TextDocument, version: number): Promise<Snapshot | undefined> {
		const guard = this.files.getReadGuard(file.uri);
		try {
			if (!guard || !await guard()) {
				return undefined;
			}
			return document.version === version ? this.sampleText(document) : { exists: true, gap: 'read_race' };
		} catch {
			return { exists: true, gap: 'read_error' };
		}
	}

	private async readDisk(file: TrackedFile, capturedAt?: Date): Promise<Snapshot | undefined> {
		const guard = this.files.getReadGuard(file.uri);
		try {
			if (!guard || !await guard()) {
				return undefined;
			}
			const handle = await open(file.uri.fsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const before = await handle.stat();
				if (!before.isFile()) {
					return undefined;
				}
				if (capturedAt && before.mtimeMs > capturedAt.getTime() + 1) {
					// The notified version was overwritten before it could be sampled.
					return { exists: true, gap: 'read_race' };
				}
				if (before.size > this.options.maxFileBytes) {
					return { exists: true, gap: 'file_size_limit' };
				}
				// Recheck the canonical scope after opening and before reading any bytes.
				if (!await guard()) {
					return undefined;
				}
				const current = await stat(file.uri.fsPath);
				if (current.dev !== before.dev || current.ino !== before.ino) {
					return { exists: true, gap: 'read_race' };
				}
				const buffer = Buffer.alloc(this.options.maxFileBytes + 1);
				let length = 0;
				while (length < buffer.length) {
					const result = await handle.read(buffer, length, buffer.length - length, length);
					if (!result.bytesRead) {
						break;
					}
					length += result.bytesRead;
				}
				const after = await handle.stat();
				if (length > this.options.maxFileBytes) {
					return { exists: true, gap: 'file_size_limit' };
				}
				if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || before.ctimeMs !== after.ctimeMs) {
					return { exists: true, gap: 'read_race' };
				}
				try {
					const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
					return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)
						? { exists: true, gap: 'binary' } : { content, hash: contentHash(content), exists: true };
				} catch {
					return { exists: true, gap: 'binary' };
				}
			} finally {
				await handle.close();
			}
		} catch {
			return { exists: true, gap: 'read_error' };
		}
	}

	private document(document: vscode.TextDocument, reason: 'edit' | 'save'): void {
		const session = this.session;
		const file = this.files.getFileContext(document.uri);
		if (!session || !file || !this.accepting(session)) {
			return;
		}
		const timestamp = this.now();
		const guard = this.files.getReadGuard(file.uri);
		const known = session.states.has(key(file));
		const snapshot = this.queued >= MAX_PENDING || (!session.edits.has(key(file)) && session.edits.size >= MAX_PENDING)
			? Promise.resolve<Snapshot>({ exists: true, gap: 'checkpoint_overflow' })
			: known ? Promise.resolve(this.sampleText(document)) : this.safeDocument(file, document, document.version);
		const captured = snapshot.then(sample => sample ?? { exists: true, gap: 'read_error' } as Snapshot);
		if (!session.startedAt || reason === 'save') {
			this.removeEdit(session, key(file));
			this.checkpoint(session, file, captured, reason, timestamp, guard);
			return;
		}
		const existing = session.edits.get(key(file));
		if (existing) {
			clearTimeout(existing.idle);
		}
		const drain = () => this.drainEdit(session, key(file));
		session.edits.set(key(file), { file, snapshot: captured, timestamp, guard,
			idle: setTimeout(drain, this.options.debounceMs),
			maximum: existing?.maximum ?? setTimeout(drain, this.options.maxCheckpointMs) });
	}

	private disk(uri: vscode.Uri, reason: 'create' | 'delete' | 'external', workspaceId: string): void {
		const session = this.session;
		const file = this.files.getFileContext(uri, reason === 'delete');
		if (!session || !file || file.workspaceId !== workspaceId || !this.accepting(session)) {
			return;
		}
		const timestamp = this.now();
		if (reason === 'delete') {
			for (const state of session.states.values()) {
				if (state.file.workspaceId === workspaceId && (!file.relativePath || state.file.relativePath === file.relativePath || state.file.relativePath.startsWith(file.relativePath + '/'))) {
					this.drainEdit(session, key(state.file));
					this.checkpoint(session, state.file, Promise.resolve(absent()), reason, timestamp);
				}
			}
			return;
		}
		this.drainEdit(session, key(file));
		const snapshot = this.queued >= MAX_PENDING
			? Promise.resolve<Snapshot>({ exists: true, gap: 'checkpoint_overflow' }) : this.readDisk(file, timestamp);
		this.checkpoint(session, file, snapshot, reason, timestamp);
		if (reason === 'create') {
			const initial = !session.startedAt;
			// Folder creation/copy: reuse the updated metadata index, and read only that subtree.
			this.enqueue(async () => {
				await this.files.flush();
				for (const child of this.files.getEligibleFiles()) {
					if (child.workspaceId === workspaceId && child.relativePath.startsWith(file.relativePath + '/')) {
						const sample = await this.readDisk(child, timestamp);
						if (sample) {
							if (initial) {
								this.store(session, child, sample, true);
							} else {
								await this.apply(session, child, sample, 'create', timestamp);
							}
						}
					}
				}
			});
		}
	}

	private checkpoint(session: Session, file: TrackedFile, snapshot: Promise<Snapshot | undefined>, reason: ChangeReason, timestamp: Date,
		guard = this.files.getReadGuard(file.uri)): void {
		const initial = !session.startedAt;
		this.enqueue(async () => {
			const sample = await snapshot;
			if (!sample) {
				return;
			}
			if ((reason === 'edit' || reason === 'save') && (!guard || !await guard())) {
				return;
			}
			if (initial) {
				this.store(session, file, sample, true);
			} else {
				await this.apply(session, file, sample, reason, timestamp);
			}
		});
	}

	private store(session: Session, file: TrackedFile, snapshot: Snapshot, needsBaseline: boolean): FileState {
		const previous = session.states.get(key(file));
		session.memoryBytes -= previous ? bytes(previous.snapshot) : 0;
		if (session.memoryBytes + bytes(snapshot) > this.options.maxMemoryBytes) {
			snapshot = { hash: snapshot.hash, exists: snapshot.exists, gap: 'memory_limit' };
			needsBaseline = true;
		}
		session.memoryBytes += bytes(snapshot);
		const state = { file, snapshot, needsBaseline, lastGap: previous?.lastGap };
		session.states.set(key(file), state);
		return state;
	}

	private patch(before: string, after: string, existed: boolean, exists: boolean): Promise<string | undefined> {
		return new Promise(resolve => {
			createTwoFilesPatch(existed ? 'before' : '/dev/null', exists ? 'after' : '/dev/null', before, after, undefined, undefined,
				{ context: 3, timeout: this.options.diffTimeoutMs, callback: resolve });
		});
	}

	private async gap(session: Session, state: FileState, reason: GapReason, changeReason: ChangeReason, timestamp: Date, beforeHash?: string): Promise<void> {
		if (state.lastGap === reason) {
			return;
		}
		await this.writer.write(createChangeEvent({ eventType: 'file.gap', sessionId: session.id, workspaceId: state.file.workspaceId, timestamp,
			payload: { relativePath: state.file.relativePath, reason, changeReason, beforeHash, afterHash: state.snapshot.hash } }));
		state.lastGap = reason;
		state.needsBaseline = true;
	}

	private async baseline(session: Session, state: FileState, reason: ChangeReason, timestamp: Date): Promise<void> {
		if (state.snapshot.gap || state.snapshot.content === undefined) {
			await this.gap(session, state, state.snapshot.gap ?? 'baseline_unavailable', reason, timestamp);
			return;
		}
		const diff = await this.patch('', state.snapshot.content, false, state.snapshot.exists);
		if (!diff || Buffer.byteLength(diff, 'utf8') > this.options.maxDiffBytes) {
			await this.gap(session, state, diff ? 'diff_size_limit' : 'diff_timeout', reason, timestamp);
			return;
		}
		await this.writer.write(createChangeEvent({ eventType: 'file.baseline', sessionId: session.id, workspaceId: state.file.workspaceId, timestamp,
			payload: { relativePath: state.file.relativePath, diff, beforeHash: contentHash(''), afterHash: state.snapshot.hash!, changeReason: reason } }));
		state.needsBaseline = false;
		state.lastGap = undefined;
	}

	private async apply(session: Session, file: TrackedFile, sample: Snapshot, reason: ChangeReason, timestamp: Date): Promise<void> {
		let previous = session.states.get(key(file));
		if (reason === 'create' && previous?.snapshot.exists) {
			reason = 'external';
		}
		if (!previous && reason === 'create') {
			previous = this.store(session, file, absent(), false);
		}
		if (sample.gap) {
			const state = this.store(session, file, sample, true);
			await this.gap(session, state, sample.gap, reason, timestamp, previous?.snapshot.hash);
			return;
		}
		if (!previous || previous.needsBaseline || previous.snapshot.content === undefined) {
			const state = this.store(session, file, sample, true);
			if (!previous) {
				await this.gap(session, state, 'baseline_unavailable', reason, timestamp);
			} else if (previous.snapshot.gap === 'write_error') {
				await this.gap(session, state, 'write_error', reason, timestamp, previous.snapshot.hash);
			}
			await this.baseline(session, state, reason, timestamp);
			return;
		}
		if (sample.hash === previous.snapshot.hash && sample.exists === previous.snapshot.exists) {
			return;
		}
		const diff = await this.patch(previous.snapshot.content, sample.content!, previous.snapshot.exists, sample.exists);
		if (!diff || Buffer.byteLength(diff, 'utf8') > this.options.maxDiffBytes) {
			const state = this.store(session, file, sample, true);
			await this.gap(session, state, diff ? 'diff_size_limit' : 'diff_timeout', reason, timestamp, previous.snapshot.hash);
			await this.baseline(session, state, reason, timestamp);
			return;
		}
		await this.writer.write(createChangeEvent({ eventType: 'file.diff', sessionId: session.id, workspaceId: file.workspaceId, timestamp,
			payload: { relativePath: file.relativePath, diff, beforeHash: previous.snapshot.hash!, afterHash: sample.hash!, changeReason: reason } }));
		const state = this.store(session, file, sample, false);
		if (state.snapshot.gap) {
			await this.gap(session, state, state.snapshot.gap, reason, timestamp, sample.hash);
		}
	}

	private removeEdit(session: Session, fileKey: string): PendingEdit | undefined {
		const edit = session.edits.get(fileKey);
		if (edit) {
			clearTimeout(edit.idle);
			clearTimeout(edit.maximum);
			session.edits.delete(fileKey);
		}
		return edit;
	}
	private drainEdit(session: Session, fileKey: string): void {
		const edit = this.removeEdit(session, fileKey);
		if (edit) {
			this.checkpoint(session, edit.file, edit.snapshot, 'edit', edit.timestamp, edit.guard);
		}
	}
	private drainEdits(session: Session): void {
		for (const fileKey of session.edits.keys()) {
			this.drainEdit(session, fileKey);
		}
	}

	private enqueue(operation: () => Promise<void>): void {
		this.queued++;
		this.pending = this.pending.then(operation).catch(error => {
			// Preserve an explicit discontinuity if storage later becomes writable again.
			for (const state of this.session?.states.values() ?? []) {
				state.needsBaseline = true;
				state.snapshot.gap = 'write_error';
				state.lastGap = undefined;
			}
			this.onError(error);
		}).finally(() => { this.queued--; });
	}

	async flush(): Promise<void> {
		if (this.session) {
			this.drainEdits(this.session);
		}
		let pending: Promise<void>;
		do {
			pending = this.pending;
			await pending;
		} while (pending !== this.pending);
		await this.writer.flush();
		if (this.session?.startedAt && (this.disposed || this.recording.sessionId !== this.session.id)) {
			this.session = undefined;
		}
	}
	private disposeWatchers(): void {
		for (const watcher of this.watchers) {
			watcher.dispose();
		}
		this.watchers = [];
	}
	dispose(): void {
		if (this.disposed) {
			return;
		}
		if (this.session) {
			this.drainEdits(this.session);
		}
		this.disposed = true;
		this.disposeWatchers();
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
	}
}
