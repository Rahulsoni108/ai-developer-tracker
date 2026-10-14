# Persistent local event queue (Tasks 3.1.1–3.1.3)

`LocalEventQueue` stores normalized recording events. Task 3.1.2 connects all existing collectors through `EventPersistence`, using SQLite as the durable store and preserving JSONL as a best-effort debug mirror. No uploads or backend connections are included.

Activation opens `AsyncLocalEventQueue`, which runs `LocalEventQueue.open()` in a dedicated storage thread. The database is `event-queue.v1.sqlite` directly inside `context.globalStorageUri`. Local desktop VS Code profiles can expose that disk-backed directory as `vscode-userdata:`; activation normalizes only that trusted, authority-free context URI to its file path when running locally on desktop. Arbitrary virtual and remote schemes remain unsupported. Local workspace paths, including canonical symlink paths, are rejected and rechecked before approving folders added after activation. Deactivation stops recording, drains the collectors and correlation work, then closes persistence, SQLite, and the thread.

## Collector integration

`FileTracker`, `DiffTracker`, `CodexEventParser`, and `ActivityCorrelator` receive the same `EventPersistence` instance through their existing `ActivityWriter` interface. It snapshots validated events without changing IDs, commits each event to SQLite, attempts the JSONL append, and notifies correlation observers of durable capture. JSONL failure resolves the write successfully because the event is already queued. Queue failure rejects the write, never appends JSONL or reports successful capture, stops recording, and displays a persistent degradation status and a sanitized warning. A failed/open-unavailable queue blocks new recordings until storage is fixed and the extension is reloaded. JSONL degradation displays a warning but allows recording to continue.

Writes are serialized with a host event-loop yield before each individual commit. SQLite inserts, queries and lock waits run in the storage thread, not the extension host. Outstanding serialized content is bounded to 32 MiB; overflow rejects visibly rather than dropping events silently. Recent committed IDs (2048) suppress repeated JSONL appends and observer notifications within a running writer; SQLite uniqueness permanently prevents duplicate queue rows. The JSONL mirror has no transactional exactly-once guarantee, automatic repair, or replay: restart or an append that partially succeeds can leave missing/duplicate debug records. SQLite remains authoritative. Existing JSONL storage locations and legacy records are unchanged; no historical JSONL import is performed. Recording consent and confirmed-session/content-consent gates are preserved.

## API and persistence

- `enqueue(event)` validates the existing common schema and snapshots the event before scheduling its insertion. The first event with a given `eventId` wins, including after acknowledgment and restart.
- `getPending(limit)` returns independent normalized event objects in insertion order. It does not consume or acknowledge them. Limits are 1–1000.
- `markAcknowledged(eventIds)` acknowledges up to 1000 UUIDs in one transaction. Unknown IDs and repeats are harmless. Payloads become NULL; event IDs remain as deduplication tombstones.
- `getPendingCount()` counts unacknowledged events.
- `getHealth()` reports pending count, SQLite/sidecar storage bytes, configured capacity, healthy/warning/full status, and interrupted/incomplete session counts.
- `beginSession()`, `finishSession()`, and `getRecordingSessions()` manage separate recording lifecycle metadata without altering historical events.
- `close()` drains accepted operations, closes the connection, and rejects subsequent operations. Repeated calls return the same promise.

SQLite WAL journaling and `synchronous=FULL` make successful writes durable without depending on shutdown. Inserts, acknowledgments, and schema creation use transactions. A one-second busy timeout bounds contention waits. A partial index supports FIFO pending reads. The queue database schema has its own `user_version=2`, independent of event `schemaVersion=1`; the existing filename remains `event-queue.v1.sqlite` for compatibility. Version-1 queues migrate transactionally without changing event records. Unknown database versions and invalid stored events fail explicitly. Errors omit driver details, paths, SQL values and event contents; the module does not log anything.

## Crash recovery

Startup runs SQLite `integrity_check`, validates stored normalized events and identity fields, and verifies schema and pending/session counters. This one-time work runs on the storage thread. Corrupt databases are reported and left in place; they are not replaced, discarded, or automatically repaired. SQLite recovers committed WAL transactions and rolls back uncommitted transactions. Pending events retain their original event IDs, session IDs, order and content. A worker request interrupted before its reply may have committed or rolled back; replaying the same event ID remains safe, but collection does not automatically replay or restart.

`recording_sessions` records active/completed/cancelled/interrupted/incomplete status separately from historical events. Active sessions whose owning process or worker disappeared are marked interrupted on the next open. Live connections are not marked interrupted; ownership includes a process-instance token and per-worker ID. Sessions from a schema-v1 database have unverifiable lifecycle state and are marked incomplete with `legacy_state_unknown`. Graceful Stop completes a session after collectors and correlations have drained; a persistence failure leaves it interrupted instead of claiming successful completion.

RecordingController is always initially stopped after activation. Recovered sessions never restore consent, recording state, Codex content consent, or confirmed-session associations. A new recording requires the existing consent flow and receives a new session ID. Unexpected worker termination also immediately signals degradation, stops collection, rejects outstanding requests safely, and requires reload to reopen storage.

## Storage limits and health

`ai-developer-tracker.queue.maxSizeMB` defaults to 100 MB (104857600 bytes), is configurable from 1 to 10240 MB in user/machine settings, and requires reload. Workspace configuration cannot raise the limit. The capacity covers the database, WAL, SHM and rollback journal; JSONL debug output is separate and is not included.

Admission reserves conservative space for event overflow pages, B-tree/index changes, counters, recording metadata and WAL frames. It checks capacity again under SQLite's writer lock, limits SQLite page allocation, and disables uncommitted cache spilling. When needed, WAL checkpointing reclaims journal space without deleting events; pinned external readers can prevent this. An event that cannot safely fit is rejected before capture, collection stops visibly, and all previously committed pending records remain. This can stop before the literal byte limit because a transaction needs overhead/headroom. Deduplication remains allowed at capacity. No events are automatically deleted or acknowledged.

Warnings appear at 80% measured usage; capacity/error warnings contain no event contents. The status bar and **AI Developer Tracker: Show Local Queue Health** command expose counts and usage. Pending and interrupted counts are maintained transactionally by SQLite triggers, so per-event health checks use metadata and filesystem sizes rather than full database scans. Routine worker notifications are limited to once per second; the first 80% and capacity notifications bypass that delay. Dialog warnings are deduplicated for the activation.

Disk-full, permission/read-only, database-lock, corruption, capacity and unavailable-worker errors are classified into safe codes. Failures stop collection and never cause JSONL to claim an unqueued event. Increase the configured limit or resolve the storage problem and reload; no automatic acknowledgment or destructive cleanup is offered.

Storage directories use mode 0700 and database files mode 0600 on POSIX. Existing symlinked, hard-linked, or nonregular database/sidecar files are rejected. SQLite sidecars inherit database permissions. These protections assume extension global storage is trusted and not being concurrently manipulated by another local process.

## SQLite integration and packaging

The integration uses Node's built-in `node:sqlite` `DatabaseSync`, available without a flag from Node 22.13, and `node:worker_threads` to isolate synchronous database work. The compiled `out/localEventQueueWorker.js` must be included in the VSIX (the existing packaging exclusions already allow it). No npm runtime dependency, native addon rebuild, architecture-specific binary, or WASM asset is required. The project's existing VS Code engine requirement is unchanged. The downloaded VS Code 1.141.0 runtime was verified to provide Node 24.21.0 and SQLite 3.53.4; the automated suite also runs the queue inside that extension host.

Reference: [Node SQLite API](https://nodejs.org/api/sqlite.html). On Node 24 the API is experimental. The implementation uses the established `DatabaseSync` API and does not depend on newer Node 26 APIs.

## Limitations

Direct `LocalEventQueue` calls are synchronous inside a serialized Promise API; production uses `AsyncLocalEventQueue` to keep that work off the extension host. Event validation, snapshot serialization and thread message copies still cost CPU and memory on the host. Read and acknowledgment batches are bounded to 1000 and serialized event size to 16 MiB (including JSON escaping overhead for the schema's 2 MiB diffs); callers should use smaller read batches for large content events. No tombstone or session-history garbage collection is included. Startup integrity checks scan existing records once and may take time for a large queue. It is for Node-based desktop/remote extension hosts with a local file global-storage URI, not web extensions or older Node runtimes.

Events are sensitive local plaintext. Permission modes do not encrypt the database and Windows uses its inherited filesystem ACLs. Clearing acknowledged payloads is logical removal, not secure erasure: old pages, WAL records and backups may retain content. Durability still depends on the local filesystem and hardware honoring SQLite's synchronization requests; shared/network storage is not supported. The storage thread performs explicitly requested persistence operations only; there is no upload, automatic acknowledgment, background queue consumer, or migration of existing JSONL records. Uncommitted events can be lost on abrupt process termination; successfully resolved writes are durable. Failure notices do not claim recovery of a failed event.

Administrative recovery/migration writes can need extra space, and a pre-existing database can already exceed a newly lowered limit; such data is preserved and new collection is blocked. Other applications writing the database directly are outside the admission policy. Ownership checks conservatively treat another process with a live or inaccessible PID as still alive; PID reuse can defer interruption marking until a later restart. Windows and other platform-specific filesystem behaviors need validation beyond the current macOS test host. Tests simulate SQLite FULL and READONLY failures without filling the user's actual disk or changing system permissions.

## Verify recording persistence

1. Launch the extension, open an eligible workspace, approve Start Recording, edit/save a TypeScript file, and Stop Recording. For Codex events, separately grant content consent and confirm the associated session.
2. Find `context.globalStorageUri.fsPath` in the activation debugger. Open `event-queue.v1.sqlite` there with a read-only SQLite viewer. On desktop this is normally under the active VS Code profile's `User/globalStorage/<extension-id>` directory, outside the workspace; the test/development host may use a separate profile.
3. Inspect counts and IDs without displaying sensitive payloads:

   ```sql
   SELECT COUNT(*) AS pending FROM queued_events WHERE acknowledged = 0;
   SELECT event_id,
          json_extract(event_json, '$.sessionId') AS session_id,
          json_extract(event_json, '$.eventType') AS event_type
   FROM queued_events WHERE acknowledged = 0 ORDER BY sequence LIMIT 20;
   ```

4. Reload VS Code without starting another recording and rerun the queries. Pending rows and their event/session IDs remain. The JSONL log is still written at its previous location. All queued events remain pending in this task because no acknowledgment worker or uploader exists.
5. Run **AI Developer Tracker: Show Local Queue Health** for safe storage diagnostics. To inspect interrupted sessions without reading sensitive event payloads, query `SELECT session_id, status, reason FROM recording_sessions;`.

Do not copy only the database while a live WAL exists; use the SQLite viewer directly or close VS Code before taking a filesystem copy.
