import { parentPort, workerData } from 'node:worker_threads';
import { PrivacyFilter, type PrivacyContext } from './privacyFilter';
import type { UploadPrivacyContext } from './uploadPrivacyContext';
import type { PreparedEventBatch } from './eventBatchManager';

// Payload filtering/serialization runs outside the extension host and never writes diagnostic files.
try {
	const { batch, contexts, maxBytes } = workerData as { batch: PreparedEventBatch; contexts: UploadPrivacyContext[]; maxBytes: number };
	if (batch.events.length !== contexts.length) { throw new Error(); }
	const filter = new PrivacyFilter();
	const events = batch.events.map((event, index) => {
		const snapshot = contexts[index];
		const context: PrivacyContext = { ...snapshot, resolveToolPath: (path, workspaceId) =>
			snapshot.verifiedToolPaths?.find(entry => entry.path === path && entry.workspaceId === workspaceId)?.relativePath };
		const result = filter.filter(event, context);
		// Changed patches/hashes cannot be uploaded as original reconstructable evidence.
		if (result.status === 'rejected' || result.requiresReconstructionGap) { throw new Error(); }
		return result.event;
	});
	const body = JSON.stringify({ contractVersion: 1, batchId: batch.batchId, events });
	if (Buffer.byteLength(body) > maxBytes) { parentPort?.postMessage({ ok: false, reason: 'configuration' }); }
	else { parentPort?.postMessage({ ok: true, body }); }
} catch { parentPort?.postMessage({ ok: false, reason: 'privacy' }); }
