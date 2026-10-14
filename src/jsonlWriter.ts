import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { EventValidationError, validateEvent, type TrackerEvent } from './eventSchema';

export interface ActivityWriter {
	write(event: TrackerEvent): Promise<void>;
	flush(): Promise<void>;
}

export class JsonlWriter implements ActivityWriter {
	private pending: Promise<void> = Promise.resolve();
	private readonly listeners = new Set<(event: Readonly<TrackerEvent>) => void>();

	constructor(readonly filePath: string) {}
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
		const line = JSON.stringify(validation.event) + '\n';
		const write = this.pending.then(async () => {
			await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
			const handle = await open(this.filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
			try {
				// Tighten existing metadata logs before adding sensitive source-code patches.
				await handle.chmod(0o600);
				await handle.writeFile(line, { encoding: 'utf8' });
			} finally {
				await handle.close();
			}
			for (const listener of this.listeners) {
				try { listener(JSON.parse(line) as TrackerEvent); } catch { /* Observer failures cannot invalidate a successful append. */ }
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
