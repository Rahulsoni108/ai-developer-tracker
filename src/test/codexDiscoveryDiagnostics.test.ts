import * as assert from 'node:assert/strict';
import { describeCodexDiscovery } from '../codexDiscoveryDiagnostics';
import type { CodexDiscoverySummary } from '../codexSessionDiscovery';

suite('Safe Codex discovery diagnostic messages', () => {
	const summary = (values: Partial<CodexDiscoverySummary> = {}): CodexDiscoverySummary => ({ recordingActive: true,
		directorySource: 'default_home', directoryStatus: 'ready', codexHome: 'unset', approvedWorkspaceCount: 1,
		inspectedFileCount: 0, candidateCount: 0, confirmedCount: 0, reasons: {}, diagnostics: [], ...values });
	test('already confirmed sessions are distinct from missing candidates and inactive content consent', () => {
		const current = summary({ confirmedCount: 1, inspectedFileCount: 1, reasons: { user_confirmed: 1 } });
		assert.ok(describeCodexDiscovery(current, true).includes('Local content-capture consent is granted'));
		assert.ok(describeCodexDiscovery(current, false).includes('not authorized or is unavailable'));
		assert.equal(describeCodexDiscovery(current, true).includes('No verified current'), false);
	});
	test('provides directory, workspace, stale, metadata and timing recovery without weakening verification', () => {
		const cases: [Partial<CodexDiscoverySummary>, string][] = [
			[{ directoryStatus: 'missing' }, 'directory is missing'], [{ directoryStatus: 'unsafe' }, 'Symlink/path safety'],
			[{ codexHome: 'differs' }, 'no other directories are searched automatically'], [{ approvedWorkspaceCount: 0 }, 'No approved workspace'],
			[{ reasons: { historical: 2 } }, 'new message in an existing conversation'], [{ reasons: { outside_workspace: 1 } }, 'ownership still requires confirmation'],
			[{ reasons: { missing_metadata: 1, invalid_metadata: 1 } }, 'never searched for replacement metadata'],
			[{ reasons: { future_timestamp: 1 } }, 'without altering session logs'], [{ reasons: { user_rejected: 1 } }, 'declined sessions remain excluded']
		];
		for (const [values, expected] of cases) { assert.ok(describeCodexDiscovery(summary(values), false).includes(expected)); }
	});
	test('missing files indicate a supported-layout or installation-path check, never a claim that consent was granted', () => {
		const text = describeCodexDiscovery(summary(), false);
		assert.ok(text.includes('No session files were inspected')); assert.ok(text.includes('Output'));
		assert.equal(text.includes('consent is granted'), false);
	});
});
