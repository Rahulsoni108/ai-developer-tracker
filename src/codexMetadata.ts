import type { FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export interface CodexSessionMetadata {
	sourceSessionId: string;
	cwd: string;
	createdAt: string;
	codexVersion?: string;
}
export type MetadataResult = { kind: 'valid'; metadata: CodexSessionMetadata }
	| { kind: 'missing' | 'invalid' | 'incomplete' | 'oversized' | 'stopped' };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Extract only identity metadata. Unknown payload fields are never retained. */
function extract(payload: unknown, envelopeTimestamp: unknown): MetadataResult {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return { kind: 'invalid' };
	}
	const values = payload as Record<string, unknown>;
	const timestamp = values.timestamp ?? envelopeTimestamp;
	const date = typeof timestamp === 'string'
		? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(timestamp) : null;
	const validDate = date && +date[2] >= 1 && +date[2] <= 12 && +date[3] >= 1
		&& +date[3] <= new Date(Date.UTC(+date[1], +date[2], 0)).getUTCDate()
		&& +date[4] <= 23 && +date[5] <= 59 && +date[6] <= 59;
	if (typeof values.id !== 'string' || !uuid.test(values.id)
		|| typeof values.cwd !== 'string' || !isAbsolute(values.cwd) || /[\u0000-\u001f]/.test(values.cwd)
		|| typeof timestamp !== 'string' || !validDate
		|| !Number.isFinite(Date.parse(timestamp))) {
		return { kind: 'invalid' };
	}
	const version = values.cli_version ?? values.codex_version;
	return { kind: 'valid', metadata: {
		sourceSessionId: values.id.toLowerCase(), cwd: values.cwd,
		createdAt: new Date(timestamp).toISOString(),
		...(typeof version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][a-z0-9.-]{1,64})?$/i.test(version)
			? { codexVersion: version } : {})
	} };
}

/**
 * Read one byte at a time deliberately: buffered readline/streams can prefetch
 * private conversation records beyond the metadata newline. No subsequent line
 * is read, and a non-session_meta type is rejected before reading its payload.
 */
export async function readSessionMetadata(handle: FileHandle, active: () => boolean, maxBytes = 65536): Promise<MetadataResult> {
	const bytes: number[] = [];
	const buffer = Buffer.alloc(1);
	const read = async (): Promise<number | undefined> => {
		if (!active()) { throw new Error('stopped'); }
		if (bytes.length >= maxBytes) { throw new Error('oversized'); }
		const result = await handle.read(buffer, 0, 1, bytes.length);
		if (!result.bytesRead) { return undefined; }
		bytes.push(buffer[0]);
		return buffer[0];
	};
	const next = async (): Promise<number> => {
		let byte = await read();
		while (byte === 32 || byte === 9 || byte === 13) { byte = await read(); }
		if (byte === undefined || byte === 10) { throw new Error('incomplete'); }
		return byte;
	};
	const string = async (): Promise<string> => {
		if (await next() !== 34) { throw new Error('invalid'); }
		const start = bytes.length - 1;
		let escaped = false;
		while (true) {
			const byte = await read();
			if (byte === undefined || byte === 10) { throw new Error('incomplete'); }
			if (byte === 34 && !escaped) { break; }
			if (byte === 92 && !escaped) { escaped = true; } else { escaped = false; }
		}
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes.slice(start)))) as string;
	};
	try {
		if (await next() !== 123) { return { kind: 'invalid' }; }
		const seen = new Set<string>();
		let type: string | undefined;
		let timestamp: string | undefined;
		while (true) {
			const name = await string();
			if (seen.has(name) || await next() !== 58) { return { kind: 'invalid' }; }
			seen.add(name);
			if (name === 'timestamp') {
				timestamp = await string();
			} else if (name === 'type') {
				type = await string();
				if (type !== 'session_meta') { return { kind: 'missing' }; }
			} else if (name === 'payload') {
				if (type !== 'session_meta') { return { kind: 'missing' }; }
				if (await next() !== 123) { return { kind: 'invalid' }; }
				const start = bytes.length - 1;
				let depth = 1;
				let quoted = false;
				let escaped = false;
				while (depth > 0) {
					const byte = await read();
					if (byte === undefined || byte === 10) { return { kind: 'incomplete' }; }
					if (quoted) {
						if (byte === 34 && !escaped) { quoted = false; }
						if (byte === 92 && !escaped) { escaped = true; } else { escaped = false; }
					} else if (byte === 34) { quoted = true;
					} else if (byte === 123) { depth++;
					} else if (byte === 125) { depth--; }
				}
				const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes.slice(start))));
				if (await next() !== 125) { return { kind: 'invalid' }; }
				let end = await read();
				while (end === 32 || end === 9 || end === 13) { end = await read(); }
				if (end !== undefined && end !== 10) { return { kind: 'invalid' }; }
				return active() ? extract(payload, timestamp) : { kind: 'stopped' };
			} else {
				// Do not read arbitrary top-level fields or look further into a conversation.
				return { kind: 'missing' };
			}
			if (await next() !== 44) { return { kind: 'missing' }; }
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : '';
		return { kind: ['stopped', 'oversized', 'incomplete'].includes(message)
			? message as 'stopped' | 'oversized' | 'incomplete' : 'invalid' };
	}
}
