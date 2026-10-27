# E4.6 — durable Rails assessment finalization

This extension implements the actual `hiring-manager` R4.3 contract in
`docs/assessment-finalization.md`, its request validator, service and serializer.
No Rails or Next.js changes are included. A real deployed Rails/website/extension
assessment has **not** been verified by the automated HTTPS fixtures.

## Stop & Submit

1. Stop the associated RecordingController and persist `submission_pending` with the
   existing, stable submission UUID. Do not start another assessment recording.
2. Disable the assessment delivery driver, drain file/diff/Codex/Claude/correlation
   collectors and SQLite writes, then complete the local recording. A degraded
   persistence path blocks submission.
3. Fetch authenticated Rails status using the original credential and timing. Close
   every bound capture window via the existing consent stop endpoint. Confirmed
   stopped receipts survive restart; closing them again is a local no-op. An uncertain
   close is retried; a receipt is never invented or renewed.
4. Freeze one encrypted SQLite snapshot for **all** bound recordings, with their
   original event counts and ID digests. Include acknowledged tombstones and empty
   approved recordings. The worker verifies capture-time approval associations and
   closed scopes. Historical/unapproved, missing or retained-away evidence blocks
   finalization. The snapshot is AES-256-GCM protected with a separate AAD domain,
   existing SecretStorage keys and the original request UUID. No extra plaintext
   evidence is persisted or returned to the host.
5. Obtain fresh explicit upload consent after restart, then use the existing scoped
   uploader/approval sidecars and flat acknowledgments. Only explicitly accepted IDs
   become acknowledged. The foreground drain uses the same single driver and SQLite
   retry lease, at most 128 batches and the controller operation timeout. Partial
   acknowledgments, backoff or unavailable transport can leave submission pending;
   background delivery may continue while consent remains valid. Retry Stop & Submit
   once delivery recovers. Backoff and pause protections are preserved.
6. Require zero pending/missing evidence, verify the unchanged frozen snapshot, stop
   the delivery driver, and POST the exact frozen finalization body. Never reduce a
   manifest to match a partial upload or acknowledge from a finalization receipt.
7. Validate the submitted receipt, original server timing, all bindings, request UUID,
   recording count and event count. Only then persist/display `submitted`. No further
   assessment capture or uploads are enabled. Manual development recording remains
   separate and cannot be adopted by the submitted assessment.

## Exact R4.3 request and response

`POST /api/v2/coding_session/extension/finalize`, HTTPS, JSON, no query string,
existing session-scoped SecretStorage Bearer credential:

```json
{
  "contract_version": 1,
  "request_id": "33333333-3333-4333-8333-333333333333",
  "recordings": [{
    "local_recording_session_id": "11111111-1111-4111-8111-111111111111",
    "event_count": 1,
    "event_ids_sha256": "d95688f63f38ee887a32eaa5c73f75dec8c769dee36ba9220fc7096bec4e80da"
  }]
}
```

Each digest hashes UTF-8 RFC 8785 canonical JSON of the lexicographically sorted,
unique, lowercase original UUID array, without whitespace, newline, BOM, payloads
or approval envelopes. The example hashes
`["22222222-2222-4222-8222-222222222222"]`; an empty recording hashes `[]` to
`4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.
The worker streams the same canonical UUID-array bytes, keeping memory bounded.
Maximum 32 distinct recordings, 16 KiB JSON, safe integer counts. Extra fields,
noncanonical IDs and unsupported versions are rejected locally.

```json
{"data":{
  "coding_session_id":"42","state":"submitted",
  "server_time":"2030-01-01T10:30:00.000Z",
  "started_at":"2030-01-01T10:00:00.000Z",
  "deadline":"2030-01-01T11:30:00.000Z",
  "local_recording_session_ids":["11111111-1111-4111-8111-111111111111"],
  "submission":{
    "contract_version":1,"request_id":"33333333-3333-4333-8333-333333333333",
    "submitted_at":"2030-01-01T10:30:00.000Z","event_count":1,"recording_count":1
  }
}}
```

GET extension/status returns the same submitted receipt. The adapter rejects
missing, malformed, mismatched, unexpected or changed receipt fields and invalid
submission timestamps. JSON object field order is immaterial. Upload request
`events`/`eventApprovals` and the flat durable acknowledgment contract are unchanged.
The old count-only `/submit` mock proposal is **not** sent to Rails.

## Recovery, privacy and retention

- Submission UUID is generated once with the paired connection and retained in
  allowlisted local metadata. The immutable manifests and assessment/origin association
  live in encrypted SQLite schema v9 (`assessment_finalizations`,
  `finalization_recordings`). The additive migration does not rewrite events or keys.
- Snapshot creation is transactional with respect to capture and cleanup. New IDs
  cannot enter frozen recordings; duplicates remain idempotent. Retrying revalidates
  the complete retained set against the authenticated snapshot and cannot replace it.
- After an unknown network outcome, status may recover a valid matching receipt,
  including after the assessment deadline. Recovery additionally requires the existing
  encrypted snapshot and zero pending/missing evidence. No frozen snapshot is created
  retroactively from an unsolicited submitted status.
- No first-finalization or upload grace exists. Rails remains authoritative for
  deadline, consent, invitation and credential expiry/revocation. A lost response does
  not prove success; 409 means reconciliation/conflict remains unresolved, 401/403
  retain evidence and block, and outages retain the same request for retry. Raw server
  messages, tokens, source paths and payloads never enter status/errors.
- Automatic retention skips frozen recording sets, including acknowledged tombstones,
  to preserve exact recovery. They remain until explicit existing local-evidence cleanup;
  this conservative pin also applies after success. E4.7 archived assessments and their
  evidence additionally remain pinned against broad local cleanup; see [archive recovery](assessment-archive.md).
  Cleanup of unarchived assessments can make receipt recovery
  impossible and never grants a new approval. Encryption keys are unchanged.
- A receipt reconciles declared evidence with committed Rails IDs. It does not attest
  trusted execution of the extension or prove undisclosed local events never existed.
  Existing separate consent, PrivacyFilter, authenticated exact-event approvals,
  workspace boundaries, encryption and TLS checks remain required.
- Expired/revoked credentials, lost local connection/key data, unapproved historical
  events or already-expired first submissions need operator recovery. This task does
  not add credential replacement, deadline extension, finalization polling or results UI.

## Verification and manual development E2E

Automated cases use isolated temporary encrypted SQLite databases and a realistic
local mock Rails HTTPS server. A self-signed certificate is trusted only by each test
transport; TLS verification is never disabled globally. Run:

```sh
npm run compile
npm run lint
npm test -- --code-version 1.141.1 --grep 'Assessment|assessment|Real Rails|queue'
npm test -- --code-version 1.141.1
```

Implementation validation: TypeScript compilation and ESLint passed. The assessment/queue
regression run passed **185 tests**; the complete suite passed **663 tests** in the cached
VS Code 1.141.1 host, including file/diff, Codex/Claude, privacy, encryption, delivery,
retention and the new finalization cases. The final focused run also verifies the exact
Rails UUID version rules. These are automated mock-server results, not a live assessment.

For a later live test, use only approved development data:

1. Run the reviewed Rails R4.3 build with its **development** migrations applied,
   configured evidence keys, valid trusted HTTPS origin and required routes (including
   `/finalize`) available through any restricted test proxy. Do not expose debug tools.
2. Run the existing Next.js candidate workflow, claim a generated VS Code invitation
   through OTP, and generate a pairing code. No production invitations or external
   emails are needed for this test.
3. Set the extension user `assessment.apiOrigin` to that same HTTPS origin, keep mock
   mode off, reload, Pair Assessment, then Start Assessment. Explicitly approve recording,
   workspace and upload consent. Check the official deadline came from Rails.
4. Edit a dummy eligible file; optionally approve dummy Codex/Claude sessions. Confirm
   safe event-type counts and upload status without opening plaintext evidence.
5. Before the deadline, select Stop & Submit. Expect `submitted` only after all valid
   acknowledgments and the verified Rails receipt. In the development database, verify
   the immutable CodingSessionSubmission, recording manifests and correct CodingSession
   associations using counts/IDs, without logging payloads or credentials.
6. Repeat Stop & Submit, reload and Show Assessment Status: same submission request and
   timestamp, unchanged deadline, no resumed recording, consent changes or event uploads.
7. With another development attempt, interrupt network delivery/finalization and reload.
   Verify `submission_pending`/recovery with retained encrypted evidence. Restore transport,
   approve uploads afresh and retry before expiry with the same request/manifests. If Rails
   already committed, status recovers the receipt without re-uploading or extending time.
8. Check a manual development recording still works independently. Browser interviews
   and their timer are outside this extension-only change and require their own live check.
