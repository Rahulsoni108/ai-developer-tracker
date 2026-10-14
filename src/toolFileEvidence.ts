import { createHash } from 'node:crypto';
import { parsePatch } from 'diff';
import type { CodexFileEvidence } from './eventSchema';

export const contentHash = (text: string) => createHash('sha256').update(text).digest('hex');
const operations: Record<string, CodexFileEvidence['operation']> = {
	write_file: 'edit', edit_file: 'edit', create_file: 'create', delete_file: 'delete', read_file: 'read'
};
function data(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) { return undefined; }
	const result: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value')) { return undefined; }
		result[key] = descriptor.value;
	}
	return result;
}

/** No file access. Ignore labels/context; hash exact, ordered edit blocks with line positions. */
export function patchChangeHash(patch: string): string | undefined {
	try {
		const patches = parsePatch(patch);
		if (patches.length !== 1 || !patches[0].hunks.length) { return undefined; }
		const blocks: { oldLine: number; newLine: number; removed: string[]; added: string[]; noNewline: string[] }[] = [];
		for (const hunk of patches[0].hunks) {
			let oldLine = hunk.oldStart; let newLine = hunk.newStart;
			let block: typeof blocks[number] | undefined;
			for (const line of hunk.lines) {
				if (line.startsWith(' ')) { block = undefined; oldLine++; newLine++; continue; }
				if (line.startsWith('\\')) { if (block) { block.noNewline.push(line); } continue; }
				if (!['+', '-'].includes(line[0])) { return undefined; }
				if (!block) { block = { oldLine, newLine, removed: [], added: [], noNewline: [] }; blocks.push(block); }
				if (line.startsWith('-')) { block.removed.push(line.slice(1)); oldLine++;
				} else { block.added.push(line.slice(1)); newLine++; }
			}
			if (oldLine !== hunk.oldStart + hunk.oldLines || newLine !== hunk.newStart + hunk.newLines) { return undefined; }
		}
		return blocks.length ? contentHash(JSON.stringify(blocks)) : undefined;
	} catch { return undefined; }
}

/** Conservative relative paths for callers without a workspace-aware resolver. */
export function relativeToolPath(raw: string, cwd = '.'): string | undefined {
	if (!raw || raw.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(raw) || raw.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) { return undefined; }
	const parts = raw.split('/');
	if (parts.some(part => part === '..' || part === '')) { return undefined; }
	const normalized = [...(cwd === '.' ? [] : cwd.split('/')), ...parts.filter(part => part !== '.')].join('/');
	return normalized && !normalized.split('/').some(part => part === '..' || part === '') ? normalized : undefined;
}

export function extractToolFileEvidence(
	payload: Record<string, unknown>,
	resolvePath: (raw: string) => string | undefined,
	excluded: (path: string) => boolean,
	applied: boolean
): CodexFileEvidence[] {
	const result: CodexFileEvidence[] = [];
	const add = (raw: string, evidence: Omit<CodexFileEvidence, 'relativePath'>) => {
		if (result.length >= 64) { return; }
		const path = resolvePath(raw);
		if (path && path.length <= 4096 && !excluded(path) && relativeToolPath(path) === path) {
			if (!result.some(item => item.relativePath === path && item.operation === evidence.operation)) {
				result.push({ relativePath: path, ...evidence });
			}
		}
	};
	if (['patch_apply_begin', 'patch_apply_end'].includes(payload.type as string)) {
		const changes = data(payload.changes);
		if (!changes) { return []; }
		for (const [path, value] of Object.entries(changes).slice(0, 64)) {
			const change = data(value);
			if (!change) { continue; }
			const kind = applied ? 'applied' as const : 'declared' as const;
			if (change.type === 'add' && typeof change.content === 'string') {
				add(path, { operation: 'create', kind, origin: 'patch_apply',
					beforeHash: contentHash(''), afterHash: contentHash(change.content) });
			} else if (change.type === 'delete' && typeof change.content === 'string') {
				add(path, { operation: 'delete', kind, origin: 'patch_apply',
					beforeHash: contentHash(change.content), afterHash: contentHash('') });
			} else if (change.type === 'update' && typeof change.unified_diff === 'string') {
				const changeHash = patchChangeHash(change.unified_diff);
				add(path, { operation: 'edit', kind, origin: 'patch_apply', ...(changeHash ? { changeHash } : {}) });
				if (typeof change.move_path === 'string') { add(change.move_path, { operation: 'unknown', kind, origin: 'patch_apply' }); }
			}
		}
		return result;
	}
	const operation = Object.hasOwn(operations, payload.name as string) ? operations[payload.name as string] : undefined;
	if (!operation || typeof payload.arguments !== 'string') { return []; }
	try {
		const argumentsData = data(JSON.parse(payload.arguments));
		if (!argumentsData) { return []; }
		for (const key of ['path', 'file_path', 'filename']) {
			if (typeof argumentsData[key] === 'string') { add(argumentsData[key], { operation, kind: 'declared', origin: 'structured_arguments' }); }
		}
		// Commands, shell arguments and prose are never interpreted as file effects.
		return result;
	} catch { return []; }
}
