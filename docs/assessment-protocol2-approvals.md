# E4.9 — Prospective protocol-2 disclosure approvals

## Contract and boundary

Implemented against the sibling Rails R4.7 `docs/assessment-event-disclosure-contract.md`,
`EventApprovalContract`, `EventDisclosureAuthorization`, disclosure receipt validators,
and `spec/fixtures/assessment-approval-v2.json`. The portable Rails fixture is copied
unchanged to `src/test/fixtures/rails-assessment-approval.v2.json` and verified with the
existing RFC 8785 implementation. No Rails/React changes or new endpoints are included.

Recording, upload and recruiter disclosure are independent permissions. Existing
workspace restrictions, provider-specific session confirmation/content consent, filters,
AES-GCM queue encryption, upload authentication and finalization remain mandatory.
Disclosure does not broaden provider discovery or admit unrelated conversations.

New eligible captures use protocol 2 only after an authenticated, validated grant/status
response confirms the exact recording, credential generation, upload receipt, deadline,
workspace, category and (for AI) selected provider/session. Supported categories:

| Evidence | Category |
| --- | --- |
| Eligible file activity, diffs, baselines and reconstruction gaps | `code_changes` |
| Approved Codex/Claude user prompts and visible responses | `ai_interactions` |
| Approved AI tool activity and supported Claude session lifecycle | `tool_activity` |
| Activity relationships | Protocol 1 only; both referenced approvals are not yet supported by Rails |

No prompts, code or extra fields are introduced by this feature. Provider adapters retain
existing limitations: only supported visible messages/hooks/transcripts, no private
reasoning or system/developer instructions. No inferred relationship proves AI authorship.

## Atomic capture, freshness and restart

`EventPersistence` records monotonic admission time before its asynchronous buffer. The
storage worker rechecks the sanitized event, exact consent and capture lease inside the
same SQLite transaction that writes encrypted event and approval. A buffered event
admitted before grant confirmation cannot acquire permission later. Existing IDs retain
their original immutable proof, even after retries, grants or revocations.

The existing encrypted disclosure state and capture approval tables are reused; no schema
migration is required. A protocol-2 local approval adds an encrypted disclosure request
reference for direct scope lookup. Neither it nor credential fingerprints enter sidecars.

Permission is process-local and short-lived: status refresh every five seconds during
recording, a 2.5-second poll timeout, and a ten-second confirmation lease measured from
request start using monotonic time. Slow/failed refresh cannot renew a lease. Host clock
changes cannot extend it. Pending grants, unknown receipts, revoked/expired scope, stopped
capture, archive and unavailable status do not authorize new protocol-2 captures. Existing
independently authorized upload-only capture continues as protocol 1. This fallback does
not grant recruiter content access or change previously stored protocol-2 evidence.

Local revocation immediately suspends and blocks that receipt before serialized storage
and network work. An older in-flight confirmation cannot re-enable it. Server revocation
is prospective. Remote revocation cannot be observed instantly during network partitions;
Rails remains authoritative and can reject an event captured during the bounded stale
window. Such evidence stays pending with its original sidecar; no silent downgrade,
redating or replacement approval is attempted.

After restart, encrypted event approvals survive but process-local leases do not.
Recording never resumes automatically. Before sending retained protocol-2 events the
assessment uploader freshly inspects each referenced receipt through Rails, verifies
historical capture scope and preserves exact bytes. This can authorize pre-revocation
captures while upload consent, credential and assessment eligibility still allow them;
it cannot authorize a capture at/after revocation or resume old recording permission.
Missing receipts/keys, tampering, stale status and archived contexts fail closed.

## Exact wire format

The root remains `contractVersion: 1`, `batchId`, `events`, `eventApprovals`; normalized
schema version is still 1. Mixed protocol-1/2 batches preserve order, with exactly one
sidecar per event and one recording/upload receipt per batch. Protocol 1 retains exactly
its original eight fields. Protocol 2 has exactly eleven:

```json
{
  "approvalProtocolVersion": 2,
  "eventId": "11111111-1111-4111-8111-111111111111",
  "localRecordingSessionId": "22222222-2222-4222-8222-222222222222",
  "consentReceiptId": "33333333-3333-4333-8333-333333333333",
  "workspaceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "captureApprovalReference": "44444444-4444-4444-8444-444444444444",
  "canonicalization": "RFC8785",
  "eventDigest": "e75286632c74c232a061a4f7b165fa3a19d1819a0bf3428c7561da33d2086703",
  "disclosureContractVersion": "assessment-disclosure.v1",
  "disclosureConsentReceiptId": "66666666-6666-4666-8666-666666666666",
  "disclosureCategory": "code_changes"
}
```

This is the Rails dummy Unicode fixture. `consentReceiptId` is upload permission;
`disclosureConsentReceiptId` is separate disclosure permission. The event digest is
lowercase SHA-256 of UTF-8 RFC 8785 canonical sanitized event JSON, excluding sidecar and
batch. Existing Unicode, UTF-16 key ordering, binary64 numbers, missing/null distinctions
and invalid-value rejection remain unchanged. Historical proof bytes are never upgraded.

Capture timestamps must be within the server's intersection of disclosure/upload/start
windows, strictly before disclosure expiry/revocation, stopped capture and deadline.
The parent upload checks remain in force. Control responses still have
`raw_disclosure_enabled: false` and `event_authorization: capture_approval_contract_required`;
these are not replaced with invented capability fields. An unsupported backend rejects
protocol 2; the client never retries it as protocol 1 or bypasses HTTP 403.

The flat response remains `contractVersion`, `batchId`, `durablyAcceptedEventIds`.
Only explicitly acknowledged original IDs change delivery state. Frozen manifests include
both protocols, including acknowledged tombstones; Stop & Submit reconciliation and
receipt verification are unchanged. Non-assessment upload behavior is unchanged.

## Trust and remaining review blockers

The envelope is a client assertion of byte/scope consistency. It is **not** attestation
that PrivacyFilter executed, consent was human, the timestamp is physically accurate or
the AI session belongs to the candidate. Rails independently enforces authentication,
consent, category, recording/workspace/source scope, windows, immutable retries, schema
and sensitive-content checks. Filtering is heuristic and cannot guarantee removal of all
secrets. No encryption keys or raw approval secrets are transmitted.

Rails R4.7 and this extension now support protocol-2 ingestion, but all current recruiter
APIs remain metadata-only. Raw prompts, responses, code and diff review need a separate,
read-only server disclosure implementation that checks retained capture authorization,
current disclosure rules and safe bounded projections. No reviewer content UI or scoring
is implemented here. There is no automatic resolution for evidence rejected by Rails;
keep it encrypted and use assessment recovery rather than rewriting manifests.

## Manual integration verification

1. Run `npm run compile` and reload the Extension Development Host. Use a trusted HTTPS
   Rails R4.7 development deployment with its required migrations/encryption configured.
2. Pair/start a fresh test assessment normally. Explicitly approve recording, workspace
   and upload permission. Do not reuse historical recordings for this check.
3. For AI scope, separately confirm an assessment-scoped Codex session/content capture or
   start an approved Claude capture. Use dummy content only; no real secrets or unrelated
   AI conversations. Confirm available source sessions before selecting them.
4. Run **Configure Assessment Disclosure Consent**. All categories are unselected; choose
   desired categories, workspaces and exact AI sessions, then approve the versioned notice.
   Decline/cancel to keep upload-only capture. **Show Assessment Disclosure Consent** must
   receive a valid server response; a stored receipt alone cannot authorize capture.
5. Create a dummy file change or supported visible AI message after grant confirmation.
   The new eligible encrypted approval should use protocol 2; earlier events remain 1.
   Using authorized Rails development tools, verify only protocol/category associations
   and event counts, without printing raw events, receipt bodies, credentials or paths.
6. Revoke disclosure during recording. New captures remain upload-only; earlier valid
   pre-revocation protocol-2 evidence may still upload. Recording/upload permission remains
   independent. Test offline status with dummy events; observe no new permission renewal.
7. Restart with pending evidence. Recording/upload need their existing fresh consent;
   old protocol-2 uploads additionally require fresh Rails receipt status, never new approval.
8. Use **Stop & Submit** and verify real server acknowledgment/reconciliation before a
   submitted success. Archive/re-pair must leave old evidence isolated and new consent empty.

Automated tests use isolated SQLite storage, dummy provider events and a local mock HTTPS
server with a test-client-only trusted certificate. They do not establish live Rails,
real AI-provider or recruiter content-review success.

## Changed files and automated validation

New modules: `src/disclosureCapture.ts`, `src/disclosureCaptureMonitor.ts`.

Modified capture/storage/transport modules: `src/assessmentEventApproval.ts`,
`src/evidenceApproval.ts`, `src/localEventQueue.ts`, `src/asyncLocalEventQueue.ts`,
`src/localEventQueueWorker.ts`, `src/eventPersistence.ts`,
`src/assessmentDisclosureConsent.ts`, `src/assessmentEventDelivery.ts`,
`src/railsAssessmentApiClient.ts`.

Modified activation/consent feedback: `src/extension.ts`,
`src/assessmentDisclosureChoices.ts`, `src/assessmentDisclosureCommands.ts`.

New tests/fixture: `src/test/disclosureCapture.test.ts`,
`src/test/disclosureCaptureMonitor.test.ts`,
`src/test/fixtures/rails-assessment-approval.v2.json`.
Extended `src/test/railsAssessment.e2e.test.ts`.

Documentation: `README.md`, `docs/assessment-disclosure-consent.md`,
`docs/event-approval-contract.md`, and this document.

Validation on the implementation checkout:

- `npm run compile`: passed.
- `npm run lint`: passed.
- Focused capture/monitor/disclosure/approval/finalization/archive tests: 90 passed.
- Mock HTTPS assessment integration suite: 54 passed (including four new protocol-2 flows).
- `npm test -- --code-version 1.141.1`: 752 passed, Extension Development Host exit 0.
- `git diff --check`: passed.
- Shared protocol-2 fixture matches the Rails source byte-for-byte.

The full suite includes manual recording, privacy/encryption, Codex/Claude, correlation,
upload, finalization and archive regressions. No live Rails or real provider calls were made.
