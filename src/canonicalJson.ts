import { createHash } from 'node:crypto';
import { types } from 'node:util';

export class CanonicalJsonError extends Error {
	constructor() { super('Canonical JSON validation failed.'); }
}

/** RFC 8785 / JCS: ECMAScript primitive serialization and raw UTF-16 property sorting.
 * Accept JSON data only; do not invoke getters/toJSON or silently discard unsupported values.
 * Production callers run this on storage/upload workers, with the existing event size bounds.
 */
export function canonicalJson(input: unknown): string {
	let nodes = 0; let bytes = 0;
	const ancestors = new Set<object>();
	const count = (value: string): string => {
		bytes += Buffer.byteLength(value, 'utf8');
		if (bytes > 16 * 1024 * 1024) { throw new CanonicalJsonError(); }
		return value;
	};
	const string = (value: string): string => {
		for (let index = 0; index < value.length; index++) {
			const code = value.charCodeAt(index);
			if (code >= 0xd800 && code <= 0xdbff) {
				const next = value.charCodeAt(++index);
				if (!(next >= 0xdc00 && next <= 0xdfff)) { throw new CanonicalJsonError(); }
			} else if (code >= 0xdc00 && code <= 0xdfff) { throw new CanonicalJsonError(); }
		}
		return count(JSON.stringify(value));
	};
	const encode = (value: unknown, depth: number): string => {
		if (++nodes > 20000 || depth > 32) { throw new CanonicalJsonError(); }
		if (value === null) { return count('null'); }
		if (typeof value === 'string') { return string(value); }
		if (typeof value === 'boolean') { return count(value ? 'true' : 'false'); }
		if (typeof value === 'number') {
			if (!Number.isFinite(value)) { throw new CanonicalJsonError(); }
			// V8 implements the RFC's ECMAScript binary64 number serialization (including -0 -> 0).
			return count(JSON.stringify(value));
		}
		if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) { throw new CanonicalJsonError(); }
		const array = Array.isArray(value);
		const proto = Object.getPrototypeOf(value);
		if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) { throw new CanonicalJsonError(); }
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Reflect.ownKeys(descriptors);
		if (keys.length > 20001 || keys.some(key => typeof key !== 'string')) { throw new CanonicalJsonError(); }
		ancestors.add(value);
		try {
			if (array) {
				if (value.length > 20000 || keys.length !== value.length + 1) { throw new CanonicalJsonError(); }
				const items: string[] = [];
				for (let index = 0; index < value.length; index++) {
					const descriptor = descriptors[String(index)];
					if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) { throw new CanonicalJsonError(); }
					items.push(encode(descriptor.value, depth + 1));
				}
				count('[]' + ','.repeat(Math.max(0, items.length - 1)));
				return '[' + items.join(',') + ']';
			}
			const items: string[] = [];
			// Serialize members directly: constructing a sorted object would re-sort numeric property names.
			for (const key of (keys as string[]).sort()) {
				const descriptor = descriptors[key];
				if (!('value' in descriptor) || !descriptor.enumerable) { throw new CanonicalJsonError(); }
				items.push(string(key) + ':' + encode(descriptor.value, depth + 1));
			}
			count('{}' + ':'.repeat(items.length) + ','.repeat(Math.max(0, items.length - 1)));
			return '{' + items.join(',') + '}';
		} finally { ancestors.delete(value); }
	};
	try { return encode(input, 0); } catch { throw new CanonicalJsonError(); }
}
export function canonicalSha256(input: unknown): string {
	return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}
