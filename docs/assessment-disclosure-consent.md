# E4.8 — Independent assessment disclosure consent

## Implemented boundary

This client implements the existing Rails R4.6 **`assessment-disclosure.v1` control
contract**, reviewed against `hiring-manager/docs/assessment-disclosure-consent.md`,
`DisclosureConsentRequest`, `DisclosureConsentScope`, and the Rails serializer.
It registers selected scope, inspects a known receipt and withdraws consent prospectively.
It does **not** enable raw recruiter disclosure, expand source capture, or change events.

Recording consent authorizes local capture. Separate upload consent authorizes eligible
sanitized evidence transmission. Separate disclosure choices describe candidate-declared
scope for authorized job-owning recruiter assessment review, not training or scoring.
Every disclosure response currently says `raw_disclosure_enabled: false` and
`event_authorization: "capture_approval_contract_required"`. A different capability or
unknown version fails closed. A disclosure receipt alone never grants event permission.

## Candidate commands and manual verification

1. Compile/reload the extension. Use normal **Pair Assessment**, then **Start Assessment**.
   Accept recording, workspace and upload consent only if desired. Rails must authorize
   the start and durably register the recording's upload receipt first.
2. For AI scope, independently confirm a Codex session and its content consent or use
   **Start Claude Code Capture** and approve the launched Claude session. Unconfirmed,
   unrelated and archived sessions are never options. No new discovery or blanket content
   consent is introduced. Tool/content availability remains adapter/version dependent.
3. Run **AI Developer Tracker: Configure Assessment Disclosure Consent**. Choose any of
   the three independent categories: AI prompts/relevant visible responses, source-code
   changes/diffs, AI tool activity. All start **unselected**. Cancel or select none to
   decline without changing existing grants or capture/upload choices.
4. Select approved workspace(s), then explicitly select confirmed, content-approved AI
   sessions for AI/tool categories. Code-only selection sends an empty AI-session list.
   Options use workspace/session ordinals rather than private source IDs. Workspace order
   is the current recording's upload receipt order. Multiple-session scope is optional;
   do not select a session you cannot confidently identify. Cancel if uncertain.
5. Read the versioned notice and click **Approve Selected Disclosure**. It explains the
   job-owning recruiter audience, assessment-review purpose and current raw-content block.
   This does not grant permission to disclose old events.
6. Run **Show Assessment Disclosure Consent** to inspect a chosen receipt through Rails.
   Feedback includes safe state, upload scope, expiry and last server time, never private
   source IDs, raw control responses, tokens, paths or evidence. Offline snapshots are
   not renewed or assumed active authorizations.
7. Run **Revoke Assessment Disclosure Consent**, select a grant and confirm withdrawal.
   Local denial is persisted before DELETE. Recording and independent upload permission
   continue unchanged; no existing evidence is erased. If offline, retry the revoke after
   reconnecting. A local withdrawal is not reported as confirmed server revocation.
8. Stop & Submit continues the existing drain/close/manifest/upload/reconcile/finalize
   process. Disclosure grants neither change frozen manifests nor authorize extra uploads.
   Archive and re-pair quarantines old disclosure records along with the old assessment;
   new pairing has no inherited disclosure scope. There is no archived-grant restore UI.

Live verification requires a trusted HTTPS Rails deployment with the R4.6 migration and
existing encryption, pairing and upload contracts. Automated tests use dummy data and a
mock HTTPS server only; no real Rails grant, candidate evidence or AI API call is made.

## Exact wire contract

All calls are bounded, authenticated HTTPS JSON requests to the paired origin using the
existing SecretStorage credential. No redirects are followed or TLS checks disabled.
No caller ownership IDs, timestamps, event payloads or credentials are sent in the body.

| Operation | Method and path | JSON body |
| --- | --- | --- |
| Grant | POST `/api/v2/coding_session/extension/disclosure_consents` | Request below |
| Inspect | POST `/api/v2/coding_session/extension/disclosure_consents/status` | `consent_id`, `local_recording_session_id` |
| Revoke | DELETE `/api/v2/coding_session/extension/disclosure_consents` | `consent_id`, `local_recording_session_id` |

```json
{
  "request_id": "44444444-4444-4444-8444-444444444444",
  "local_recording_session_id": "11111111-1111-4111-8111-111111111111",
  "upload_consent_id": "22222222-2222-4222-8222-222222222222",
  "approval_action": "approve_recruiter_disclosure",
  "consent_version": "assessment-disclosure.v1",
  "audience": "job_owning_recruiter",
  "purpose": "assessment_review",
  "categories": ["code_changes"],
  "approved_workspace_ids": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  "approved_source_sessions": []
}
```

AI/tool requests require explicitly selected `{ "source": "codex" | "claude",
"source_session_id": "<confirmed-source-id>" }` pairs. Lists, identifiers and total UTF-8
body size follow Rails bounds (32 workspaces/sources; 4096 bytes). All responses use only
`{ "data": <documented receipt> }`; response keys, scope, times, versions and capability
are validated. HTTP errors/raw bodies are never logged or displayed.

## Durable state, revocation and recovery

SQLite schema **v11** adds `disclosure_consents` and a recording index. Request IDs and local
recording IDs index domain-separated AES-256-GCM encrypted control state. Private source
scope and receipt contents are encrypted on the existing worker using SecretStorage keys.
No encryption keys or bearer credentials are copied into the table. Existing event,
approval, upload, delivery, acknowledgment and finalization formats are unchanged.
Existing cleanup includes this bookkeeping only under the same explicit/retention scope;
archived evidence remains protected. No evidence migration/backfill is performed.

A durable intent precedes a grant request. An explicit retry of the same pending selection
uses its original request UUID across restart. Immutable owner, credential generation,
request, scope, start/expiry and receipt identity cannot be replaced; revocation cannot be
undone. An active server snapshot is not restored as event permission after restart.
Grant requires an active associated local recording, fresh upload consent and the existing
active upload receipt. Inspection/revocation can use known bound receipts after capture
stops, subject to Rails credential/invitation eligibility. No local timer is authoritative.

If the initial grant response is lost, the receipt ID may be unknown. Withdrawal preserves
local denial and an unresolved revoke intent. It **never replays grant after withdrawal**
just to discover a receipt; Rails has no request-ID status endpoint. Resolve such unknown
server state through an approved recovery/privacy workflow. Expired/revoked credentials
may also prevent remote revocation. No anonymous cleanup or credential bypass is added.
An archive racing a response prevents later writes into the archived scope. The encrypted
intent remains retained; an unknown remote outcome is not claimed revoked or successful.

## Capture-time authorization and remaining server blockers

The current upload envelope is protocol **1** and contains no disclosure receipt reference.
Rails rejects extra fields and unsupported versions. Therefore E4.8 deliberately does not
persist a purported per-event disclosure authorization, retrofit old approvals, attach a
receipt at upload time, or emit the proposed protocol-2 sidecar. **All current events,
including events captured after a grant, remain raw-disclosure restricted.** The compatible
work here is encrypted prospective scope/intent bookkeeping and control UX/API integration.
Existing explicitly approved local Codex/Claude capture, privacy filtering and sanitized
upload-only v1 evidence remain functional under their existing independent consents.

Before disclosure-capable capture/recruiter content review can be enabled, both sides must:

- Agree on and implement a versioned immutable capture-time event-to-disclosure-receipt
  association, exact event digest, category, recording, workspace and selected AI source
  checks; define upload-only behavior and retain permanent v1 restrictions.
- Validate and store those associations atomically with new events before sending them.
  Never promote historical queued/submitted events or recover missing permissions from a
  server receipt alone. Revocation/stop/expiry must deny future capture authorization.
- Implement Rails ingestion version/cardinality/digest/window/retry checks and independent
  privacy screening, then authorized, bounded recruiter content projections. Relationships
  need the applicable approvals for both linked events; timestamps do not prove authorship.

A client digest/receipt is consistency evidence about a client assertion, not trusted
PrivacyFilter execution, actual capture time, human interaction or real AI session ownership.
Secret filtering is heuristic. No permission here authorizes private reasoning,
system/developer instructions, unrelated conversations, secrets or unrestricted tool output.
The existing providers capture only their supported visible messages/hooks/transcripts;
missing content is not invented. No server/Next.js, uploader/finalization protocol, raw
review endpoint or scoring changes are included.

## Automated verification

```sh
npm run compile
npm run lint
node node_modules/mocha/bin/mocha.js --ui tdd --timeout 20000 \
  out/test/assessmentDisclosure.test.js out/test/railsAssessment.e2e.test.js \
  out/test/railsEvidenceConsent.test.js out/test/assessmentFinalization.test.js \
  out/test/assessmentArchive.test.js out/test/durableEvidenceApproval.test.js \
  out/test/queueRecovery.test.js
npm test -- --code-version 1.141.1
```

Tests cover independent/unselected choices, decline, source/workspace isolation, exact
control contracts, malformed/error responses, encrypted restart/tampering, stable retry
IDs, durable withdrawal, legacy migrations, old-v1 restrictions, capture/upload isolation,
archival, server-scoped HTTPS, finalization and existing source adapter regressions.

Validation completed for E4.8:

- TypeScript compilation and ESLint: passed.
- Focused disclosure/HTTPS/consent/finalization/archive/approval/recovery run: **145 passing**.
- Complete suite once, cached VS Code 1.141.1: **725 passing**, extension host exit code 0.
  Includes existing Codex, Claude, correlation, recording and encryption tests.
- Added 25 standalone disclosure tests and three real-transport mock HTTPS assessment
  lifecycle tests. Updated command-registration and legacy-database fixture coverage.
- `git diff --check`: passed.

Files added: `src/assessmentDisclosure.ts`, `src/assessmentDisclosureConsent.ts`,
`src/assessmentDisclosureChoices.ts`, `src/assessmentDisclosureCommands.ts`,
`src/railsDisclosureConsentClient.ts`, `src/test/assessmentDisclosure.test.ts`, and this doc.
Modified: `package.json`, `src/assessmentController.ts`, `src/extension.ts`,
`src/localEventQueue.ts`, `src/asyncLocalEventQueue.ts`, `src/localEventQueueWorker.ts`,
`src/evidenceEncryption.ts`, `README.md`, `docs/rails-assessment-integration.md`, and tests
`assessmentCommands`, `railsAssessment.e2e`, `assessmentArchive`, `assessmentFinalization`,
`durableEvidenceApproval`, `queueRecovery` (all under `src/test/`, suffix `.test.ts`).
