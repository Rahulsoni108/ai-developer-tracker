# One explicit assessment consent action

Real Rails assessments now use `assessment-workflow.v1`: one **Agree & Start Assessment** notice explicitly covers recording, scoped upload, recruiter disclosure, AI processing and prospective enrollment of supported assessment-launched AI sessions. The notice identifies workspace folders, HTTPS destination, available providers, the server-approved processor/model, retention and withdrawal terms. Nothing is preselected. Cancel sends no start or grant.

The permissions remain independent. Each purpose has an explicit request and its own server receipt. Pairing, recording consent, a receipt or a client digest never substitutes for another permission or attests to trusted PrivacyFilter execution. Existing manual/development recording and its separate consent dialogs are unchanged.

## Requirements and local setup

1. Deploy the matching Rails workflow API and its two migrations. No development/production migrations were run by this implementation. The API contract is documented in `hiring-manager/docs/assessment-workflow-consent.md` and its OpenAPI.
2. Configure the existing trusted HTTPS assessment origin and Rails-approved processor policy. No LLM keys belong in VS Code. Missing/disabled processor policy blocks this profile before the official timer starts; there is no silent mock or recording-only fallback.
3. Install a supported Codex CLI (`--no-daemon` and `--cd`) and/or Claude Code CLI (`--plugin-dir`, `--session-id`, the existing hook support) and Node.js. Preflight must find at least one supported provider. Actual authenticated provider execution remains a live verification step.
4. Any restricted development tunnel proxy must allow the five new workflow paths with their exact methods, in addition to the existing pairing/status/events/finalization routes. Preserve TLS validation, HTTPS forwarding and authentication.

## Candidate steps

1. Open the intended assessment workspace, pair through the existing OTP-issued code, then run **AI Developer Tracker: Start Assessment**.
2. Read the single notice. Select **Agree & Start Assessment** only if you approve every listed purpose. Storage/workspace/baseline preparation and the atomic Rails start must complete before recording becomes active. The Rails deadline is assigned once and is never reset by retries.
3. Run **AI Developer Tracker: Launch Assessment AI Session**, choose Codex or Claude Code and an approved workspace. This launches a supported tracked session; it does not ask for another content-consent checkbox.
4. For Codex, sign in if required and **wait for “Assessment Codex capture ready” before entering prompts**. The private launch home is separate from personal Codex state. Credentials are not copied; the CLI is configured to require OS-keyring credential storage. Native VS Code Codex chats and sessions opened outside this managed context are not automatically captured.
5. Claude uses the existing per-launch temporary additive hook plugin and authenticated local bridge. Source enrollment must succeed before hook content capability is approved or Claude launches. Existing user hooks/settings are not overwritten. The existing **Start Claude Code Capture** command also reuses the explicit workflow approval for this recording.
6. Use the tools normally. Newly discovered sessions inside the managed Codex launch context are enrolled prospectively without another consent dialog. Unrelated workspaces, prior history, system/developer instructions, private reasoning and unsupported subagent content remain excluded. No AI authorship is inferred from timestamps.
7. Use **Show Recorded Event Summary** to verify retained event-type counts. Before Stop & Submit, a non-blocking warning appears if this recording captured no AI prompts/responses. It does not invent evidence or prevent submission.
8. **Stop & Submit Assessment** stops new capture, drains admitted checkpoints, completes/seals local sessions, closes server capture windows, uploads only approved evidence and finalizes through the unchanged reconciliation contract. Success still requires a verified Rails submission receipt.
9. The recruiter can use the existing evaluation controls after submission. This feature grants eligible processing scope; it does not automatically call an LLM or fabricate a report. Rails evaluation/processor enablement and sufficient retained evidence are still required.

For early confirmation, use **Show Assessment AI Capture Status**. The status bar distinguishes reader initialization from observed prompt/response persistence, and warns during recording if no messages have been observed. **Connect Current AI Chat** explains current native support: the server advertises launched-only scope, so native attachment remains unavailable rather than silently broadening consent. See [E5.1 investigation and prerequisites](native-ai-chat-assessments.md).

## Wire contract

All new paths are under `/api/v2/coding_session/extension/workflow_consents`, require HTTPS and the existing paired Bearer credential, and use `{data: ...}` control responses:

| Method/path | Purpose |
| --- | --- |
| `GET /policy` | Verify version, `extension_launched_only` capabilities and current processor policy. |
| `POST /start` | Atomic timing/binding plus explicit independent purpose requests. |
| `POST /sources` | Prospectively enroll one exact provider/source/workspace with explicit disclosure and processing requests. |
| `POST /status` | Refresh the original bundle and bounded independent disclosure confirmations. |
| `DELETE` on the base path | Explicitly revoke workflow permissions. |

Start body is exactly `{intent, upload, disclosure, processing}`. `intent` uses the strict `WorkflowStartRequest` fields. `upload` is the complete existing upload grant. The complete code-only disclosure and processing grants reference `upload_request_id` inside this atomic bundle; Rails resolves only that reference to the real upload receipt ID. Missing approval actions, mismatched workspaces/recordings, policy changes, ownership inputs and unknown fields fail closed.

Source body is exactly `{intent, disclosure, processing}`. Its intent identifies the existing workflow, idempotency UUID, provider source UUID and workspace hash. Complete existing purpose requests use the real upload receipt ID, exact one-source/one-workspace scope and categories `ai_interactions`/`tool_activity`.

Responses include the original request, server status, each resolved request/receipt and bounded disclosure `confirmations`. The workflow ID is the original start intent request UUID. The TypeScript client validates actual Rails synthetic fixtures, every scope/receipt/identity and server timing before persisting anything as approved. Event schemas, RFC 8785 digests, protocol-1/2 sidecars, encrypted queue storage and flat durable event acknowledgments remain unchanged.

The server caps current processing scopes at 32 per assessment (including recording/code scopes), matching the existing evaluator. A workflow can enroll at most 31 AI sessions. Further requests are rejected visibly rather than silently omitting evaluation scope.

## Recovery, withdrawal and archival

- Intent is stored in SecretStorage before requests. Purpose receipts and exact-event approvals use the existing encrypted SQLite infrastructure; processing receipts also remain visible to the existing secure processing consent controls.
- Restart can recover original server receipts with read-only status. It never restores recording, upload freshness or source capture authority automatically. New recording needs fresh explicit consent, a new recording UUID and the same original Rails deadline.
- Lost source-request outcomes retain their original request IDs. No capture becomes active from a timeout; an explicit supported retry uses the same stored request. No historical event is upgraded.
- **Revoke Assessment Workflow Consent** stops current capture/delivery and durably records withdrawal before requesting server revocation. Local failure/network loss leaves remote outcome unconfirmed; retry is supported even after recording stops. Independent existing disclosure/processing controls remain available. Withdrawing an applicable purpose blocks future combined capture/enrollment rather than silently regranting it.
- Disclosure withdrawal is prospective for otherwise valid historical evidence. Processing withdrawal blocks undispatched requests; previously produced reports follow Rails' retention policy. Full workflow withdrawal also withdraws uploads. None of these actions deletes evidence, recalls already processed data, submits an assessment or extends a deadline.
- **Archive Assessment Connection** retains isolated encrypted evidence, credentials, manifests and request IDs. New assessment pairing inherits none of the archived permissions or sources.

## Limitations and verification

### Start-response validation

Rails serializes the same disclosure receipt independently in `disclosure` and `confirmations`; their `server_time` observations may differ by milliseconds. The extension validates each observation and compares all remaining receipt identity, scope, window and revocation fields. Frozen timestamps must not be assumed. Output reports only fixed validation-stage codes such as `confirmation_identity` or `processing_receipt`, never response contents. After a failed start, compile/reload the extension and inspect Assessment Status before retrying; read-only receipt recovery preserves existing bindings and deadlines. Do not clear evidence, re-pair or manually reset server timing to resolve a protocol error.

Native/unverified Codex or Claude chats are intentionally not auto-approved. Managed Codex requires a CLI version that emits the supported JSONL metadata/records in its launch home. Activity before the post-enrollment byte boundary, including a partial line begun earlier, is omitted with safe feedback. Do not enter prompts before capture-ready confirmation. Claude content depends on supported hooks/visible transcript fields; private reasoning/subagents remain excluded.

Codex itself can retain **plaintext provider transcripts** in the private launch directory. Those files are not JSONL diagnostics and are not copied into the tracker workspace. The tracker queue stays encrypted and diagnostics remain metadata-only. Provider-produced files have separate retention/trust implications; there is no automatic cleanup or secure-erasure claim.

An initial baseline prepared before server consent registration can remain protocol 1. Older events and revoked/unverified scopes never gain disclosure permission. Network/permission refresh failures stop the combined capture safely; pending local evidence remains encrypted. Existing server deadlines still apply; no upload/finalization grace period was introduced.

Automated verification uses synthetic evidence, authenticated mock transports, actual encrypted SQLite, isolated Rails PostgreSQL, existing local mock HTTPS tests and real local Claude-hook IPC. It does not make real Codex/Claude/Groq requests or establish live provider compatibility. For live testing, verify capture-ready notices, new `ai.prompt.submitted`/`ai.response.completed`/tool and `file.diff` counts, approved Rails associations, durable acknowledgments and a submitted receipt before requesting evaluation.
