import { createHash } from 'node:crypto';
import {
	createCursorEvent,
	MAX_CODEX_CONTENT_BYTES,
	type CursorActivityEvent,
	type CursorSourceRecord
} from './eventSchema';
import { PrivacyFilter } from './privacyFilter';
import type { ActivityWriter } from './jsonlWriter';
import type { CursorPromptRecord, CursorGenerationRecord } from './cursorSqliteReader';

export interface CursorEventParserOptions {
	recordingSessionId: string;
	workspaceId: string;
	sourceSessionId?: string;
	privacyFilter?: PrivacyFilter;
	onDiagnostic?: (diagnostic: CursorParserDiagnostic, details?: unknown) => void;
}

export type CursorParserDiagnostic =
	| 'event_created'
	| 'text_redacted'
	| 'text_truncated'
	| 'empty_prompt_skipped'
	| 'write_failed';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Normalizes raw Cursor SQLite prompts and generations into standard TrackerEvents,
 * applying privacy filtering and size limits.
 */
export class CursorEventParser {
	private readonly privacy: PrivacyFilter;
	private recordIndex = 0;
	private disposed = false;

	constructor(
		private readonly writer: ActivityWriter,
		private readonly options: CursorEventParserOptions
	) {
		this.privacy = options.privacyFilter ?? new PrivacyFilter();
	}

	/**
	 * Parse and write a Cursor prompt event (ai.prompt.submitted).
	 */
	async handlePrompt(prompt: CursorPromptRecord): Promise<CursorActivityEvent | undefined> {
		if (this.disposed) {
			return undefined;
		}

		const rawText = prompt.text.trim();
		if (!rawText) {
			this.options.onDiagnostic?.('empty_prompt_skipped');
			return undefined;
		}

		const sanitizedText = this.sanitizeText(rawText);
		const sourceSessionId = this.options.sourceSessionId ?? this.options.workspaceId;
		const sourceRef = 'cursor-file:' + digest(sourceSessionId);
		const byteLen = Buffer.byteLength(sanitizedText, 'utf8');

		const sourceRecord: CursorSourceRecord = {
			sourceFileReference: sourceRef,
			recordIndex: ++this.recordIndex,
			generation: 0,
			byteOffset: 0,
			byteLength: byteLen,
			recordType: 'cursor_prompt'
		};

		const event = createCursorEvent({
			eventType: 'ai.prompt.submitted',
			sessionId: this.options.recordingSessionId,
			workspaceId: this.options.workspaceId,
			sourceSessionId,
			attribution: 'unknown',
			timestamp: new Date(prompt.timestampMs),
			payload: {
				text: sanitizedText,
				sourceRecord,
				messageId: `prompt-${prompt.index}`
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
	 * Parse and write a Cursor generation event (ai.response.completed and/or ai.prompt.submitted).
	 */
	async handleGeneration(generation: CursorGenerationRecord): Promise<CursorActivityEvent | undefined> {
		if (this.disposed) {
			return undefined;
		}

		// Use textDescription or responseSnippet
		const rawText = (generation.textDescription || generation.responseSnippet || `Cursor ${generation.type} generation`).trim();
		const sanitizedText = this.sanitizeText(rawText);
		const sourceSessionId = generation.generationUUID;
		const sourceRef = 'cursor-file:' + digest(sourceSessionId);
		const byteLen = Buffer.byteLength(sanitizedText, 'utf8');

		const sourceRecord: CursorSourceRecord = {
			sourceFileReference: sourceRef,
			recordIndex: ++this.recordIndex,
			generation: 1,
			byteOffset: 0,
			byteLength: byteLen,
			recordType: 'cursor_generation'
		};

		// If generation has prompt textDescription, we map to ai.response.completed
		const event = createCursorEvent({
			eventType: 'ai.response.completed',
			sessionId: this.options.recordingSessionId,
			workspaceId: this.options.workspaceId,
			sourceSessionId,
			attribution: 'unknown',
			timestamp: new Date(generation.unixMs),
			payload: {
				text: sanitizedText,
				sourceRecord,
				messageId: generation.generationUUID
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
		// 1. Clamp byte length if exceeds max schema limit
		if (Buffer.byteLength(text, 'utf8') > MAX_CODEX_CONTENT_BYTES) {
			text = Buffer.from(text, 'utf8').subarray(0, MAX_CODEX_CONTENT_BYTES - 16).toString('utf8');
			this.options.onDiagnostic?.('text_truncated');
		}

		// 2. Filter secrets through PrivacyFilter
		const filtered = this.privacy.filterContent(text);
		if (filtered.status === 'redacted' && typeof filtered.value === 'string') {
			this.options.onDiagnostic?.('text_redacted');
			return filtered.value;
		}
		if (filtered.status === 'accepted' && typeof filtered.value === 'string') {
			return filtered.value;
		}

		// Fallback if filter rejected structure
		return text.replace(/[A-Za-z0-9_-]{24,}/g, '[REDACTED]');
	}

	dispose(): void {
		this.disposed = true;
	}
}
