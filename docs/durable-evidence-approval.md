# E4.3 — Durable evidence approvals and Rails consent

E4.4 update: [the versioned event approval contract](event-approval-contract.md) adds
capture-time local v2 approvals containing RFC 8785 wire envelopes. Historical v1
approvals below retain their original exact-byte digest and are never backfilled.
Assessment request preparation is implemented; transmission remains blocked until Rails
implements the contract. No receipt/capability or upload-consent protection is relaxed.

## Security boundary and current availability

Inspected the sibling `hiring-manager/docs/assessment-evidence-consent.md`,
`assessment-event-ingestion.md`, and `assessment-recording-bindings.md`. These are
available contracts, not inferred endpoints. No Rails or React files change here.

**Rails assessment ingestion remains blocked.** Its production privacy-authorization
policy still returns HTTP 403 even after scope/secret checks. This extension neither
sends an invented attestation nor treats a consent receipt as per-event privacy proof.
There is no enable flag or alternative uploader that bypasses this guard.

The assessment controller now has a consent-lifecycle adapter. The HTTPS client implements
only the documented consent endpoints. The production assessment pairing/start/status
adapter is still unavailable, so live assessment commands cannot reach them yet. Tests
inject authenticated mock Rails responses. The local development assessment mock stores
an encrypted, blocked intent; it never manufactures a server receipt or makes network calls.
No new finalization API or real assessment-delivery worker is implemented.

## Local proof protocol, version 1

1. Existing recording/workspace/source-session and Codex/Claude content admission is
   checked by PrivacyFilter in the common EventPersistence path.
2. The sanitized normalized event is validated and serialized using UTF-8
   `JSON.stringify(validatedEvent)`. Object order is retained, not sorted. These are the
   exact event bytes used by this protocol; semantically equivalent reordered objects
   do not inherit an approval. IDs, recording UUIDs, timestamps and correlations stay intact.
3. On the SQLite worker, the current filter is run again using the bounded capture-time
   context. Only an unchanged, accepted snapshot gets an approval. A redacted diff is
   already a `file.gap`; its original patch never gets an approval.
4. The event and approval are committed **in the same FULL/WAL SQLite transaction**.
   The approval contains version, scope `local_filtered_capture.v1`, event/session/workspace
   identities, event type, SHA-256 of the exact event bytes, and the minimal captured
   workspace/source admission context. Assessment captures additionally retain the
   authenticated Rails session/origin and, only when the scope/window matches, receipt ID.
   That ID is not a privacy attestation or permission to transmit.
5. Both records use the existing AES-256-GCM SecretStorage key, fresh independent nonces,
   and distinct authenticated domains (`sqlite-event`, `sqlite-approval`). Scope states
   and revocation tombstones use `sqlite-consent` and `sqlite-revocation`. AAD includes
   the record UUID, version, algorithm and key ID. Keys are transferred only through the
   existing private storage-worker channel, never persisted alongside SQLite.
6. On upload resolution the worker authenticates the event and approval, checks indexed
   identities, exact digest, current filter, and revocation. The upload filter worker
   also requires the request event bytes to remain unchanged. If today's filter would
   redact an approved snapshot further, delivery fails closed; no changed evidence is
   sent under the old event ID. Failed proofs never fall back to the old in-memory cache.

SQLite schema version **8** adds encrypted `event_approvals`, `evidence_consents`, and
`approval_revocations` tables. Existing event payloads, IDs and delivery state are not
rewritten. Indexed reads replace memory-only proof retention; verification/filter work
runs on storage/upload workers. Proofs count toward existing storage limits and follow
explicit cleanup/session retention. No pending evidence is automatically deleted.

An event inserted before this protocol, or through the raw legacy enqueue API, never
gets an approval on retry, new consent, or restart. New evidence in the same session
cannot authorize it. Duplicates retain the first snapshot; conflicting direct queue
writes to approved IDs fail. Missing proofs, keys, invalid tags/digests, or changed
session/workspace identities block delivery. Closed recordings can retain approved
pending events, but separate upload enablement still expires on reload. Restoring local
integrity proof does not restore user permission to upload.

## What this does and does not prove

The AEAD-protected digest binds an event to the admission decision made by an uncompromised
extension holding the user's local key. It detects changed bytes, swapped records and
unauthenticated metadata. It is not a remote attestation of executing PrivacyFilter.
SHA-256 alone is not authentication; the encrypted, domain-bound approval provides local
authentication. A compromised host/client with key access can manufacture records. Whole
storage rollback or deletion of a revocation tombstone cannot be ruled out by local AEAD
alone. No stronger guarantee is claimed.

Rails can independently authenticate its bearer credential, durable recording binding,
consent receipt, approved workspace hashes/types, server window/expiry and event-ID
identity; it also applies bounded, reject-only schema/path/secret checks. It cannot
independently establish filesystem containment, actual capture time, human interaction,
source-session confirmation, source-specific content consent or perfect secret removal
from a client digest. Workspace hashes are not paths or proof of physical containment.

**No wire-level event privacy-proof protocol has been agreed.** Local proof v1 is not
sent or advertised as verified by Rails. A future reviewed protocol must bind exact event
bytes, recording, receipt, credential generation and destination, specify replay/revocation
semantics, define trust assumptions honestly, and be implemented on both sides before
removing Rails' guard. A client-generated hash or `privacyApproved: true` is insufficient.

## Scoped Rails consent contract

HTTPS, JSON, session-scoped bearer authentication and a pinned trusted API origin are
required. No cookies, recruiter JWTs, caller ownership IDs, timestamps or destination URLs
are sent as authorization inputs. Tokens remain in the existing SecretStorage-backed
assessment connection, supplied only in the Authorization header. TLS verification stays
enabled, redirects are never followed, requests time out/cancel and response bodies are
bounded. Errors contain fixed codes, not response bodies, tokens or paths.

After the separate assessment upload dialog and authenticated start/binding, **before
collectors activate**, the adapter registers the selected workspace hashes and event
categories. Recording consent alone cannot call registration. The dialog names destination,
workspace hashes, categories, potentially sensitive content, scope, expiry and revocation.

`POST /api/v2/coding_session/extension/evidence_consents`:

```json
{
  "request_id": "44444444-4444-4444-8444-444444444444",
  "local_recording_session_id": "11111111-1111-4111-8111-111111111111",
  "approval_action": "approve_upload",
  "consent_version": "assessment-evidence.v1",
  "scope": "assessment_evidence",
  "approved_workspace_ids": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  "event_types": ["file.modified", "ai.prompt.submitted"]
}
```

Exactly seven fields; lowercase UUIDv4 (client-generated), 1–32 unique lowercase SHA-256
workspace IDs, 1–17 schema event types, maximum 4096 bytes. A durable encrypted intent is
saved before sending; retries reuse its original request UUID and exact scope.

A receipt is returned only by Rails, inside `{ "data": { ... } }`:

```json
{
  "data": {
    "consent_id": "55555555-5555-4555-8555-555555555555",
    "local_recording_session_id": "11111111-1111-4111-8111-111111111111",
    "consent_version": "assessment-evidence.v1",
    "scope": "assessment_evidence",
    "approved_workspace_ids": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    "event_types": ["ai.prompt.submitted", "file.modified"],
    "destination_origin": "https://assessment.example.test",
    "consented_at": "2030-01-01T10:00:01.000Z",
    "expires_at": "2030-01-01T11:00:00.000Z",
    "server_time": "2030-01-01T10:00:01.000Z",
    "state": "active",
    "evidence_window": {"starts_at":"2030-01-01T10:00:01.000Z", "ends_at":"2030-01-01T11:00:00.000Z"},
    "upload_authorized": false,
    "privacy_authorization": "unverified"
  }
}
```

Validate exact owner-local UUID, destination, version, scope, sets, canonical UTC server
times, immutable deadline and receipt ID. Expiry cannot exceed the server assessment
deadline. No new deadline or receipt is fabricated. The local host clock cannot extend
server authorization; reported event timestamps outside the receipt window remain
ineligible and are never rewritten. Actual client capture time remains unverifiable.

`DELETE /api/v2/coding_session/extension/evidence_consents` (revoke) and
`POST /api/v2/coding_session/extension/evidence_consents/stop` (close capture window)
use exactly:

```json
{"consent_id":"55555555-5555-4555-8555-555555555555","local_recording_session_id":"11111111-1111-4111-8111-111111111111"}
```

They return the same receipt envelope with server-assigned `revoked_at` or fixed
`evidence_window.stopped_at`/`ends_at`. Local stop and clean shutdown drain collectors before requesting
closure. Restart recovery also closes prior open windows with current credentials,
without restarting recording or enabling uploads. Local revocation/closure intent is committed before network mutation; failed
requests remain pending and cannot be reported as server success. A lost registration
response can be retried with its original request ID only while fresh explicit consent
is still present. Once capture is closed or consent withdrawn, the client never replays
registration to discover a receipt: that could create a grant after withdrawal if the
original request never reached Rails. The local denial and unresolved mutation remain
durable. Rails currently documents no read-only receipt lookup by request ID; remote
reconciliation of this case remains blocked until that contract exists or credentials expire.
After restart those intents can be retried with current credentials; registration/resume
still requires fresh explicit user consent. No automatic restart recording or upload.

These local scope records are monotonic: no reassignment to another Rails session,
origin, workspace/type scope, request or deadline, no reopening capture or undoing
revocation. This client is deliberately stricter than Rails re-consent: a revoked/closed
local recording needs a new explicitly authorized recovery recording, not retroactive
approval of its old events. Server-side credential rotation/expiry and invitation
revocation remain mandatory checks on every call; a cached receipt is never sufficient.

Stopping does not acknowledge/delete evidence or finalize the assessment. Rails allows
previous in-window events only before receipt/credential/assessment expiry, with no
implicit grace. This build keeps **all assessment-scoped events blocked** from the
general development uploader, including after restart or loss of host connection metadata.

## Unchanged ingestion acknowledgment

No proof fields are added to the existing three-field request (`contractVersion`,
`batchId`, `events`) or response:

```json
{"contractVersion":1,"batchId":"66666666-6666-4666-8666-666666666666","durablyAcceptedEventIds":[]}
```

Only explicitly durably accepted original IDs can change queue delivery state. Neither
HTTP 200 nor consent success acknowledges evidence. Consent HTTP 403 remains a failure.

## Validation and remaining work

Focused tests exercise encrypted restart recovery, legacy rows, sanitized Codex/Claude
messages, diff gaps, tampering/swaps, transaction rollback, revocation, scope/window
isolation, duplicate/retry behavior, malformed/forged receipts, failed stop/revoke recovery,
and lifecycle ordering with separate consent. The normal full suite covers both adapters,
manual recording, encryption, uploader TLS/retries and assessment regressions.

Still required for live assessment delivery: the reviewed real Rails assessment
pair/start/status adapter, an agreed server privacy authorization protocol, scoped
assessment batch transport/reconciliation and separately designed finalization. Source
transcripts/workspace files remain external plaintext; SecretStorage compromise and
incomplete secret detection remain limitations. No new raw JSONL evidence is produced.

## Changed files and validation

New modules: `src/evidenceApproval.ts`, `src/evidenceConsent.ts`,
`src/railsEvidenceConsentClient.ts`, `src/assessmentEvidenceConsent.ts`.

Storage/crypto integration: `src/localEventQueue.ts`, `src/asyncLocalEventQueue.ts`,
`src/localEventQueueWorker.ts`, `src/evidenceEncryption.ts`.
Persistence/delivery integration: `src/eventPersistence.ts`, `src/uploadPrivacyContext.ts`,
`src/eventUploader.ts`, `src/eventUploadPrivacyWorker.ts`, `src/httpsEventTransport.ts`.
Assessment/UI integration: `src/assessmentController.ts`, `src/extension.ts`.

Tests: `src/test/durableEvidenceApproval.test.ts`, `src/test/railsEvidenceConsent.test.ts`,
`src/test/queueRecovery.test.ts` (the old-schema fixture removes the new tables before
simulating version 2). Documentation: this file, `docs/assessment-workflow.md`, `README.md`.

Validation on VS Code 1.141.1 / Node 24:

- TypeScript compilation: passed.
- ESLint: passed.
- Focused approval/consent/recovery/controller regression run: 60 passed.
- Final full VS Code suite: **589 passed**, including 24 new approval/consent cases and
  existing Codex, Claude, recording, encryption, privacy, HTTPS and assessment tests.
- The first full run exposed the outdated version-2 fixture; it was corrected and the
  full suite passed on rerun. No Rails/React code, production databases or real backend
  endpoints were used for validation.
