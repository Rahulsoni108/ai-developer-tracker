> E4.3 update: see [durable approvals and the actual Rails consent contract](durable-evidence-approval.md). The control contract below is the older mock proposal; the real pairing/start/status adapter remains unavailable.

# Assessment workflow foundation — E4.1

This build adds an extension-side controller and typed API seam, not a Rails transport. Rails and React repositories are unchanged. The four commands are **Pair Assessment**, **Start Assessment**, **Stop & Submit Assessment**, and **Show Assessment Status**.

## Safe defaults and local development

The default `UnavailableAssessmentApiClient` rejects every request. No HTTP request, fake production session, recording, token exchange or automatic upload happens when Rails is unavailable.

For synthetic development only, set `ai-developer-tracker.assessment.mock.enabled` to `true` in **user settings**, reload, choose Pair Assessment, acknowledge the mock warning, and enter `DEMO-ASSESSMENT`. This is an in-memory server double, explicitly labeled mock in status. It does not call Rails, acknowledge evidence, or transmit events. The mock server loses its state on extension reload; retained client metadata then fails closed rather than recreating a server attempt/deadline. Automated restart tests preserve the mock server instance while recreating the controller/queue, representing a durable future Rails server.

Only one assessment connection is retained in this foundation. Replacing an existing connection is deliberately refused; production unpair/reassignment and recovery UX require a later reviewed task.

## Controller and recording lifecycle

States are `unpaired`, `paired`, `starting`, `active`, `stopping`, `submission_pending`, `submitted`, `recovery`, and `error`. Safe fixed reason codes accompany failures; no pairing codes, credentials, paths or evidence are displayed. `RecordingController` remains the sole owner of recording state.

Start first verifies server status, then calls the existing RecordingController consent/workspace flow. A preparation listener obtains **separate destination-scoped upload consent**, disables the generic development uploader, persists the proposed local-recording binding, and asks the server to authorize/bind that UUID. Only a valid active response and a successfully persisted binding/deadline allow RecordingController to activate collectors. Cancellation/refusal or backend failure prevents recording. Preparations may create an empty cancelled local queue session before server authorization; no collector events are emitted until activation. Concurrent/repeated starts do not create extra recordings.

The server CodingSession ID is a decimal string; local recording IDs remain UUIDs in the unchanged common event schema. The connection stores their association, not a replacement session ID. A resume creates a fresh local recording UUID with fresh consent, attached to the same Rails attempt and original deadline. Source-specific Codex/Claude session/content approvals remain unchanged.

Metadata is allowlisted in extension `globalState`: connection/endpoint identifiers, credential reference, local recording IDs, last server timing/status, lifecycle phase and a stable finalize request ID. Credentials are stored/read back only through SecretStorage, using assessment-specific keys separate from the development upload token. Pairing codes are not persisted. Invalid metadata, missing keys, wrong session IDs, unknown remote bindings, clock rollback or a changed established deadline fail closed.

Status shows UTC timing from the last server response and a clearly labeled server-snapshot remaining duration. It never calculates authority from the host wall clock, starts a fresh timer offline, or silently resumes recording on reload. There is no automatic status polling or deadline timer in E4.1. A status failure stops assessment capture conservatively; server-expired/revoked status stops/drains it. Server enforcement and later online/offline deadline UX remain necessary.

Stop & Submit stops local recording first, durably records submission intent, drains file/diff/Codex/Claude/correlation/persistence work and completes the local queue sessions. An indexed worker query returns only retained total/pending counts and missing-session count for **all bound recording IDs**. Pending (including privacy-blocked) or missing/retained-away evidence prevents finalization. It never falls back to a global zero-pending count, automatically acknowledges data, or treats an HTTP success as acceptance. A local persistence degradation also blocks submission.

Only after there are no pending/missing records does the API get a finalize request. The controller displays `submitted` only after a validated server confirmation and local delivery check; lost responses leave `submission_pending` until authoritative recovery. Finalize retries reuse the stored request ID. **No upload grace period is assumed.** The generic uploader cannot upload assessment-bound recordings; assessment-scoped batching/transport is a production blocker, so the UI mock normally remains pending after capturing events. Existing batch/acknowledgment APIs are exercised only by tests simulating explicit durable server acceptance.

Disable Uploads also revokes volatile assessment upload consent; any future retry/finalization needs fresh consent. Reload always clears this consent. E4.3 persists exact sanitized-event approvals atomically in encrypted SQLite. Only authenticated capture-time approvals survive restart; historical events without them remain blocked. Assessment receipts never create these proofs or enable ingestion; see the E4.3 protocol. Pending evidence is preserved and never presented as successfully submitted. Manual Start/Stop Recording continues to work independently, and an already running manual recording cannot be adopted as an assessment.

## Proposed Rails API contract (not implemented)

Use the existing Rails application and CodingSession/InterviewPipeline attempt. Browser invitation + OTP claim must already have succeeded. Pairing codes must not authenticate until that server condition is true; use hashed, expiring, single-use codes, rate limits and explicit candidate approval. The extension does not submit OTPs or read browser cookies. A future HTTPS adapter will map Rails snake_case fields/envelopes to the typed camelCase client interface.

### Pair

`POST /api/v2/coding_session/extension/pair`

```json
{"pairing_code":"EXAMPLE-ONLY"}
```

```json
{"data":{"coding_session_id":"42","api_origin":"https://assessment.example.test","upload_endpoint":"https://assessment.example.test/api/v2/coding_session/extension/events","credential":"EXAMPLE-SECRET-RETURNED-ONCE","status":{"coding_session_id":"42","state":"paired","server_time":"2030-01-01T10:00:00.000Z","local_recording_session_ids":[]}}}
```

Pin the HTTPS origin in the trusted API client; never choose an endpoint from a code, workspace settings or arbitrary callback. The credential must be limited to this attempt and these operations; it is not a recruiter JWT or the browser session cookie.

### Authorize start / resume

`POST /api/v2/coding_session/extension/start`, `Authorization: Bearer <assessment credential>`

```json
{"request_id":"11111111-1111-4111-8111-111111111111","local_recording_session_id":"11111111-1111-4111-8111-111111111111"}
```

```json
{"data":{"coding_session_id":"42","state":"active","server_time":"2030-01-01T10:00:00.000Z","started_at":"2030-01-01T10:00:00.000Z","deadline":"2030-01-01T11:00:00.000Z","local_recording_session_ids":["11111111-1111-4111-8111-111111111111"]}}
```

Rails must use a transaction/row lock to set official assessment timing **exactly once per CodingSession**, and durably register each authenticated local recording binding before responding. Repeated requests, reconnects, new local recording IDs and credential rotation must not extend it. Request IDs are idempotent; conflicting reuse is rejected. A retry after an ambiguous response first retrieves server status and reconciles its binding without losing evidence.

**Existing Rails incompatibility:** current `ClaimInvitationService#first_claim!` already fills `started_at`/`ends_at` at OTP claim, and those fields are non-null. The new official-start workflow needs an explicit backend design to defer or separately represent assessment timing while preserving legacy interview behavior. Do not silently reset an existing interview deadline. No Rails changes are included here.

### Status

`GET /api/v2/coding_session/extension/status`, same bearer credential. Returns the same status shape as start; state is `paired`, `active`, `submitted`, `expired` or `revoked`. Timing is UTC. An established start/deadline remains immutable, and server time must not move backwards across successful client observations. Session ownership is derived from the credential, not body-provided candidate/challenge IDs.

### Event delivery — unchanged contract

Send normalized event **objects** to the bound event endpoint, using the unchanged uploader request:

```json
{"contractVersion":1,"batchId":"22222222-2222-4222-8222-222222222222","events":[{"schemaVersion":1,"eventId":"33333333-3333-4333-8333-333333333333","sessionId":"11111111-1111-4111-8111-111111111111","source":"vscode","eventType":"file.saved","timestamp":"2030-01-01T10:01:00.000Z","workspaceId":"workspace-example","payload":{"relativePath":"example.ts"}}]}
```

Original event IDs, UUID recording session IDs, schema versions and sanitized contents stay unchanged. Rails validates each recording binding, event/schema/size limits and authorization; stores/deduplicates by original event ID before acknowledging.

The existing uploader requires the exact **top-level**, unwrapped response:

```json
{"contractVersion":1,"batchId":"22222222-2222-4222-8222-222222222222","durablyAcceptedEventIds":["33333333-3333-4333-8333-333333333333"]}
```

Do not wrap that acknowledgment in `{data: ...}` or change its semantics. This requires a documented transport-contract exception at the future Rails ingestion boundary; ordinary control endpoints retain the Rails V2 envelope. HTTP 200 alone never acknowledges events. Existing retry, TLS and PrivacyFilter protections remain mandatory. No ingestion transport is introduced in E4.1.

### Finalize

`POST /api/v2/coding_session/extension/submit`, same bearer credential:

```json
{"request_id":"44444444-4444-4444-8444-444444444444","local_recording_session_ids":["11111111-1111-4111-8111-111111111111"],"retained_event_count":12}
```

Success returns `{data: <status>}` with `state: "submitted"`, original timing and bindings. Rails must independently verify durable accepted evidence for the authenticated attempt; a client count is a reconciliation hint, not proof of completeness. Use an immutable finalization receipt/idempotency record and a closed-recording manifest or equivalent server reconciliation before production. The mock checks accepted count/bindings and idempotency of finalized state; it is not a production evidence verifier.

Use safe `{ "error": "<fixed message>" }` responses for failures: 401 invalid credential, 403 revoked/unclaimed access, 409 conflicting binding/idempotency/evidence incomplete, 410 expired session/code, 422 invalid input, 429 throttling, and 503 unavailable. Retain pending events on all failures. No code, token, prompt, diff or raw server response enters diagnostics. Control requests need bounded timeouts/cancellation, valid TLS and no credential forwarding on redirects when a real client is implemented.

## Validation / remaining work

Focused tests cover controller transitions, independent consent, unavailable/rejected pairing, repeated starts, lost start/finalize responses, stop/drain failures, pending/missing evidence, real queue acknowledgment bookkeeping, restart, manual recording isolation, malformed metadata and command registration. The full existing suite checks source adapters, encryption/privacy and development uploads.

E4.1 baseline validation on VS Code 1.141.1: TypeScript compilation and ESLint passed; all **27 focused assessment tests** passed; the complete suite ran once and passed **540 tests**. See [E4.2 integration/security verification](assessment-security-verification.md) for subsequent coverage and fixes. Reproduce with `npm test -- --code-version 1.141.1 --grep 'Assessment'` and `npm test -- --code-version 1.141.1` (both run compilation/lint first).

Production blockers: implement/review Rails endpoints and official timing semantics; securely bind pairing to OTP-claimed identity; implement narrowly scoped assessment batching/delivery and durable server receipts; define explicit late-upload policy if needed; resolve historical upload approval recovery without weakening current proof requirements; design server evidence encryption/retention/access controls; implement React pairing/start/review UX. No backend, React, API networking or event schema changes are made by this task.
