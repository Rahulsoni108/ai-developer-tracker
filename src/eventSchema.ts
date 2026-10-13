import { randomUUID } from 'node:crypto';
import { parsePatch } from 'diff';

export const SCHEMA_VERSION = 1;
export const EVENT_LOG_FILENAME = 'events.v1.jsonl';
// Task 1.3 records in this file are unversioned legacy schema v0. They are never
// converted, relabeled, or appended to by the v1 recording pipeline.
export const LEGACY_EVENT_LOG_FILENAME = 'file-activity.jsonl';

export type EventSource = 'vscode' | 'codex' | 'claude';
export type Attribution = 'ai_confirmed' | 'human_confirmed' | 'unknown';
export type FileEventType = 'file.created' | 'file.modified' | 'file.saved' | 'file.deleted';

/** Shared envelope for current file events and future explicitly defined payloads. */
export interface CommonEvent<TType extends string, TPayload extends object> {
	schemaVersion: typeof SCHEMA_VERSION;
	eventId: string;
	timestamp: string;
	source: EventSource;
	eventType: TType;
	sessionId: string;
	workspaceId?: string;
	payload: TPayload;
	sourceSessionId?: string;
	correlationId?: string;
	attribution?: Attribution;
}

export interface FileEventPayload {
	relativePath: string;
}

export interface FileActivityEvent extends CommonEvent<FileEventType, FileEventPayload> {
	workspaceId: string;
}

// Extend this union and the runtime validator together when adding event kinds.
export type ChangeReason = 'edit' | 'save' | 'external' | 'create' | 'delete';
export const GAP_REASONS = ['binary', 'file_size_limit', 'diff_size_limit', 'memory_limit', 'read_error', 'read_race', 'diff_timeout', 'baseline_unavailable', 'checkpoint_overflow', 'write_error'] as const;
export type GapReason = typeof GAP_REASONS[number];
export const MAX_SCHEMA_DIFF_BYTES = 2 * 1024 * 1024;

export interface DiffPayload extends FileEventPayload {
	diff: string;
	beforeHash: string;
	afterHash: string;
	changeReason: ChangeReason;
}

export interface GapPayload extends FileEventPayload {
	reason: GapReason;
	changeReason: ChangeReason;
	beforeHash?: string;
	afterHash?: string;
}

export interface DiffEvent extends CommonEvent<'file.diff', DiffPayload> {
	workspaceId: string;
	source: 'vscode';
	attribution: 'unknown';
}
export interface BaselineEvent extends CommonEvent<'file.baseline', DiffPayload> {
	workspaceId: string;
	source: 'vscode';
	attribution: 'unknown';
}
export interface GapEvent extends CommonEvent<'file.gap', GapPayload> {
	workspaceId: string;
	source: 'vscode';
	attribution: 'unknown';
}
export type CodeChangeEvent = DiffEvent | BaselineEvent | GapEvent;
export type TrackerEvent = FileActivityEvent | CodeChangeEvent;

export function createChangeEvent(input: (
	Omit<DiffEvent, 'schemaVersion' | 'eventId' | 'timestamp' | 'source' | 'attribution'>
	| Omit<BaselineEvent, 'schemaVersion' | 'eventId' | 'timestamp' | 'source' | 'attribution'>
	| Omit<GapEvent, 'schemaVersion' | 'eventId' | 'timestamp' | 'source' | 'attribution'>
) & { timestamp?: Date }): CodeChangeEvent {
	return { ...input, schemaVersion: SCHEMA_VERSION, eventId: randomUUID(),
		timestamp: (input.timestamp ?? new Date()).toISOString(), source: 'vscode', attribution: 'unknown' };
}

export function createFileEvent(
	input: Omit<FileActivityEvent, 'schemaVersion' | 'eventId' | 'timestamp'> & { timestamp?: Date }
): FileActivityEvent {
	return {
		...input,
		schemaVersion: SCHEMA_VERSION,
		eventId: randomUUID(),
		timestamp: (input.timestamp ?? new Date()).toISOString(),
		attribution: input.attribution ?? 'unknown'
	};
}

export function isUuid(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export type EventValidationResult = { valid: true; event: TrackerEvent } | { valid: false; errors: string[] };

const fields = new Set([
	'schemaVersion', 'eventId', 'timestamp', 'source', 'eventType', 'sessionId',
	'workspaceId', 'payload', 'sourceSessionId', 'correlationId', 'attribution'
]);
const eventTypes = new Set<string>(['file.created', 'file.modified', 'file.saved', 'file.deleted', 'file.diff', 'file.baseline', 'file.gap']);
const changeReasons = new Set<ChangeReason>(['edit', 'save', 'external', 'create', 'delete']);

function isHash(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isUnifiedDiff(value: unknown): value is string {
	if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX_SCHEMA_DIFF_BYTES) {
		return false;
	}
	try {
		const patches = parsePatch(value);
		return patches.length === 1 && ['before', '/dev/null'].includes(patches[0].oldFileName ?? '')
			&& ['after', '/dev/null'].includes(patches[0].newFileName ?? '');
	} catch {
		return false;
	}
}

function dataObject(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return undefined;
	}
	const copy: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
			return undefined;
		}
		copy[key] = descriptor.value;
	}
	return copy;
}

function isIdentifier(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 256
		&& value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function isUtcTimestamp(value: unknown): value is string {
	return typeof value === 'string'
		&& /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
		&& Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isRelativePath(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && !/[\\\u0000]/.test(value)
		&& !/^[a-z][a-z0-9+.-]*:/i.test(value)
		&& value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

/** Contents are allowed only as bounded unified patches in explicit code-change events. */
export function validateEvent(value: unknown): EventValidationResult {
	try {
		const input = dataObject(value);
		if (!input) {
			return { valid: false, errors: ['Event must be a plain data object'] };
		}
		const errors: string[] = [];
		if (Object.keys(input).some(key => !fields.has(key))) {
			errors.push('Unexpected event fields');
		}
		if (input.schemaVersion !== SCHEMA_VERSION) {
			errors.push('Unsupported or missing schemaVersion');
		}
		if (!isUuid(input.eventId)) {
			errors.push('eventId must be a UUID v4');
		}
		if (!isUuid(input.sessionId)) {
			errors.push('sessionId must be a UUID v4');
		}
		if (!isUtcTimestamp(input.timestamp)) {
			errors.push('timestamp must be canonical UTC ISO 8601');
		}
		if (!['vscode', 'codex', 'claude'].includes(input.source as string)) {
			errors.push('Unsupported or missing source');
		}
		if (!eventTypes.has(input.eventType as FileEventType)) {
			errors.push('Unsupported or missing eventType');
		}
		if (!isIdentifier(input.workspaceId)) {
			errors.push('workspaceId is required for file events');
		}
		const payload = dataObject(input.payload);
		const isChange = ['file.diff', 'file.baseline', 'file.gap'].includes(input.eventType as string);
		const allowedPayloadFields = input.eventType === 'file.gap'
			? ['relativePath', 'reason', 'changeReason', 'beforeHash', 'afterHash']
			: isChange ? ['relativePath', 'diff', 'changeReason', 'beforeHash', 'afterHash'] : ['relativePath'];
		if (!payload || Object.keys(payload).some(key => !allowedPayloadFields.includes(key)) || !isRelativePath(payload.relativePath)) {
			errors.push('Invalid file payload fields or relativePath');
		} else if (isChange) {
			if (input.source !== 'vscode' || input.attribution !== 'unknown') {
				errors.push('Code-change events require source vscode and attribution unknown');
			}
			if (!changeReasons.has(payload.changeReason as ChangeReason)) {
				errors.push('Invalid changeReason');
			}
			if (input.eventType === 'file.gap') {
				if (!GAP_REASONS.includes(payload.reason as GapReason)
					|| (payload.beforeHash !== undefined && !isHash(payload.beforeHash))
					|| (payload.afterHash !== undefined && !isHash(payload.afterHash))) {
					errors.push('Invalid reconstruction gap');
				}
			} else if (!isHash(payload.beforeHash) || !isHash(payload.afterHash) || !isUnifiedDiff(payload.diff)) {
				errors.push('Invalid unified diff or SHA-256 hashes');
			}
		}
		input.payload = payload;
		for (const field of ['sourceSessionId', 'correlationId'] as const) {
			if (input[field] !== undefined && !isIdentifier(input[field])) {
				errors.push(`${field} must be a nonempty identifier`);
			}
		}
		if (input.attribution !== undefined && !['ai_confirmed', 'human_confirmed', 'unknown'].includes(input.attribution as string)) {
			errors.push('Unsupported attribution');
		}
		return errors.length > 0 ? { valid: false, errors } : { valid: true, event: input as unknown as TrackerEvent };
	} catch {
		// Error text never includes submitted values, which could contain sensitive data.
		return { valid: false, errors: ['Malformed event object'] };
	}
}

export class EventValidationError extends Error {
	constructor(readonly errors: readonly string[]) {
		super(`Invalid tracker event: ${errors.join('; ')}`);
		this.name = 'EventValidationError';
	}
}
