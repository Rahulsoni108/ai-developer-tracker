import { JsonlWriter } from '../jsonlWriter';
import type { TrackerEvent } from '../eventSchema';

/** Test observation only: logs still contain safe diagnostics; evidence stays in memory. */
export class MemoryEventJournal extends JsonlWriter {
	readonly captured: TrackerEvent[] = [];
	constructor(path: string) { super(path); this.onDidWrite(event => this.captured.push(event as TrackerEvent)); }
}
