import type { CodexDiscoverySummary } from './codexSessionDiscovery';

/** Safe actionable status; no untrusted metadata is interpolated. */
export function describeCodexDiscovery(summary: CodexDiscoverySummary, contentConsent: boolean): string {
	if (summary.confirmedCount) {
		return `No new Codex sessions await confirmation. Already confirmed for this recording: ${summary.confirmedCount}. `
			+ (contentConsent ? 'Local content-capture consent is granted; inspect reader/capture diagnostics and event counts to verify capture.'
				: 'Local content capture is not authorized or is unavailable. Session selection alone does not authorize conversation capture.')
			+ ' See Output → AI Developer Tracker for safe discovery counts.';
	}
	const hints: string[] = [];
	if (!summary.approvedWorkspaceCount) { hints.push('No approved workspace could be verified. Check the current recording workspace.'); }
	if (summary.directoryStatus === 'missing') { hints.push('The configured session directory is missing. Check the user setting ai-developer-tracker.codex.sessionsDirectory.'); }
	if (summary.directoryStatus === 'unsafe') { hints.push('The session directory is unsafe or inaccessible. Symlink/path safety checks remain required.'); }
	if (summary.codexHome === 'differs' || summary.codexHome === 'invalid') { hints.push('CODEX_HOME does not match the tracker session directory. Check the local session location and explicitly configure the tracker user setting; no other directories are searched automatically.'); }
	if (summary.reasons.historical) { hints.push('Older sessions are excluded. Create a new Codex conversation after recording is active; a new message in an existing conversation is not a new session.'); }
	if (summary.reasons.outside_workspace || summary.reasons.working_directory_unverified) { hints.push('A session working directory is outside the approved workspace or could not be verified. Open Codex in an approved folder; ownership still requires confirmation.'); }
	if (['missing_metadata', 'invalid_metadata', 'incomplete_metadata', 'oversized_metadata'].some(reason => summary.reasons[reason as keyof typeof summary.reasons])) {
		hints.push('Some first-record metadata could not be verified. Check the metadata reason counts; conversation records are never searched for replacement metadata.');
	}
	if (summary.reasons.future_timestamp || summary.reasons.creation_time_unverified) { hints.push('Session creation time could not be verified. Check system timing/filesystem support without altering session logs.'); }
	if (!summary.inspectedFileCount && summary.directoryStatus === 'ready') { hints.push('No session files were inspected in the supported recent date folders. Check where this Codex installation writes local sessions.'); }
	if (summary.reasons.user_rejected) { hints.push('Previously declined sessions remain excluded from this recording.'); }
	return 'No verified current Codex session candidates are available. ' + hints.join(' ') + ' See Output → AI Developer Tracker for safe discovery counts and reason codes.';
}
