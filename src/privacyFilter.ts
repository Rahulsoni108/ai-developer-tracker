import { types } from 'node:util';
import { formatPatch, parsePatch } from 'diff';
import { validateEvent, type TrackerEvent } from './eventSchema';

export const REDACTED_VALUE = '[REDACTED]';
export const PRIVACY_EVENT_TYPES = [
	'file.created', 'file.modified', 'file.saved', 'file.deleted', 'file.diff', 'file.baseline', 'file.gap',
	'ai.session.started', 'ai.session.ended', 'ai.prompt.submitted', 'ai.response.completed', 'ai.tool.started', 'ai.tool.completed', 'ai.tool.failed', 'ai.tool.incomplete',
	'activity.relationship.created', 'activity.relationship.updated'
] as const satisfies readonly TrackerEvent['eventType'][];
export const PRIVACY_REASON_CODES = ['secret_redacted', 'private_key_redacted', 'sensitive_file_path', 'unverified_path',
	'unsupported_event_type', 'unsupported_source', 'malformed_event', 'malformed_content', 'unsupported_structure',
	'recording_inactive', 'session_not_approved', 'workspace_not_approved', 'source_session_not_confirmed',
	'content_consent_missing', 'sensitive_identifier', 'incomplete_private_key', 'processing_limit',
	'multipart_metadata_removed', 'diff_reconstruction_changed', 'boundary_check_failed', 'filter_failed'] as const;
export type PrivacyReasonCode = typeof PRIVACY_REASON_CODES[number];

/** Trusted admission snapshot supplied by existing recording/approval components, never by the event. */
export interface PrivacyContext {
	recordingActive: boolean;
	sessionId: string;
	approvedWorkspaceIds: readonly string[];
	confirmedCodexSessions: readonly { sourceSessionId: string; workspaceId: string }[];
	codexContentConsent: boolean;
	confirmedClaudeSessions?: readonly { sourceSessionId: string; workspaceId: string }[];
	claudeContentConsent?: boolean;
	/** Optional snapshot-based guard, for example eligible files indexed by FileTracker. */
	isApprovedRelativePath?: (relativePath: string, workspaceId: string) => boolean;
	/** Required to verify absolute structured tool paths; must not execute tool input. */
	resolveToolPath?: (path: string, workspaceId: string) => string | undefined;
}
export const DEFAULT_PRIVACY_LIMITS = Object.freeze({
	maxInputBytes: 4 * 1024 * 1024, maxOutputBytes: 4 * 1024 * 1024,
	maxStringBytes: 2 * 1024 * 1024, maxProcessingBytes: 8 * 1024 * 1024,
	maxDepth: 32, maxNodes: 10000, maxJsonParses: 100, maxDiffLines: 10000
});
export type PrivacyLimits = { [K in keyof typeof DEFAULT_PRIVACY_LIMITS]: number };
export type PrivacyResult = {
	status: 'accepted' | 'redacted'; event: TrackerEvent; reasonCodes: PrivacyReasonCode[];
	/** Original content hashes cannot validate reconstruction from a sanitized patch. */
	requiresReconstructionGap: boolean;
} | { status: 'rejected'; reasonCodes: PrivacyReasonCode[] };
export type ContentPrivacyResult = { status: 'accepted' | 'redacted'; value: unknown; reasonCodes: PrivacyReasonCode[] }
	| { status: 'rejected'; reasonCodes: PrivacyReasonCode[] };

class Rejection extends Error {
	constructor(readonly reason: PrivacyReasonCode) { super(reason); }
}
interface Budget { nodes: number; bytes: number; processingBytes: number; jsonParses: number }
const budget = (): Budget => ({ nodes: 0, bytes: 0, processingBytes: 0, jsonParses: 0 });

// Deliberately independent of FileTracker: importing it would require VS Code and alter collectors in Task 3.2.1.
const excludedDirectories = new Set(['.git', '.hg', '.svn', 'node_modules', 'bower_components', 'jspm_packages', 'vendor',
	'.venv', 'venv', 'env', '__pycache__', '.tox', '.bundle', 'pods', '.gradle', '.m2', '.yarn', '.npm', '.pnpm-store',
	'.cache', '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', 'dist', 'build', 'out', 'target', 'bin', 'obj',
	'coverage', 'generated', '.vscode-test', '.idea', '.vs', '.aws', '.ssh', '.azure', '.gcloud', '.kube', '.terraform',
	'.serverless', '.vercel', '.docker', '.gnupg', 'logs']);
const excludedFiles = new Set(['.ds_store', 'thumbs.db', '.npmrc', '.netrc', '.pypirc', '.envrc', 'package-lock.json',
	'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'composer.lock', 'poetry.lock', 'pipfile.lock', 'cargo.lock',
	'gemfile.lock', '.pnp.cjs', '.pnp.loader.mjs', 'file-activity.jsonl', '.git-credentials', '.htpasswd', 'passwd', 'shadow']);
const secretKeys = new Set(['password', 'passwd', 'pwd', 'passphrase', 'apikey', 'token', 'accesstoken', 'refreshtoken',
	'idtoken', 'bearertoken', 'sessiontoken', 'clientsecret', 'secret', 'secretkey', 'signingkey', 'accesskey',
	'secretaccesskey', 'privatekey', 'credentials', 'authorization', 'proxyauthorization', 'cookie', 'setcookie']);
const pathKeys = new Set(['path', 'filepath', 'filename', 'file', 'relativepath', 'targetpath', 'cwd',
	'paths', 'filepaths', 'filenames', 'files', 'relativepaths', 'targetpaths']);
const protectedKeys = new Set(['callId', 'startedEventId', 'messageId', 'relationshipId', 'sourceEventId', 'targetEventId',
	'previousRelationshipEventId', 'eventId', 'sourceSessionId', 'correlationId', 'sessionId', 'sourceFileReference', 'beforeHash', 'afterHash', 'changeHash', 'toolName']);
const normalizedKey = (key: string) => key.toLowerCase().replace(/[_.\s-]/g, '');
const isSecretKey = (key: string) => secretKeys.has(normalizedKey(key))
	|| /(?:password|passwd|apikey|clientsecret|secretaccesskey|privatekey|token)$/.test(normalizedKey(key));

function canonicalPath(path: string): string {
	let decoded = path.normalize('NFKC');
	for (let index = 0; index < 3 && /%[0-9a-f]{2}/i.test(decoded); index++) {
		try { decoded = decodeURIComponent(decoded); } catch { throw new Rejection('unverified_path'); }
	}
	if (/%[0-9a-f]{2}/i.test(decoded) || /[\u0000-\u001f\u007f]/.test(decoded)) { throw new Rejection('unverified_path'); }
	return decoded.replace(/\\/g, '/');
}

/** A path exclusion policy, not filesystem authorization; does not read files or follow links. */
export function isSensitivePath(path: string): boolean {
	try {
		return canonicalPath(path).toLowerCase().split('/').some(segment => excludedDirectories.has(segment)
			|| excludedFiles.has(segment) || /(^|\.)env($|\.)/.test(segment)
			|| /^(?:credentials?|secrets?|id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:[._-].*)?$/.test(segment)
			|| /^events\.v\d+\.jsonl$/.test(segment)
			|| /\.(?:pem|key|p12|pfx|crt|cer|jks|keystore|kdbx|db|sqlite3?)(?:-(?:wal|shm|journal))?$/.test(segment)
			|| /\.(?:log|tmp|temp|bak|swp|swo|lock|map|tsbuildinfo|pyc|class|o|so|dll|exe|wasm|zip|gz|tar|vsix)$/.test(segment)
			|| /\.min\.(?:js|css)$/.test(segment) || segment.endsWith('~'));
	} catch { return true; }
}

const placeholder = (value: string) => !value || value.replace(/\[REDACTED\]/g, '').replace(/[\r\n]/g, '') === ''
	|| /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
	|| /^<(?:YOUR_|INSERT_|REPLACE_)[A-Z0-9_ -]+>$/.test(value)
	|| /^(?:process\.env\.[A-Za-z_]\w*|os\.environ\[['"][A-Za-z_]\w*['"]\])$/.test(value);
const preserveLines = (value: string) => value.replace(/[^\r\n]+/g, REDACTED_VALUE);

export class PrivacyFilter {
	private readonly limits: PrivacyLimits;
	constructor(options: Partial<PrivacyLimits> = {}) {
		this.limits = { ...DEFAULT_PRIVACY_LIMITS, ...options };
		const hardLimits: PrivacyLimits = { maxInputBytes: 16 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024,
			maxStringBytes: 2 * 1024 * 1024, maxProcessingBytes: 32 * 1024 * 1024, maxDepth: 64,
			maxNodes: 100000, maxJsonParses: 1000, maxDiffLines: 100000 };
		for (const name of Object.keys(hardLimits) as (keyof PrivacyLimits)[]) {
			if (!Number.isSafeInteger(this.limits[name]) || this.limits[name] < 1 || this.limits[name] > hardLimits[name]) {
				throw new Error('Invalid privacy processing limits.');
			}
		}
	}

	filter(event: unknown, context: PrivacyContext): PrivacyResult {
		try {
			const work = budget();
			const snapshot = this.clone(event, work, 0, new Set(), true) as Record<string, unknown>;
			if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || typeof snapshot.eventType !== 'string') { throw new Rejection('malformed_event'); }
			if (!(PRIVACY_EVENT_TYPES as readonly unknown[]).includes(snapshot.eventType)) {
				throw new Rejection('unsupported_event_type');
			}
			const payload = snapshot.payload as Record<string, unknown> | undefined;
			if (typeof payload?.diff === 'string') { this.checkDiffLines(payload.diff); }
			const validation = validateEvent(snapshot);
			if (!validation.valid) { throw new Rejection('malformed_event'); }
			const input = validation.event;
			if (input.source !== 'vscode' && input.source !== 'codex' && input.source !== 'claude' || input.eventType.startsWith('file.') && input.source !== 'vscode') { throw new Rejection('unsupported_source'); }
			this.checkBoundaries(input, context);
			const reasons = new Set<PrivacyReasonCode>();
			for (const [key, value] of Object.entries(snapshot)) {
				if (key !== 'payload' && typeof value === 'string' && this.text(value, work, new Set(), 0) !== value) {
					throw new Rejection('sensitive_identifier');
				}
			}
			let requiresReconstructionGap = false;
			const filtered = this.walk(input.payload, work, reasons, 0, context, input.workspaceId!, true) as TrackerEvent['payload'];
			if ('diff' in input.payload && 'diff' in filtered && filtered.diff !== input.payload.diff) {
				requiresReconstructionGap = true; reasons.add('diff_reconstruction_changed');
			}
			if ('text' in input.payload && 'text' in filtered && filtered.text !== input.payload.text && 'partLengths' in filtered) {
				delete filtered.partLengths; reasons.add('multipart_metadata_removed');
			}
			const result = { ...snapshot, payload: filtered };
			this.checkOutput(result);
			if (!validateEvent(result).valid) { throw new Rejection('malformed_event'); }
			return { status: reasons.size ? 'redacted' : 'accepted', event: result as unknown as TrackerEvent,
				reasonCodes: [...reasons], requiresReconstructionGap };
		} catch (error) { return this.rejected(error); }
	}

	/** Reusable content filtering only; this helper does not authorize collection or persistence. */
	filterContent(value: unknown): ContentPrivacyResult {
		try {
			const work = budget(); const reasons = new Set<PrivacyReasonCode>();
			const snapshot = this.clone(value, work, 0, new Set(), false);
			const filtered = this.walk(snapshot, work, reasons, 0);
			this.checkOutput(filtered);
			return { status: reasons.size ? 'redacted' : 'accepted', value: filtered, reasonCodes: [...reasons] };
		} catch (error) { return this.rejected(error); }
	}

	private rejected(error: unknown): { status: 'rejected'; reasonCodes: PrivacyReasonCode[] } {
		return { status: 'rejected', reasonCodes: [error instanceof Rejection ? error.reason : 'malformed_content'] };
	}

	private checkBoundaries(event: TrackerEvent, context: PrivacyContext): void {
		if (!context.recordingActive) { throw new Rejection('recording_inactive'); }
		if (event.sessionId !== context.sessionId) { throw new Rejection('session_not_approved'); }
		if (!context.approvedWorkspaceIds.includes(event.workspaceId!)) { throw new Rejection('workspace_not_approved'); }
		const relationshipPayload = 'evidence' in event.payload ? event.payload : undefined;
		const relationshipReference = relationshipPayload?.evidence.find(entry => entry.eventId === relationshipPayload.sourceEventId && entry.sourceRecord)?.sourceRecord?.sourceFileReference;
		const claude = event.source === 'claude' || relationshipReference?.startsWith('claude-file:');
		const confirmed = claude ? context.confirmedClaudeSessions ?? [] : context.confirmedCodexSessions;
		if (event.sourceSessionId && !confirmed.some(session => session.sourceSessionId === event.sourceSessionId
			&& session.workspaceId === event.workspaceId)) { throw new Rejection('source_session_not_confirmed'); }
		if ((event.source === 'claude' || event.source === 'codex' || event.eventType.startsWith('activity.'))
			&& !(claude ? context.claudeContentConsent : context.codexContentConsent)) { throw new Rejection('content_consent_missing'); }
	}

	private clone(value: unknown, work: Budget, depth: number, ancestors: Set<object>, allowUndefined: boolean): unknown {
		if (++work.nodes > this.limits.maxNodes || depth > this.limits.maxDepth) { throw new Rejection('processing_limit'); }
		if (typeof value === 'string') {
			const bytes = Buffer.byteLength(value);
			work.bytes += bytes;
			if (bytes > this.limits.maxStringBytes || work.bytes > this.limits.maxInputBytes) { throw new Rejection('processing_limit'); }
			return value;
		}
		if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) { return value; }
		if (value === undefined && allowUndefined) { return value; }
		if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) { throw new Rejection('unsupported_structure'); }
		const prototype = Object.getPrototypeOf(value);
		if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype) { throw new Rejection('unsupported_structure'); }
		ancestors.add(value);
		const keys = Reflect.ownKeys(value);
		if (keys.length > this.limits.maxNodes) { throw new Rejection('processing_limit'); }
		const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null);
		if (Array.isArray(value) && value.length + 1 !== keys.length) { throw new Rejection('unsupported_structure'); }
		for (const key of keys) {
			if (Array.isArray(value) && key === 'length') { continue; }
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
				|| ['__proto__', 'prototype', 'constructor'].includes(key)) { throw new Rejection('unsupported_structure'); }
			if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) { throw new Rejection('unsupported_structure'); }
			work.bytes += Buffer.byteLength(key);
			if (Buffer.byteLength(key) > this.limits.maxStringBytes || work.bytes > this.limits.maxInputBytes) { throw new Rejection('processing_limit'); }
			(result as Record<string, unknown>)[key] = this.clone(descriptor.value, work, depth + 1, ancestors, allowUndefined && !Array.isArray(value));
		}
		ancestors.delete(value);
		return result;
	}

	private walk(value: unknown, work: Budget, reasons: Set<PrivacyReasonCode>, depth: number,
		context?: PrivacyContext, workspaceId?: string, eventPayload = false, forced = false): unknown {
		if (++work.nodes > this.limits.maxNodes || depth > this.limits.maxDepth) { throw new Rejection('processing_limit'); }
		if (typeof value === 'string') {
			if (forced && !placeholder(value)) { reasons.add('secret_redacted'); return preserveLines(value); }
			return this.text(value, work, reasons, depth, context, workspaceId);
		}
		if (typeof value === 'number' && forced) { reasons.add('secret_redacted'); return REDACTED_VALUE; }
		if (value === null || typeof value !== 'object') { return value; }
		if (Array.isArray(value)) { return value.map(item => this.walk(item, work, reasons, depth + 1, context, workspaceId, eventPayload, forced)); }
		const result: Record<string, unknown> = Object.create(null);
		for (const [key, item] of Object.entries(value)) {
			if (this.text(key, work, new Set(), depth) !== key) { throw new Rejection('sensitive_identifier'); }
			if (typeof item === 'string' && pathKeys.has(normalizedKey(key))) {
				this.checkPath(item, work, context, workspaceId); result[key] = item;
			} else if (Array.isArray(item) && pathKeys.has(normalizedKey(key)) && item.every(path => typeof path === 'string')) {
				for (const path of item) { this.checkPath(path, work, context, workspaceId); }
				result[key] = [...item];
			} else if (eventPayload && key === 'diff' && typeof item === 'string') {
				result[key] = this.diff(item, work, reasons, depth, context, workspaceId);
			} else if (eventPayload && protectedKeys.has(key)) {
				if (typeof item === 'string' && this.text(item, work, new Set(), depth) !== item) { throw new Rejection('sensitive_identifier'); }
				result[key] = item;
			} else {
				result[key] = this.walk(item, work, reasons, depth + 1, context, workspaceId,
					eventPayload && ['sourceRecord', 'fileEvidence', 'evidence'].includes(key), forced || isSecretKey(key));
			}
		}
		return result;
	}

	private checkPath(path: string, work: Budget, context?: PrivacyContext, workspaceId?: string): void {
		if (isSensitivePath(path)) { throw new Rejection('sensitive_file_path'); }
		const normalized = canonicalPath(path);
		let relative = normalized;
		if (/^(?:\/|[A-Za-z]:|[a-z][a-z0-9+.-]*:)/i.test(normalized)) {
			if (!context || !workspaceId || !context.resolveToolPath) { throw new Rejection('unverified_path'); }
			try { relative = canonicalPath(context.resolveToolPath(path, workspaceId) ?? ''); } catch { throw new Rejection('boundary_check_failed'); }
		}
		if (!relative || relative.split('/').some(segment => !segment || segment === '..' || segment === '.')
			|| /^(?:\/|[A-Za-z]:|[a-z][a-z0-9+.-]*:)/i.test(relative) || isSensitivePath(relative)) { throw new Rejection('unverified_path'); }
		if (this.text(normalized, work, new Set(), 0) !== normalized) { throw new Rejection('sensitive_identifier'); }
		if (context?.isApprovedRelativePath && workspaceId) {
			try { if (!context.isApprovedRelativePath(relative, workspaceId)) { throw new Rejection('unverified_path'); } }
			catch (error) { throw error instanceof Rejection ? error : new Rejection('boundary_check_failed'); }
		}
	}

	private text(value: string, work: Budget, reasons: Set<PrivacyReasonCode>, depth: number,
		context?: PrivacyContext, workspaceId?: string, parseStructured = true): string {
		work.processingBytes += Buffer.byteLength(value);
		if (work.processingBytes > this.limits.maxProcessingBytes) { throw new Rejection('processing_limit'); }
		if (parseStructured && /^\s*(?:\{|\[\s*(?:[\[\{"\d\-\]]|true\b|false\b|null\b))/.test(value)) {
			if (++work.jsonParses > this.limits.maxJsonParses) { throw new Rejection('processing_limit'); }
			this.checkJsonComplexity(value, depth);
			let parsed: unknown;
			try { parsed = JSON.parse(value); } catch { throw new Rejection('malformed_content'); }
			const snapshot = this.clone(parsed, work, depth + 1, new Set(), false);
			const before = reasons.size;
			const filtered = this.walk(snapshot, work, reasons, depth + 1, context, workspaceId);
			const encoded = JSON.stringify(filtered);
			return encoded !== JSON.stringify(snapshot) || reasons.size !== before ? encoded : value;
		}
		let text = value;
		const privateBegin = /-----BEGIN ((?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY)-----/g;
		let match: RegExpExecArray | null;
		let cursor = 0; let replacement = '';
		while ((match = privateBegin.exec(text))) {
			const marker = `-----END ${match[1]}-----`;
			const end = text.indexOf(marker, privateBegin.lastIndex);
			if (end < 0) { throw new Rejection('incomplete_private_key'); }
			const last = end + marker.length;
			replacement += text.slice(cursor, match.index) + preserveLines(text.slice(match.index, last));
			cursor = last; privateBegin.lastIndex = last; reasons.add('private_key_redacted');
		}
		if (cursor) { text = replacement + text.slice(cursor); }
		if (/-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-/.test(text)) { throw new Rejection('incomplete_private_key'); }
		const replace = (pattern: RegExp, transform: (...args: string[]) => string) => {
			text = text.replace(pattern, (...args: string[]) => { reasons.add('secret_redacted'); return transform(...args); });
		};
		replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{16,})(?![A-Za-z0-9_-])/g, () => REDACTED_VALUE);
		replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\b/g, () => REDACTED_VALUE);
		replace(/\b((?:Authorization|Proxy-Authorization)[ \t]*:[ \t]*)(Basic|Bearer|Digest)[ \t]+[^\r\n]+/gi, (_all, prefix, scheme) => prefix + scheme + ' ' + REDACTED_VALUE);
		replace(/\b((?:Cookie|Set-Cookie|X-API-Key|Api-Key|X-Auth-Token)[ \t]*:[ \t]*)[^\r\n]+/gi, (_all, prefix) => prefix + REDACTED_VALUE);
		text = text.replace(/\b(Bearer[ \t]+)([A-Za-z0-9._~+\/-]+={0,2})/gi, (all, prefix: string, token: string) => {
			// Bare prose commonly says "Bearer token(s)"; actual authorization headers were handled above.
			if (/^tokens?$/i.test(token)) { return all; }
			reasons.add('secret_redacted'); return prefix + REDACTED_VALUE;
		});
		replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\/\s:@]+:[^\/\s@]+@/gi, (_all, prefix) => prefix + REDACTED_VALUE + ':' + REDACTED_VALUE + '@');
		return this.assignments(text, reasons);
	}

	private assignments(text: string, reasons: Set<PrivacyReasonCode>): string {
		const assignments = /(?<![A-Za-z0-9_.-])(?:(['"]?)([A-Za-z][A-Za-z0-9_.-]{0,80})\1[ \t]*[:=][ \t]*|--([A-Za-z][A-Za-z0-9_-]{0,80})[ \t]+)/g;
		let match: RegExpExecArray | null; let cursor = 0; let result = '';
		while ((match = assignments.exec(text))) {
			if (!isSecretKey(match[2] ?? match[3])) { continue; }
			const start = assignments.lastIndex;
			const quote = ['"', "'", '`'].includes(text[start]) ? text[start] : '';
			let end = start + (quote ? 1 : 0);
			if (quote) {
				while (end < text.length && text[end] !== quote) { end += text[end] === '\\' ? 2 : 1; }
				if (end >= text.length) { throw new Rejection('malformed_content'); }
			} else {
				while (end < text.length && !/[\s,;)&\]}\[{}<>]/.test(text[end])) { end++; }
			}
			const value = text.slice(start + (quote ? 1 : 0), end);
			if (!quote && /^(?:[|>][+-]?\d*|\d*[|>][+-]?)$/.test(value)) { throw new Rejection('malformed_content'); }
			const codeReference = !quote && /^(?:[A-Za-z_$]\w*(?:\.\w+)+|[A-Za-z_$]\w*\(|\$[A-Za-z_]\w*|true|false|null|undefined)$/.test(value);
			const finish = end + (quote ? 1 : 0);
			assignments.lastIndex = Math.max(finish, start + 1);
			if (placeholder(value) || codeReference) { continue; }
			reasons.add('secret_redacted');
			result += text.slice(cursor, start) + quote + preserveLines(value) + quote;
			cursor = finish;
		}
		return cursor ? result + text.slice(cursor) : text;
	}

	private checkDiffLines(value: string): void {
		let lines = 1;
		for (let index = 0; index < value.length; index++) {
			if (value[index] === '\n' && ++lines > this.limits.maxDiffLines) { throw new Rejection('processing_limit'); }
		}
	}
	private diff(value: string, work: Budget, reasons: Set<PrivacyReasonCode>, depth: number, context?: PrivacyContext, workspaceId?: string): string {
		const patches = parsePatch(value);
		if (patches.length !== 1) { throw new Rejection('malformed_event'); }
		const patch = patches[0];
		if (patch.index && isSensitivePath(patch.index)) { throw new Rejection('sensitive_file_path'); }
		let changed = false;
		for (const field of ['index', 'oldHeader', 'newHeader'] as const) {
			if (patch[field]) { const filtered = this.text(patch[field]!, work, reasons, depth, context, workspaceId); changed ||= filtered !== patch[field]; patch[field] = filtered; }
		}
		for (const hunk of patch.hunks) {
			const positions = hunk.lines.map((line, index) => /^[ +\-]/.test(line) ? index : -1).filter(index => index >= 0);
			const original = positions.map(index => hunk.lines[index].slice(1)).join('\n');
			const filtered = this.text(original, work, reasons, depth, context, workspaceId, false);
			if (filtered === original) { continue; }
			const lines = filtered.split('\n');
			if (lines.length !== positions.length) { throw new Rejection('malformed_content'); }
			positions.forEach((position, index) => { hunk.lines[position] = hunk.lines[position][0] + lines[index]; }); changed = true;
		}
		return changed ? formatPatch(patch) : value;
	}
	private checkJsonComplexity(text: string, depth: number): void {
		let nodes = 0;
		const stack: { type: string; keys: Set<string>; keyExpected: boolean }[] = [];
		for (let index = 0; index < text.length; index++) {
			const char = text[index];
			if (char === '"') {
				const start = index++;
				while (index < text.length && text[index] !== '"') { index += text[index] === '\\' ? 2 : 1; }
				const current = stack.at(-1);
				if (current?.type === '{' && current.keyExpected) {
					let key: string;
					try { key = JSON.parse(text.slice(start, index + 1)); } catch { throw new Rejection('malformed_content'); }
					if (current.keys.has(key)) { throw new Rejection('malformed_content'); }
					current.keys.add(key); current.keyExpected = false;
				}
				continue;
			}
			if (char === '{' || char === '[') { depth++; stack.push({ type: char, keys: new Set(), keyExpected: char === '{' }); }
			if (char === '}' || char === ']') { depth--; stack.pop(); }
			if (char === ',' && stack.at(-1)?.type === '{') { stack.at(-1)!.keyExpected = true; }
			if (/[{\[:,]/.test(char) && ++nodes > this.limits.maxNodes || depth > this.limits.maxDepth) { throw new Rejection('processing_limit'); }
		}
	}
	private checkOutput(value: unknown): void {
		if (Buffer.byteLength(JSON.stringify(value)) > this.limits.maxOutputBytes) { throw new Rejection('processing_limit'); }
	}
}
