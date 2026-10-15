import type { AsyncLocalEventQueue } from './asyncLocalEventQueue';
import type { TrackerEvent } from './eventSchema';

export const MAX_DELIVERY_BATCH_BYTES = 32 * 1024 * 1024;
export interface PreparedEventBatch {
	batchId: string;
	createdAt: string;
	/** UTF-8 bytes of JSON.stringify(events), including array delimiters. */
	byteSize: number;
	events: TrackerEvent[];
}
export interface DeliveryStatus {
	pendingEvents: number;
	claimedEvents: number;
	availableEvents: number;
	activeBatches: number;
	deliveredBatches: number;
	releasedBatches: number;
	recoveredBatches: number;
}

/** No transport or timers. Durable ownership and decryption stay on the storage worker. */
export class EventBatchManager {
	constructor(private readonly queue: Pick<AsyncLocalEventQueue, 'prepareBatch' | 'markDelivered' | 'releaseBatch' | 'getDeliveryStatus'>) { }
	prepareBatch(maxEvents: number, maxBytes: number): Promise<PreparedEventBatch | null> {
		return this.queue.prepareBatch(maxEvents, maxBytes);
	}
	markDelivered(batchId: string, acknowledgedEventIds: readonly string[]): Promise<void> {
		return this.queue.markDelivered(batchId, acknowledgedEventIds);
	}
	releaseBatch(batchId: string): Promise<void> { return this.queue.releaseBatch(batchId); }
	getDeliveryStatus(): Promise<DeliveryStatus> { return this.queue.getDeliveryStatus(); }
}
