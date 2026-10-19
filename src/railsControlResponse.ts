import { AssessmentApiError } from './assessmentApiClient';

/** Bounded control JSON, including escaped duplicate member names, without diagnostics of input. */
export function parseRailsControlResponse(body: string): unknown {
	try {
		if (Buffer.byteLength(body) > 32768) { throw new Error(); }
		const frames: { object: boolean; key: boolean; names: Set<string> }[] = [];
		const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
		let end = 0;
		for (const match of body.matchAll(tokens)) {
			if (body.slice(end, match.index).trim()) { throw new Error(); } end = match.index + match[0].length;
			const token = match[0]; const frame = frames.at(-1);
			if (token === '{' || token === '[') {
				if (frames.length >= 16) { throw new Error(); } frames.push({ object: token === '{', key: token === '{', names: new Set() });
			} else if (token === '}' || token === ']') { frames.pop(); }
			else if (token === ',' && frame?.object) { frame.key = true; }
			else if (token.startsWith('"') && frame?.object && frame.key) {
				const name = JSON.parse(token) as string; if (frame.names.has(name)) { throw new Error(); }
				frame.names.add(name); frame.key = false;
			}
		}
		if (body.slice(end).trim() || frames.length) { throw new Error(); }
		return JSON.parse(body);
	} catch { throw new AssessmentApiError('protocol'); }
}
export function exactObject(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key))
		&& Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
