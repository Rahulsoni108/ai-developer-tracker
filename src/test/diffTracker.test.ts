import * as assert from 'assert';
import * as vscode from 'vscode';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyPatch } from 'diff';
import { DiffTracker, contentHash, type DiffOptions } from '../diffTracker';
import { FileTracker } from '../fileTracker';
import { JsonlWriter, type ActivityWriter } from '../jsonlWriter';
import { RecordingController } from '../recording';
import { EVENT_LOG_FILENAME, type CodeChangeEvent, type TrackerEvent } from '../eventSchema';

class Watcher implements vscode.FileSystemWatcher {
	readonly creates = new vscode.EventEmitter<vscode.Uri>();
	readonly changes = new vscode.EventEmitter<vscode.Uri>();
	readonly deletes = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidCreate = this.creates.event;
	readonly onDidChange = this.changes.event;
	readonly onDidDelete = this.deletes.event;
	disposed = false;
	constructor(readonly ignoreCreateEvents: boolean, readonly ignoreChangeEvents: boolean, readonly ignoreDeleteEvents: boolean) {}
	dispose(): void {
		this.disposed = true;
		this.creates.dispose(); this.changes.dispose(); this.deletes.dispose();
	}
}
class Document {
	version = 1;
	isDirty = false;
	reads = 0;
	constructor(readonly uri: vscode.Uri, public content: string) {}
	get lineCount(): number { return this.content.split('\n').length; }
	offsetAt(): number { return this.content.length; }
	getText(): string { this.reads++; return this.content; }
	get vscode(): vscode.TextDocument { return this as unknown as vscode.TextDocument; }
}
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

suite('Diff tracking', () => {
	let temporary: string;
	let folders: vscode.WorkspaceFolder[];
	let recording: RecordingController;
	let files: FileTracker;
	let diffs: DiffTracker;
	let jsonl: JsonlWriter;
	let writer: ActivityWriter;
	let captured: TrackerEvent[];
	let errors: unknown[];
	let watchers: Watcher[];
	let documents: Document[];
	let changes: vscode.EventEmitter<vscode.TextDocumentChangeEvent>;
	let saves: vscode.EventEmitter<vscode.TextDocument>;
	const initial = 'const answer = 1;\n';
	const uri = (path: string) => vscode.Uri.joinPath(folders[0].uri, path);
	const host = () => ({
		get textDocuments() { return documents.map(document => document.vscode); },
		onDidChangeTextDocument: changes.event,
		onDidSaveTextDocument: saves.event,
		getWorkspaceFolder: (uri: vscode.Uri) => folders
			.filter(folder => uri.scheme === folder.uri.scheme && (uri.path === folder.uri.path || uri.path.startsWith(folder.uri.path + '/')))
			.sort((a, b) => b.uri.path.length - a.uri.path.length)[0],
		fs: vscode.workspace.fs,
		createFileSystemWatcher: (_pattern: vscode.GlobPattern, create = false, change = false, remove = false) => {
			const watcher = new Watcher(create, change, remove);
			watchers.push(watcher);
			return watcher;
		}
	});
	function configure(options: Partial<DiffOptions> = {}): void {
		diffs?.dispose();
		diffs = new DiffTracker(recording, files, writer, error => { errors.push(error); recording.stop(); },
			{ debounceMs: 20, maxCheckpointMs: 80, ...options }, host());
	}
	function editor(path = 'app.ts'): Document {
		let document = documents.find(document => document.uri.toString() === uri(path).toString());
		if (!document) {
			document = new Document(uri(path), initial);
			documents.push(document);
		}
		return document;
	}
	function edit(document: Document, content: string): void {
		document.content = content; document.version++; document.isDirty = true;
		changes.fire({ document: document.vscode, reason: undefined, contentChanges: [{
			range: new vscode.Range(0, 0, 0, 0), rangeOffset: 0, rangeLength: 0, text: content
		}] });
	}
	function disk(kind: 'create' | 'external' | 'delete', file = uri('app.ts')): void {
		for (const watcher of watchers.filter(watcher => !watcher.disposed)) {
			if (kind === 'create') { watcher.creates.fire(file); }
			if (kind === 'external') { watcher.changes.fire(file); }
			if (kind === 'delete') { watcher.deletes.fire(file); }
		}
	}
	async function start(): Promise<void> {
		await recording.start();
		await diffs.flush();
	}
	async function events(): Promise<CodeChangeEvent[]> {
		await diffs.flush();
		await files.flush();
		return captured.filter((event): event is CodeChangeEvent => ['file.baseline', 'file.diff', 'file.gap'].includes(event.eventType));
	}
	function reconstruct(events: CodeChangeEvent[], path = 'app.ts'): string[] {
		let content = '';
		const versions: string[] = [];
		for (const event of events.filter(event => event.payload.relativePath === path)) {
			assert.notStrictEqual(event.eventType, 'file.gap', 'Unexpected reconstruction gap');
			if (event.eventType === 'file.gap') { continue; }
			if (event.eventType === 'file.baseline') { content = ''; }
			assert.strictEqual(contentHash(content), event.payload.beforeHash);
			const patched = applyPatch(content, event.payload.diff);
			assert.notStrictEqual(patched, false);
			content = patched as string;
			assert.strictEqual(contentHash(content), event.payload.afterHash);
			versions.push(content);
		}
		return versions;
	}

	setup(async () => {
		temporary = await mkdtemp(join(tmpdir(), 'diff-test-'));
		folders = [{ uri: vscode.Uri.file(join(temporary, 'project')), name: 'project', index: 0 }];
		await mkdir(folders[0].uri.fsPath);
		await writeFile(uri('app.ts').fsPath, initial);
		captured = []; errors = []; watchers = []; documents = [];
		changes = new vscode.EventEmitter(); saves = new vscode.EventEmitter();
		recording = new RecordingController({ text: '', tooltip: undefined, command: undefined, show() {}, dispose() {} }, async () => true);
		jsonl = new JsonlWriter(join(temporary, 'storage', EVENT_LOG_FILENAME));
		writer = { write: async event => { await jsonl.write(event); captured.push(event); }, flush: () => jsonl.flush() };
		files = new FileTracker(recording, writer, vscode.Uri.file(dirname(jsonl.filePath)), error => { errors.push(error); recording.stop(); }, host());
		await files.selectWorkspaces(folders);
		configure();
	});
	teardown(async () => {
		recording.stop(); diffs.dispose();
		await diffs.flush(); await files.flush(); files.dispose(); recording.dispose();
		changes.dispose(); saves.dispose();
		await rm(temporary, { recursive: true, force: true });
	});

	test('establishes a persisted initial baseline without modifying source files', async () => {
		await start();
		const captured = await events();
		assert.deepStrictEqual(captured.map(event => event.eventType), ['file.baseline']);
		assert.deepStrictEqual(reconstruct(captured), [initial]);
		assert.strictEqual(await readFile(uri('app.ts').fsPath, 'utf8'), initial);
		assert.strictEqual(captured[0].sessionId, recording.sessionId);
		assert.strictEqual(captured[0].source, 'vscode');
		assert.strictEqual(captured[0].attribution, 'unknown');
	});

	test('uses existing unsaved editor content as the initial baseline', async () => {
		const document = editor(); document.content = 'unsaved initial\n'; document.isDirty = true;
		await start();
		assert.deepStrictEqual(reconstruct(await events()), ['unsaved initial\n']);
		assert.strictEqual(await readFile(uri('app.ts').fsPath, 'utf8'), initial);
	});

	test('captures unsaved manual edits and groups rapid keystrokes into one diff', async () => {
		await start();
		const document = editor();
		for (let value = 2; value <= 8; value++) { edit(document, `const answer = ${value};\n`); }
		const captured = await events();
		assert.deepStrictEqual(captured.map(event => event.eventType), ['file.baseline', 'file.diff']);
		assert.deepStrictEqual(reconstruct(captured), [initial, 'const answer = 8;\n']);
		assert.strictEqual(captured[1].payload.changeReason, 'edit');
		assert.strictEqual(await readFile(uri('app.ts').fsPath, 'utf8'), initial);
	});

	test('checkpoints continuous typing before the idle debounce can fire', async () => {
		configure({ debounceMs: 40, maxCheckpointMs: 60 });
		await start();
		const document = editor();
		for (let value = 2; value <= 10; value++) {
			edit(document, `const answer = ${value};\n`);
			await wait(20);
		}
		const captured = await events();
		assert.ok(captured.filter(event => event.eventType === 'file.diff').length >= 2);
		assert.strictEqual(reconstruct(captured).at(-1), 'const answer = 10;\n');
	});

	test('save checkpoints preserve meaningful intermediate versions and avoid watcher duplicates', async () => {
		await start();
		const document = editor();
		for (const content of ['saved first\n', 'saved second\n']) {
			edit(document, content);
			await writeFile(document.uri.fsPath, content);
			document.isDirty = false; saves.fire(document.vscode); disk('external');
			await diffs.flush();
		}
		const captured = await events();
		assert.deepStrictEqual(reconstruct(captured), [initial, 'saved first\n', 'saved second\n']);
		assert.deepStrictEqual(captured.slice(1).map(event => event.payload.changeReason), ['save', 'save']);
	});

	test('captures external edits, drains unsaved edits first, and suppresses duplicate notifications', async () => {
		await start();
		edit(editor(), 'unsaved local\n');
		await writeFile(uri('app.ts').fsPath, 'external tool\n');
		disk('external'); disk('external');
		const captured = await events();
		assert.deepStrictEqual(reconstruct(captured), [initial, 'unsaved local\n', 'external tool\n']);
		assert.deepStrictEqual(captured.slice(1).map(event => event.payload.changeReason), ['edit', 'external']);
	});

	test('captures AI-style atomic file replacement without assuming AI attribution', async () => {
		await start();
		const replacement = uri('replacement.tmp');
		await writeFile(replacement.fsPath, 'replacement from tool\n');
		await rename(replacement.fsPath, uri('app.ts').fsPath);
		disk('create'); disk('external');
		const captured = await events();
		assert.deepStrictEqual(reconstruct(captured), [initial, 'replacement from tool\n']);
		assert.strictEqual(captured[1].payload.changeReason, 'external');
		assert.ok(captured.every(event => event.attribution === 'unknown'));
	});

	test('records file creation, deletion and recreation in reconstructible order', async () => {
		await start();
		const created = uri('new.ts');
		await writeFile(created.fsPath, 'created\n'); disk('create', created);
		await diffs.flush();
		await rm(created.fsPath); disk('delete', created); disk('delete', created);
		await diffs.flush();
		await writeFile(created.fsPath, 'recreated\n'); disk('create', created);
		const captured = (await events()).filter(event => event.payload.relativePath === 'new.ts');
		assert.deepStrictEqual(captured.map(event => event.payload.changeReason), ['create', 'delete', 'create']);
		assert.deepStrictEqual(reconstruct(captured, 'new.ts'), ['created\n', '', 'recreated\n']);
	});

	test('preserves pending unsaved edits when the file is deleted', async () => {
		await start();
		edit(editor(), 'unsaved before deletion\n');
		await rm(uri('app.ts').fsPath); disk('delete');
		assert.deepStrictEqual(reconstruct(await events()), [initial, 'unsaved before deletion\n', '']);
		assert.deepStrictEqual(errors, []);
	});

	test('handles empty files and exact CRLF/no-final-newline changes', async () => {
		await writeFile(uri('app.ts').fsPath, '');
		await start();
		for (const content of ['first\r\nsecond\r\n', 'first\r\nthird', '']) {
			await writeFile(uri('app.ts').fsPath, content); disk('external'); await diffs.flush();
		}
		assert.deepStrictEqual(reconstruct(await events()), ['', 'first\r\nsecond\r\n', 'first\r\nthird', '']);
	});

	test('filters excluded files, outside roots and storage aliases before reading contents', async function () {
		const excluded = ['.env', '.env.local', 'credentials.json', '.git/config', 'node_modules/a.js', 'dist/output.js'];
		for (const path of excluded) {
			await mkdir(dirname(uri(path).fsPath), { recursive: true }); await writeFile(uri(path).fsPath, 'private');
		}
		await files.selectWorkspaces(folders);
		await start();
		for (const path of excluded) {
			const document = new Document(uri(path), 'private');
			edit(document, 'do not capture'); saves.fire(document.vscode); disk('external', document.uri);
			assert.strictEqual(document.reads, 0);
		}
		const outside = new Document(vscode.Uri.file(join(temporary, 'outside.ts')), 'private');
		edit(outside, 'do not capture'); saves.fire(outside.vscode); disk('external', outside.uri);
		assert.strictEqual(outside.reads, 0);
		if (process.platform !== 'win32') {
			await writeFile(outside.uri.fsPath, 'private');
			await symlink(outside.uri.fsPath, uri('outside-link.ts').fsPath);
			disk('create', uri('outside-link.ts'));
			await symlink(dirname(jsonl.filePath), uri('storage-alias').fsPath, 'dir');
			disk('external', uri('storage-alias/' + EVENT_LOG_FILENAME));
		}
		assert.deepStrictEqual((await events()).map(event => event.payload.relativePath), ['app.ts']);
		assert.ok(!(await readFile(jsonl.filePath, 'utf8')).includes('do not capture'));
	});

	test('records explicit gaps for binary and oversized files without storing their contents', async () => {
		configure({ maxFileBytes: 64 });
		await writeFile(uri('binary.dat').fsPath, Buffer.from([0, 1, 255, 3]));
		await writeFile(uri('large.ts').fsPath, 'sensitive oversized content'.repeat(10));
		await files.selectWorkspaces(folders);
		await start();
		const captured = await events();
		assert.deepStrictEqual(captured.filter(event => event.eventType === 'file.gap').map(event => event.payload.reason).sort(), ['binary', 'file_size_limit']);
		assert.ok(!(await readFile(jsonl.filePath, 'utf8')).includes('sensitive oversized content'));
		await writeFile(uri('large.ts').fsPath, 'now small\n'); disk('external', uri('large.ts'));
		const recovery = (await events()).filter(event => event.payload.relativePath === 'large.ts');
		assert.deepStrictEqual(recovery.map(event => event.eventType), ['file.gap', 'file.baseline']);
	});

	test('enforces diff-size limits and marks reconstruction gaps rather than truncating patches', async () => {
		configure({ maxDiffBytes: 120 });
		await start();
		edit(editor(), 'large changed line '.repeat(30));
		const captured = await events();
		assert.ok(captured.some(event => event.eventType === 'file.gap' && event.payload.reason === 'diff_size_limit'));
		assert.ok(captured.filter(event => event.eventType !== 'file.gap').every(event => Buffer.byteLength(event.payload.diff) <= 120));
		edit(editor(), 'small\n');
		const recovery = (await events()).at(-1)!;
		assert.strictEqual(recovery.eventType, 'file.baseline');
	});

	test('bounds retained baseline memory and records a gap when the budget is exhausted', async () => {
		configure({ maxMemoryBytes: 1 });
		await start();
		assert.ok((await events()).some(event => event.eventType === 'file.gap' && event.payload.reason === 'memory_limit'));
	});

	test('flushes pending edits at Stop and starts a fresh baseline in the next session', async () => {
		await start();
		const firstSession = recording.sessionId;
		edit(editor(), 'pending at stop\n'); recording.stop();
		edit(editor(), 'outside recording\n');
		await diffs.flush();
		const first = await events();
		assert.deepStrictEqual(reconstruct(first), [initial, 'pending at stop\n']);
		assert.ok(first.every(event => event.sessionId === firstSession));
		await start();
		const second = (await events()).filter(event => event.sessionId !== firstSession);
		assert.deepStrictEqual(reconstruct(second), ['outside recording\n']);
	});

	test('a cancelled start produces no baseline or code-change log', async () => {
		let entered!: () => void; let release!: () => void;
		const reached = new Promise<void>(resolve => { entered = resolve; });
		const waiting = new Promise<void>(resolve => { release = resolve; });
		const original = files.getReadGuard.bind(files);
		files.getReadGuard = file => {
			const guard = original(file);
			return async () => { entered(); await waiting; return await guard?.() ?? false; };
		};
		const starting = recording.start();
		await reached; recording.stop(); release(); await starting;
		assert.deepStrictEqual(await events(), []);
		assert.strictEqual(recording.isRecording, false);
	});

	test('admitted edits survive clearing the workspace and disposing the tracker', async () => {
		await start();
		edit(editor(), 'last checkpoint\n'); recording.stop();
		files.clearWorkspace(); diffs.dispose();
		assert.deepStrictEqual(reconstruct(await events()), [initial, 'last checkpoint\n']);
	});

	test('keeps a consistent patch chain across edit, save, external edit and deletion', async () => {
		await start();
		edit(editor(), 'edit version\n'); await diffs.flush();
		const document = editor(); edit(document, 'save version\n');
		await writeFile(document.uri.fsPath, document.content); saves.fire(document.vscode); await diffs.flush();
		await writeFile(document.uri.fsPath, 'external version\n'); disk('external'); await diffs.flush();
		await rm(document.uri.fsPath); disk('delete');
		const captured = await events();
		assert.deepStrictEqual(reconstruct(captured), [initial, 'edit version\n', 'save version\n', 'external version\n', '']);
		assert.strictEqual(new Set(captured.map(event => event.eventId)).size, captured.length);
		assert.deepStrictEqual(errors, []);
	});
});
