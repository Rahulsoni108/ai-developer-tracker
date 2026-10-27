import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RecordingController } from '../recording';
import { AssessmentController } from '../assessmentController';
import { AssessmentConnectionStore } from '../assessmentStorage';
import { MockAssessmentApiClient } from '../assessmentApiClient';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { EventPersistence } from '../eventPersistence';
import { FileTracker } from '../fileTracker';
import { DiffTracker } from '../diffTracker';
import { approveRecordingWorkspaces, describeAssessmentStart, type AssessmentStartDiagnostic, type AssessmentStartStep } from '../assessmentStartDiagnostics';
import { formatAssessmentStatus } from '../assessmentCommands';

suite('Assessment production recording preparation', function () {
	this.timeout(15000);
	let root: string; let folder: vscode.WorkspaceFolder; let folders: vscode.WorkspaceFolder[];
	let queue: AsyncLocalEventQueue; let writer: EventPersistence; let recording: RecordingController; let files: FileTracker; let diffs: DiffTracker;
	let assessment: AssessmentController; let api: MockAssessmentApiClient; let store: AssessmentConnectionStore;
	let recordingConsent: boolean; let uploadConsent: boolean; let uploadDialogs: number; let starts: number;
	let steps: AssessmentStartDiagnostic[]; let prerequisiteCodes: AssessmentStartStep[]; let sequence: string[];
	let values: Map<string, unknown>; let secrets: Map<string, string>;
	const report = (step: AssessmentStartStep) => { prerequisiteCodes.push(step); assessment.reportStartPrerequisite(step); };
	const workspaceId = () => createHash('sha256').update(folder.uri.toString()).digest('hex');
	const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
	const recordingRequest = async (current: () => boolean): Promise<boolean> => {
		sequence.push('recording_confirmation'); report('recording_consent');
		if (!recordingConsent || !current()) { report(current() ? 'recording_consent_declined' : 'request_cancelled'); return false; }
		try { return await approveRecordingWorkspaces(folders, files, current, () => folders, report); }
		catch { recording.stop(); return false; } // Same fail-closed behavior as the production error handler.
	};
	async function drain(id?: string): Promise<void> { await diffs.flush(); await files.flush(); await writer.flush(); await writer.completeSession(id); }
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'assessment-start-')); await mkdir(join(root, 'workspace')); await writeFile(join(root, 'workspace', 'app.ts'), 'export const dummy = 1;\n');
		folder = { uri: vscode.Uri.file(join(root, 'workspace')), name: 'dummy-assessment', index: 0 }; folders = [folder];
		values = new Map(); secrets = new Map(); steps = []; prerequisiteCodes = []; sequence = []; recordingConsent = true; uploadConsent = true; uploadDialogs = 0; starts = 0;
		queue = await AsyncLocalEventQueue.open({ scheme: 'file', fsPath: join(root, 'queue') }, [{ uri: folder.uri }], {}, {
			get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }
		});
		recording = new RecordingController({ text: '', tooltip: '', command: '', show() {}, dispose() {} }, recordingRequest, () => new Date(), report);
		writer = new EventPersistence(queue, { write: async () => {}, flush: async () => {} });
		writer.attachRecording(recording, () => ({ approvedWorkspaceIds: files.getApprovedFolders().map(item => createHash('sha256').update(item.uri.toString()).digest('hex')),
			confirmedCodexSessions: [], codexContentConsent: false }));
		const host = { onDidChangeTextDocument: vscode.workspace.onDidChangeTextDocument, onDidSaveTextDocument: vscode.workspace.onDidSaveTextDocument,
			getWorkspaceFolder: (uri: vscode.Uri) => folders.find(item => uri.fsPath === item.uri.fsPath || uri.fsPath.startsWith(item.uri.fsPath + '/')),
			fs: vscode.workspace.fs, textDocuments: vscode.workspace.textDocuments, createFileSystemWatcher: vscode.workspace.createFileSystemWatcher };
		files = new FileTracker(recording, writer, vscode.Uri.file(join(root, 'queue')), () => recording.stop(), host);
		diffs = new DiffTracker(recording, files, writer, () => recording.stop(), {}, host);
		api = new MockAssessmentApiClient(() => new Date('2030-01-01T10:00:00.000Z')); api.seedInvitation('FIRST-PAIR', '2'); api.seedInvitation('SECOND-PAIR', '3');
		const actual = api.startOrResume.bind(api); api.startOrResume = async (...args) => { sequence.push('rails_start'); starts++; assert.equal(recording.isRecording, false); return actual(...args); };
		store = new AssessmentConnectionStore({ get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T,
			update: async (key, value) => { values.set(key, structuredClone(value)); } }, {
			get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }
		}, queue);
		assessment = new AssessmentController(api, store, recording, { flushStopped: id => drain(id), getStatus: ids => queue.getSessionEvidenceStatus(ids), disableDevelopmentUploads: async () => {} },
			async () => { sequence.push('upload_confirmation'); uploadDialogs++; return uploadConsent; }, () => {}, 1000, undefined, undefined,
			value => steps.push(value));
		await assessment.initialize(); await assessment.pair('FIRST-PAIR');
	});
	teardown(async () => { await assessment.dispose(); const id = recording.sessionId; recording.stop(); await drain(id); files.dispose(); diffs.dispose(); recording.dispose(); await writer.close(); await rm(root, { recursive: true, force: true }); });

	test('recording confirmation proceeds through real workspace selection, storage and baselines to upload consent, Rails binding and active capture', async () => {
		await assessment.start(); await writer.flush(); assert.equal(assessment.view.state, 'active'); assert.equal(recording.isRecording, true);
		assert.deepEqual(sequence, ['recording_confirmation', 'upload_confirmation', 'rails_start']); assert.equal(starts, 1);
		assert.deepEqual(prerequisiteCodes, ['recording_consent', 'workspace_approval', 'workspace_approved', 'local_storage', 'diff_baseline', 'assessment_authorization']);
		assert.equal(assessment.view.lastStart?.status, 'active'); assert.equal(assessment.view.lastStart?.step, 'assessment_active');
		const status = (await store.load())!.serverStatus; assert.equal(status.localRecordingSessionIds[0], recording.sessionId); assert.ok(status.deadline);
	});
	test('workspace indexing must finish before a second dialog or Rails start, and reports its pending prerequisite', async () => {
		const entered = deferred(); const release = deferred(); const actual = files.selectWorkspaces.bind(files);
		files.selectWorkspaces = async selected => { entered.resolve(); await release.promise; await actual(selected); };
		const starting = assessment.start(); await entered.promise;
		assert.equal(uploadDialogs, 0); assert.equal(starts, 0); assert.equal(recording.isRecording, false); assert.equal(assessment.view.lastStart?.step, 'workspace_approval');
		await assessment.showStatus(); assert.equal(assessment.view.state, 'starting'); assert.equal(assessment.view.lastStart?.step, 'workspace_approval');
		release.resolve(); await starting; assert.equal(assessment.view.state, 'active'); assert.equal(starts, 1);
	});
	test('baseline preparation cannot start the timer early and reports progress before upload confirmation', async () => {
		const entered = deferred(); const release = deferred(); const actual = diffs.prepare.bind(diffs);
		diffs.prepare = async (...args) => { entered.resolve(); await release.promise; await actual(...args); };
		const starting = assessment.start(); await entered.promise;
		assert.equal(uploadDialogs, 0); assert.equal(starts, 0); assert.equal(recording.isRecording, false); assert.equal(assessment.view.lastStart?.step, 'diff_baseline');
		release.resolve(); await starting; assert.equal(assessment.view.state, 'active');
	});
	test('workspace failure reports a safe actionable cause, and Show Status cannot erase the failed prerequisite', async () => {
		const sensitive = 'dummy-password-and-private-path'; files.selectWorkspaces = async () => { throw new Error(sensitive); };
		await assessment.start(); assert.equal(starts, 0); assert.equal(uploadDialogs, 0); assert.equal(recording.isRecording, false);
		assert.equal(assessment.view.lastStart?.status, 'failed'); assert.equal(assessment.view.lastStart?.step, 'workspace_unavailable');
		await assessment.showStatus(); assert.equal(assessment.view.state, 'paired'); assert.equal(assessment.view.lastStart?.step, 'workspace_unavailable');
		const text = formatAssessmentStatus(assessment.view); assert.ok(text.includes('can be read')); assert.equal(text.includes(sensitive), false);
		assert.equal(JSON.stringify(steps).includes(sensitive), false); assert.equal((await store.load())!.serverStatus.startedAt, undefined);
	});
	test('unchanged open folders are not sufficient if tracker approval was discarded', async () => {
		const actual = files.selectWorkspaces.bind(files); files.selectWorkspaces = async selected => { await actual(selected); files.clearWorkspace(); };
		await assessment.start(); assert.equal(starts, 0); assert.equal(uploadDialogs, 0);
		assert.equal(assessment.view.lastStart?.step, 'workspace_not_approved'); assert.equal(recording.isRecording, false);
	});
	test('a workspace change or Stop during selection prevents late authorization and identifies the cancelled prerequisite', async () => {
		const actual = files.selectWorkspaces.bind(files); files.selectWorkspaces = async selected => { await actual(selected); folders = []; };
		await assessment.start(); assert.equal(assessment.view.lastStart?.step, 'workspace_changed'); assert.equal(starts, 0);
		folders = [folder]; files.selectWorkspaces = async selected => { await actual(selected); recording.stop(); };
		await assessment.start(); assert.equal(assessment.view.lastStart?.step, 'request_cancelled'); assert.equal(starts, 0); assert.equal(uploadDialogs, 0);
	});
	test('recording and upload refusal stay separate and never call Rails start', async () => {
		recordingConsent = false; await assessment.start(); assert.equal(assessment.view.lastStart?.step, 'recording_consent_declined'); assert.equal(uploadDialogs, 0); assert.equal(starts, 0);
		recordingConsent = true; uploadConsent = false; await assessment.start(); assert.equal(assessment.view.lastStart?.step, 'upload_consent'); assert.equal(starts, 0);
		assert.equal(recording.isRecording, false); assert.equal((await store.load())!.serverStatus.startedAt, undefined);
	});
	test('a new assessment after archival uses the same real preparation sequence with fresh consents and isolated recordings', async () => {
		await assessment.start(); const old = recording.sessionId!; await assessment.archive(async () => true); assert.equal(assessment.view.lastStart, undefined);
		await assessment.pair('SECOND-PAIR'); assert.equal(assessment.view.deadline, undefined); assert.equal(assessment.view.lastStart, undefined); sequence = [];
		await assessment.start(); assert.equal(assessment.view.state, 'active'); assert.notEqual(recording.sessionId, old); assert.equal(starts, 2); assert.equal(uploadDialogs, 2);
		assert.deepEqual(sequence, ['recording_confirmation', 'upload_confirmation', 'rails_start']); assert.equal(assessment.allowsDevelopmentUpload(old), false);
		assert.equal(await queue.prepareBatch(100, 100000, old), null); assert.equal((await store.load())!.connection.codingSessionId, '3');
	});
	test('manual Start Recording remains local and emits no Rails authorization diagnostics', async () => {
		await recording.start(); assert.equal(recording.isRecording, true); assert.equal(starts, 0); assert.equal(uploadDialogs, 0); assert.equal(assessment.view.state, 'paired');
		assert.equal(assessment.view.lastStart, undefined); assert.equal(steps.length, 0); assert.ok(files.getApprovedFolders().length);
	});
	test('diagnostic descriptions are a fixed allowlist without connection, workspace or credential identifiers', () => {
		const text = describeAssessmentStart({ step: 'rails_start', status: 'failed', reason: 'authentication' });
		assert.ok(text.includes('HTTPS connectivity')); assert.equal(text.includes(workspaceId()), false); assert.equal(text.includes(root), false);
		for (const token of secrets.values()) { assert.equal(text.includes(token), false); }
	});
});
