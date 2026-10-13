import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EventValidationError, validateEvent, type TrackerEvent } from './eventSchema';

export interface ActivityWriter {
	write(event: TrackerEvent): Promise<void>;
	flush(): Promise<void>;
}

export class JsonlWriter implements ActivityWriter {
	private pending: Promise<void> = Promise.resolve();

	constructor(readonly filePath: string) {}

	write(event: unknown): Promise<void> {
		const validation = validateEvent(event);
		if (!validation.valid) {
			return Promise.reject(new EventValidationError(validation.errors));
		}
		const line = JSON.stringify(validation.event) + '\n';
		const write = this.pending.then(async () => {
			await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
			await appendFile(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
		});
		// A failed append must not prevent later writes; the caller receives the error.
		this.pending = write.catch(() => {});
		return write;
	}

	flush(): Promise<void> {
		return this.pending;
	}
}
