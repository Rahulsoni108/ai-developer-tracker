import { createHash } from 'node:crypto';
import {
	createCopilotEvent,
	MAX_CODEX_CONTENT_BYTES,
	type CopilotActivityEvent,
	type CopilotSourceRecord
} from './eventSchema';
import { PrivacyFilter } from './privacyFilter';
import type { ActivityWriter } from './jsonlWriter';
import type { CopilotPromptRecord, CopilotResponseRecord } from './copilotChatReader';

export interface CopilotEventParserOptions {
	recordingSessionId: string;
	workspaceId: string;
	sourceSessionId?: string;
	privacyFilter?: PrivacyFilter;
	onDiagnostic?: (diagnostic: CopilotParserDiagnostic, details?: unknown) => void;
}

export type CopilotParserDiagnostic =
	| 'event_created'
	| 'text_redacted'
	| 'text_truncated'
	| 'empty_prompt_skipped'
	| 'empty_response_skipped'
	| 'write_failed';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Normalizes raw Copilot prompt and response records into standard TrackerEvents,
 * applying privacy sanitization and payload boundaries.
 */
export class CopilotEventParser {
	private readonly privacy: PrivacyFilter;
	private recordIndex = 0;
	private disposed = false;

	constructor(
		private readonly writer: ActivityWriter,
		private readonly options: CopilotEventParserOptions
	) {
		this.privacy = options.privacyFilter ?? new PrivacyFilter();
	}

	/**
	 * Parse and write a Copilot prompt event (ai.prompt.submitted).
	 */
	async handlePrompt(prompt: CopilotPromptRecord): Promise<CopilotActivityEvent | undefined> {
		if (this.disposed) {
			return undefined;
		}

		const rawText = prompt.text.trim();
		if (!rawText) {
			this.options.onDiagnostic?.('empty_prompt_skipped');
			return undefined;
		}

		const sanitizedText = this.sanitizeText(rawText);
		const sourceSessionId = prompt.sessionId || this.options.sourceSessionId || this.options.workspaceId;
		const sourceRef = 'copilot-file:' + digest(sourceSessionId);
		const byteLen = Buffer.byteLength(sanitizedText, 'utf8');

		const sourceRecord: CopilotSourceRecord = {
			sourceFileReference: sourceRef,
			recordIndex: ++this.recordIndex,
			generation: 0,
			byteOffset: 0,
			byteLength: byteLen,
			recordType: 'copilot_turn'
		};

		const event = createCopilotEvent({
			eventType: 'ai.prompt.submitted',
			sessionId: this.options.recordingSessionId,
			workspaceId: this.options.workspaceId,
			sourceSessionId,
			attribution: 'unknown',
			timestamp: new Date(prompt.timestampMs),
			payload: {
				text: sanitizedText,
				sourceRecord,
				messageId: prompt.requestId
			}
		});

		try {
			await this.writer.write(event);
			this.options.onDiagnostic?.('event_created', { eventId: event.eventId, type: event.eventType });
			return event;
		} catch (err) {
			this.options.onDiagnostic?.('write_failed', err);
			return undefined;
		}
	}

	/**
	 * Parse and write a Copilot response event (ai.response.completed).
	 */
	async handleResponse(response: CopilotResponseRecord): Promise<CopilotActivityEvent | undefined> {
		if (this.disposed) {
			return undefined;
		}

		const rawText = response.text.trim();
		if (!rawText) {
			this.options.onDiagnostic?.('empty_response_skipped');
			return undefined;
		}

		const sanitizedText = this.sanitizeText(rawText);
		const sourceSessionId = response.sessionId || this.options.sourceSessionId || this.options.workspaceId;
		const sourceRef = 'copilot-file:' + digest(sourceSessionId);
		const byteLen = Buffer.byteLength(sanitizedText, 'utf8');

		const sourceRecord: CopilotSourceRecord = {
			sourceFileReference: sourceRef,
			recordIndex: ++this.recordIndex,
			generation: 1,
			byteOffset: 0,
			byteLength: byteLen,
			recordType: 'copilot_message'
		};

		const event = createCopilotEvent({
			eventType: 'ai.response.completed',
			sessionId: this.options.recordingSessionId,
			workspaceId: this.options.workspaceId,
			sourceSessionId,
			attribution: 'unknown',
			timestamp: new Date(response.timestampMs),
			payload: {
				text: sanitizedText,
				sourceRecord,
				messageId: response.responseId
			}
		});

		try {
			await this.writer.write(event);
			this.options.onDiagnostic?.('event_created', { eventId: event.eventId, type: event.eventType });
			return event;
		} catch (err) {
			this.options.onDiagnostic?.('write_failed', err);
			return undefined;
		}
	}

	/**
	 * Sanitizes text with PrivacyFilter, redacting tokens, keys, and credentials, and clamps size.
	 */
	private sanitizeText(raw: string): string {
		let text = raw;
		if (Buffer.byteLength(text, 'utf8') > MAX_CODEX_CONTENT_BYTES) {
			text = Buffer.from(text, 'utf8').subarray(0, MAX_CODEX_CONTENT_BYTES - 16).toString('utf8');
			this.options.onDiagnostic?.('text_truncated');
		}

		const filtered = this.privacy.filterContent(text);
		if (filtered.status === 'redacted' && typeof filtered.value === 'string') {
			this.options.onDiagnostic?.('text_redacted');
			return filtered.value;
		}
		if (filtered.status === 'accepted' && typeof filtered.value === 'string') {
			return filtered.value;
		}

		return text.replace(/[A-Za-z0-9_-]{24,}/g, '[REDACTED]');
	}

	dispose(): void {
		this.disposed = true;
	}
}
