# Real Rails control and scoped event delivery (E4.5 / E4.6)

The extension now has a real `RailsAssessmentApiClient` and an assessment-scoped
`EventUploader` path for the inspected hiring-manager R4.1D/R4.2B/R4.2D contracts.
E4.6 adds [durable R4.3 finalization](assessment-finalization.md).
No Rails/React files change and no new backend is introduced. Tests use a local mock HTTPS server, not real candidate accounts.

## Setup and user workflow

1. Deploy the reviewed Rails R4.3 release (including R4.2D) and migrations with its configured HTTPS
   `BACKEND_URL` origin, TLS certificates and evidence-encryption keys. Configure the
   same trusted origin in **user settings** as `ai-developer-tracker.assessment.apiOrigin`,
   for example `https://assessment.example.com`, then reload VS Code. Empty/invalid
   configuration disables real pairing. Workspace settings cannot redirect requests.
2. Keep `assessment.mock.enabled` false for real use. The explicit development mock
   remains available separately, with a warning and dummy codes; failure never falls
   back to it. A stored mock connection cannot be treated as a real Rails assessment.
3. Complete the website's existing invitation/OTP claim and obtain a short-lived pairing
   code through its authenticated browser flow. Run **Pair Assessment** and enter that
   code. It is sent only to the configured HTTPS origin. The response's origin, upload
   endpoint, identity, credential format/expiry and status are strictly checked. Codes
   and returned credentials are never written to settings, event payloads or diagnostics.
4. **Start Assessment** obtains fresh existing recording/workspace consent and a separate
   upload decision identifying the destination, workspace hashes and event categories.
   Rails authorizes Start and binds the generated recording UUID before capture becomes
   active. The same Start request keeps its original request/recording UUIDs; Rails
   retries cannot reset the original deadline. Consent registration commits an encrypted
   local intent before the network request and validates the server receipt before
   activating collectors. Failed/missing consent prevents capture, not a guessed session.
5. Recording events pass through the existing PrivacyFilter and encrypted queue. Each
   eligible event's capture-time approval and E4.4 sidecar commit atomically. The scoped
   uploader runs asynchronously; network retries do not participate in collector writes.
6. **Stop & Submit Assessment** stops and drains local producers, closes the Rails capture
   window and keeps eligible evidence delivery available while consent/credential/deadline
   remain valid. E4.6 freezes encrypted manifests for all recordings and calls the documented
   R4.3 `/finalize` endpoint only after all evidence is acknowledged. Success requires a
   validated immutable submission receipt; outages leave submission pending.
7. After restart, recording and upload consent remain off. Status/binding recovery and
   closure of an old capture window are read/reconciled using the original IDs/deadline.
   Use **Enable Assessment Uploads** for fresh destination consent to deliver retained
   eligible evidence without restarting recording or manufacturing a new receipt.
8. **Disable Uploads** disables both upload paths and explicitly revokes assessment consent.
   Tombstoned approvals cannot be revived by Enable, reload or a new receipt. **Revoke
   Assessment Credential** cancels pending Start/uploads, stops/drains assessment recording,
   revokes owned consent and calls Rails credential revocation. Only after successful
   revocation is its local SecretStorage token deleted. Network errors retain safe recovery
   state and pending evidence; neither command acknowledges/deletes events.

The paired connection is pinned. Relevant assessment-setting changes immediately revoke
upload consent and require reload; changing origins never forwards an old credential to
the new origin. Existing manual recording and the generic uploader remain available with
their original separate consent/token configuration. Start Assessment drains/disables the
manual uploader; both paths share the existing exclusive SQLite upload-attempt lease.

## Exact endpoint mappings

All paths use the configured/pair-verified origin and no query strings. Authenticated
operations use only `Authorization: Bearer <assessment SecretStorage credential>`.
The generic development upload token is never copied or used for an assessment.

| Client operation | Method and path | Request | Response |
| --- | --- | --- | --- |
| Pair | POST `/api/v2/coding_session/extension/pair` | `{pairing_code}`; no Authorization header | `{data:{coding_session_id,api_origin,upload_endpoint,credential,credential_expires_at,status}}` |
| Start/resume | POST `/api/v2/coding_session/extension/start` | `{request_id,local_recording_session_id}` | `{data:status}` |
| Status | GET `/api/v2/coding_session/extension/status` | No body or ownership inputs | `{data:status}` |
| Register consent | POST `/api/v2/coding_session/extension/evidence_consents` | Existing seven-field `assessment-evidence.v1` request with explicit `approve_upload` | `{data:receipt}` |
| Revoke consent | DELETE `/api/v2/coding_session/extension/evidence_consents` | `{consent_id,local_recording_session_id}` | `{data:receipt}` with revoked state |
| Close capture | POST `/api/v2/coding_session/extension/evidence_consents/stop` | Same two-field mutation | `{data:receipt}` with closed window |
| Revoke credential | DELETE `/api/v2/coding_session/extension/credential` | `{}` | `{data:{revoked:true}}` |
| Upload events | POST to the Rails-issued `/api/v2/coding_session/extension/events` | `{contractVersion:1,batchId,events,eventApprovals}` | Flat `{contractVersion:1,batchId,durablyAcceptedEventIds}` |
| Finalize | POST `/api/v2/coding_session/extension/finalize` | `{contract_version:1,request_id,recordings:[{local_recording_session_id,event_count,event_ids_sha256}]}` | `{data:status}` with validated immutable `submission` receipt |

`status` uses exact snake_case Rails fields: `coding_session_id`, `state`, `server_time`,
`local_recording_session_ids`, with `started_at` and `deadline` omitted when paired and
required when active or submitted. Submitted status includes the exact R4.3 `submission` receipt. Timing is canonical UTC with three fractional digits. Rails returns
safe 401 errors for ineligible/expired/revoked/ended sessions, not invented terminal 200
objects. The adapter translates names into the existing typed controller seam while
preserving all wire names/bodies. Unknown fields/states, wrong owners, timing changes,
non-JSON/oversized responses and duplicate JSON member names (including escaped aliases)
fail closed. Raw Rails error messages/responses are never surfaced or logged.

## Protocol pin and transport gate

The supported capability is **the reviewed R4.2D assessment-events v1 contract**, pinned
in the real adapter, not an arbitrary endpoint or user bypass flag. Rails currently
advertises no dynamic capability-discovery endpoint/response field. No such field is
invented. Operators must deploy R4.2D at the configured origin; older/unsupported servers
reject the sidecar and pause delivery without acknowledgment. Live deployed-version
verification remains necessary before real candidate use.

The current Rails receipt still contains `upload_authorized: false` and
`privacy_authorization: "unverified"`. These are retained exactly: a receipt alone is not
blanket event authorization or evidence of trusted PrivacyFilter execution. Under R4.2D,
individual events can instead be accepted only when the versioned sidecar and every
independent server authorization/privacy check pass. This client implements those documented
semantics; it does not flip receipt booleans, claim attestation or suppress a Rails 403.

Before any assessment event POST, all of the following are required:

- A real-mode paired connection with the configured origin and exact Rails-issued event
  endpoint, current SecretStorage credential and volatile destination upload consent.
- An authenticated fresh GET status after batch selection, preserving the saved official
  start/deadline, owner and known recording bindings, before expiry. No host clock resets
  or caller-supplied candidate/challenge/session ownership fields authorize anything.
- A matching encrypted receipt scope, recording/workspace/event categories, permitted
  capture window, no local revocation/pending mutation, and an immutable **capture-time
  credential-generation binding**. This new internal field is a SHA-256 digest of the
  random bearer, encrypted in consent state; it is never a raw token, global setting,
  request field or public proof. It cannot be changed, removed or backfilled. Historical
  scopes without this evidence stay blocked rather than being attached to today's token.
- A storage-worker-authenticated original event and durable capture-time E4.4 approval,
  matching exact event bytes, IDs, workspace, recording, receipt and canonical digest.
  Current PrivacyFilter must still accept the exact snapshot. No upload-time approval
  minting, changed-diff evidence, raw JSONL fallback, or historical approval reconstruction.
- A process-local opaque batch permit issued by the pinned real adapter after those
  status/scope checks. It binds the batch ID, ordered event IDs, recording, receipt,
  destination and credential digest. A plain JSON lookalike cannot satisfy this gate;
  it is not persisted/restored and is not sent as remote attestation.
- A final recheck of volatile consent, SecretStorage credential and durable scope before
  transport. The worker-built body must contain the matching E4.4 sidecars; an assessment
  permit cannot authorize an ordinary body, or an ordinary uploader an assessment body.

SQLite batching is filtered by the already-authorized recording UUID before decryption
and claiming. FIFO order is preserved within a recording, one recording/receipt per
request. Associated recordings are drained in durable binding order. Unrelated/manual
sessions cannot be claimed or transmitted by this path. Sidecar overhead is reserved in
batch sizing, and the entire serialized request remains size-bounded. Unapproved historical
head events block their recording instead of being skipped or retrospectively approved.

The existing uploader retains its single active batch, durable retry state, bounded jitter/
Retry-After, cancellation and explicit partial acknowledgment handling. Only valid accepted
IDs are marked delivered after server response validation. Failed/malformed/unknown/wrapped
acks, 401/403, TLS errors, redirects, timeouts and outages never imply success. Transient
network/408/429/5xx failures retain pending evidence and retry; authentication/configuration/
privacy/protocol failures pause until explicit remediation. Control operations fail safely
and retain original binding/request intent for status reconciliation; they do not retry
pairing blindly or manufacture a successful registration after an uncertain response.

HTTPS uses valid certificate/hostname checks, minimum TLS 1.2, bounded responses, request
cancellation/timeouts and no redirects. Pairing is the only unauthenticated control call.
The local HTTPS test certificate is trusted only by that test's private agent; neither
production code nor tests disable TLS verification globally. Diagnostic notices contain
fixed status codes, not pairing codes, tokens, server bodies, source paths or evidence.

## Recovery and limitations

- This is an extension adapter, not a completed production rollout. Validate the deployed
  Rails build, trusted `BACKEND_URL`/upload origin, TLS, encryption, migrations, browser
  OTP/pair-code UI and real VS Code source capture together. No live Rails/React changes
  or real candidate uploads are performed by these tests.
- R4.3 finalization is implemented; no upload grace exists. Stop never stops the official timer. Upload
  must complete before receipt/credential/assessment expiry; pending evidence is retained
  safely if authorization expires. There is no automatic acknowledgment or local timer reset.
- Credential rotation invalidates prior receipt-generation authorization on both sides.
  The controller still refuses replacing an already paired attempt or adopting unknown
  server bindings. A separate controlled re-pair/reconciliation UX is needed for expired/
  revoked credentials or lost local connection metadata; this task does not transfer old
  approvals, delete pending evidence or silently adopt another assessment.
- A lost registration response followed by withdrawal cannot be reconciled through a
  nonexistent read-only receipt lookup. Local denial persists; the adapter never replays
  approval after withdrawal merely to discover a receipt. Recovery remains explicit.
- Source event timestamps are local and checked against server bounds. Clock skew can
  block capture eligibility/upload; timestamps and digests are never rewritten to fit.
- A cancellation cannot undo a request already committed by Rails. If an acknowledgment
  is lost or consent is revoked in flight, retained local IDs support safe server deduplication.
- Client digests/permits establish consistency within an uncompromised extension, **not**
  trusted execution of PrivacyFilter or proof of human consent interaction. Rails must
  continue independent credential, consent, ownership, schema and sensitive-content checks.
- Existing encryption/privacy heuristics remain unchanged apart from the added confidential
  generation binding. Neither platform can guarantee detection of every secret. Evidence
  is plaintext transiently in bounded worker/HTTPS memory, never new diagnostic files.

## Files and validation

Created `src/railsAssessmentApiClient.ts`, `src/railsControlResponse.ts`,
`src/assessmentEventDelivery.ts`, `src/test/railsAssessment.e2e.test.ts`,
`src/test/fixtures/rails-assessment-control.v1.json`, and this document.
Modified files:

- `src/assessmentApiClient.ts`, `src/assessmentCommands.ts`, `src/assessmentController.ts`,
  `src/assessmentStorage.ts`.
- `src/assessmentEvidenceConsent.ts`, `src/evidenceConsent.ts`,
  `src/railsEvidenceConsentClient.ts`.
- `src/eventUploader.ts`, `src/httpsEventTransport.ts`.
- `src/localEventQueue.ts`, `src/asyncLocalEventQueue.ts`, `src/localEventQueueWorker.ts`.
- `src/extension.ts`, `package.json`, `README.md`.
- `docs/assessment-workflow.md`, `docs/durable-evidence-approval.md`,
  `docs/event-approval-contract.md`, `docs/event-uploader.md`.

E4.5 introduced no event/approval/acknowledgment, schema, key-format or dependency changes.
E4.6 adds encrypted SQLite manifest metadata (schema v9), with unchanged normalized events,
approval sidecars, flat acknowledgments, keys and dependencies. See the finalization document.

Validation completed for E4.5:

- `npm run compile` — passed.
- `npm run lint` — passed.
- Focused Mocha run covering Rails HTTPS integration, assessment lifecycle/persistence,
  consent, approval envelopes, batching, durable approval and canonicalization — **102
  passing**, including **25 new Rails integration cases**.
- `npm test -- --code-version 1.141.1` — **630 passing**, extension host exit code 0.
  The complete suite was run once after implementation.
- `git diff --check` — passed.

The HTTPS fixtures cover pairing/start/status/consent, encrypted capture and filtered
delivery, partial/invalid acknowledgments, 403/429/503, interruption/timeouts, revocation,
restart recovery, credential-generation isolation, malformed responses, redirects and
certificate rejection. Only private test agents trust the local test certificate. These
results do not establish compatibility with a live deployed Rails instance.
