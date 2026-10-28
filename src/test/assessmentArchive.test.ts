import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AssessmentController } from '../assessmentController';
import { AssessmentConnectionStore, ASSESSMENT_METADATA_KEY, type AssessmentMetadata } from '../assessmentStorage';
import { AssessmentApiError, MockAssessmentApiClient } from '../assessmentApiClient';
import { RecordingController } from '../recording';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { EventPersistence } from '../eventPersistence';
import { EvidenceCipher } from '../evidenceEncryption';
import { supplyEvidenceKeys } from '../evidenceKeyStorage';
import { LOCAL_QUEUE_FILENAME } from '../localEventQueue';
import { createFileEvent } from '../eventSchema';
import type { AssessmentArchiveStorage } from '../assessmentArchive';

suite('Safe assessment archive and re-pair', function () {
	this.timeout(20000);
	let root: string; let queue: AsyncLocalEventQueue; let controller: AssessmentController; let store: AssessmentConnectionStore;
	let recording: RecordingController; let writer: EventPersistence; let api: MockAssessmentApiClient;
	let values: Map<string, unknown>; let secrets: Map<string, string>; let recordingConsent: boolean; let uploadConsent: boolean;
	let recordingDialogs: number; let uploadDialogs: number; let flushes: number; let disables: number; let failDrain: boolean;
	let archiveBackend: AssessmentArchiveStorage;
	const storage = () => ({ scheme: 'file', fsPath: root });
	const metadata = () => values.get(ASSESSMENT_METADATA_KEY) as AssessmentMetadata;
	const file = (sessionId = recording.sessionId!) => createFileEvent({ sessionId, source: 'vscode', workspaceId: 'workspace', eventType: 'file.saved', payload: { relativePath: 'dummy.ts' } });
	const database = () => new DatabaseSync(join(root, LOCAL_QUEUE_FILENAME));
	function createController(): void {
		store = new AssessmentConnectionStore({ get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T,
			update: async (key, value) => { values.set(key, structuredClone(value)); } }, {
			get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); }
		}, archiveBackend);
		controller = new AssessmentController(api, store, recording, {
			flushStopped: async id => { flushes++; if (failDrain) { throw new Error('dummy private failure'); }
				await writer.flush(); await writer.completeSession(id); if (writer.isDegraded) { throw new AssessmentApiError('storage'); } },
			getStatus: ids => queue.getSessionEvidenceStatus(ids), disableDevelopmentUploads: async () => { disables++; }
		}, async () => { uploadDialogs++; return uploadConsent; });
	}
	async function open(): Promise<void> {
		queue = await AsyncLocalEventQueue.open(storage(), [], {}, { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); } });
		archiveBackend = { archiveAssessment: value => queue.archiveAssessment(value), getAssessmentArchiveIndex: () => queue.getAssessmentArchiveIndex() };
		recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => { recordingDialogs++; return recordingConsent; });
		writer = new EventPersistence(queue, { write: async () => {}, flush: async () => {} });
		writer.attachRecording(recording, () => ({ approvedWorkspaceIds: ['workspace'], confirmedCodexSessions: [], codexContentConsent: false }));
		createController(); await controller.initialize();
	}
	async function close(): Promise<void> { await controller.dispose(); recording.stop(); await writer.close(); recording.dispose(); }
	async function active(): Promise<string> { await controller.pair('OLD-PAIR'); await controller.start(); assert.equal(controller.view.state, 'active', `Fixture start failed: ${controller.view.reason ?? 'no reason'}`); return recording.sessionId!; }
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'assessment-archive-')); values = new Map(); secrets = new Map();
		// One authoritative fixture instant avoids a millisecond boundary between the
		// mock's authorization and start timestamps under full-suite load.
		api = new MockAssessmentApiClient(() => new Date('2030-01-01T10:00:00.000Z')); api.seedInvitation('OLD-PAIR', '2'); api.seedInvitation('NEW-PAIR', '3');
		recordingConsent = true; uploadConsent = true; recordingDialogs = 0; uploadDialogs = 0; flushes = 0; disables = 0; failDrain = false; await open();
	});
	teardown(async () => { await close(); await rm(root, { recursive: true, force: true }); });

	test('cancelled confirmation leaves capture, active connection, consent, credentials and evidence untouched', async () => {
		const id = await active(); const event = file(); await writer.write(event); const before = structuredClone(metadata()); const keys = [...secrets];
		await controller.archive(async summary => { assert.equal(summary.submissionConfirmed, false); return false; });
		assert.equal(recording.isRecording, true); assert.equal(recording.sessionId, id); assert.equal(controller.view.state, 'active');
		assert.deepEqual(metadata(), before); assert.deepEqual([...secrets], keys); assert.deepEqual(await queue.getPending(10), [event]);
		assert.equal((await queue.getAssessmentArchiveIndex()).archives.length, 0);
	});
	test('confirmed archive drains active capture, retains exact ciphertext and credentials, and releases only the pairing slot', async () => {
		const id = await active(); const event = file(); await writer.write(event); const before = structuredClone(metadata()); const keys = [...secrets];
		const db = database(); const ciphertext = db.prepare('SELECT event_json FROM queued_events WHERE event_id = ?').get(event.eventId)!.event_json;
		try {
			await controller.archive(async () => true);
			assert.equal(controller.view.state, 'unpaired'); assert.equal(controller.view.archivedUnconfirmedCount, 1); assert.equal(recording.isRecording, false);
			assert.ok(flushes > 0); assert.ok(disables > 1); assert.equal(controller.view.uploadConsent, false); assert.equal(controller.view.deadline, undefined);
			assert.equal(controller.allowsDevelopmentUpload(id), false); assert.deepEqual([...secrets], keys); assert.deepEqual(metadata(), before);
			assert.equal(await store.load(), undefined); assert.deepEqual(await queue.getPending(10), [event]);
			assert.equal(db.prepare('SELECT event_json FROM queued_events WHERE event_id = ?').get(event.eventId)!.event_json, ciphertext);
			const raw = String(db.prepare('SELECT archive_json FROM assessment_archives').get()!.archive_json);
			assert.equal(raw.includes('submitRequestId'), false); assert.equal(raw.includes(before.submitRequestId), false);
			assert.equal(raw.includes(before.connection.apiOrigin), false); assert.equal(raw.includes('credential'), false);
			const keyIds = db.prepare('SELECT key_id FROM queue_encryption_keys').all().map(row => String(row.key_id));
			const cipher = new EvidenceCipher(await supplyEvidenceKeys({ get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); } }, { keyIds }));
			try { const saved = cipher.decrypt(before.credentialId, JSON.parse(raw), 'archive') as { metadata: AssessmentMetadata; remoteDisposition: string };
				assert.deepEqual(saved.metadata, before); assert.equal(saved.metadata.submitRequestId, before.submitRequestId); assert.equal(saved.remoteDisposition, 'unverified'); }
			finally { cipher.dispose(); }
			await assert.rejects(store.save(before)); await assert.rejects(store.deleteCredential(before.credentialId));
		} finally { db.close(); }
	});
	test('fresh pairing has no stale deadline, consent or recording; new evidence never includes archived recordings', async () => {
		const id = await active(); const old = file(); await writer.write(old); const oldCredential = await store.getCredential(metadata().credentialId);
		await controller.archive(async () => true); await controller.pair('NEW-PAIR'); assert.equal(metadata().connection.codingSessionId, '3');
		assert.equal(controller.view.state, 'paired'); assert.equal(controller.view.deadline, undefined); assert.equal(controller.view.serverTime, metadata().serverStatus.serverTime);
		assert.equal(controller.view.uploadConsent, false); assert.equal(recording.isRecording, false); assert.deepEqual(metadata().localRecordingSessionIds, []);
		assert.notEqual(await store.getCredential(metadata().credentialId), oldCredential);
		recordingConsent = false; await controller.start(); assert.equal(recording.isRecording, false);
		recordingConsent = true; uploadConsent = false; await controller.start(); assert.equal(recording.isRecording, false);
		uploadConsent = true; await controller.start(); const freshId = recording.sessionId!; assert.notEqual(freshId, id); assert.equal(recordingDialogs, 4); assert.equal(uploadDialogs, 3);
		const fresh = file(); await writer.write(fresh);
		assert.equal(await queue.prepareBatch(100, 100000, id), null);
		const batch = (await queue.prepareBatch(100, 100000))!; assert.deepEqual(batch.events, [fresh]); await queue.releaseBatch(batch.batchId);
		assert.equal(controller.allowsDevelopmentUpload(id), false); assert.equal(controller.isAssociatedSession(id), false); assert.equal(controller.isAssociatedSession(freshId), true);
	});
	test('authentication recovery does not archive automatically; explicit archive needs no successful Rails call', async () => {
		await active(); const original = api.getStatus.bind(api); api.getStatus = async () => { throw new AssessmentApiError('authentication'); };
		await controller.showStatus(); assert.equal(controller.view.state, 'recovery'); assert.equal(controller.view.reason, 'authentication');
		assert.equal((await queue.getAssessmentArchiveIndex()).archives.length, 0); const keys = [...secrets];
		await controller.archive(async summary => { assert.equal(summary.submissionConfirmed, false); return true; });
		assert.equal(controller.view.state, 'unpaired'); assert.deepEqual([...secrets], keys); api.getStatus = original;
		await controller.pair('NEW-PAIR'); assert.equal(metadata().connection.codingSessionId, '3');
	});
	test('restart after archive ignores the preserved old pointer and restores durable upload isolation', async () => {
		const id = await active(); const event = file(); await writer.write(event); await controller.archive(async () => true);
		await close(); await open(); assert.equal(controller.view.state, 'unpaired'); assert.equal(controller.view.archivedCount, 1);
		assert.equal(controller.view.deadline, undefined); assert.equal(controller.view.uploadConsent, false); assert.equal(controller.allowsDevelopmentUpload(id), false);
		assert.deepEqual(await queue.getPending(10), [event]); await controller.pair('NEW-PAIR'); assert.equal(metadata().connection.codingSessionId, '3');
	});
	test('failed fresh pairing and repeated archive attempts never overwrite the old immutable archive', async () => {
		await active(); await controller.archive(async () => true); const db = database();
		try {
			const original = db.prepare('SELECT archive_json FROM assessment_archives').get()!.archive_json;
			await controller.pair('INVALID'); assert.equal(controller.view.state, 'error'); assert.equal(await store.load(), undefined);
			await controller.archive(async () => { throw new Error('No active connection must not prompt'); });
			await controller.pair('NEW-PAIR'); assert.equal(controller.view.state, 'paired');
			assert.equal(db.prepare('SELECT archive_json FROM assessment_archives').get()!.archive_json, original);
			assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assessment_archives').get()!.count, 1);
		} finally { db.close(); }
	});
	test('archive transaction failure rolls back quarantine, keeps the old connection in recovery and allows a safe retry', async () => {
		const id = await active(); const event = file(); await writer.write(event); const db = database();
		db.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON assessment_archive_recordings BEGIN SELECT RAISE(ABORT, 'private dummy detail'); END;");
		try {
			await controller.archive(async () => true); assert.equal(controller.view.state, 'recovery'); assert.equal(controller.view.reason, 'storage');
			assert.equal((await queue.getAssessmentArchiveIndex()).archives.length, 0); assert.equal((await store.load())!.connection.codingSessionId, '2');
			await controller.pair('NEW-PAIR'); assert.equal(controller.view.reason, 'recovery_required'); assert.equal(recording.isRecording, false);
			assert.equal(controller.allowsDevelopmentUpload(id), false); assert.deepEqual(await queue.getPending(10), [event]);
			db.exec('DROP TRIGGER fail_archive'); await controller.archive(async () => true); assert.equal(controller.view.state, 'unpaired');
		} finally { db.close(); }
	});
	test('restart before commit preserves the old connection; an unknown committed outcome recovers without a second archive', async () => {
		await active(); archiveBackend.archiveAssessment = async () => { throw new Error('simulated interruption before commit'); };
		await controller.archive(async () => true); await close(); await open(); assert.equal(controller.view.state, 'recovery');
		assert.equal((await queue.getAssessmentArchiveIndex()).archives.length, 0);
		archiveBackend.archiveAssessment = async value => { await queue.archiveAssessment(value); throw new Error('simulated lost commit reply'); };
		await controller.archive(async () => true); assert.equal(controller.view.state, 'recovery');
		assert.equal((await queue.getAssessmentArchiveIndex()).archives.length, 1);
		await close(); await open(); assert.equal(controller.view.state, 'unpaired'); assert.equal(controller.view.archivedCount, 1);
	});
	test('repeated concurrent archive requests prompt once, commit once, and retries retain the first audit snapshot', async () => {
		await active(); let prompts = 0;
		const first = controller.archive(async () => { prompts++; return true; }); assert.equal(first, controller.archive(async () => { prompts++; return true; }));
		await first; await controller.archive(async () => { prompts++; return true; }); assert.equal(prompts, 1);
		assert.equal((await queue.getAssessmentArchiveIndex()).archives.length, 1);
	});
	test('drain failure does not release the active slot or archive incomplete asynchronous capture', async () => {
		await active(); failDrain = true; await controller.archive(async () => true);
		assert.equal(controller.view.state, 'recovery'); assert.equal(recording.isRecording, false); assert.equal((await queue.getAssessmentArchiveIndex()).archives.length, 0);
		await controller.pair('NEW-PAIR'); assert.equal(controller.view.reason, 'recovery_required');
		failDrain = false; await controller.archive(async () => true); assert.equal(controller.view.state, 'unpaired');
	});
	test('confirmed archive interrupts an in-progress start without allowing late local recording or replacing the new connection', async () => {
		await controller.pair('OLD-PAIR'); const actual = api.startOrResume.bind(api); let requested!: () => void;
		const pending = new Promise<void>(resolve => { requested = resolve; });
		api.startOrResume = async (...args) => { requested(); await new Promise(resolve => setTimeout(resolve, 80)); return actual(...args); };
		const starting = controller.start(); await pending;
		await controller.archive(async () => true); await starting; assert.equal(controller.view.state, 'unpaired'); assert.equal(recording.isRecording, false);
		api.startOrResume = actual; await controller.pair('NEW-PAIR'); await new Promise(resolve => setTimeout(resolve, 100));
		assert.equal(controller.view.state, 'paired'); assert.equal(metadata().connection.codingSessionId, '3'); assert.equal(recording.isRecording, false);
		assert.equal((await queue.getAssessmentArchiveIndex()).archives.length, 1);
	});
	test('an unrelated manual recording is not stopped or adopted by archiving', async () => {
		await controller.pair('OLD-PAIR'); await recording.start(); const id = recording.sessionId;
		await controller.archive(async () => true); assert.equal(recording.sessionId, id); assert.equal(recording.isRecording, true);
		assert.equal(controller.view.reason, 'recording_busy'); assert.equal((await queue.getAssessmentArchiveIndex()).archives.length, 0);
	});
	test('claimed evidence blocks archival until the existing uploader releases its batch', async () => {
		await active(); await writer.write(file()); const batch = (await queue.prepareBatch(100, 100000))!;
		await controller.archive(async () => true); assert.equal(controller.view.state, 'recovery'); assert.equal((await queue.getAssessmentArchiveIndex()).archives.length, 0);
		await queue.releaseBatch(batch.batchId); await controller.archive(async () => true); assert.equal(controller.view.state, 'unpaired');
	});
	test('archived events cannot gain acknowledgments, new writes, recording starts or generic upload approval', async () => {
		const id = await active(); const event = file(); await writer.write(event); await controller.archive(async () => true);
		await assert.rejects(queue.markAcknowledged([event.eventId])); await assert.rejects(queue.enqueue(file(id))); await assert.rejects(queue.beginSession(id));
		assert.equal(await queue.getUploadPrivacyContext(event), undefined); assert.equal(await queue.getPendingCount(), 1);
		await queue.enqueue(event); assert.equal(await queue.getPendingCount(), 1); // Exact duplicate cannot revive/change the archived evidence.
	});
	test('retention and broad local cleanup preserve archived evidence and audit metadata', async () => {
		await active(); const event = file(); await writer.write(event); await controller.archive(async () => true);
		await queue.acquireMaintenance();
		try { const result = await queue.deleteEvidence('all'); assert.equal(result.deletedRecords, 0); assert.equal(result.deletedSessions, 0);
			const expired = await queue.expireAcknowledged(new Date().toISOString()); assert.equal(expired.deletedSessions, 0); }
		finally { await queue.releaseMaintenance(); }
		assert.deepEqual(await queue.getPending(10), [event]); assert.equal((await queue.getAssessmentArchiveIndex()).archives.length, 1);
	});
	test('tampered archive ciphertext fails closed on restart without exposing contents or enabling pairing', async () => {
		await active(); await controller.archive(async () => true); await close(); const db = database();
		try { const envelope = JSON.parse(String(db.prepare('SELECT archive_json FROM assessment_archives').get()!.archive_json));
			envelope.tag = Buffer.alloc(16).toString('base64'); db.prepare('UPDATE assessment_archives SET archive_json = ?').run(JSON.stringify(envelope)); }
		finally { db.close(); }
		await assert.rejects(AsyncLocalEventQueue.open(storage(), [], {}, { get: async key => secrets.get(key), store: async () => {} }), error => {
			assert.ok(error instanceof Error); assert.equal(error.message.includes('credential'), false); return true;
		});
		// Restore the original database contents only inside this disposable fixture so teardown can reopen.
		const repair = database(); repair.exec('DELETE FROM assessment_archive_recordings; DELETE FROM assessment_archives;'); repair.close(); await open();
	});
	test('a new pairing cannot reactivate an archived Rails identity with a different credential', async () => {
		await active(); await controller.archive(async () => true);
		const anotherClient = new MockAssessmentApiClient(); anotherClient.seedInvitation('SAME-PAIR', '2');
		api.pair = anotherClient.pair.bind(anotherClient); await controller.pair('SAME-PAIR');
		assert.equal(controller.view.reason, 'protocol'); assert.equal(await store.load(), undefined);
		assert.equal((await queue.getAssessmentArchiveIndex()).archives.length, 1);
	});
	test('schema v9 migration retains pre-existing evidence and does not manufacture archives', async () => {
		const id = await active(); const captured = file(); await writer.write(captured); await close(); const db = database();
		db.exec('DROP TABLE disclosure_consents; DROP TABLE assessment_archive_recordings; DROP TABLE assessment_archives; PRAGMA user_version = 9;'); db.close();
		await open(); assert.equal(controller.view.state, 'recovery'); assert.equal(controller.isAssociatedSession(id), true);
		assert.deepEqual(await queue.getPending(10), [captured]); assert.equal((await queue.getAssessmentArchiveIndex()).archives.length, 0);
		await controller.archive(async () => true); assert.equal(controller.view.state, 'unpaired');
	});
	test('archive index failure leaves all development uploads and pairing blocked', async () => {
		await controller.dispose(); archiveBackend.getAssessmentArchiveIndex = async () => { throw new Error('private database failure'); };
		createController(); await controller.initialize(); assert.equal(controller.view.state, 'error');
		assert.equal(controller.allowsDevelopmentUpload(randomUUID()), false); await controller.pair('OLD-PAIR'); assert.equal(controller.view.reason, 'storage');
	});
});
