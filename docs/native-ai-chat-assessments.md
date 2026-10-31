# E5.1 — Native chat investigation and capture health

## E5.2 update

This document records the original E5.1 investigation. Its launched-only blocker still applies to old servers/grants. E5.2 now adds a **separate** explicit native Codex capability and connector; see [the implemented contract and current manual QA](native-session-authorization.md). Native Claude remains disabled. Historical findings below do not describe the new capability as unavailable.

## Original E5.1 delivery status

**Native assessment chat connection is blocked by the current backend authorization contract. This change does not enable native Codex/Claude capture under a launched-only grant.** It implements the compatible early capture-health surface, accurate managed-reader readiness, explicit connection diagnostics and tests. Rails and frontend are unchanged.

`Connect Current AI Chat` checks whether an assessment recording is active and explains the current restriction. It does not silently select a session, read transcript content, issue a grant or claim capture-ready. The candidate may explicitly choose the existing optional tracked-launch command, or inspect capture status. That alternative does not connect an already open native chat.

## Why native Codex capture stopped working

The older manual/development flow is still present: `CodexSessionDiscovery` checks bounded first-record `session_meta`, verifies UUID/filesystem identity/canonical workspace scope, and offers candidates through `CodexDiscoveryUi`. Candidate selection and separate content consent allow the existing parser/reader to capture permitted records. General recording consent alone never authorizes content. The old discovery intentionally excludes pre-recording sessions.

The newer assessment workflow introduced a narrower trust/consent boundary:

- Rails `WorkflowConsentsController#policy` explicitly advertises `source_mode: extension_launched_only`.
- `assessmentWorkflowContract.ts#validWorkflowPolicy` accepts only that exact supported mode. The candidate notice describes tracker-launched sessions; its permission cannot be reinterpreted as native-chat approval.
- Assessment recordings intercept `Review Codex Sessions` rather than invoke its manual content-grant path. Automatic candidate notifications also stay disabled for assessments.
- Workflow source enrollment derives scope from the existing launched-only parent. The server's current documentation contains no native-session enrollment capability.
- Using ordinary independent disclosure/processing grants as a workaround would supersede previous binding grants. The workflow then becomes blocked. It is not a safe way to combine native capture with the existing parent.

Previously working *manual* native discovery therefore does not establish support for the current assessment consent profile. Native chat replies, a prepared terminal or a successful assessment submission do not establish captured AI evidence.

During these unsupported assessment recordings, the global/native Codex discovery instance now receives no approved discovery scopes, so it does not install a watcher or inspect unrelated session metadata. Managed launch homes use their own existing scoped discovery. Manual/development discovery remains unchanged.

## Claude-specific limitation

The current Claude implementation is launch-scoped, not a generic native-session discovery API. `ClaudeCapture` creates an additive per-launch hook plugin and authenticated local IPC capability; the parser binds each hook to that exact approved UUID, canonical workspace and active recording. `ClaudeTranscriptReader` is only a bounded fallback for a transcript provided by an already authenticated hook. A transcript filename or cwd alone cannot establish native ownership.

Attaching the existing plugin to an independently running native Claude extension/session is not implemented. This task does not modify global/project Claude settings, copy credentials, scan personal Claude projects or invent a provider API. Such support needs an explicit, supported session-specific hook/provider handoff and agreed backend scope. Existing tracked Claude launch capture remains available.

## Early candidate feedback

`Show Assessment AI Capture Status` and the assessment AI status-bar item display:

- Not connected, initializing, reader ready, interrupted or stopped.
- Connected/readable session count and provider-level reader state.
- Observed prompt and response counts from successful, privacy-filtered SQLite notifications.

Readiness and content are separate. Codex readiness now requires the incremental reader to actually read the verified `session_meta` after enrollment; launch or enrollment alone cannot display ready. Claude is observed ready only after a valid hook event has successfully reached the filtered queue. An initialized reader with zero messages explicitly says that no prompt/response capture has yet been observed.

Reader failures interrupt the corresponding displayed provider status. Managed Codex removes the failed source from active content approvals rather than carrying a stale ready state through deletion/truncation/read errors. Other recording/file/upload behavior remains independent. A failed managed source requires a fresh supported tracked connection; readiness is not automatically restored from old offsets/consent.

A lightweight two-second check reconciles the display against existing in-memory adapter approvals and current workflow permission; it does not rescan provider directories or inspect conversation contents. Workspace-folder changes stop assessment capture and preserve evidence, requiring fresh recording/workspace approval without resetting Rails timing. Manual/development recordings are unaffected by this assessment-only guard.

At 30 seconds into an assessment recording with no observed prompts/responses, a one-time warning explains how to inspect availability. It does not inspect unauthorized conversation contents or claim to detect whether a native chat is being used. The existing final zero-AI warning remains.

Counts are in-memory observations for the current recording/process, not total historical/server counts or proof of complete coverage. Event-ID deduplication is bounded at 32,768 observations; beyond that the display explicitly marks counts as lower bounds. Use `Show Recorded Event Summary` for the existing worker-side retained pending totals. IDs, paths, prompt text and credentials do not appear in health output. An archive/new recording does not inherit old readiness or counts.

## Backend prerequisite — no invented wire fields

Full native support needs a jointly documented, versioned capability/consent update. At minimum it must:

1. Explicitly authorize a candidate-confirmed native session as a distinct supported connection mode, while preserving existing launched mode.
2. Define how the original workflow notice and exact source-specific confirmation bind that native UUID, recording, canonical workspace and prospective boundary. A source cannot be falsely represented as tracker-launched.
3. Return independently validated disclosure/processing receipts without superseding unrelated valid recording/source grants.
4. Preserve scope limits, expiry, revocation, exact-event protocol-2 approvals and finalization reconciliation. No historical event can gain new permission.
5. Provide authoritative capability/version negotiation and cross-language contract tests.

No endpoint, receipt field or mode literal for that future contract is guessed here. Current `assessment-workflow.v1` continues to fail closed for unsupported policy values.

After agreement, the Codex client work still needed is an explicitly initiated, scoped native connector using metadata-only verification plus candidate confirmation; support for already-open sessions with a guarded EOF/partial-line boundary; no historical record parsing/backfill; real reader initialization; and shared exact-source authorization with the managed adapter. Existing broad date-directory discovery must not be used to import old personal chats. Claude requires the supported identity/hook handoff described above before a connector can safely be added.

## Manual QA with the current contract

Use a fresh synthetic Rails assessment and approved scratch workspace, with the existing HTTPS/TLS, processor policy and workflow migrations correctly configured.

1. Compile/reload the extension; pair and Start Assessment with explicit consent.
2. Check the AI status item: not connected, zero observed messages. Opening a native chat alone must not change it to ready.
3. Run `Connect Current AI Chat`. Confirm it explains the launched-only contract and does not silently approve or read a native session. There is no native capture QA pass to claim at this stage.
4. Leave AI disconnected for 30 seconds; verify the safe early warning, without affecting file capture or submission.
5. If desired, explicitly choose `Launch Optional Tracked Session`. For Codex, use the existing launch, sign in if needed, and wait for actual reader-ready. For Claude, use the existing hook-enabled launch and verify its authenticated SessionStart/other persisted hook activity.
6. Send a NEW dummy prompt after readiness and wait for a visible response. Verify observed counts increase and the retained event summary contains actual AI event types. Inspect only safe server counts/associations to confirm approved uploads.
7. Stop & Submit; verify the durable Rails receipt independently of AI counts. Status becomes stopped. Later chat activity cannot become new assessment capture.
8. Revoke consent, switch recording/workspace, reload or archive using existing supported commands. Old readiness must not carry into another recording; existing encrypted evidence remains intact.

Once the native contract and connector are implemented, the requested full native QA is: new dummy assessment → pair/start → open normal provider chat → explicitly connect the technically verified assessment session → wait for real reader-ready → send new dummy prompt → verify local counts, scoped protocol-2 Rails events, durable submission receipt and permitted recruiter detail viewer. This sequence is **pending**, not verified by this change.

Automated tests use synthetic records only. No real native conversations, provider credentials or model APIs are accessed.

## Validation performed

- TypeScript compilation and scoped ESLint passed.
- Final focused health, managed-reader and discovery selection: **46 passing**.
- Final cached VS Code host command/manual-discovery/Claude UI and synthetic Claude pipeline regressions: **37 passing**.
- An earlier broader feature-only VS Code selection passed 106 tests before the final in-memory reconciliation/workspace checks; the final focused runs validate those additions. Counts overlap and must not be added as unique tests.
- No full unrelated test suite, real provider API, live Rails mutation or native candidate conversation was used. Native assessment capture itself remains blocked and is not a passing E2E claim.

## Exact changed files

| File | Change |
| --- | --- |
| `src/assessmentAiCaptureHealth.ts` | Safe observations, bounded counters, readiness/interruption states and assessment workspace guard. |
| `src/extension.ts` | Status bar/commands, early feedback, in-memory reconciliation and unsupported-native discovery gating. |
| `src/managedCodexCapture.ts` | Actual reader metadata required for ready; failures remove active source approvals. |
| `package.json` | Two command contributions only; no dependency or lockfile change. |
| `src/test/assessmentAiCaptureHealth.test.ts` | Counts, scope, readiness, interruption, restart, workspace and privacy tests. |
| `src/test/assessmentCommands.test.ts` | New command registration regression. |
| `src/test/codexSessionDiscovery.test.ts` | No native/global scan without an approved discovery scope. |
| `src/test/managedCodexCapture.test.ts` | No fake readiness and early reader-failure handling. |
| `README.md` | Accurate current support, commands and documentation link. |
| `docs/assessment-workflow-consent.md` | Early health/status and native contract limitation. |
| `docs/native-ai-chat-assessments.md` | Findings, delivery boundary, prerequisites, tests and manual QA. |
| `docs/session-context-handoff.md` | Latest protocol fix and partial E5.1 status for future agents. |
