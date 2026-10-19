import { parentPort, workerData } from 'node:worker_threads';
import { serializeUploadBatch } from './uploadBatchSerialization';
import type { UploadPrivacyContext } from './uploadPrivacyContext';
import type { PreparedEventBatch } from './eventBatchManager';

// Payload filtering/serialization runs outside the extension host and never writes diagnostic files.
try {
	const { batch, contexts, maxBytes } = workerData as { batch: PreparedEventBatch; contexts: UploadPrivacyContext[]; maxBytes: number };
	parentPort?.postMessage({ ok: true, ...serializeUploadBatch(batch, contexts, maxBytes) });
} catch (error) { parentPort?.postMessage({ ok: false, reason: error instanceof RangeError ? 'configuration' : 'privacy' }); }
