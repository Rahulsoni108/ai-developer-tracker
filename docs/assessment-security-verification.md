# Assessment integration and security verification — E4.2

This task tests the existing foundation and fixes two reproduced controller defects. It adds no backend client, production upload path, API endpoints, dashboard or schema changes. Rails and React repositories are untouched.

## Test setup and coverage

`src/test/assessmentWorkflow.e2e.test.ts` runs in the VS Code test host with isolated temporary workspaces/databases, in-memory metadata/SecretStorage doubles and bounded waits. Pairing codes enter the existing controller input boundary; consent dialogs are simulated. No real credentials, Claude/Codex account, subscription or backend requests are used.

The harness uses real RecordingController, FileTracker, DiffTracker, CodexEventParser, ClaudeCapture/hook bridge/parser, ActivityCorrelator, PrivacyFilter/EventPersistence, encrypted SQLite worker, EventBatchManager and EventUploader. VS Code edits/saves are real. Claude payloads traverse authenticated local IPC; Codex inputs are representative confirmed-session parser records. The mock Rails server survives controller/queue recreation to represent server durability. The test deliberately sets server time differently from the host clock.

EventUploader receives an **in-memory transport double**, not an HTTP client. The fixture supplies a test-only assessment binding/privacy-proof selector to simulate future authorized delivery, and separately tests the generic uploader's existing assessment exclusion guard. Successful mock responses explicitly advertise accepted event IDs and exercise the real SQLite acknowledgment bookkeeping. No application mock command can automatically acknowledge evidence or create this delivery adapter.

There are 25 new checks:

- Complete pairing, independent recording/upload consent, server authorization, original recording UUID binding, file/Codex/Claude capture, redaction, AES-GCM SQLite persistence, stop/drain, durable acknowledgment and finalize flow.
- Partial acknowledgments preserve FIFO remainder and original IDs; finalization waits for all pending evidence.
- HTTP 200 without an acknowledgment, a wrapped Rails `data` acknowledgment, wrong batch IDs and unknown event IDs cannot acknowledge/finalize evidence.
- Invalid, expired and reused pairing-code responses cannot create a local identity or recording. Expiry is a scripted rejected server response; no new pairing-code expiration implementation is added.
- Missing recording/upload consent, withdrawn consent, missing/revoked credentials and event-delivery authentication failures fail closed.
- Duplicate Start requests, lost start responses and finalization failures both before commit and after a committed response is lost preserve recovery/idempotency behavior.
- Deadline expiry and attempted timer extension cannot reset the official deadline or restart capture.
- Restart retains encrypted evidence, Rails identity/deadline and original event IDs; fresh recording/upload consent is required. Historical evidence without volatile exact-content approval remains blocked.
- Wrong Rails session IDs, lost confirmed recording bindings, and mixed batches containing another recording with its own valid privacy proof cannot cross the assessment boundary.
- Manual recording and both AI adapters remain usable independently; generic development uploads cannot send assessment evidence.
- All documented JSON request/response examples parse; the batch example contains schema-valid normalized objects, its event UUIDs belong to the start binding, and the flat acknowledgment names only original event IDs in that batch.

## Integration defects fixed

1. **Finalize-consent revocation race:** a delayed affirmative dialog response could restore consent after revocation and send a finalize request. The controller now captures the consent generation and checks generation/disposal before accepting the response. Revocation wins; the regression verifies zero finalize calls, false consent and an incomplete submission.
2. **Confirmed binding removal:** status validation allowed a previously confirmed recording UUID to disappear, overwrote the last verified binding snapshot, then failed later during evidence reconciliation. The controller now rejects removal before updating trusted status. Provisional IDs from interrupted, never-authorized starts can still be reconciled safely; confirmed bindings remain immutable.

The workflow document's illustrative event array was also corrected to show actual normalized objects rather than placeholder strings. The uploader contract/implementation itself is unchanged.

## Contract and readiness

Control endpoints may retain the proposed Rails V2 `{data: ...}` envelope; a future typed adapter must unwrap/map those responses. Event ingestion must preserve the existing exact top-level `{contractVersion, batchId, durablyAcceptedEventIds}` acknowledgment. Durable storage/deduplication must commit before acknowledgment; HTTP success and client-side event counts do not prove complete evidence. See [the proposed contract](assessment-workflow.md).

**Not yet ready for a production Rails connection.** The default remains unavailable and the opt-in UI mock remains local/memory-only. Required integration work is unchanged:

1. Implement the reviewed HTTPS control client and Rails pairing/start/status/finalize endpoints, scoped credentials, expiry/revocation and immutable recording bindings.
2. Resolve existing Rails timer-at-OTP-claim behavior versus official Start Assessment timing, preserving legacy interview behavior and setting the official deadline only once.
3. Implement assessment-scoped batching/delivery without transmitting other assessment/manual evidence; define durable receipt/manifest verification and an explicit server-approved late-upload policy if needed.
4. Resolve restart privacy-proof recovery without recreating authorization from IDs or consent alone. Currently such evidence remains pending/blocked, as intended.
5. Verify server evidence encryption/retention/access controls and implement the website's pairing/start/review integration in later tasks. The UI mock losing its server on reload is an explicit limitation, not a reason to fabricate a new attempt.

Run focused checks with `npm test -- --code-version 1.141.1 --grep 'Assessment'`, then the complete suite with `npm test -- --code-version 1.141.1`. Both include compilation and ESLint. Earlier E4.1 validation results remain labeled as the baseline in the workflow document.

Validation on VS Code 1.141.1: TypeScript compilation and ESLint passed; **52 focused assessment tests** passed (including the **25 new E4.2 checks**); the full suite ran once and passed **565 tests**. No real backend requests were made.
