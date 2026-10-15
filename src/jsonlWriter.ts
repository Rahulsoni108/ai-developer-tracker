import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { EventValidationError, validateEvent, type TrackerEvent } from './eventSchema';
import { PRIVACY_EVENT_TYPES } from './privacyFilter';

export const DIAGNOSTIC_LOG_PREFIX = 'diagnostics.v1.';
export interface SafeEventDiagnostic {
	diagnosticVersion: 1;
	eventType: TrackerEvent['eventType'];
	timestamp: string;
	status: 'captured' | 'reconstruction_gap';
	reasonCode: 'none' | 'privacy_filter' | 'reconstruction_gap';
}
/** Deliberately contains no IDs, paths, payload, arguments, content or caller-supplied reason strings. */
export function eventDiagnostic(event: TrackerEvent): SafeEventDiagnostic {
	if (!PRIVACY_EVENT_TYPES.includes(event.eventType)) { throw new EventValidationError(['Unsupported diagnostic event type']); }
	return { diagnosticVersion: 1, eventType: event.eventType, timestamp: event.timestamp,
		status: event.eventType === 'file.gap' ? 'reconstruction_gap' : 'captured',
		reasonCode: event.eventType === 'file.gap' ? event.payload.reason === 'privacy_filter' ? 'privacy_filter' : 'reconstruction_gap' : 'none' };
}

export interface ActivityWriter {
	write(event: TrackerEvent): Promise<void>;
	flush(): Promise<void>;
}

export class JsonlWriter implements ActivityWriter {
	private pending: Promise<void> = Promise.resolve();
	private readonly listeners = new Set<(event: Readonly<TrackerEvent>) => void>();

	constructor(private readonly destination: string | (() => string)) {}
	get filePath(): string { return typeof this.destination === 'function' ? this.destination() : this.destination; }
	/** Synchronous notifications after successful persistence. Listeners must queue async work. */
	onDidWrite(listener: (event: Readonly<TrackerEvent>) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	write(event: unknown): Promise<void> {
		const validation = validateEvent(event);
		if (!validation.valid) {
			return Promise.reject(new EventValidationError(validation.errors));
		}
		const line = JSON.stringify(eventDiagnostic(validation.event)) + '\n';
		const snapshot = JSON.stringify(validation.event);
		const filePath = this.filePath;
		const write = this.pending.then(async () => {
			await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
			const handle = await open(filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
			try {
				// Metadata only. Raw evidence output has no opt-in switch.
				await handle.chmod(0o600);
				await handle.writeFile(line, { encoding: 'utf8' });
			} finally {
				await handle.close();
			}
			for (const listener of this.listeners) {
				try { listener(JSON.parse(snapshot) as TrackerEvent); } catch { /* In-memory observers do not receive evidence from disk. */ }
			}
		});
		// A failed append must not prevent later writes; the caller receives the error.
		this.pending = write.catch(() => {});
		return write;
	}

	flush(): Promise<void> {
		return this.pending;
	}
}
