# Secure diagnostics and local retention — Task 3.2.3B

SQLite remains the authoritative event store. New events pass the existing privacy filter and AES-256-GCM worker encryption. Raw event JSONL output is removed; there is no setting or constructor option to enable it. No backend, upload, key rotation or automatic pending-event deletion is introduced.

## Metadata-only diagnostics

`JsonlWriter` validates the event and projects only allowlisted metadata before appending. Prompts, responses, diffs, source code, tool inputs/outputs, identifiers, hashes, workspace/file paths and arbitrary payload fields never enter new diagnostic lines. The event snapshot is used only for in-memory observers; production correlation observes durable sanitized SQLite capture through `EventPersistence`, not JSONL.

```json
{"diagnosticVersion":1,"eventType":"file.diff","timestamp":"2026-10-14T10:00:00.000Z","status":"captured","reasonCode":"none"}
```

Reconstruction gaps use a fixed gap status and safe reason category. Unsupported or malformed events are rejected. Diagnostics use their own version, independent of common event schema v1. Production files rotate daily under the extension's global-storage `diagnostics` directory as `diagnostics.v1.YYYY-MM-DD.jsonl`, with private permissions. Existing `events.v1.jsonl` and `file-activity.jsonl` are never appended to by production. Output-channel messages use fixed categories and counts; storage paths are no longer printed. Reader metadata already uses allowlisted kinds/timestamps and omits untrusted source identifiers.

SQLite commit precedes diagnostics and sanitized observers. Diagnostic append/flush failures cannot invalidate or duplicate a successful SQLite capture and never cause a fallback to raw evidence. Test-only journals observe events in memory; they write the same safe diagnostics, and compiled test fixtures are excluded from the extension package.

## Historical plaintext detection

At activation, the worker counts pending legacy SQLite rows with format 0 and nonempty known historical JSONL files in global storage and the current known workspace-storage directory. It does not read historical log contents or display record/file contents or paths. A warning reports counts and points to the historical-cleanup command. Historical event payloads are not rewritten, relabeled as encrypted or silently deleted.

Detection is scoped to this extension's current storage profile and known directories. Other VS Code profiles, logs left in other workspace-storage directories, manually exported/copied files, original Codex sessions and backups are not scanned or removed. If the database cannot open because of missing keys, corruption or storage failure, detection/cleanup are reported unavailable and existing data is preserved. Resolve that condition first; this task does not introduce a destructive key-loss/database-reset bypass.

## Retention settings

`ai-developer-tracker.retention.days` defaults to **30**. Accepted values are 0–3650; 0 disables automatic expiration. Only the user/global setting is read, so repository settings cannot force deletion. Retention runs at activation, after a normal Stop/drain, and once daily while the extension remains open. It skips active recordings, pending recording consent and concurrent maintenance.

Automatic expiration preserves every unacknowledged event. To keep source/target correlation references consistent, it expires an entire recording session only when:

- the session is closed and its known end time is older than the cutoff;
- no event in that session is pending;
- every associated acknowledgment has a known timestamp older than the cutoff.

New acknowledgment timestamps are set once; duplicate acknowledgments do not extend age. Unknown historical tombstone ages are retained conservatively until explicit cleanup. Empty old closed session histories can expire. Session/privacy-health metadata is removed with its qualifying events, and database counters remain consistent. No automatic acknowledgment is performed. Deduplication tombstones expire with qualifying sessions, so future consumers must not replay acknowledged history after its retention window.

Only old daily metadata diagnostic files expire automatically, using both file age and date. Historical plaintext JSONL files are retained regardless of age until the user confirms cleanup. A recording lasting beyond the configured retention period defers maintenance until it stops; retention is a conservative cleanup policy, not a precise deletion deadline.

## Explicit cleanup commands

**AI Developer Tracker: Clean Up Historical Plaintext Evidence** deletes known historical JSONL logs plus whole SQLite sessions containing pending plaintext records. Mixed sessions may contain encrypted records and correlation evidence too; the confirmation explicitly describes that scope and the number of pending events that will be lost. Other encrypted sessions and new metadata diagnostics remain.

**AI Developer Tracker: Delete Local Assessment Evidence** deletes all queue records, acknowledgment tombstones, session/privacy-health history, correlation evidence, known historical logs and metadata diagnostics in the current scope. Its modal confirmation explicitly states the pending-event loss. Cancellation preserves existing data. Workspace source files, original Codex session files, other profiles/workspace logs, unrelated files and encryption keys are not deleted. Used key identifiers remain registered; this is not key rotation or cryptographic erasure.

The controller refuses cleanup during recording, cancels an unsubmitted recording-consent request for explicit cleanup, and prevents a new Start while maintenance is in progress. It rechecks recording state after confirmation. A SQLite maintenance lease prevents other windows from starting recording, writing/acknowledging events or concurrently cleaning the same queue. Active/prepared ledger sessions block acquisition until producer draining/session completion is safe. A failed recording may need reload/recovery before cleanup can acquire this lease.

SQLite session/event/health deletion is transactional. Filesystem unlink and database compaction cannot share that transaction: a later failure is reported as partial, never as completed cleanup. Some rows/files may already have been removed; inspect counts and retry. Storage work, directory scans, unlink, expiration and compaction run on the existing storage worker. Current workspace-boundary checks are rechecked before deletion. Scans are bounded, deletion filenames are allowlisted, and symlink/hardlink/root-identity changes are rejected. No recursive directory deletion or arbitrary path command is exposed.

Interrupted maintenance leases recover through existing queue ownership recovery. After confirmed cleanup, this window clears stopped diff/correlation/association caches and persistence deduplication history. Restart uses the retained SecretStorage keys and starts recording only after fresh consent. Other windows/processes may retain already-loaded memory; local cleanup is not memory sanitization.

## Deletion limitations and remaining plaintext

**Deleting rows or log files, checkpointing and compacting SQLite do not guarantee secure erasure from storage media, filesystem snapshots, WAL history, temporary storage, backups or copied exports.** Keys are retained and no backup/media-erasure capability is added. Compaction can need disk space and may fail after logical deletion commits; this is reported separately through partial-cleanup status. A failed lease release blocks new recording until storage/reload recovery succeeds.

Remaining plaintext exposure is limited to preserved historical SQLite/JSONL data and copies; original workspace/Codex files; transient collector/worker memory and OS caches; and the explicitly safe diagnostic metadata/operational indexing and health fields. New diagnostic files contain no event evidence. The existing heuristic privacy filter and host SecretStorage security limitations still apply.

## Files for this task

Created: `src/localDiagnosticFiles.ts`, `src/localDataController.ts`, `src/test/localDataRetention.test.ts`, `src/test/memoryEventJournal.ts`, and this document.

Updated runtime: `src/jsonlWriter.ts`, `src/localEventQueue.ts`, `src/asyncLocalEventQueue.ts`, `src/localEventQueueWorker.ts`, `src/eventPersistence.ts`, `src/extension.ts`, `src/recording.ts`, `src/diffTracker.ts`, `src/activityCorrelator.ts`, `src/codexSessionDiscovery.ts`, `package.json`, `.vscodeignore`.

Existing schema, collector, reader, queue, privacy and encryption tests were adapted to verify metadata files and observe full evidence only in SQLite or memory. Storage/privacy/encryption documentation was updated to distinguish earlier plaintext behavior from this task.
