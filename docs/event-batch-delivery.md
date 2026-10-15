# Event batch preparation and delivery state (Task 3.3.1)

`EventBatchManager` accepts the existing `AsyncLocalEventQueue`. It has no timers, collector subscriptions, network requests or automatic acknowledgments. Production database access and event decryption run on the queue's storage worker.

```ts
const batches = new EventBatchManager(queue);
const batch = await batches.prepareBatch(100, 1024 * 1024);
// A future trusted delivery caller must explicitly supply actual acknowledged IDs.
// await batches.markDelivered(batch.batchId, acknowledgedEventIds);
// await batches.releaseBatch(batch.batchId);
const status = await batches.getDeliveryStatus();
```

Preparation returns `{ batchId, createdAt, byteSize, events }`, or `null` when no unclaimed pending events exist. Events retain their original IDs, recording sessions and queue sequence order. Limits are 1–1000 events and 2 bytes–32 MiB. Bytes measure the UTF-8 serialized **events array**, including brackets and commas; future transport envelope overhead is not included. Selection stops at the byte limit. An oversized oldest available event causes a safe error; it is never skipped or acknowledged. Increase the requested byte limit to retry.

Schema version 6 adds metadata-only `delivery_batches` and `delivery_members` tables. Membership stores only event IDs, ordinal, ownership/claim and delivery flags. Payloads stay in the existing encrypted event store; historical plaintext events remain compatible without being migrated. A `BEGIN IMMEDIATE` transaction and a unique partial index on claimed event IDs prevent overlapping claims across managers and extension windows. Count/byte selection is bounded and decrypts candidates individually rather than loading the entire queue. Batch bookkeeping uses the existing storage admission limits.

`markDelivered` validates the complete supplied acknowledgment list before changing anything. IDs must belong to that worker's batch; unknown, released and recovered batches cannot acknowledge newly claimed events. Repeated acknowledgments are idempotent. Partial acknowledgment keeps remaining members exclusively claimed until explicit release or owner recovery. When every member is acknowledged the batch becomes delivered. Acknowledgment uses the existing queue tombstones and removes acknowledged payloads as before; unacknowledged evidence is retained. The legacy direct `markAcknowledged` API rejects actively claimed IDs, requiring their batch acknowledgment path.

`releaseBatch` is idempotent for terminal batches owned by the current worker and never acknowledges an event. Clean worker closure releases its unfinished claims. Startup detects abandoned owners using the existing queue recovery mechanism and records their unfinished batches as recovered, releasing only their claims. Live workers keep ownership. Surviving unacknowledged events can then be prepared again, preserving IDs for future server-side deduplication. Recording is never resumed by this manager.

Status returns pending, claimed and available event counts and active/delivered/released/recovered batch counts. Historical bookkeeping survives reopening. Existing explicit cleanup and acknowledged-session retention remove affected delivery references transactionally; a partially affected active batch is released so its surviving members can be retried. Cleanup maintenance blocks preparation, acknowledgment and release mutations.

## Limitations

- This implements preparation and local state only; no delivery, retry worker, lease expiry or backend verification exists. An explicit acknowledgment is trusted caller input, not proof of a network response.
- Prepared events contain decrypted evidence in memory for future delivery. Callers must not log them or persist plaintext copies. Encryption and centralized filtering remain unchanged.
- Concurrent batches preserve order within each batch and select the oldest unclaimed events; future delivery coordination must manage cross-batch ordering.
- Lost responses after committing claims require release or worker recovery. Stale batch IDs from previous workers are rejected; reprepare recovered events instead.
- Batch history consumes queue storage until existing user-controlled cleanup or eligible acknowledged-session retention removes its references. Storage exhaustion can prevent new batch preparation, but never silently discards or acknowledges pending events.
