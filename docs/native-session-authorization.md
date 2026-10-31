# E5.2 — Native AI session authorization

## Compatibility and implemented contract

Existing `assessment-workflow.v1` explicitly authorizes tracker-launched sessions, not native conversations. Its `/policy`, `/start`, `/sources`, `/status` and withdrawal formats remain unchanged. `assessment-disclosure.v1`, `assessment-ai-processing.v2`, protocol-1/2 event approvals and finalization remain unchanged. Existing immutable grants must not acquire new scope from a software upgrade.

This implementation adds a separate `assessment-ai-session.v1` authorization contract for an explicitly confirmed exact native Codex session. The source receives new prospective disclosure and processing receipts within its existing authenticated recording/upload scope; this does not supersede other workflow grants or reinterpret the original launched-only notice. Explicit native confirmation separately explains content capture, upload, recruiter review and processing for that one source.

New authenticated HTTPS routes under `/api/v2/coding_session/extension/workflow_consents`:

- `GET /session_capabilities`: versioned `extension_launched` and `native_confirmed` provider capabilities; old `/policy` is unchanged.
- `POST /native_sources`: exact source confirmation and complete independent disclosure/processing requests.
- `POST /native_sources/status`: read-only recovery of that exact immutable authorization request.

Capabilities support launched Codex/Claude and native Codex only. Native Claude remains unsupported: its current authenticated hook and transcript attribution is per-launch. No personal Claude directory scan, settings overwrite or invented provider API is introduced.

Native request shape: `{intent,disclosure,processing}`. The existing source intent fields remain, with required `authorization_version: assessment-ai-session.v1`, `connection_mode: native_confirmed`, `approval_action: approve_native_assessment_session`, `source_identity: {source_file_reference,created_at}` and `identity_digest`. `source_file_reference` is the opaque `codex-file:<64 lowercase hex>` reference; `created_at` is canonical millisecond UTC metadata time. No absolute path, conversation text, candidate/challenge ownership ID or capture timestamp override is accepted.

`identity_digest` is RFC 8785 SHA-256 over `{coding_session_id,local_recording_session_id,source,source_session_id,workspace_id,source_identity}`. Rails resolves the assessment from the credential, recomputes the digest and verifies the original upload/binding/workspace/policy scope. This is client-asserted consistency, not trusted-execution attestation. Existing locked transactions, encrypted immutable enrollment bundles and unique source/request IDs provide durability; no historical event is changed.

Native responses are `{data:{authorization_version,connection_mode,identity_digest,authorization}}`, where `authorization` is the existing independently validated workflow receipt bundle for that exact source request. Read-only native status body is exactly `{workflow_consent_id,request_id}`. The new explicit mode lives in the native enrollment, not the old parent grant. Ordinary source enrollment remains the `extension_launched` path and rejects native-only fields.

The candidate explicitly selects one provider session record in the configured Codex sessions directory. The connector verifies first-record metadata, UUID, canonical workspace and immutable filesystem identity; candidate confirmation cannot override missing technical proof. Only the selected file is inspected, including when it was opened before recording. After fresh server authorization, a guarded reader starts at current EOF, drops any pre-existing partial line and rejects truncation/replacement rather than replaying history. Readiness requires actual reader initialization and current permission. No CLI launch/sign-in is required for this native path.

## Readiness, failures and recovery

The connector checks capability and consent freshness, verifies only the selected metadata record and requires an explicit candidate confirmation. It never identifies ownership from the active editor. A server grant alone is not capture readiness: the guarded reader must initialize its authorized EOF boundary first. The status bar reports reader readiness separately from successfully filtered/queued prompt and response counts.

The active workflow refreshes server permissions every two seconds; permission older than five seconds is unusable. Withdrawal, expiry, failed refresh, changed workspace, source replacement/truncation or reader interruption stops new content admission. Buffered writes already admitted through the existing persistence pipeline drain on stop; stored evidence remains encrypted. Reconnect is explicit and establishes a new EOF boundary, never a rewind. Unsupported or timestamp-less source records are not imported.

Source intent/request UUIDs are stored before the network operation in SecretStorage. Encrypted server enrollment and independent receipts are immutable. Exact retries reuse the request; conflicting source identities are rejected. Native read-only status can inspect an existing request without granting new authority. Restart restores original receipts and durable event approvals, **not** live source capture. Resume uses the existing assessment recovery/new-recording consent flow with the original Rails deadline, then explicitly reconnects the source at a fresh EOF. Archived assessment permissions are never reused.

## Manual local QA (development data only)

1. Deploy the matching Rails code and compile/reload the extension. E5.2 needs no new migration, but existing workflow tables must already exist. Keep the trusted HTTPS origin and processor policy configured. A restrictive tunnel proxy must add the exact three routes/methods listed above; do not expose unrelated routes or disable TLS.
2. Pair and **Start Assessment** in the approved workspace. Read/approve the normal workflow notice. Native capability can satisfy Codex preflight without an installed CLI; a terminal or separate provider sign-in is not required by this connector.
3. Open your normal Codex VS Code chat. Run **Connect Current AI Chat**, choose **Codex**, and select that chat's exact JSONL record beneath the user-configured Codex sessions directory (default `~/.codex/sessions`, including date subdirectories). The integration cannot determine an arbitrary current chat from editor focus. If the provider exposes no supported metadata/record, stop here rather than choosing an unrelated record.
4. Check the displayed session identity suffix and creation time against the intended assessment conversation. Read the separate exact-source purposes, processor, retention and withdrawal notice. Choose **Confirm & Connect This Session** only for this assessment chat. Declining must create no native source grant or capture.
5. Wait for **AI capture ready — native Codex**, then send a new synthetic prompt and receive a visible reply. Earlier messages and the completion of a pre-existing partial line must not appear. **Show Assessment AI Capture Status** and **Show Recorded Event Summary** must show only genuinely captured new events; zero counts do not mean provider replies were observed.
6. Connect a second deliberately selected synthetic assessment chat if needed; unrelated sessions remain unselected/unread. Try a wrong-workspace or malformed/symlink record: it must fail closed. Choosing Claude must explain unsupported native attribution without scanning its files.
7. Revoke workflow/disclosure/processing scope or interrupt connectivity. New capture must stop with a safe status; existing evidence is retained. Restart must not resume native capture automatically or reset the official deadline.
8. **Stop & Submit Assessment** uses existing close-window, durable approval upload and event-ID reconciliation. Confirm a server receipt before claiming submission. Inspect authorized Rails event associations and permitted recruiter views; protocol-1 historical evidence remains restricted.
9. Check old-server behavior: missing native capability leaves native attachment unavailable while supported launched flows continue unchanged.

## Trust and provider limitations

- Rails authenticates assessment/recording/upload ownership, exact scopes, independent consent windows and integrity. Neither a local metadata file nor its digest proves a trusted client or provider created a conversation. Technical filesystem/metadata verification plus explicit candidate assertion is the supported attribution level; no provider API attestation is claimed.
- Only supported timestamped Codex JSONL prompt/visible-response/tool records are captured. System/developer instructions, private reasoning and unsupported subagent content remain excluded. Provider version/storage changes can make native capture unavailable; no universal chat tracking is promised.
- Claude native remains disabled: the current adapter requires its launch-scoped authenticated hook capability. Transcript filenames, cwd and editor focus do not prove identity. Existing optional tracked Claude launch remains supported.
- At most eight native connection attempts/readers are retained per recording; the server's existing total source/processing limits still apply. No full-directory rescan or historical import is introduced. Missing native capability is not a reason to expand an old grant.
- The tracker queue remains encrypted and diagnostic logs contain fixed status codes only. Codex may retain its own plaintext provider transcripts; this task neither copies nor deletes them and makes no secure-erasure claim.
- Automated verification is synthetic. Real provider conversations, live candidate evidence, external AI calls and live tunnel submission have not been exercised by these tests.


## Automated verification

- TypeScript compilation and ESLint on the changed implementation/tests passed.
- Cached VS Code 1.141.1 Extension Development Host: **154 focused tests passed** across native and managed Codex, discovery/reader, consent and Ruby-fixture interoperability, capture-health/command UI, Claude-hook UI and frozen-finalization regressions. The native pipeline test uses real encrypted worker SQLite, synthetic secret redaction and restart recovery with fresh server observations.
- Matching Rails: **116 relevant examples passed** (native/workflow/concurrency plus disclosure, processing, protocol-2 ingestion and finalization); the eight native request examples also passed after adding schema validation. RuboCop passed for all eight changed Ruby files.
- OpenAPI existing paths/schemas are semantically unchanged; new response schemas validate actual Rails responses. RFC 8785 identity digests and full native receipt bundles are checked by the TypeScript client against an exported synthetic Ruby fixture.
- No full unrelated suite, migration, real AI call, candidate evidence query or live provider/tunnel submission was run. Live QA above remains required.
