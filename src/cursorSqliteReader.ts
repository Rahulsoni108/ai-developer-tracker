import { DatabaseSync } from 'node:sqlite';
import { stat } from 'node:fs/promises';

export interface CursorReaderOptions {
	/** Absolute path to workspace state.vscdb */
	stateDbPath: string;
	/** Epoch millisecond timestamp of assessment start; records prior to this are ignored */
	startTimestampMs?: number;
	/** Optional path to globalStorage/state.vscdb for enriched bubble responses */
	globalStorageDbPath?: string;
	/** Polling interval in ms (defaults to 1000) */
	pollIntervalMs?: number;
	/** Diagnostic event callback */
	onDiagnostic?: (diagnostic: CursorReaderDiagnostic, error?: unknown) => void;
	/** Time provider for testing */
	now?: () => number;
}

export type CursorReaderDiagnostic =
	| 'poll_started'
	| 'poll_completed'
	| 'db_not_found'
	| 'db_busy'
	| 'db_error'
	| 'json_parse_error';

export interface CursorPromptRecord {
	index: number;
	text: string;
	commandType?: number;
	timestampMs: number;
	source: 'cursor_prompt';
}

export interface CursorGenerationRecord {
	generationUUID: string;
	unixMs: number;
	type: string;
	textDescription: string;
	responseSnippet?: string;
	source: 'cursor_generation';
}

export interface CursorReadBatch {
	prompts: CursorPromptRecord[];
	generations: CursorGenerationRecord[];
	latestTimestampMs: number;
}

interface RawGeneration {
	unixMs?: number;
	generationUUID?: string;
	type?: string;
	textDescription?: string;
}

interface RawPrompt {
	text?: string;
	commandType?: number;
}

/**
 * Reads Cursor IDE prompts and generations from the workspace's local SQLite database.
 * Operates in read-only mode to prevent interference with Cursor's own processes.
 */
export class CursorSqliteReader {
	private readonly options: Required<Omit<CursorReaderOptions, 'globalStorageDbPath' | 'onDiagnostic'>> & {
		globalStorageDbPath?: string;
		onDiagnostic?: (diagnostic: CursorReaderDiagnostic, error?: unknown) => void;
	};

	private readonly seenGenerationUUIDs = new Set<string>();
	private lastPromptCount = 0;
	private initialized = false;
	private pollTimer?: ReturnType<typeof setInterval>;
	private disposed = false;
	private polling = false;

	constructor(options: CursorReaderOptions) {
		const nowFn = options.now ?? (() => Date.now());
		this.options = {
			stateDbPath: options.stateDbPath,
			startTimestampMs: options.startTimestampMs ?? nowFn(),
			pollIntervalMs: Math.max(10, options.pollIntervalMs ?? 1000),
			globalStorageDbPath: options.globalStorageDbPath,
			onDiagnostic: options.onDiagnostic,
			now: nowFn
		};
	}

	/**
	 * Perform a single read from state.vscdb and return newly discovered prompts and generations.
	 */
	async readOnce(): Promise<CursorReadBatch> {
		if (this.disposed) {
			return { prompts: [], generations: [], latestTimestampMs: this.options.startTimestampMs };
		}

		this.options.onDiagnostic?.('poll_started');

		// Ensure file exists before attempting to open
		try {
			const s = await stat(this.options.stateDbPath);
			if (!s.isFile()) {
				this.options.onDiagnostic?.('db_not_found');
				return { prompts: [], generations: [], latestTimestampMs: this.options.startTimestampMs };
			}
		} catch (err) {
			this.options.onDiagnostic?.('db_not_found', err);
			return { prompts: [], generations: [], latestTimestampMs: this.options.startTimestampMs };
		}

		let db: DatabaseSync | undefined;
		try {
			db = new DatabaseSync(this.options.stateDbPath, { readOnly: true });

			const rawPromptsJson = this.queryItemTableValue(db, 'aiService.prompts');
			const rawGenerationsJson = this.queryItemTableValue(db, 'aiService.generations');

			const newPrompts: CursorPromptRecord[] = [];
			const newGenerations: CursorGenerationRecord[] = [];
			let latestTimestamp = this.options.startTimestampMs;

			// 1. Process aiService.generations
			if (rawGenerationsJson) {
				try {
					const parsedGens = JSON.parse(rawGenerationsJson) as RawGeneration[];
					if (Array.isArray(parsedGens)) {
						for (const gen of parsedGens) {
							if (!gen || typeof gen.generationUUID !== 'string' || typeof gen.unixMs !== 'number') {
								continue;
							}
							if (gen.unixMs < this.options.startTimestampMs) {
								continue; // Skip historical records created prior to assessment start
							}
							if (this.seenGenerationUUIDs.has(gen.generationUUID)) {
								continue; // Skip already processed generations
							}

							this.seenGenerationUUIDs.add(gen.generationUUID);
							if (gen.unixMs > latestTimestamp) {
								latestTimestamp = gen.unixMs;
							}

							newGenerations.push({
								generationUUID: gen.generationUUID,
								unixMs: gen.unixMs,
								type: gen.type ?? 'composer',
								textDescription: typeof gen.textDescription === 'string' ? gen.textDescription : '',
								source: 'cursor_generation'
							});
						}
					}
				} catch (parseErr) {
					this.options.onDiagnostic?.('json_parse_error', parseErr);
				}
			}

			// 2. Process aiService.prompts
			if (rawPromptsJson) {
				try {
					const parsedPrompts = JSON.parse(rawPromptsJson) as RawPrompt[];
					if (Array.isArray(parsedPrompts)) {
						if (!this.initialized) {
							// On first run, mark existing prompts as baseline so historical prompts are not re-emitted
							this.lastPromptCount = parsedPrompts.length;
							this.initialized = true;
						} else if (parsedPrompts.length > this.lastPromptCount) {
							// Extract new prompts added since last read
							for (let i = this.lastPromptCount; i < parsedPrompts.length; i++) {
								const p = parsedPrompts[i];
								if (p && typeof p.text === 'string') {
									const now = this.options.now();
									newPrompts.push({
										index: i,
										text: p.text,
										commandType: p.commandType,
										timestampMs: now,
										source: 'cursor_prompt'
									});
									if (now > latestTimestamp) {
										latestTimestamp = now;
									}
								}
							}
							this.lastPromptCount = parsedPrompts.length;
						}
					}
				} catch (parseErr) {
					this.options.onDiagnostic?.('json_parse_error', parseErr);
				}
			} else if (!this.initialized) {
				this.initialized = true;
			}

			this.options.onDiagnostic?.('poll_completed');

			return {
				prompts: newPrompts,
				generations: newGenerations,
				latestTimestampMs: latestTimestamp
			};
		} catch (err: unknown) {
			const msg = String(err);
			if (msg.includes('busy') || msg.includes('locked')) {
				this.options.onDiagnostic?.('db_busy', err);
			} else {
				this.options.onDiagnostic?.('db_error', err);
			}
			return { prompts: [], generations: [], latestTimestampMs: this.options.startTimestampMs };
		} finally {
			if (db) {
				try {
					db.close();
				} catch {
					// ignore closing error
				}
			}
		}
	}

	private queryItemTableValue(db: DatabaseSync, key: string): string | undefined {
		try {
			const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1');
			const row = stmt.get(key) as { value?: string } | undefined;
			return row?.value;
		} catch {
			return undefined;
		}
	}

	/**
	 * Starts interval polling. Safe against concurrent poll overlapping.
	 */
	startPolling(callback: (batch: CursorReadBatch) => void | Promise<void>): void {
		if (this.disposed || this.pollTimer) {
			return;
		}

		this.pollTimer = setInterval(async () => {
			if (this.polling || this.disposed) {
				return;
			}
			this.polling = true;
			try {
				const batch = await this.readOnce();
				if (batch.prompts.length > 0 || batch.generations.length > 0) {
					await callback(batch);
				}
			} catch (err) {
				this.options.onDiagnostic?.('db_error', err);
			} finally {
				this.polling = false;
			}
		}, this.options.pollIntervalMs);
	}

	/**
	 * Stop active polling interval.
	 */
	stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	/**
	 * Dispose the reader.
	 */
	dispose(): void {
		this.disposed = true;
		this.stopPolling();
	}

	isDisposed(): boolean {
		return this.disposed;
	}
}
