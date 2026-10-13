import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CodexDiscoveryUi, type CodexCandidateItem, type CodexDiscoveryPrompts } from '../codexDiscoveryUi';
import type { CodexSessionRegistration } from '../codexSessionDiscovery';
import { RecordingController } from '../recording';

suite('Codex discovery confirmation UI', () => {
	let recording: RecordingController;
	let ui: CodexDiscoveryUi;
	let entries: CodexSessionRegistration[];
	let confirmed: string[];
	let rejected: string[];
	let scans: number;
	let picks: number;
	let messages: string[];
	let pick: CodexDiscoveryPrompts['pick'];

	setup(async () => {
		recording = new RecordingController({ text: '', tooltip: '', command: '', show() {}, dispose() {} }, async () => true);
		await recording.start();
		entries = [1, 2].map(index => ({
			recordingSessionId: recording.sessionId!, sourceSessionId: randomUUID(),
			workspaceId: 'workspace-' + index, sourceFileId: 'opaque-file-' + index,
			sourceFileReference: 'codex-file:opaque-' + index,
			createdAt: '2026-10-13T10:00:00.000Z', workspaceRelativeCwd: 'private-customer/project',
			status: 'ambiguous', reason: 'multiple_matches'
		}));
		confirmed = []; rejected = []; scans = 0; picks = 0; messages = [];
		pick = async () => undefined;
		ui = new CodexDiscoveryUi(recording, {
			scanNow: async () => { scans++; },
			getConfirmationCandidates: () => entries.filter(entry =>
				entry.reason === 'multiple_matches' || entry.reason === 'recent_workspace_match'),
			confirm: async id => {
				confirmed.push(id);
				const entry = entries.find(candidate => candidate.sourceFileId === id)!;
				entry.status = 'confirmed'; entry.reason = 'user_confirmed'; return true;
			},
			reject: id => {
				rejected.push(id);
				const entry = entries.find(candidate => candidate.sourceFileId === id)!;
				entry.status = 'rejected'; entry.reason = 'user_rejected';
			}
		}, {
			pick: items => { picks++; return pick(items); },
			information: async message => { messages.push(message); }
		});
	});
	teardown(() => { ui.dispose(); recording.dispose(); });

	test('requires explicit selection and shows recognizable session IDs without private paths', async () => {
		pick = async items => {
			assert.deepEqual(confirmed, []);
			assert.equal(items.length, 2);
			assert.ok(items[0].label.includes(entries[0].sourceSessionId!.slice(-8)));
			assert.ok(!JSON.stringify(items).includes('private-customer'));
			return [items[0]];
		};
		await ui.review();
		assert.deepEqual(confirmed, [entries[0].sourceFileId]);
		assert.deepEqual(rejected, [entries[1].sourceFileId]);
	});
	test('cancel leaves all candidates unconfirmed and available for later review', async () => {
		await ui.review();
		assert.deepEqual(confirmed, []);
		assert.deepEqual(rejected, []);
		assert.ok(entries.every(entry => entry.status === 'ambiguous'));
	});
	test('ignores a selection resolved after stopping and starting a different recording', async () => {
		let resolve!: (items: readonly CodexCandidateItem[]) => void;
		let shown!: () => void;
		const visible = new Promise<void>(done => { shown = done; });
		let selected: readonly CodexCandidateItem[] = [];
		pick = items => { selected = items; shown(); return new Promise(done => { resolve = done; }); };
		const reviewing = ui.review();
		await visible;
		recording.stop(); await recording.start();
		resolve(selected);
		await reviewing;
		assert.deepEqual(confirmed, []);
		assert.deepEqual(rejected, []);
	});
	test('does not scan or prompt while stopped', async () => {
		recording.stop();
		await ui.review();
		assert.equal(scans, 0); assert.equal(picks, 0);
		assert.ok(messages[0].includes('Start recording'));
	});
	test('does not repeatedly prompt for dismissed candidates', async () => {
		let shown!: () => void;
		const visible = new Promise<void>(done => { shown = done; });
		pick = async () => { shown(); return undefined; };
		ui.notify(entries);
		await visible;
		await new Promise(done => setTimeout(done, 10));
		ui.notify(entries);
		await new Promise(done => setTimeout(done, 10));
		assert.equal(picks, 1);
		assert.deepEqual(confirmed, []);
	});

	function contentUi(request: () => PromiseLike<boolean>, grant: (session: string) => void, hasConsent = false): void {
		ui.dispose();
		ui = new CodexDiscoveryUi(recording, {
			scanNow: async () => {},
			getConfirmationCandidates: () => entries,
			confirm: async id => { confirmed.push(id); return true; },
			reject: id => { rejected.push(id); }
		}, { pick: async items => [items[0]], information: async () => {} }, {
			request, grant, hasConsent: () => hasConsent
		});
	}
	test('requires explicit content consent before granting and confirming selected sessions', async () => {
		const granted: string[] = [];
		contentUi(async () => {
			assert.equal(confirmed.length, 0); assert.equal(granted.length, 0); return true;
		}, session => granted.push(session));
		await ui.review();
		assert.deepEqual(granted, [recording.sessionId]);
		assert.deepEqual(confirmed, [entries[0].sourceFileId]);
	});
	test('canceling content consent leaves sessions unconfirmed and permits later review', async () => {
		let granted = false;
		contentUi(async () => false, () => { granted = true; });
		await ui.review();
		assert.equal(granted, false); assert.equal(confirmed.length, 0); assert.equal(rejected.length, 0);
	});
	test('does not reuse a consent result after recording stops or its session changes', async () => {
		let resolve!: (value: boolean) => void; let reached!: () => void; let granted = false;
		const shown = new Promise<void>(done => { reached = done; });
		contentUi(() => { reached(); return new Promise(done => { resolve = done; }); }, () => { granted = true; });
		const reviewing = ui.review();
		await shown;
		recording.stop(); await recording.start(); resolve(true); await reviewing;
		assert.equal(granted, false); assert.equal(confirmed.length, 0);
	});
	test('does not repeat content consent already granted for the current recording', async () => {
		contentUi(async () => { throw new Error('Consent should not repeat'); }, () => {}, true);
		await ui.review();
		assert.deepEqual(confirmed, [entries[0].sourceFileId]);
	});
});
