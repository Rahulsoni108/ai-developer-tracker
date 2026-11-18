import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface CopilotReaderOptions {
	/** Absolute path to workspace chatSessions directory */
	chatSessionsDir: string;
	/** Epoch millisecond timestamp of assessment start; records prior to this are ignored */
	startTimestampMs?: number;
	/** Polling interval in ms (defaults to 1000) */
	pollIntervalMs?: number;
	/** Diagnostic event callback */
	onDiagnostic?: (diagnostic: CopilotReaderDiagnostic, error?: unknown) => void;
	/** Time provider for testing */
	now?: () => number;
}

export type CopilotReaderDiagnostic =
	| 'poll_started'
	| 'poll_completed'
	| 'directory_not_found'
	| 'file_read_error'
	| 'json_parse_error';

export interface CopilotPromptRecord {
	sessionId: string;
	requestId: string;
	text: string;
	timestampMs: number;
	source: 'copilot_prompt';
}

export interface CopilotResponseRecord {
	sessionId: string;
	requestId: string;
	responseId: string;
	text: string;
	timestampMs: number;
	source: 'copilot_response';
}

export interface CopilotReadBatch {
	prompts: CopilotPromptRecord[];
	responses: CopilotResponseRecord[];
	latestTimestampMs: number;
}

interface RawRequest {
	requestId?: string;
	timestamp?: number;
	responseId?: string;
	responseTimestamp?: number;
	message?: unknown;
	response?: unknown;
	modelState?: {
		value?: number;
		completedAt?: number;
	};
}

/**
 * Extracts plain text from a Copilot message object or parts array.
 */
export function extractPromptText(message: unknown): string {
	if (!message) {
		return '';
	}
	if (typeof message === 'string') {
		return message.trim();
	}
	if (typeof message === 'object') {
		const obj = message as Record<string, unknown>;
		if (typeof obj.text === 'string' && obj.text.trim()) {
			return obj.text.trim();
		}
		if (Array.isArray(obj.parts)) {
			const parts: string[] = [];
			for (const part of obj.parts) {
				if (typeof part === 'string') {
					parts.push(part);
				} else if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
					parts.push((part as Record<string, unknown>).text as string);
				}
			}
			return parts.join('\n').trim();
		}
	}
	return '';
}

/**
 * Extracts accumulated text from Copilot response items.
 */
export function extractResponseText(responseItems: unknown): string {
	if (!responseItems) {
		return '';
	}
	if (typeof responseItems === 'string') {
		return responseItems.trim();
	}
	if (!Array.isArray(responseItems)) {
		return '';
	}

	const parts: string[] = [];
	for (const item of responseItems) {
		if (!item || typeof item !== 'object') {
			if (typeof item === 'string') {
				parts.push(item);
			}
			continue;
		}

		const obj = item as Record<string, unknown>;
		if (typeof obj.value === 'string') {
			parts.push(obj.value);
		} else if (obj.value && typeof obj.value === 'object' && typeof (obj.value as Record<string, unknown>).value === 'string') {
			parts.push((obj.value as Record<string, unknown>).value as string);
		} else if (typeof obj.content === 'string') {
			parts.push(obj.content);
		} else if (obj.content && typeof obj.content === 'object' && typeof (obj.content as Record<string, unknown>).value === 'string') {
			parts.push((obj.content as Record<string, unknown>).value as string);
		} else if (typeof obj.text === 'string') {
			parts.push(obj.text);
		}
	}

	return parts.join('\n').trim();
}

/**
 * Reads and polls GitHub Copilot Chat session records from workspaceStorage/<id>/chatSessions/*.jsonl.
 */
export class CopilotChatReader {
	private readonly options: Required<Omit<CopilotReaderOptions, 'onDiagnostic'>> & {
		onDiagnostic?: (diagnostic: CopilotReaderDiagnostic, error?: unknown) => void;
	};

	private readonly seenRequestIds = new Set<string>();
	private readonly seenResponseIds = new Set<string>();
	private readonly fileMtimes = new Map<string, number>();
	private pollTimer?: ReturnType<typeof setInterval>;
	private disposed = false;
	private polling = false;

	constructor(options: CopilotReaderOptions) {
		const nowFn = options.now ?? (() => Date.now());
		this.options = {
			chatSessionsDir: options.chatSessionsDir,
			startTimestampMs: options.startTimestampMs ?? nowFn(),
			pollIntervalMs: Math.max(10, options.pollIntervalMs ?? 1000),
			now: nowFn,
			onDiagnostic: options.onDiagnostic
		};
	}

	/**
	 * Starts interval polling of the chatSessions directory.
	 */
	start(onBatch: (batch: CopilotReadBatch) => void): void {
		if (this.disposed || this.pollTimer) {
			return;
		}

		const interval = this.options.pollIntervalMs;
		this.pollTimer = setInterval(async () => {
			if (this.polling || this.disposed) {
				return;
			}
			this.polling = true;
			try {
				const batch = await this.readOnce();
				if (batch.prompts.length > 0 || batch.responses.length > 0) {
					onBatch(batch);
				}
			} catch (err) {
				this.options.onDiagnostic?.('file_read_error', err);
			} finally {
				this.polling = false;
			}
		}, interval);
	}

	/**
	 * Stops polling.
	 */
	stop(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	/**
	 * Releases resources and stops polling.
	 */
	dispose(): void {
		this.disposed = true;
		this.stop();
		this.fileMtimes.clear();
		this.seenRequestIds.clear();
		this.seenResponseIds.clear();
	}

	/**
	 * Performs a single read pass across all *.jsonl files in chatSessions directory.
	 */
	async readOnce(): Promise<CopilotReadBatch> {
		if (this.disposed) {
			return { prompts: [], responses: [], latestTimestampMs: 0 };
		}

		this.options.onDiagnostic?.('poll_started');
		let files: string[];
		try {
			files = await readdir(this.options.chatSessionsDir);
		} catch (error) {
			this.options.onDiagnostic?.('directory_not_found', error);
			return { prompts: [], responses: [], latestTimestampMs: 0 };
		}

		const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
		const newPrompts: CopilotPromptRecord[] = [];
		const newResponses: CopilotResponseRecord[] = [];
		let latestTimestamp = 0;

		for (const filename of jsonlFiles) {
			const fullPath = join(this.options.chatSessionsDir, filename);

			let fileStat;
			try {
				fileStat = await stat(fullPath);
			} catch {
				continue;
			}

			const prevMtime = this.fileMtimes.get(fullPath);
			if (prevMtime !== undefined && prevMtime === fileStat.mtimeMs) {
				// File hasn't changed since last read
				continue;
			}

			try {
				const fileContent = await readFile(fullPath, 'utf8');
				this.fileMtimes.set(fullPath, fileStat.mtimeMs);

				const { prompts, responses } = this.parseSessionFile(filename, fileContent);
				for (const prompt of prompts) {
					newPrompts.push(prompt);
					if (prompt.timestampMs > latestTimestamp) {
						latestTimestamp = prompt.timestampMs;
					}
				}
				for (const response of responses) {
					newResponses.push(response);
					if (response.timestampMs > latestTimestamp) {
						latestTimestamp = response.timestampMs;
					}
				}
			} catch (error) {
				this.options.onDiagnostic?.('file_read_error', error);
			}
		}

		this.options.onDiagnostic?.('poll_completed');
		return {
			prompts: newPrompts,
			responses: newResponses,
			latestTimestampMs: latestTimestamp
		};
	}

	/**
	 * Parses a session .jsonl file, handling both initial snapshot (kind 0) and patches (kind 1).
	 */
	private parseSessionFile(filename: string, content: string): { prompts: CopilotPromptRecord[]; responses: CopilotResponseRecord[] } {
		const prompts: CopilotPromptRecord[] = [];
		const responses: CopilotResponseRecord[] = [];
		const fileSessionId = filename.replace(/\.jsonl$/, '');

		const lines = content.split('\n');
		let currentSessionId = fileSessionId;
		const requests: RawRequest[] = [];

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}

			try {
				const entry = JSON.parse(trimmed);
				if (entry.kind === 0 && entry.v) {
					if (typeof entry.v.sessionId === 'string' && entry.v.sessionId) {
						currentSessionId = entry.v.sessionId;
					}
					if (Array.isArray(entry.v.requests)) {
						requests.push(...entry.v.requests);
					}
				} else if (entry.kind === 1 && Array.isArray(entry.k)) {
					// Check if a patch updates a request
					if (entry.k[0] === 'requests' && typeof entry.k[1] === 'number') {
						const index = entry.k[1];
						if (requests[index]) {
							if (entry.k[2] === 'response') {
								requests[index].response = entry.v;
							} else if (entry.k[2] === 'modelState') {
								requests[index].modelState = entry.v;
							}
						}
					}
				}
			} catch (parseError) {
				this.options.onDiagnostic?.('json_parse_error', parseError);
			}
		}

		// Process collected requests
		for (const req of requests) {
			const reqId = req.requestId ?? `${currentSessionId}_${req.timestamp ?? Date.now()}`;
			const promptText = extractPromptText(req.message);
			const promptTimestamp = typeof req.timestamp === 'number' ? req.timestamp : this.options.startTimestampMs;

			// Check prospective filter for prompt
			if (promptTimestamp >= this.options.startTimestampMs && promptText && !this.seenRequestIds.has(reqId)) {
				this.seenRequestIds.add(reqId);
				prompts.push({
					sessionId: currentSessionId,
					requestId: reqId,
					text: promptText,
					timestampMs: promptTimestamp,
					source: 'copilot_prompt'
				});
			}

			// Check response
			const responseText = extractResponseText(req.response);
			if (responseText) {
				const respId = req.responseId ?? `${reqId}_response`;
				const respTimestamp = typeof req.modelState?.completedAt === 'number'
					? req.modelState.completedAt
					: typeof req.responseTimestamp === 'number'
						? req.responseTimestamp
						: promptTimestamp;

				if (respTimestamp >= this.options.startTimestampMs && !this.seenResponseIds.has(respId)) {
					this.seenResponseIds.add(respId);
					responses.push({
						sessionId: currentSessionId,
						requestId: reqId,
						responseId: respId,
						text: responseText,
						timestampMs: respTimestamp,
						source: 'copilot_response'
					});
				}
			}
		}

		return { prompts, responses };
	}
}
