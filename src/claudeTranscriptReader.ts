import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, resolve, relative, isAbsolute } from 'node:path';
const withinClaudeRoot = (root: string, path: string) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part); };

export interface ClaudeTranscriptMessage { text: string; byteOffset: number; byteLength: number; recordIndex: number }

/** Fallback only for a confirmed hook-provided transcript, never a directory scan or historical import. */
export class ClaudeTranscriptReader {
	private path?: string;
	private canonicalRoot?: string;
	private offset = 0;
	private identity?: string;
	private tail = Buffer.alloc(0);
	private recordIndex = 0;
	constructor(private readonly root: string, private readonly sourceSessionId: string) {}
	async baseline(path: unknown): Promise<void> {
		if (typeof path !== 'string' || !withinClaudeRoot(resolve(this.root), resolve(path)) || basename(path) !== this.sourceSessionId + '.jsonl') { return; }
		try {
			this.canonicalRoot = await realpath(this.root);
			this.path = resolve(this.canonicalRoot, relative(resolve(this.root), resolve(path)));
			const handle = await this.safeOpen();
			try { const info = await handle.stat(); this.offset = info.size; this.identity = `${info.dev}:${info.ino}`; } finally { await handle.close(); }
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.path = undefined; }
			// Missing transcript at SessionStart is normal for a new, explicitly approved UUID.
		}
	}
	private async safeOpen() {
		if (!this.path || await realpath(this.root) !== this.canonicalRoot || await realpath(this.path) !== this.path) { throw new Error('Transcript unavailable.'); }
		const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 * 1024) { await handle.close(); throw new Error('Transcript unavailable.'); }
		return handle;
	}
	async read(canRead: () => boolean): Promise<ClaudeTranscriptMessage[]> {
		if (!this.path || !canRead()) { return []; }
		const handle = await this.safeOpen();
		try {
			const info = await handle.stat(); const identity = `${info.dev}:${info.ino}`;
			if (info.size < this.offset || this.identity && identity !== this.identity) {
				// Replacement/truncation never replays history; wait for future appended records.
				this.offset = info.size; this.tail = Buffer.alloc(0); this.identity = identity; return [];
			}
			this.identity = identity;
			if (info.size - this.offset > 1024 * 1024) { this.offset = info.size; this.tail = Buffer.alloc(0); throw new Error('Transcript capture limit.'); }
			const chunk = Buffer.alloc(info.size - this.offset);
			if (!canRead()) { return []; }
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, this.offset); this.offset += bytesRead;
			if (!canRead()) { return []; }
			const data = Buffer.concat([this.tail, chunk.subarray(0, bytesRead)]); const end = data.lastIndexOf(10);
			if (end < 0) { if (data.length > 262144) { this.tail = Buffer.alloc(0); throw new Error('Transcript line limit.'); } this.tail = data; return []; }
			this.tail = Buffer.from(data.subarray(end + 1)); if (this.tail.length > 262144) { this.tail = Buffer.alloc(0); }
			const messages: ClaudeTranscriptMessage[] = [];
			let byteOffset = this.offset - data.length;
			for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
				const start = byteOffset; const byteLength = Buffer.byteLength(line) + 1; byteOffset += byteLength; this.recordIndex++;
				if (Buffer.byteLength(line) > 262144) { continue; }
				try {
					const record = JSON.parse(line);
					if (record.sessionId !== this.sourceSessionId || record.type !== 'assistant' || record.isSidechain || record.agentId
						|| record.message?.role !== 'assistant' || !Array.isArray(record.message.content)) { continue; }
					const text = record.message.content.filter((part: { type?: unknown; text?: unknown }) => part?.type === 'text' && typeof part.text === 'string')
						.map((part: { text: string }) => part.text).join('\n');
					if (text.trim() && Buffer.byteLength(text) <= 262144) { messages.push({ text, byteOffset: start, byteLength, recordIndex: this.recordIndex }); }
				} catch { /* Ignore malformed lines without logging their content. */ }
			} return messages;
		} finally { await handle.close(); }
	}
}
