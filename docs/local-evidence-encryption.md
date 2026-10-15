# Local evidence encryption foundation — Task 3.2.3A

New normalized SQLite events are encrypted with Node.js `crypto` AES-256-GCM after the existing privacy filter. No dependency was added. At Task 3.2.3A, JSONL behavior remained unchanged. Task 3.2.3B now uses [metadata-only diagnostics and controlled retention](secure-diagnostics-retention.md); the event schema, encryption and key-management foundations remain intact.

**New JSONL diagnostics now contain only safe metadata. Historical raw JSONL/SQLite records, old pages and backups can still contain plaintext; Task 3.2.3B detects known historical data and offers explicit cleanup. No silent event-payload conversion or key rotation is performed.**

## What is encrypted

`queued_events.event_json` holds the complete encrypted normalized event when `payload_format = 1`. This encrypts payload, file paths, event type, event timestamp, workspace/source session IDs, local session ID, attribution and correlation references together. Event ID remains an opaque unencrypted unique index; sequence and acknowledgment state remain accessible for FIFO reads and deduplication. The existing operational recording-session/owner/health tables still expose the IDs, start/end times, status, counts and fixed reason codes needed for lifecycle recovery and health reporting. Key IDs are opaque UUIDs, not key material.

The encrypted envelope is versioned independently of the event schema and database schema:

```json
{
  "encryptionVersion": 1,
  "algorithm": "AES-256-GCM",
  "keyId": "<opaque key UUID>",
  "nonce": "<Base64 of 12 random bytes>",
  "tag": "<Base64 of 16 authentication bytes>",
  "ciphertext": "<Base64 ciphertext>"
}
```

Every encryption generates a fresh cryptographically random 96-bit nonce. GCM uses a full 128-bit authentication tag. Additional authenticated data binds the immutable event ID, encryption version, algorithm and key ID to a queue-specific domain. Nonce/ciphertext changes also invalidate authentication. The event envelope and source identifiers are inside authenticated ciphertext. Plaintext is not parsed or delivered until authentication succeeds. Unsupported formats, changed indexing IDs, damaged tags and incorrect keys fail closed; an encrypted row is never retried as plaintext.

This protects event content and identity, not the entire SQLite database. Mutable FIFO/acknowledgment/health bookkeeping and historical plaintext records are not cryptographically authenticated. An attacker with database write access can delete/reorder rows, forge legacy data or damage bookkeeping; this is not a tamper-proof audit ledger or full-database encryption.

## SecretStorage and worker handoff

The only persistent copy of encryption key material is the extension's VS Code SecretStorage entry `ai-developer-tracker.evidence-keyring.v1`. It stores a versioned keyring with a 256-bit random key, an active key UUID and retained older key UUIDs. Keys are never stored in SQLite, JSONL, settings, workspace files, command arguments, environment variables or logs.

The worker opens/checks SQLite and requests required key IDs through its private parent-port channel. The host uses `context.secrets.get/store` and transfers dedicated key ArrayBuffers back to that worker. Keys are not put in `workerData` or ordinary queue RPC results. Transfer detaches the host buffers; the worker creates Node `KeyObject`s and wipes the received buffers. Keys are kept only in worker memory until close/failure; normal close releases references. No key retrieval RPC is exposed. SecretStorage calls and small random-key generation run on the host because that VS Code API is host-only; AES operations, authenticated reads, database integrity checks and transactions run on the storage worker.

Initial key creation is permitted only when SQLite reports no previous encryption key IDs. SecretStorage store/readback must succeed before the worker accepts events. Existing invalid keyrings or missing required keys are never overwritten/regenerated. Opaque key IDs remain registered even after acknowledgment removes encrypted payloads, preventing accidental key replacement on an apparently empty encrypted queue. Required keys are checked before event verification and owner recovery. A failed startup leaves committed records intact and blocks recording through existing queue-degradation handling.

First-use schema/key provisioning is serialized under the SQLite writer lock, and host SecretStorage provisioning is serialized within the extension process. A 15-second key-supply timeout and the existing SQLite busy timeout fail safely on unavailable/slow backends or contention. Failed secret reads, stores, readback, malformed keys, incorrect key material and missing historical keys are reported using fixed safe error codes only.

Keyring entries and per-record key IDs support a future rotation workflow: a new active key can encrypt new records while retained old keys decrypt earlier records. No rotation command, automated rotation, export, recovery UI or historical re-encryption is implemented. SecretStorage is not synced across machines; copying a database without the matching keys does not make it readable. If required keys are lost, restore them through trusted SecretStorage recovery; this extension cannot reconstruct them and does not reset the database.

Security relies on the VS Code SecretStorage platform contract. The extension cannot attest the OS credential backend or protect against a compromised host/extension process, memory inspection or crash dumps. JavaScript strings containing keys/plaintext cannot be reliably zeroed; byte buffers are wiped where owned. Workers retain their loaded keys for their lifetime; out-of-band SecretStorage deletion/replacement is detected when opening the next worker. A live worker does not poll the credential backend on every event.

## Queue compatibility and durability

Database schema 4 introduced `payload_format` and a table of opaque used key IDs. Older schema-1/2/3 databases upgrade transactionally; their existing event JSON text is preserved exactly with format 0. Legacy reads validate the common schema as before. A mixed queue reads legacy and encrypted events in original FIFO order. Public `getPending()` still returns normal validated event objects, and IDs/session IDs are unchanged. Task 3.2.3A introduced no retention/deletion. Schema 5 now adds acknowledgment/session indexing and guarded cleanup, without converting historical payloads or automatically deleting pending evidence.

Deduplication happens before encryption/insertion. Existing acknowledgment behavior clears payloads but keeps IDs/format tombstones. SQLite WAL and FULL synchronization continue to protect committed writes. Startup authenticates pending encrypted records as well as validating legacy events, counters and schema. Interrupted worker operations recover through SQLite transactions and the existing owner/session recovery; recording never resumes automatically. Encryption overhead (Base64 and envelope) is included in storage reservations and actual database/sidecar usage, preserving the existing limit and warning behavior.

Direct `LocalEventQueue` access without a key provider can read an exclusively legacy queue but cannot enqueue new plaintext. Production always uses the worker and SecretStorage; there is no plaintext fallback if secure storage is unavailable.

## Verification

Run the extension with an available SecretStorage backend, grant recording consent and capture a permitted event. Stop recording and inspect safe metadata only:

```sql
SELECT event_id, acknowledged, payload_format,
       CASE WHEN payload_format = 1 THEN json_extract(event_json, '$.encryptionVersion') END AS encryption_version,
       CASE WHEN payload_format = 1 THEN json_extract(event_json, '$.algorithm') END AS algorithm
FROM queued_events ORDER BY sequence LIMIT 20;
```

New pending rows have format 1 and version 1/AES-256-GCM. Format 0 identifies unchanged legacy plaintext. The worker's `getPending()` verifies authentication and returns decrypted events; do not print those events for diagnostics. Restart preserves event/session IDs and pending counts. Do not copy a live SQLite file without its WAL or inspect/export the SecretStorage key as part of routine verification.

Automated tests use runtime-generated keys and a test-only in-memory SecretStorage double. They exercise encryption, nonce uniqueness, tampering, wrong/missing keys, safe backend failures, first-open contention, restart/interruption recovery, acknowledgment, deduplication, mixed legacy records, retained key identifiers, metadata-only JSONL and existing privacy/collector behavior. Platform credential-backend security and recovery need deployment validation beyond mocked-backend tests.
