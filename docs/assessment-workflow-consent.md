# Assessment workflow consent — proposed version 1

Status: contract foundation only. **Not enabled in activation or recording.** Existing consent commands, server contracts and capture restrictions remain unchanged until Rails and extension integration pass the security checks below.

## Candidate action and independent permissions

The proposed `assessment-workflow.v1` profile presents one complete notice and an explicit **Agree & Start Assessment** action. It covers recording, upload to the paired HTTPS destination, job-owning recruiter review, the current Rails-approved processing policy, and future supported assessment-launched AI sessions. No approval is preselected. Cancel leaves the assessment unstarted. Separate durable upload, disclosure and processing receipts remain authoritative; a combined notice is not a substitute for those receipts.

The notice must identify workspaces, destination, providers, processor/model, purpose, retention and withdrawal semantics. New origins, workspaces, provider scopes or processing policies require fresh explicit approval. Existing recording/development commands remain independent.

## Proposed control contract

These routes are **proposals, not currently usable endpoints**:

- `GET /api/v2/coding_session/extension/workflow_consents/policy`: authenticated capabilities, `consent_version`, `source_mode: extension_launched_only`, provider allowlist and existing authenticated `processor_policy` object.
- `POST .../workflow_consents/start`: atomically validate intent, start/bind using the existing service and create separate upload, code-disclosure and code-processing receipts. The exact request is `request_id`, `local_recording_session_id`, `consent_version`, `approval_action: approve_assessment_workflow`, `approved_workspace_ids`, `providers`, `processing_policy_digest`.
- `POST .../workflow_consents/sources`: enroll a verified newly launched session using `workflow_consent_id`, `request_id`, `workspace_id`, `source`, `source_session_id`. Create narrow, prospective child disclosure/processing receipts without superseding earlier authorized sources.
- `POST .../workflow_consents/status` and `DELETE .../workflow_consents`: exact body `workflow_consent_id`; authenticated status or explicit revocation.

Control responses must retain Rails' `{data: ...}` envelope. Receipt bundle response validation, persistence and HTTP wiring are a later implementation increment; no consumer may invent a receipt or silently fall back if capabilities are unavailable. Event/approval upload sidecars and flat durable acknowledgments remain unchanged. Version-1/protocol-1 historical events must never be promoted.

## Required server and storage invariants

Start and receipt creation must commit together under the existing invitation/session lock order. Any validation or grant failure must roll back timing, binding and permission writes. Idempotent retries preserve the original deadline, request and receipts; conflict reuse is rejected. Scope registration cannot trust caller-supplied assessment ownership IDs.

Each parent grant is immutable and bound to assessment, recording, credential, destination, workspace set and exact processing policy. Each AI-source enrollment is immutable, bounded and independently scoped. Enrollment must not revoke earlier processing grants or widen existing event authorization. New enrollment is rejected when the parent, upload permission, applicable child permission, credential, policy or capture window is invalid. Concurrent revocation and enrollment share server locks.

The storage worker needs independently scoped, fresh disclosure confirmations for code and each AI session. Its current single-latest-receipt behavior cannot safely authorize this profile. Restart cannot restore live capture authority from disk alone. New event approvals must still be created atomically over exact sanitized bytes at capture time.

No source content may be read before the parent action and source authorization. Enrollment cannot backdate permissions. Events before enrollment must not be retrospectively upgraded. Failure to enroll must be visible as unavailable/partial capture. Stopping must drain admitted work before closing capture and reconciling existing finalization manifests.

## AI session linkage

Claude can reuse existing per-launch temporary hooks and authenticated local bridge. Concurrent launches remain bounded. Existing unrelated hooks/settings are not overwritten.

Codex workspace/time matches identify candidates only. They do not establish ownership. Investigate an assessment-only launch context before automatic enrollment. The supported `CODEX_HOME` setting isolates Codex state, but also affects authentication/configuration: never copy existing credentials or personal transcripts. Any managed launch must explicitly account for sign-in, provider-produced plaintext session storage, child processes, safe paths and teardown. Existing native VS Code chats remain unverified unless a supported mechanism supplies reliable linkage. Do not auto-confirm global session-directory matches.

The extension does not attest to trusted execution. Client digests and session linkage assertions are consistency evidence; Rails retains independent authorization, schema, integrity and privacy checks.

## Verification and rollout gates

Use synthetic fixtures and relevant tests only: atomic start rollback, request conflicts, source isolation, overlapping sources, historical restriction, prospective grants, independent withdrawal, revoked-credential races, policy changes, restart, archival, queue approval integrity, partial acknowledgments and finalization reconciliation. No real AI calls are needed for automated tests.

Do not enable the new UX until both sides advertise and verify this contract. Processor/tool preflight failure must be shown before the official timer starts. Existing recordings and submitted evidence are unchanged. No deadline grace-period redesign is included.

Reference: official [Codex environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables) and [authentication](https://learn.chatgpt.com/docs/auth).
