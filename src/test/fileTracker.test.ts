import * as assert from 'assert';
import * as vscode from 'vscode';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileTracker, isExcludedPath, relativeWorkspacePath } from '../fileTracker';
import { createFileEvent, EVENT_LOG_FILENAME, isUuid, type FileActivityEvent } from '../eventSchema';
import { randomUUID } from 'node:crypto';
import { JsonlWriter, type ActivityWriter } from '../jsonlWriter';
import { RecordingController } from '../recording';

class TestWatcher implements vscode.FileSystemWatcher {
	readonly creates = new vscode.EventEmitter<vscode.Uri>();
	readonly changes = new vscode.EventEmitter<vscode.Uri>();
	readonly deletes = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidCreate = this.creates.event;
	readonly onDidChange = this.changes.event;
	readonly onDidDelete = this.deletes.event;
	readonly ignoreCreateEvents = false;
	readonly ignoreChangeEvents = true;
	readonly ignoreDeleteEvents = false;
	disposed = false;

	dispose(): void {
		this.disposed = true;
		this.creates.dispose();
		this.changes.dispose();
		this.deletes.dispose();
	}
}

suite('File activity tracking', () => {
	let temporary: string;
	let folder: vscode.WorkspaceFolder;
	let folders: vscode.WorkspaceFolder[];
	let recording: RecordingController;
	let tracker: FileTracker;
	let writer: JsonlWriter;
	let changes: vscode.EventEmitter<vscode.TextDocumentChangeEvent>;
	let saves: vscode.EventEmitter<vscode.TextDocument>;
	let watchers: TestWatcher[];
	let errors: unknown[];
	let patterns: vscode.GlobPattern[];
	const timestamp = '2026-10-12T12:00:00.000Z';

	function uri(filePath: string): vscode.Uri {
		return vscode.Uri.joinPath(folder.uri, filePath);
	}

	function document(fileUri: vscode.Uri): vscode.TextDocument {
		return {
			uri: fileUri,
			getText: () => { throw new Error('File contents must never be read'); }
		} as unknown as vscode.TextDocument;
	}

	function edit(fileUri: vscode.Uri, contentChanges = true): void {
		changes.fire({
			document: document(fileUri),
			reason: undefined,
			contentChanges: contentChanges ? [{ range: new vscode.Range(0, 0, 0, 0), rangeOffset: 0, rangeLength: 0, text: 'private file contents' }] : []
		});
	}

	async function events(): Promise<FileActivityEvent[]> {
		await tracker.flush();
		try {
			return (await readFile(writer.filePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			throw error;
		}
	}

	const host = () => ({
		onDidChangeTextDocument: changes.event,
		onDidSaveTextDocument: saves.event,
		getWorkspaceFolder: (fileUri: vscode.Uri) => folders
			.filter(candidate => fileUri.scheme === candidate.uri.scheme
				&& (fileUri.path === candidate.uri.path || fileUri.path.startsWith(candidate.uri.path + '/')))
			.sort((a, b) => b.uri.path.length - a.uri.path.length)[0],
		fs: vscode.workspace.fs,
		createFileSystemWatcher: (pattern: vscode.GlobPattern, ignoreCreate?: boolean, ignoreChange?: boolean, ignoreDelete?: boolean) => {
			assert.deepStrictEqual([ignoreCreate, ignoreChange, ignoreDelete], [false, true, false]);
			patterns.push(pattern);
			const watcher = new TestWatcher();
			watchers.push(watcher);
			return watcher;
		}
	});

	setup(async () => {
		temporary = await mkdtemp(join(tmpdir(), 'tracker-test-'));
		folder = { uri: vscode.Uri.file(join(temporary, 'workspace')), name: 'workspace', index: 0 };
		folders = [folder];
		await mkdir(join(folder.uri.fsPath, 'src'), { recursive: true });
		await writeFile(uri('src/existing.ts').fsPath, 'initial');
		changes = new vscode.EventEmitter();
		saves = new vscode.EventEmitter();
		watchers = [];
		patterns = [];
		errors = [];
		recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true);
		writer = new JsonlWriter(join(temporary, 'storage', EVENT_LOG_FILENAME));
		tracker = new FileTracker(recording, writer, vscode.Uri.file(dirname(writer.filePath)), error => errors.push(error), host(), () => new Date(timestamp));
		await tracker.selectWorkspace(folder);
	});

	teardown(async () => {
		tracker.dispose();
		recording.dispose();
		await tracker.flush();
		changes.dispose();
		saves.dispose();
		await rm(temporary, { recursive: true, force: true });
	});

	test('captures edits and saves as metadata-only JSONL with a stable workspace identifier', async () => {
		await recording.start();
		edit(uri('src/existing.ts'));
		saves.fire(document(uri('src/existing.ts')));
		const captured = await events();
		assert.deepStrictEqual(captured.map(event => event.eventType), ['file.modified', 'file.saved']);
		for (const event of captured) {
			assert.deepStrictEqual(Object.keys(event).sort(), ['attribution', 'eventId', 'eventType', 'payload', 'schemaVersion', 'sessionId', 'source', 'timestamp', 'workspaceId']);
			assert.strictEqual(event.payload.relativePath, 'src/existing.ts');
			assert.strictEqual(event.timestamp, timestamp);
			assert.match(event.workspaceId, /^[a-f0-9]{64}$/);
			assert.strictEqual(event.schemaVersion, 1);
			assert.strictEqual(event.source, 'vscode');
			assert.strictEqual(event.sessionId, recording.sessionId);
			assert.ok(isUuid(event.eventId));
			assert.strictEqual(event.attribution, 'unknown');
		}
		assert.notStrictEqual(captured[0].eventId, captured[1].eventId);
		assert.strictEqual(captured[0].workspaceId, captured[1].workspaceId);
		const jsonl = await readFile(writer.filePath, 'utf8');
		assert.ok(jsonl.endsWith('\n'));
		assert.ok(!jsonl.includes('private file contents'));
		assert.ok(!jsonl.includes(folder.uri.fsPath));
	});

	test('queued events retain their original recording session across stop and restart', async () => {
		await recording.start();
		const firstSession = recording.sessionId;
		edit(uri('src/existing.ts'));
		saves.fire(document(uri('src/existing.ts')));
		recording.stop();
		await recording.start();
		const secondSession = recording.sessionId;
		edit(uri('src/existing.ts'));
		const captured = await events();
		assert.notStrictEqual(firstSession, secondSession);
		assert.deepStrictEqual(captured.map(event => event.sessionId), [firstSession, firstSession, secondSession]);
	});

	test('captures creation and deletion, including extensionless files', async () => {
		await recording.start();
		const file = uri('Dockerfile');
		await writeFile(file.fsPath, 'FROM scratch');
		watchers[0].creates.fire(file);
		await tracker.flush();
		await rm(file.fsPath);
		watchers[0].deletes.fire(file);
		assert.deepStrictEqual((await events()).map(event => [event.eventType, event.payload.relativePath]), [
			['file.created', 'Dockerfile'], ['file.deleted', 'Dockerfile']
		]);
	});

	test('records nothing before start, after stop, or while consent is pending', async () => {
		recording.dispose();
		let accept: (value: boolean) => void = () => {};
		recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} },
			() => new Promise(resolve => { accept = resolve; }));
		tracker.dispose();
		tracker = new FileTracker(recording, writer, vscode.Uri.file(dirname(writer.filePath)), error => errors.push(error), host());
		await tracker.selectWorkspace(folder);
		edit(uri('src/existing.ts'));
		saves.fire(document(uri('src/existing.ts')));
		const starting = recording.start();
		edit(uri('src/existing.ts'));
		assert.deepStrictEqual(await events(), []);
		accept(true);
		await starting;
		edit(uri('src/existing.ts'));
		recording.stop();
		edit(uri('src/existing.ts'));
		saves.fire(document(uri('src/existing.ts')));
		assert.deepStrictEqual((await events()).map(event => event.eventType), ['file.modified']);
	});

	test('maintains lifecycle metadata while stopped without recording it', async () => {
		const file = uri('offline.ts');
		await writeFile(file.fsPath, '');
		watchers[0].creates.fire(file);
		assert.deepStrictEqual(await events(), []);
		await recording.start();
		await rm(file.fsPath);
		watchers[0].deletes.fire(file);
		assert.deepStrictEqual((await events()).map(event => event.eventType), ['file.deleted']);
	});

	test('filters outside files, sibling path prefixes, untitled documents, and other workspace roots', async () => {
		const sibling: vscode.WorkspaceFolder = { uri: vscode.Uri.file(folder.uri.fsPath + '-other'), name: 'other', index: 1 };
		folders.push(sibling);
		await mkdir(sibling.uri.fsPath);
		const external = vscode.Uri.file(join(temporary, 'outside.ts'));
		const other = vscode.Uri.joinPath(sibling.uri, 'file.ts');
		await writeFile(external.fsPath, '');
		await writeFile(other.fsPath, '');
		await recording.start();
		for (const file of [external, other, vscode.Uri.parse('untitled:Untitled-1'), vscode.Uri.parse('git:/src/existing.ts')]) {
			edit(file);
			saves.fire(document(file));
			watchers[0].creates.fire(file);
			watchers[0].deletes.fire(file);
		}
		assert.deepStrictEqual(await events(), []);
	});

	test('does not include a different nested workspace folder', async () => {
		const nested: vscode.WorkspaceFolder = { uri: uri('nested'), name: 'nested', index: 1 };
		folders.push(nested);
		await mkdir(nested.uri.fsPath);
		const file = vscode.Uri.joinPath(nested.uri, 'file.ts');
		await writeFile(file.fsPath, '');
		await recording.start();
		edit(file);
		watchers[0].creates.fire(file);
		assert.deepStrictEqual(await events(), []);
	});

	test('records every selected workspace root with distinct identifiers and relative paths', async () => {
		const other: vscode.WorkspaceFolder = { uri: vscode.Uri.file(join(temporary, 'second')), name: 'second', index: 1 };
		folders.push(other);
		await mkdir(join(other.uri.fsPath, 'src'), { recursive: true });
		const secondFile = vscode.Uri.joinPath(other.uri, 'src/existing.ts');
		await writeFile(secondFile.fsPath, '');
		await tracker.selectWorkspaces(folders);
		await recording.start();
		edit(uri('src/existing.ts'));
		edit(secondFile);
		saves.fire(document(secondFile));
		const captured = await events();
		assert.deepStrictEqual(captured.map(event => event.payload.relativePath), ['src/existing.ts', 'src/existing.ts', 'src/existing.ts']);
		assert.notStrictEqual(captured[0].workspaceId, captured[1].workspaceId);
		assert.strictEqual(captured[1].workspaceId, captured[2].workspaceId);
		assert.strictEqual(watchers.filter(watcher => !watcher.disposed).length, 2);
		const newFile = vscode.Uri.joinPath(other.uri, 'new.ts');
		await writeFile(newFile.fsPath, '');
		watchers[1].creates.fire(newFile);
		watchers[2].creates.fire(newFile);
		await tracker.flush();
		await rm(newFile.fsPath);
		watchers[1].deletes.fire(newFile);
		watchers[2].deletes.fire(newFile);
		assert.deepStrictEqual((await events()).slice(3).map(event => event.eventType), ['file.created', 'file.deleted']);
	});

	test('assigns nested-root events to the owning folder and ignores overlapping parent notifications', async () => {
		const nested: vscode.WorkspaceFolder = { uri: uri('nested'), name: 'nested', index: 1 };
		folders.push(nested);
		await mkdir(nested.uri.fsPath);
		await tracker.selectWorkspaces(folders);
		await recording.start();
		const file = vscode.Uri.joinPath(nested.uri, 'a.ts');
		await writeFile(file.fsPath, '');
		watchers[1].creates.fire(file);
		watchers[2].creates.fire(file);
		edit(file);
		await tracker.flush();
		await rm(nested.uri.fsPath, { recursive: true });
		watchers[1].deletes.fire(nested.uri);
		watchers[2].deletes.fire(nested.uri);
		watchers[2].deletes.fire(file);
		const captured = await events();
		assert.deepStrictEqual(captured.map(event => [event.eventType, event.payload.relativePath]), [
			['file.created', 'a.ts'], ['file.modified', 'a.ts'], ['file.deleted', 'a.ts']
		]);
		assert.ok(captured.every(event => event.workspaceId === captured[0].workspaceId));
	});

	test('excludes sensitive, dependency, generated files and its own storage from every event type', async () => {
		const excluded = ['.git/config', 'node_modules/pkg/index.js', '.env', '.env.local', 'config/production.env',
			'config/secrets.json', 'keys/server.pem', '.aws/credentials', '.ssh/id_rsa', '.npmrc',
			'vendor/lib/file.php', '.venv/bin/python', 'dist/app.js', 'build/output.js', 'coverage/index.html',
			'package-lock.json', 'yarn.lock', 'main.js.map', 'app.min.js', 'debug.log', '.vscode-test/cache', 'data.sqlite'];
		for (const filePath of excluded) {
			await mkdir(dirname(uri(filePath).fsPath), { recursive: true });
			await writeFile(uri(filePath).fsPath, 'sensitive');
		}
		await tracker.selectWorkspace(folder);
		await recording.start();
		for (const filePath of excluded) {
			const file = uri(filePath);
			edit(file);
			saves.fire(document(file));
			watchers[1].creates.fire(file);
			watchers[1].deletes.fire(file);
		}
		edit(vscode.Uri.file(writer.filePath));
		assert.deepStrictEqual(await events(), []);
		assert.deepStrictEqual(errors, []);
	});

	test('excludes log storage even when it is located inside the workspace', async () => {
		tracker.dispose();
		const storage = uri('tracker-storage');
		writer = new JsonlWriter(vscode.Uri.joinPath(storage, EVENT_LOG_FILENAME).fsPath);
		tracker = new FileTracker(recording, writer, storage, error => errors.push(error), host());
		await tracker.selectWorkspace(folder);
		await recording.start();
		const file = vscode.Uri.joinPath(storage, EVENT_LOG_FILENAME);
		edit(file);
		saves.fire(document(file));
		watchers[1].creates.fire(file);
		assert.deepStrictEqual(await events(), []);
	});

	test('skips dirty-state-only notifications and preserves separate real edits and saves', async () => {
		await recording.start();
		edit(uri('src/existing.ts'), false);
		edit(uri('src/existing.ts'));
		edit(uri('src/existing.ts'));
		saves.fire(document(uri('src/existing.ts')));
		watchers[0].changes.fire(uri('src/existing.ts'));
		assert.deepStrictEqual((await events()).map(event => event.eventType), ['file.modified', 'file.modified', 'file.saved']);
	});

	test('suppresses duplicate lifecycle notifications without losing delete/recreate cycles', async () => {
		await recording.start();
		const file = uri('new.ts');
		await writeFile(file.fsPath, '');
		watchers[0].creates.fire(file);
		watchers[0].creates.fire(file);
		await tracker.flush();
		await rm(file.fsPath);
		watchers[0].deletes.fire(file);
		watchers[0].deletes.fire(file);
		await tracker.flush();
		await writeFile(file.fsPath, '');
		watchers[0].creates.fire(file);
		assert.deepStrictEqual((await events()).map(event => event.eventType), ['file.created', 'file.deleted', 'file.created']);
	});

	test('expands directory lifecycle events into eligible files, without duplicate child events', async () => {
		await recording.start();
		await mkdir(uri('new-directory').fsPath);
		await writeFile(uri('new-directory/a.ts').fsPath, '');
		await writeFile(uri('new-directory/.env').fsPath, '');
		watchers[0].creates.fire(uri('new-directory'));
		watchers[0].creates.fire(uri('new-directory/a.ts'));
		await tracker.flush();
		await rm(uri('new-directory').fsPath, { recursive: true });
		watchers[0].deletes.fire(uri('new-directory'));
		watchers[0].deletes.fire(uri('new-directory/a.ts'));
		assert.deepStrictEqual((await events()).map(event => [event.eventType, event.payload.relativePath]), [
			['file.created', 'new-directory/a.ts'], ['file.deleted', 'new-directory/a.ts']
		]);
	});

	test('rejects symlinks escaping the root or pointing into excluded locations', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		await writeFile(join(temporary, 'external.ts'), '');
		await mkdir(uri('node_modules').fsPath);
		await writeFile(uri('node_modules/private.ts').fsPath, '');
		await symlink(join(temporary, 'external.ts'), uri('external-link.ts').fsPath);
		await symlink(uri('node_modules/private.ts').fsPath, uri('private-link.ts').fsPath);
		await symlink(temporary, uri('outside-directory').fsPath, 'dir');
		await recording.start();
		for (const file of [uri('external-link.ts'), uri('private-link.ts'), uri('outside-directory/external.ts')]) {
			edit(file);
			saves.fire(document(file));
			watchers[0].creates.fire(file);
		}
		assert.deepStrictEqual(await events(), []);
	});

	test('replaces watchers when selecting a workspace and preserves the workspace identifier', async () => {
		const old = watchers[0];
		await recording.start();
		edit(uri('src/existing.ts'));
		const firstId = (await events())[0].workspaceId;
		recording.stop();
		await tracker.selectWorkspace(folder);
		assert.strictEqual(old.disposed, true);
		assert.strictEqual(watchers.filter(watcher => !watcher.disposed).length, 1);
		const pattern = patterns[1] as vscode.RelativePattern;
		assert.strictEqual(pattern.baseUri.toString(), folder.uri.toString());
		assert.strictEqual(pattern.pattern, '**/*');
		await recording.start();
		edit(uri('src/existing.ts'));
		assert.strictEqual((await events())[1].workspaceId, firstId);
	});

	test('disposing listeners prevents new events and lets accepted events finish writing', async () => {
		await recording.start();
		edit(uri('src/existing.ts'));
		tracker.dispose();
		tracker.dispose();
		edit(uri('src/existing.ts'));
		saves.fire(document(uri('src/existing.ts')));
		assert.strictEqual((await events()).length, 1);
		assert.ok(watchers.every(watcher => watcher.disposed));
	});

	test('handles disappearing creates without stopping recording or reporting a failure', async () => {
		await recording.start();
		watchers[0].creates.fire(uri('already-gone.ts'));
		assert.deepStrictEqual(await events(), []);
		assert.deepStrictEqual(errors, []);
		assert.strictEqual(recording.isRecording, true);
	});

	test('reports writer errors and continues processing subsequent events', async () => {
		tracker.dispose();
		let attempts = 0;
		const failingWriter: ActivityWriter = {
			write: async event => {
				if (++attempts === 1) {
					throw new Error('Disk full');
				}
				await writer.write(event);
			},
			flush: () => writer.flush()
		};
		tracker = new FileTracker(recording, failingWriter, vscode.Uri.file(dirname(writer.filePath)), error => errors.push(error), host());
		await tracker.selectWorkspace(folder);
		await recording.start();
		edit(uri('src/existing.ts'));
		saves.fire(document(uri('src/existing.ts')));
		assert.deepStrictEqual((await events()).map(event => event.eventType), ['file.saved']);
		assert.strictEqual(errors.length, 1);
	});

	test('rejects remote workspace folders and captures nothing without a selection', async () => {
		await assert.rejects(tracker.selectWorkspace({ uri: vscode.Uri.parse('vscode-remote://ssh-remote+host/workspace'), name: 'remote', index: 1 }), /local file workspace/);
		await recording.start();
		edit(uri('src/existing.ts'));
		assert.deepStrictEqual(await events(), []);
	});
});

suite('Path filters and JSONL writer', () => {
	test('checks URI schemes and segment boundaries rather than path prefixes', () => {
		const folder = { uri: vscode.Uri.file('/project'), name: 'project', index: 0 };
		assert.strictEqual(relativeWorkspacePath(vscode.Uri.file('/project/src/a.ts'), folder), 'src/a.ts');
		assert.strictEqual(relativeWorkspacePath(vscode.Uri.file('/project-other/a.ts'), folder), undefined);
		assert.strictEqual(relativeWorkspacePath(vscode.Uri.file('/elsewhere/a.ts'), folder), undefined);
		assert.strictEqual(relativeWorkspacePath(vscode.Uri.parse('untitled:/project/a.ts'), folder), undefined);
		assert.strictEqual(isExcludedPath('SRC/Node_Modules/a.js'), true);
		assert.strictEqual(isExcludedPath('config\\.env.local'), true);
		assert.strictEqual(isExcludedPath('src/environment.ts'), false);
		assert.strictEqual(isExcludedPath('src/builders.ts'), false);
	});

	test('serializes concurrent JSONL appends and preserves existing events', async () => {
		const temporary = await mkdtemp(join(tmpdir(), 'writer-test-'));
		try {
			const filePath = join(temporary, 'nested', 'events.jsonl');
			const writer = new JsonlWriter(filePath);
			const makeEvent = (relativePath: string): FileActivityEvent => createFileEvent({
				eventType: 'file.saved', timestamp: new Date('2026-10-12T12:00:00.000Z'), source: 'vscode',
				sessionId: randomUUID(), payload: { relativePath }, workspaceId: 'workspace-id'
			});
			await Promise.all([writer.write(makeEvent('a.ts')), writer.write(makeEvent('quote"and\nnewline.ts'))]);
			const reopened = new JsonlWriter(filePath);
			await reopened.write(makeEvent('b.ts'));
			await reopened.flush();
			const lines = (await readFile(filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
			assert.deepStrictEqual(lines.map(event => event.payload.relativePath), ['a.ts', 'quote"and\nnewline.ts', 'b.ts']);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
});
