import { describeCodexDiscovery } from './codexDiscoveryDiagnostics';
import * as vscode from 'vscode';
import type { RecordingController } from './recording';
import type { CodexSessionDiscovery, CodexSessionRegistration } from './codexSessionDiscovery';

export const REVIEW_CODEX_SESSIONS_COMMAND = 'ai-developer-tracker.reviewCodexSessions';

export interface CodexCandidateItem extends vscode.QuickPickItem { sourceFileId: string; }
export interface CodexDiscoveryPrompts {
	pick(items: readonly CodexCandidateItem[]): PromiseLike<readonly CodexCandidateItem[] | undefined>;
	information(message: string): PromiseLike<unknown>;
}
export interface CodexContentConsent {
	hasConsent(sessionId: string): boolean;
	request(): PromiseLike<boolean>;
	grant(sessionId: string): void;
}
const defaultPrompts: CodexDiscoveryPrompts = {
	pick: items => vscode.window.showQuickPick(items, {
		canPickMany: true, title: 'Confirm Codex sessions for this recording',
		placeHolder: 'Select only sessions belonging to your current work. Content capture requires separate consent.'
	}),
	information: message => vscode.window.showInformationMessage(message)
};

export class CodexDiscoveryUi implements vscode.Disposable {
	private reviewing = false;
	private disposed = false;
	private readonly prompted = new Set<string>();
	constructor(
		private readonly recording: Pick<RecordingController, 'isRecording' | 'sessionId'>,
		private readonly discovery: Pick<CodexSessionDiscovery, 'scanNow' | 'getConfirmationCandidates' | 'confirm' | 'reject'> & Partial<Pick<CodexSessionDiscovery, 'getDiagnostics'>>,
		private readonly prompts: CodexDiscoveryPrompts = defaultPrompts,
		private readonly contentConsent?: CodexContentConsent,
		private readonly reportDiagnostics: (summary: ReturnType<CodexSessionDiscovery['getDiagnostics']>, contentConsent: boolean) => void = () => {}
	) {}

	notify(candidates: readonly CodexSessionRegistration[]): void {
		if (this.disposed || this.reviewing || !this.recording.isRecording) { return; }
		if (candidates.some(entry => !this.prompted.has(`${entry.recordingSessionId}:${entry.sourceFileId}`))) {
			void this.review().catch(() => {}).finally(() => this.notify(this.discovery.getConfirmationCandidates()));
		}
	}

	async review(): Promise<void> {
		if (this.disposed || this.reviewing) { return; }
		if (!this.recording.isRecording) {
			await this.prompts.information('Start recording before reviewing Codex session candidates.'); return;
		}
		this.reviewing = true;
		const sessionId = this.recording.sessionId;
		try {
			await this.discovery.scanNow();
			if (this.disposed || this.recording.sessionId !== sessionId) { return; }
			const candidates = this.discovery.getConfirmationCandidates();
			const summary = this.discovery.getDiagnostics?.();
			const hasContentConsent = this.contentConsent?.hasConsent(sessionId!) ?? false;
			if (summary) { this.reportDiagnostics(summary, hasContentConsent); }
			if (!candidates.length) {
				await this.prompts.information(summary ? describeCodexDiscovery(summary, hasContentConsent) : 'No verified current Codex session candidates are available.'); return;
			}
			const workspaceIds = [...new Set(candidates.map(entry => entry.workspaceId))];
			for (const candidate of candidates) { this.prompted.add(`${sessionId}:${candidate.sourceFileId}`); }
			// Display generated labels, session UUID suffixes, and UTC times; no paths or account fields.
			const items = candidates.map((entry, index) => ({
				label: `Codex candidate ${index + 1} — session ${entry.sourceSessionId!.slice(-8)}`,
				description: `Approved workspace ${workspaceIds.indexOf(entry.workspaceId) + 1}`,
				detail: `Created ${entry.createdAt}. Ownership requires your confirmation.`,
				sourceFileId: entry.sourceFileId
			}));
			const selected = await this.prompts.pick(items);
			if (!selected || this.disposed || !this.recording.isRecording || this.recording.sessionId !== sessionId) { return; }
			if (selected.length && this.contentConsent && !this.contentConsent.hasConsent(sessionId!)) {
				const consent = await this.contentConsent.request();
				if (!consent || this.disposed || !this.recording.isRecording || this.recording.sessionId !== sessionId) { return; }
				this.contentConsent.grant(sessionId!);
			}
			const selectedIds = new Set(selected.map(item => item.sourceFileId));
			for (const candidate of candidates) {
				if (selectedIds.has(candidate.sourceFileId)) { await this.discovery.confirm(candidate.sourceFileId);
				} else { this.discovery.reject(candidate.sourceFileId); }
			}
			if (this.recording.isRecording && this.recording.sessionId === sessionId) {
				const updated = this.discovery.getDiagnostics?.();
				if (updated) { this.reportDiagnostics(updated, this.contentConsent?.hasConsent(sessionId!) ?? false); }
			}
		} finally { this.reviewing = false; }
	}
	dispose(): void { this.disposed = true; }
}
