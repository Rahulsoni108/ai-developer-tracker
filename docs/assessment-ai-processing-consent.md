# Candidate AI processing consent and trusted processor discovery

The existing Configure/Show/Revoke commands now use authenticated Rails processor discovery. Missing or unapproved policy remains unavailable; there is no arbitrary processor URL field, settings override, receipt-derived policy, mock production fallback or direct extension-to-LLM request.

Commands:

- **AI Developer Tracker: Configure Assessment AI Processing Consent**
- **AI Developer Tracker: Show Assessment AI Processing Consent**
- **AI Developer Tracker: Revoke Assessment AI Processing Consent**

## Trusted Rails contract

`GET /api/v2/coding_session/extension/processor_policy` uses the paired session credential over existing certificate-verified HTTPS. No body/query or evidence is sent. The response must be a bounded, duplicate-key-free `{data: ...}` envelope, with matching coding_session_id and valid server_time. No redirects or certificate bypass. Exact policy fields/version/digest are validated before display and fetched again before granting.

Available policy version: `assessment-processor-policy.v1`. It identifies public processor id/name/description/external status, processor_scope (backend/provider/model/origin/configuration_digest), purpose, categories, enablement and withdrawal/retention terms. A compatibility label such as openai_compatible does not establish provider identity. Operator-approved identity and data policy come from Rails. The RFC8785 SHA-256 policy digest excludes only policy_digest, server_time and coding_session_id. This is a consistency check, not trusted-execution attestation.

V2 grant uses the existing endpoint `POST /api/v2/coding_session/extension/processing_consents`, existing scope/request fields and exactly:

- consent_version: `assessment-ai-processing.v2`
- retention_policy_version: `assessment-report-retention.v1`
- processing_policy_digest: the displayed and freshly revalidated Rails policy digest

Other exact fields: request_id, local_recording_session_id, upload_consent_id, approval_action=approve_assessment_ai_processing, purpose=assessment_performance_evaluation, external_processing_permitted, processor_scope, categories, approved_workspace_ids, approved_source_sessions. Source entries are `{source, source_session_id}`. No prompts, code or provider credentials are part of consent requests.

Status remains POST `/api/v2/coding_session/extension/processing_consents/status`; revoke remains DELETE `/api/v2/coding_session/extension/processing_consents`. Both use only consent_id and local_recording_session_id in the body. Receipts must echo immutable scope and policy digest, server capture/expiry timestamps and supported limitations. Status/revoke cannot discover receipts created elsewhere: no local receipt is not proof of no server consent.

V2 limitations: retention_policy_version=assessment-report-retention.v1; prepared_input_persistence=none; external_processing_enabled=false; provider_retention=operator_approved_no_training; withdrawal=blocks_undispatched_requests; existing_report_policy=retain_until_expiry. Receipt state preparation_only means consent alone does not dispatch anything. A separately enabled Rails deployment, recruiter action and current server authorization are required. Legacy v1 receipts retain original preparation-only semantics/limitations and never become dispatchable.

See Rails `docs/assessment-ai-evaluation.md` and OpenAPI for complete server fields and operator requirements. No existing upload, event approval, submission or finalization format changes.

## Explicit choices and lifecycle

Configure requires a current active assessment recording, independent upload authorization and approved workspace scope. All category, workspace and confirmed/content-approved Codex/Claude session choices start unselected. Code-only selection needs no AI sessions. The confirmation displays processor name/identity/description, provider/model/origin, selected categories/scope, external use, purpose, enablement, report retention and withdrawal terms. Cancel or decline sends no grant. It does not silently revoke another grant; use Revoke explicitly.

Recording/upload/content-capture/recruiter disclosure/AI processing remain separate. A grant does not change an event or durable event approval. Rails watermarks/capture windows exclude historical events, including earlier submitted assessments. Captured evidence still must independently pass protocol-2 disclosure, privacy and submission reconciliation checks.

Withdrawal blocks requests not yet transmitted. An already transmitted request cannot be recalled. Under the explicit v2 policy, generated reports remain reviewable until the configured run expiry. Withdrawal does not delete evidence/reports/provider data. The existing 24-hour processing receipt expiry and server capture_until are distinct. No client clock extends either.

Scope intents/receipts and the verified policy snapshot reside only in SecretStorage, hashed by origin/assessment and bound to credential generation and recording. No bearer copy in the ledger, no plaintext Memento/settings/diagnostics/JSONL receipts. Save intent before network; explicit uncertain-outcome retry reuses its UUID and scope. Restart never replays grants. Pending revocation remains visibly unconfirmed until a valid revoked receipt returns. Policy changes during selection prevent granting; never silently downgrade to v1. Archive/re-pair/credential changes cannot transfer another assessment's scope or ledger.

## Manual synthetic verification

1. Use trusted local HTTPS Rails with the new processor-policy implementation. Compile (`npm run compile`) and reload the Extension Development Host. Pair/start a NEW synthetic assessment through the normal lifecycle.
2. With missing operator policy, Configure must show unavailable and send no consent POST. Recording remains independent. Do not invent processor IDs/scopes to work around this.
3. After the operator approves a synthetic/live-test processor and explicit retention policy, Configure must display exact discovery details. Select independent categories/workspaces/AI sessions and confirm. Grant BEFORE capturing new eligible evidence. If live evaluation is intended, the reviewed enabled policy must already be configured before this grant; changing enablement changes its digest and requires a new prospective grant.
4. Show must return the validated server state and original dates, never claim that preparation equals evaluation. Existing privacy, upload approvals and Stop & Submit remain unchanged.
5. Revoke explicitly; offline revocation stays unconfirmed and can be explicitly retried. Reload and check receipt isolation, no automatic grant and no direct provider traffic. Test archives/new pairing with synthetic records, preserving old evidence.
6. Recruiter evaluation and report access occur only through Rails after finalization. No real provider call was made by automated tests. Never disable TLS or put processor credentials in this extension.

## Validation and known limitations

Compile and ESLint passed. **119 selected tests passed** across processing consent (30), existing recording, disclosure, archive and finalization. The compiled extension validator also accepted the actual synthetic Rails policy response and canonical digest. Fixtures use mocked HTTP and dummy values, no candidate content or real model requests.

The extension cannot verify a provider's contractual no-training claim; it relies on approved server configuration. Server discovery/worker deployment and fresh prospective v2 grants are required for live evaluation. Previously retained v1 evidence remains restricted. Locally missing consent receipts cannot be recovered via a list endpoint. Ambiguous prompt provenance, incomplete source diffs and missing task context limit what Rails may evaluate. Existing reports may outlive withdrawal only under the explicitly displayed retention policy.
