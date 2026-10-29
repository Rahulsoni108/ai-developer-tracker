# E5.0 — Candidate AI processing consent

## Implemented and blocked boundaries

This extension implements the Rails R5.0C `assessment-ai-processing.v1` control
contract from `hiring-manager` commit `bfd07d1`, checked against
`docs/assessment-evaluation-preparation.md`, `swagger/v2/swagger.yaml`,
`ProcessingConsentRequest`, `ProcessingConsentService`, `ProcessingPolicy` and
`AssessmentAiProcessingConsentSerializer`.

**Live granting is intentionally unavailable.** R5.0C has no authenticated
processor-policy discovery endpoint, and the existing pairing/status contract
does not provision a trusted processor policy. The extension cannot identify an
approved external provider, model, origin or configuration digest. Configure
therefore displays an unavailable message and sends **no grant**. There is no
arbitrary provider URL field, settings override, receipt-derived policy or mock
fallback. Do not paste processor configuration, consent IDs or credentials into
settings to work around this boundary.

The three palette commands are installed:

- **AI Developer Tracker: Configure Assessment AI Processing Consent**
- **AI Developer Tracker: Show Assessment AI Processing Consent**
- **AI Developer Tracker: Revoke Assessment AI Processing Consent**

The exact grant client and explicit selection flow are implemented and tested
using a synthetic injected trusted-policy source. Production does not supply
that source. No real grant or live AI processing was verified. Status and revoke
use only known, locally retained receipts for the current assessment; they
cannot discover consent created elsewhere. A missing local receipt is not proof
that no server consent exists. R5.0C exposes no receipt-list/recovery endpoint.

## Independent choices and policy semantics

Processing consent does not replace recording, upload, content-capture or
recruiter disclosure consent. Once trusted policy discovery is implemented,
candidates can explicitly select categories, approved workspaces and confirmed,
content-approved Codex/Claude sessions. Every choice starts unselected. Cancelling,
choosing nothing or declining confirmation sends no request and changes no
existing permission. Code-only selection carries no AI sessions.

The notice identifies the processing purpose, possible external service use and
the supplied processor configuration. An `openai_compatible` adapter name alone
does not identify an approved provider; trusted discovery must additionally
supply sufficient provider/policy disclosures before enabling production UX.

Current Rails receipts permit **preparation only**, never model dispatch.
`external_processing_enabled` is false; provider retention is `not_approved`.
Consent is prospective: Rails enforces its stored event watermark and capture
window. No old event, approval, manifest or receipt is rewritten by these controls.

Withdrawal and supersession block future preparation under that processing
receipt, including previously captured evidence. This differs from historical
recruiter-disclosure semantics. Withdrawal neither deletes evidence nor reverses
processing already performed. The policy for any future existing reports is
unresolved; this release creates no reports. Capture ends at the server's
`capture_until`; processing permission expires 24 hours after `consented_at`.
Those are distinct times. The extension never manufactures `server_time`, extends
these dates or uses its wall clock to renew permission.

## Exact Rails HTTPS control mapping

Requests use the current paired session-scoped SecretStorage bearer, the pinned
Rails origin and the existing certificate-verifying transport. Redirects are
not followed. Request bodies contain scope identifiers only, not event payloads,
prompts, code, model keys or caller ownership IDs. JSON bodies are bounded to
4096 bytes. Responses are bounded to 32768 bytes, reject duplicate keys, and
require a single `{ "data": ... }` envelope.

| Action | Method and path | Body |
| --- | --- | --- |
| Grant | POST `/api/v2/coding_session/extension/processing_consents` | Exact request below |
| Status | POST `/api/v2/coding_session/extension/processing_consents/status` | `consent_id`, `local_recording_session_id` |
| Revoke | DELETE `/api/v2/coding_session/extension/processing_consents` | `consent_id`, `local_recording_session_id` |

Illustrative grant with synthetic identifiers; not an approved production processor:

```json
{
  "request_id": "10000000-0000-4000-8000-000000000001",
  "local_recording_session_id": "10000000-0000-4000-8000-000000000002",
  "upload_consent_id": "10000000-0000-4000-8000-000000000003",
  "approval_action": "approve_assessment_ai_processing",
  "consent_version": "assessment-ai-processing.v1",
  "purpose": "assessment_performance_evaluation",
  "retention_policy_version": "ephemeral-preparation.v1",
  "external_processing_permitted": true,
  "processor_scope": {
    "backend": "direct",
    "provider": "openai_compatible",
    "model": "synthetic-model",
    "origin": "https://processor.invalid",
    "configuration_digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "categories": ["code_changes"],
  "approved_workspace_ids": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  "approved_source_sessions": []
}
```

The response `data` must echo all requested scope (excluding `request_id` and
`approval_action`) and include `consent_id`, `consented_at`, `capture_until`,
`expires_at`, nullable `revoked_at`, `external_processing_enabled: false`,
`limitations` and `state`. Supported states: `preparation_only`, `declined`,
`revoked`, `expired`. The immutable scope/receipt must not change during status
or revoke. `limitations` must exactly match the R5.0C policy:

```json
{
  "retention_policy_version": "ephemeral-preparation.v1",
  "prepared_input_persistence": "none",
  "external_processing_enabled": false,
  "provider_retention": "not_approved",
  "withdrawal": "blocks_future_preparation",
  "existing_report_policy": "unresolved_no_reports_created"
}
```

## Recovery, isolation and storage

Optional control intents/receipts reside only in VS Code **SecretStorage**, under
an origin/assessment-hashed key, with recording and credential-generation binding.
No bearer copy is stored in the ledger. Unknown/malformed state fails closed.
No plaintext settings, Memento, diagnostic or JSONL receipt copy is written.
New receipt state is never an event-approval input or authority to call an LLM.

Intent is saved before a request. An explicitly confirmed retry of an unresolved
grant reuses its original idempotency UUID and scope. Restart does not replay
anything. Unknown-outcome withdrawal never replays a grant to discover a receipt;
it stays recovery-required. A pending withdrawal is saved before DELETE and can
be explicitly retried after connectivity returns. It is not reported as confirmed
server revocation until a validated revoked receipt returns. There are no timers,
background processing workers or automatic grant retries.

Assessment context is rechecked across dialogs and async operations. Archive,
credential changes, stop, or re-pair cannot supply a grant to a new assessment.
Old SecretStorage ledgers remain isolated and retained; there is no archive
consent-restore workflow. Authentication failures leave evidence intact and do
not establish whether the server assessment was deleted. Status shows only fixed
states and server receipt dates, never private receipt/session IDs or scope bodies.

## Manual verification now

1. Run `npm run compile`, launch/reload the Extension Development Host, configure
   the existing trusted HTTPS Rails assessment origin and pair a development
   assessment normally. Never use real candidate evidence for verification.
2. Start the assessment with the existing independent recording/workspace/upload
   choices. Run **Configure Assessment AI Processing Consent**. Expect the trusted
   processor unavailable message and **no processing-consent POST**. Recording
   must continue normally. Do not attempt a guessed processor scope.
3. Run **Show Assessment AI Processing Consent** and **Revoke Assessment AI
   Processing Consent**. With no local receipts, expect the explicit no-local-
   receipt message; no lookup, revocation or permission assertion is fabricated.
4. Reload, repeat status and verify no automatic grant/evaluation. Existing
   disclosure commands, encrypted events, upload and Stop & Submit retain their
   existing behavior. Do not delete evidence to test this feature.
5. Successful live grant/status/revoke testing is blocked pending the discovery
   contract below. After implementing that separate integration, verify category/
   workspace/source choices start unselected, cancel sends nothing, Rails receipts
   remain preparation-only, explicit retries reuse request IDs and offline revoke
   remains visibly unconfirmed until validated by Rails. Never disable TLS checks.

## Outstanding backend and integration dependencies

1. Agree and implement authenticated, assessment-scoped processor-policy discovery
   (or verified deployment provisioning), including the exact processor scope and
   clear provider identity, purpose and retention/withdrawal disclosure. Supply
   validity/version semantics so stale policy cannot authorize a grant. No such
   endpoint or response is invented by this change.
2. Wire only that reviewed source into `TrustedProcessorPolicy` and the consent UI.
   Recheck the selected policy immediately before sending. Existing receipts are
   not a discovery source. Candidate settings are not trusted provisioning.
3. Define server receipt discovery/recovery if candidates need to inspect or revoke
   a grant without its local receipt, including an interrupted grant whose response
   was lost. Until then, unknown outcomes require server/operator-assisted recovery.
4. External evidence dispatch and existing-report withdrawal policy remain blocked
   by R5.0C. This extension does not implement evaluation or relax that boundary.

## Focused validation

```sh
npm run compile
npm run lint
node node_modules/@vscode/test-cli/out/bin.mjs --code-version 1.141.1 --run out/test/assessmentProcessingConsent.test.js
```

Tests inject synthetic trusted policies and mocked HTTPS control responses; no
Rails, candidate evidence or AI provider is contacted. Relevant existing consent,
recording, assessment, archive, upload/finalization regression suites are run
separately; unrelated feature suites are intentionally excluded.

E5.0 validation: TypeScript and ESLint passed. The final selected run passed
**168 tests**: 25 processing-consent cases plus 143 relevant existing regressions
(`assessmentDisclosure`, `disclosureCapture`, `disclosureCaptureMonitor`,
`assessmentController`, `assessmentArchive`, `assessmentFinalization`,
`assessmentWorkflow.e2e`, `recordingCommands`, `assessmentCommands`). The complete
unrelated extension suite and live grants were not run.
