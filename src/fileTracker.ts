import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { RecordingController } from './recording';
import type { ActivityWriter } from './jsonlWriter';
import { createFileEvent, type FileEventType } from './eventSchema';

export type FileActivityType = 'modify' | 'save' | 'create' | 'delete';

const eventTypeMapping: Record<FileActivityType, FileEventType> = {
	create: 'file.created', modify: 'file.modified', save: 'file.saved', delete: 'file.deleted'
};

const excludedDirectories = new Set([
	'.git', '.hg', '.svn', 'node_modules', 'bower_components', 'jspm_packages', 'vendor',
	'.venv', 'venv', 'env', '__pycache__', '.tox', '.bundle', 'pods', '.gradle', '.m2',
	'.yarn', '.npm', '.pnpm-store', '.cache', '.next', '.nuxt', '.svelte-kit', '.turbo',
	'.parcel-cache', 'dist', 'build', 'out', 'target', 'bin', 'obj', 'coverage', 'generated',
	'.vscode-test', '.idea', '.vs', '.aws', '.ssh', '.azure', '.gcloud', '.kube',
	'.terraform', '.serverless', '.vercel', 'logs'
]);

const excludedFiles = new Set([
	'.ds_store', 'thumbs.db', '.npmrc', '.netrc', '.pypirc', '.envrc',
	'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
	'composer.lock', 'poetry.lock', 'pipfile.lock', 'cargo.lock', 'gemfile.lock',
	'.pnp.cjs', '.pnp.loader.mjs'
]);

export function isExcludedPath(filePath: string): boolean {
	const segments = filePath.replace(/\\/g, '/').toLowerCase().split('/');
	return segments.some(segment => excludedDirectories.has(segment)
		|| excludedFiles.has(segment)
		|| /(^|\.)env($|\.)/.test(segment)
		|| /^(credentials|secrets?|id_rsa|id_ed25519)(\..*)?$/.test(segment)
		|| /\.(pem|key|p12|pfx|crt|cer|jks|keystore|kdbx|db|sqlite3?|log|tmp|temp|bak|swp|swo|lock|map|tsbuildinfo|pyc|class|o|so|dll|exe|wasm|zip|gz|tar|vsix)$/.test(segment)
		|| /\.min\.(js|css)$/.test(segment)
		|| segment.endsWith('~'));
}

export function relativeWorkspacePath(uri: vscode.Uri, folder: vscode.WorkspaceFolder): string | undefined {
	if (uri.scheme !== 'file' || folder.uri.scheme !== 'file' || uri.authority !== folder.uri.authority) {
		return undefined;
	}
	const filePath = relative(folder.uri.fsPath, uri.fsPath);
	if (!filePath || isAbsolute(filePath) || filePath === '..' || filePath.startsWith('..' + sep)) {
		return undefined;
	}
	const normalized = filePath.split(sep).join('/');
	return isExcludedPath(normalized) ? undefined : normalized;
}

type TrackerWorkspace = Pick<typeof vscode.workspace,
	'onDidChangeTextDocument' | 'onDidSaveTextDocument' | 'createFileSystemWatcher' | 'getWorkspaceFolder' | 'fs'>;

interface SelectedWorkspace {
	folder: vscode.WorkspaceFolder;
	id: string;
	canonicalPath: string;
	files: Set<string>;
}

export interface TrackedFile {
	uri: vscode.Uri;
	relativePath: string;
	workspaceId: string;
}

async function canonicalPath(filePath: string): Promise<string> {
	let candidate = filePath;
	const missing: string[] = [];
	while (true) {
		try {
			return join(await realpath(candidate), ...missing);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(candidate) === candidate) {
				throw error;
			}
			missing.unshift(basename(candidate));
			candidate = dirname(candidate);
		}
	}
}

export class FileTracker implements vscode.Disposable {
	private readonly subscriptions: vscode.Disposable[];
	private watcherSubscriptions: vscode.Disposable[] = [];
	private selected = new Map<string, SelectedWorkspace>();
	private selectionRequest: object | undefined;
	private pending: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(
		private readonly recording: Pick<RecordingController, 'isRecording' | 'sessionId'>,
		private readonly writer: ActivityWriter,
		private readonly storageDirectory: vscode.Uri,
		private readonly onError: (error: unknown) => void,
		private readonly workspace: TrackerWorkspace = vscode.workspace,
		private readonly now: () => Date = () => new Date()
	) {
		this.subscriptions = [
			workspace.onDidChangeTextDocument(event => {
				// Dirty-state notifications without edits are not file modifications.
				if (event.contentChanges.length > 0) {
					this.capture('modify', event.document.uri);
				}
			}),
			workspace.onDidSaveTextDocument(document => this.capture('save', document.uri))
		];
	}

	async selectWorkspace(folder: vscode.WorkspaceFolder): Promise<void> {
		await this.selectWorkspaces([folder]);
	}

	async selectWorkspaces(folders: readonly vscode.WorkspaceFolder[]): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.clearWorkspace();
		const request = {};
		this.selectionRequest = request;
		if (folders.some(folder => folder.uri.scheme !== 'file')) {
			throw new Error('File activity tracking currently requires a local file workspace.');
		}
		const selections: SelectedWorkspace[] = await Promise.all(folders.map(async folder => ({
			folder,
			id: createHash('sha256').update(folder.uri.toString()).digest('hex'),
			canonicalPath: await realpath(folder.uri.fsPath),
			files: new Set<string>()
		})));
		if (this.disposed || this.selectionRequest !== request) {
			return;
		}
		this.selected = new Map(selections.map(selected => [selected.folder.uri.toString(), selected]));
		// Seed metadata only, so folder deletions can be expanded into file deletions.
		const indexing = this.pending.then(async () => {
			for (const selected of selections) {
				await this.indexDirectory(selected, selected.folder.uri);
			}
		});
		this.pending = indexing.catch(() => {});
		// One watcher per root; callbacks only accept files owned by that root, even when roots overlap.
		for (const selected of selections) {
			const watcher = this.workspace.createFileSystemWatcher(new vscode.RelativePattern(selected.folder, '**/*'), false, true, false);
			this.watcherSubscriptions.push(
				watcher,
				watcher.onDidCreate(uri => this.capture('create', uri, selected)),
				watcher.onDidDelete(uri => this.capture('delete', uri, selected))
			);
		}
		try {
			await indexing;
		} catch (error) {
			if (this.selectionRequest === request) {
				this.clearWorkspace();
			}
			throw error;
		}
	}

	clearWorkspace(): void {
		this.selected.clear();
		this.selectionRequest = undefined;
		for (const subscription of this.watcherSubscriptions) {
			subscription.dispose();
		}
		this.watcherSubscriptions = [];
	}

	getEligibleFiles(): TrackedFile[] {
		return [...this.selected.values()].flatMap(selected => [...selected.files].map(relativePath => ({
			uri: vscode.Uri.joinPath(selected.folder.uri, relativePath), relativePath, workspaceId: selected.id
		})));
	}

	getApprovedFolders(): vscode.WorkspaceFolder[] {
		return [...this.selected.values()].map(selected => selected.folder);
	}

	getFileContext(uri: vscode.Uri, allowRoot = false): TrackedFile | undefined {
		const folder = this.workspace.getWorkspaceFolder(uri);
		const selected = folder && this.selected.get(folder.uri.toString());
		const relativePath = selected && this.allowedPath(uri, selected, allowRoot);
		return selected && relativePath !== undefined ? { uri, relativePath, workspaceId: selected.id } : undefined;
	}

	async canReadFile(uri: vscode.Uri): Promise<boolean> {
		return await this.getReadGuard(uri)?.() ?? false;
	}

	getReadGuard(uri: vscode.Uri): (() => Promise<boolean>) | undefined {
		const folder = this.workspace.getWorkspaceFolder(uri);
		const selected = folder && this.selected.get(folder.uri.toString());
		if (!selected || this.allowedPath(uri, selected) === undefined) {
			return undefined;
		}
		return async () => {
			if (!await this.physicallyInside(uri, selected)) {
				return false;
			}
			// Capture the approval, so admitted checkpoints can finish after Stop or a folder change.
			const resolved = await canonicalPath(uri.fsPath);
			const storage = await realpath(this.storageDirectory.fsPath).catch(() => this.storageDirectory.fsPath);
			const storagePath = relative(storage, resolved);
			return storagePath === '..' || storagePath.startsWith('..' + sep) || isAbsolute(storagePath);
		};
	}

	private allowedPath(uri: vscode.Uri, selected: SelectedWorkspace, allowRoot = false): string | undefined {
		const filePath = allowRoot && uri.toString() === selected.folder.uri.toString()
			? '' : relativeWorkspacePath(uri, selected.folder);
		const containingFolder = this.workspace.getWorkspaceFolder(uri);
		if (filePath === undefined || containingFolder?.uri.toString() !== selected.folder.uri.toString()) {
			return undefined;
		}
		const storagePath = relative(this.storageDirectory.fsPath, uri.fsPath);
		if (uri.scheme === this.storageDirectory.scheme
			&& (!storagePath || (!isAbsolute(storagePath) && storagePath !== '..' && !storagePath.startsWith('..' + sep)))) {
			return undefined;
		}
		return filePath;
	}

	private async physicallyInside(uri: vscode.Uri, selected: SelectedWorkspace): Promise<boolean> {
		// Resolve existing ancestors for deleted files; reject links escaping the selected root
		// or pointing at an excluded location within it.
		let candidate = uri.fsPath;
		while (true) {
			try {
				const resolved = await realpath(candidate);
				const filePath = relative(selected.canonicalPath, resolved);
				return !isAbsolute(filePath) && filePath !== '..' && !filePath.startsWith('..' + sep)
					&& !isExcludedPath(filePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw error;
				}
				const parent = dirname(candidate);
				if (parent === candidate) {
					return false;
				}
				candidate = parent;
			}
		}
	}

	private async indexDirectory(selected: SelectedWorkspace, directory: vscode.Uri): Promise<string[]> {
		const added: string[] = [];
		if (!await this.physicallyInside(directory, selected)) {
			return added;
		}
		let entries: [string, vscode.FileType][];
		try {
			entries = await this.workspace.fs.readDirectory(directory);
		} catch (error) {
			if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
				return added;
			}
			throw error;
		}
		for (const [name, type] of entries) {
			const uri = vscode.Uri.joinPath(directory, name);
			const filePath = this.allowedPath(uri, selected);
			if (!filePath || (type & vscode.FileType.SymbolicLink)) {
				continue;
			}
			if (type & vscode.FileType.Directory) {
				added.push(...await this.indexDirectory(selected, uri));
			} else if ((type & vscode.FileType.File) && !selected.files.has(filePath)) {
				selected.files.add(filePath);
				added.push(filePath);
			}
		}
		return added;
	}

	private capture(eventType: FileActivityType, uri: vscode.Uri, sourceWorkspace?: SelectedWorkspace): void {
		const folder = this.workspace.getWorkspaceFolder(uri);
		const selected = sourceWorkspace ?? (folder && this.selected.get(folder.uri.toString()));
		if (this.disposed || !selected || this.selected.get(selected.folder.uri.toString()) !== selected) {
			return;
		}
		const filePath = this.allowedPath(uri, selected, eventType === 'delete');
		if (filePath === undefined) {
			return;
		}
		// Snapshot eligibility and time at arrival, before asynchronous metadata checks/writes.
		const sessionId = this.recording.isRecording ? this.recording.sessionId : undefined;
		const timestamp = sessionId ? this.now() : undefined;
		if (!timestamp && (eventType === 'modify' || eventType === 'save')) {
			return;
		}
		this.pending = this.pending.then(async () => {
			if (eventType !== 'delete' && !await this.physicallyInside(uri, selected)) {
				return;
			}
			let paths = [filePath];
			if (eventType === 'create') {
				let stat: vscode.FileStat;
				try {
					stat = await this.workspace.fs.stat(uri);
				} catch (error) {
					// A watcher can report a short-lived file after it has disappeared.
					if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
						return;
					}
					throw error;
				}
				if (stat.type & vscode.FileType.SymbolicLink) {
					return;
				}
				if (stat.type & vscode.FileType.Directory) {
					paths = await this.indexDirectory(selected, uri);
				} else if ((stat.type & vscode.FileType.File) && !selected.files.has(filePath)) {
					selected.files.add(filePath);
				} else {
					return;
				}
			} else if (eventType === 'delete') {
				paths = [...selected.files].filter(known => !filePath || known === filePath || known.startsWith(filePath + '/'));
				for (const deleted of paths) {
					selected.files.delete(deleted);
				}
			}
			if (timestamp && sessionId) {
				for (const relativePath of paths) {
					await this.writer.write(createFileEvent({
						eventType: eventTypeMapping[eventType], timestamp, source: 'vscode',
						sessionId, workspaceId: selected.id, payload: { relativePath }
					}));
				}
			}
		}).catch(this.onError);
	}

	async flush(): Promise<void> {
		await this.pending;
		await this.writer.flush();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.clearWorkspace();
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
	}
}
