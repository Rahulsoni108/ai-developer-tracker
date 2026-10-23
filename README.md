# AI Developer Tracker

## 1. Project Overview

AI Developer Tracker is a VS Code extension for an AI-assisted developer assessment platform. It records approved workspace activity, incremental code changes, and explicitly approved Codex or Claude Code conversations and tool activity. Events pass through privacy filtering before entering an encrypted local SQLite queue.

Candidates can currently use development recording commands in a local coding workspace. The intended integrated experience associates that evidence with an existing Rails coding-interview attempt, with separate recording/upload consent, a server-authorized start and reliable submission.

**Current status:** recording, local storage, AI adapters and upload infrastructure are implemented and covered by automated tests. [E4.5](docs/rails-assessment-integration.md) adds real Rails pairing/start/status/consent APIs and scoped evidence uploads for the reviewed R4.2D contract. Configure a trusted HTTPS `assessment.apiOrigin` in user settings; it is empty/disabled by default. [E4.6](docs/assessment-finalization.md) adds real Stop & Submit with frozen encrypted manifests, durable acknowledgment reconciliation and validated Rails R4.3 receipts. Live deployment verification is still required.

## 2. Technology Stack

| Area | Implementation |
| --- | --- |
| Extension | TypeScript, Node.js and the VS Code Extension API |
| File changes | Document/save events, file-system watchers and incremental unified diffs using npm `diff` |
| AI activity | Incremental Codex JSONL reading; Claude Code hooks/plugin with bounded transcript fallback |
| Event format | Shared, validated, versioned events with UUID event/local recording IDs |
| Persistence | Built-in `node:sqlite`, WAL transactions and a dedicated storage worker |
| Privacy/encryption | Centralized secret filtering; Node `crypto` AES-256-GCM; VS Code SecretStorage for keys and credentials |
| Delivery | Bounded batches, Node HTTPS transport, persisted retries and explicit durable acknowledgments |
| Verification | TypeScript compilation, ESLint and Mocha through the VS Code test runner |

The existing Rails/PostgreSQL application (`hiring-manager`) and React/Next.js application (`ReactAppHirrring`) are separate repositories. This repository contains the extension; no separate FastAPI backend is used or planned for this integration.

## 3. Features Implemented

These capabilities have implementation and automated coverage. That does not imply live verification of every installed AI CLI version or a working production assessment backend.

| Feature | Current behavior |
| --- | --- |
| Recording and consent | Start/Stop commands, duplicate-start prevention and a clickable Recording/Not Recording status indicator. Workspace recording requires consent. |
| File activity and diffs | Modifications, saves, creation/deletion, initial baselines, debounced incremental diffs, unsaved editor/external changes and stop-time flushing. Exclusions and size limits apply. |
| Codex discovery | Finds eligible new local sessions during recording, initially reads metadata only, and requires session confirmation plus separate content consent. Historical/unrelated sessions are excluded. |
| Codex event capture | Incremental offsets/partial-line handling; supported prompts, visible responses, tool calls/results and incomplete activity. Internal instructions and private reasoning are excluded. |
| Claude Code adapter | Separately approved, extension-launched sessions use temporary additive hooks for prompts, supported responses, tool outcomes and lifecycle events. Approved-session transcript fallback is bounded. Existing user hooks/settings are not overwritten. |
| Activity correlation | Uses structured evidence and session/workspace boundaries. Relationships are confirmed, possible or unknown; timestamps alone do not establish AI authorship. |
| Privacy filtering | Recursively redacts recognized secrets, excludes sensitive paths and rejects unsafe/unfilterable events. Redacted code patches become reconstruction gaps. |
| Encrypted queue | New events use AES-256-GCM SQLite storage. Queue-first persistence preserves IDs, FIFO order, deduplication and acknowledgment state. |
| Recovery and limits | Integrity checks, committed-event recovery, interrupted-session metadata, queue health and configurable capacity. Restart does not resume recording or restore consent. |
| Delivery infrastructure | Persistent batch ownership, partial acknowledgments, valid HTTPS/TLS, timeouts/cancellation, exponential backoff with jitter, bounded Retry-After handling and authentication/configuration pauses. |
| Assessment foundation | Pair, Start, Stop & Submit and Status commands; lifecycle/recovery states, separate Rails/local identities, immutable server-timing checks and real Rails control/consent APIs and scoped approved-event uploads; explicit mock remains available; R4.3 finalization freezes manifests and verifies server submission receipts. |
| Diagnostics | Queue health, latest-recording retained pending event-type counts, metadata-only JSONL and explicit cleanup controls. |

**Live Claude CLI/model testing is pending.** Codex and Claude have automated coverage using representative records/hooks; installed-version compatibility still needs manual verification. Real Rails deployment and candidate workflow verification remain pending.

## 4. Architecture

```text
VS Code file/editor events    Codex approved JSONL    Claude approved hooks/transcript
             \                       |                       /
              +-------- Shared event normalization --------+
                                      |
                              EventPersistence
                                      |
                                PrivacyFilter
                                      |
                           Encrypted SQLite queue
                                      |
                             Batch manager/uploader
                                      |
                                HTTPS delivery
                                      |
                          Rails R4.2D event API [CONFIGURED HTTPS]
```

Sanitized, successfully committed events also feed `ActivityCorrelator`; its relationship events pass through the same persistence path. JSONL diagnostics are metadata-only, not an evidence store or upload fallback.

The uploader exists but is disabled by default and requires a trusted configured endpoint, authentication and separate endpoint-scoped consent. **Assessment-specific delivery is connected through the pinned R4.2D adapter:** it uses its paired credential and scoped durable approvals; the generic development uploader still blocks assessment-bound evidence. The explicit interactive mock never uploads or automatically acknowledges events.

Details: [privacy filtering](docs/privacy-filter.md), [encrypted storage](docs/local-evidence-encryption.md), [correlation](docs/activity-correlation.md), [uploader integration](docs/vscode-upload-integration.md).

## 5. Installation and Local Development

### Requirements

- VS Code compatible with the manifest requirement `^1.140.0`, using a Node-based extension host with built-in `node:sqlite` support. This is not a web extension.
- Node.js 24.x and npm are recommended for local development, matching the Node type definitions. No external SQLite server or native npm addon installation is required.
- A local file workspace and working VS Code SecretStorage. Remote/virtual workspaces and platform-specific behavior need separate verification.
- For manual AI capture: a compatible Codex installation, or Claude Code supporting the mechanisms described in [Claude integration](docs/claude-code-integration.md). Claude capture also requires Node.js on VS Code's PATH.
- For the full automated suite: a desktop test environment, local IPC/HTTPS socket permissions, and `openssl` on PATH supporting `req -addext` for the temporary HTTPS test certificate.

Automated AI/assessment tests need no Claude subscription or real backend. The test runner may download VS Code when its runtime is not cached.

### Install, compile and launch

From the extension repository root:

```sh
npm ci
npm run compile
```

For continuous compilation, use `npm run watch`.

1. Open the extension repository folder in VS Code.
2. Select **Run Extension** in Run and Debug, then press **F5**. The checked-in launch configuration starts the default `npm run watch` build task.
3. Open a scratch coding workspace in the new Extension Development Host. Keep extension storage outside the tracked workspace.
4. Use dummy code and leave uploads disabled unless testing a trusted mock endpoint. Captured code remains sensitive after filtering.

### Compile, lint and test

These scripts are defined in `package.json`:

```sh
npm run compile
npm run lint
npm test
```

`npm test` runs compilation and ESLint through `pretest`, then launches the VS Code extension test runner. A focused assessment run using a previously tested runtime is:

```sh
npm test -- --code-version 1.141.1 --grep 'Assessment'
```

There is no `npm run build` script; use `npm run compile`. No Rails migrations or backend startup are needed for extension tests.

### Key settings

| Setting | Default / purpose |
| --- | --- |
| `ai-developer-tracker.codex.enabled` | `true`; discovery during recording, with confirmation still required |
| `ai-developer-tracker.codex.sessionsDirectory` | Empty uses the standard `~/.codex/sessions` directory; supports a custom test directory |
| `ai-developer-tracker.queue.maxSizeMB` | `100`; warns at 80% usage and stops collection when safe admission fails |
| `ai-developer-tracker.retention.days` | `30`; eligible acknowledged-session/diagnostic expiration; `0` disables expiration |
| `ai-developer-tracker.upload.endpoint` | Empty; HTTPS destination configuration, not authorization |
| `ai-developer-tracker.upload.enabled` | `false`; status mirror—setting true does not grant consent |
| `ai-developer-tracker.upload.maxEvents` | `100` events per batch |
| `ai-developer-tracker.upload.maxBytes` | `1048576` bytes per request |
| `ai-developer-tracker.upload.timeoutMs` | `30000` milliseconds |
| `ai-developer-tracker.assessment.mock.enabled` | `false`; explicit development-only mock, applied after reload |

Diff size/memory limits and debounce/checkpoint controls are under `ai-developer-tracker.diff`; reload to apply them. Upload, queue, retention, Codex and mock controls use user/global settings; repository settings cannot authorize or redirect those sensitive operations. Configure tokens through commands/SecretStorage, never settings.

## 6. Extension Commands

Command Palette titles and IDs match `package.json`.

| Command title | Command ID | Purpose |
| --- | --- | --- |
| AI Developer Tracker: Start Recording | `ai-developer-tracker.startRecording` | Request consent and start manual development recording. |
| AI Developer Tracker: Stop Recording | `ai-developer-tracker.stopRecording` | Stop local capture and drain pending work. |
| AI Developer Tracker: Review Codex Sessions | `ai-developer-tracker.reviewCodexSessions` | Review eligible sessions; content consent and explicit association are required. |
| AI Developer Tracker: Start Claude Code Capture | `ai-developer-tracker.startClaudeCapture` | During recording, request consent and launch a new Claude session with temporary hooks. |
| AI Developer Tracker: Revoke Claude Code Capture | `ai-developer-tracker.revokeClaudeCapture` | Revoke Claude capture without stopping file recording or terminating Claude itself. |
| AI Developer Tracker: Show Local Queue Health | `ai-developer-tracker.showQueueHealth` | Display pending counts, storage usage and recovery health. |
| AI Developer Tracker: Show Recorded Event Summary | `ai-developer-tracker.showRecordedEventSummary` | Show event-type counts for the latest non-cancelled session's retained pending events. |
| AI Developer Tracker: Pair Assessment | `ai-developer-tracker.pairAssessment` | Pair with configured trusted Rails HTTPS origin, or explicit local mock. |
| AI Developer Tracker: Start Assessment | `ai-developer-tracker.startAssessment` | Obtain Rails authorization/binding and separate consents before recording. |
| AI Developer Tracker: Stop & Submit Assessment | `ai-developer-tracker.stopAndSubmitAssessment` | Stop/drain; keep submission pending until acknowledgments and server finalization. |
| AI Developer Tracker: Enable Assessment Uploads | `ai-developer-tracker.enableAssessmentUploads` | Fresh upload consent for retained approved evidence; never restarts recording or recreates approvals. |
| AI Developer Tracker: Revoke Assessment Credential | `ai-developer-tracker.revokeAssessmentCredential` | Confirmed stop/revoke; preserve pending evidence and remove the revoked SecretStorage credential. |
| AI Developer Tracker: Show Assessment Status | `ai-developer-tracker.showAssessmentStatus` | Show lifecycle state, last server timing snapshot and safe recovery reasons. |
| AI Developer Tracker: Configure Upload Endpoint | `ai-developer-tracker.configureUploadEndpoint` | Configure validated HTTPS; changes require new consent. |
| AI Developer Tracker: Configure Upload Authentication | `ai-developer-tracker.configureUploadAuthentication` | Configure/remove a token using masked input and SecretStorage. |
| AI Developer Tracker: Enable Uploads | `ai-developer-tracker.enableUploads` | Request destination consent and enable eligible development uploads. |
| AI Developer Tracker: Disable Uploads | `ai-developer-tracker.disableUploads` | Revoke consent and stop delivery; retain pending evidence. Also revokes assessment upload consent. |
| AI Developer Tracker: Show Upload Status | `ai-developer-tracker.showUploadStatus` | Show safe destination/status, authentication availability and pending/retry information. |
| AI Developer Tracker: Delete Local Assessment Evidence | `ai-developer-tracker.deleteLocalEvidence` | Confirm deletion of local evidence, including pending events in scope. |
| AI Developer Tracker: Clean Up Historical Plaintext Evidence | `ai-developer-tracker.cleanupLegacyEvidence` | Confirm cleanup of detected historical plaintext logs and affected sessions. |

The event summary decrypts/validates inside the storage worker and returns only event-type names and integer counts. Acknowledged payloads are cleared, so this is **not** a complete historical count. See [recorded event summary](docs/recorded-event-summary.md).

## 7. Candidate Assessment Workflow

**Implemented extension flow; deployed end-to-end verification is pending:**

1. A recruiter sends an invitation through the existing Rails application.
2. The candidate opens the link, verifies email OTP and claims the interview on the existing Next.js website without creating an account.
3. The candidate connects VS Code using a short-lived pairing code issued after verification.
4. The candidate grants separate recording and upload consent. AI content still needs source-specific approval.
5. The candidate clicks **Start Assessment** in VS Code.
6. Rails authorizes the start and establishes the official deadline exactly once; reconnects/restarts must not reset it.
7. The extension records approved workspace and AI activity through privacy filtering and encrypted storage.
8. The candidate clicks **Stop & Submit Assessment**. Capture stops and flushes; durable event acknowledgments and server finalization are required before success. Network failure leaves submission pending.

Rails R4.1A–D provides a prepared VS Code mode and server-authoritative Start while preserving browser interviews. This extension preserves original timing. Stop & Submit uses the [R4.3 finalization contract](docs/assessment-finalization.md). Partial uploads or unavailable authorization keep submission pending; only a verified receipt establishes success.

### Try the implemented local mock

Enable `ai-developer-tracker.assessment.mock.enabled` in **user settings**, reload, run Pair Assessment, accept the local-mock warning and enter the dummy code `DEMO-ASSESSMENT`. Never enter a real invitation or credential into this demo.

Start Assessment exercises consent and authorization states. The mock does not upload or automatically acknowledge evidence, so Stop & Submit normally remains pending after capture. The in-memory mock server does not survive reload; retained metadata fails closed rather than inventing a new session. Automated recovery tests preserve the mock server while recreating extension-side components.

Details: [assessment workflow/proposed contract](docs/assessment-workflow.md), [integration/security verification](docs/assessment-security-verification.md).

## 8. Security and Privacy

- **Separate permissions:** recording consent does not grant AI-content capture or uploads. Upload consent is destination-scoped, expires on reload and is revoked by relevant configuration/token changes or Disable Uploads.
- **Approved boundaries:** file capture is limited to approved local workspaces. Codex requires eligible-session confirmation; Claude capture is limited to separately approved extension-launched sessions. Supported capture excludes unrelated conversations, subagents, system/developer instructions and private reasoning.
- **Exclusions/filtering:** `.env` files, credential/key stores, `.git`, dependency folders, build outputs and other sensitive/generated paths are excluded. Recursive filtering recognizes common credentials, bearer tokens and private-key blocks. Unsafe events fail closed. Rules are heuristic: they can miss secrets or exclude harmless data.
- **Reconstruction/attribution:** redacted patches become explicit gaps rather than falsely reconstructable diffs. Correlation uses sanitized evidence and preserves uncertainty; timing alone does not prove authorship.
- **Encryption:** new SQLite events use AES-256-GCM with random nonces and authenticated metadata. Keys/credentials use SecretStorage; missing required keys fail closed. This is event encryption, not whole-database encryption or a tamper-proof ledger. Operational IDs/counts/status metadata remain accessible.
- **Diagnostics:** new JSONL contains safe metadata, not prompts, code, diffs, tool arguments or sensitive paths. There is no raw-evidence logging switch. SQLite is authoritative; diagnostic failure does not undo capture.
- **Retention/deletion:** default retention is 30 days for eligible closed, fully acknowledged sessions and disposable diagnostics. Pending evidence is never automatically deleted or acknowledged. Historical plaintext detection reports counts. Cleanup requires confirmation and cannot run during recording; whole-session cleanup can include encrypted/pending evidence. Deletion does not guarantee secure erasure from media, snapshots or backups.
- **Durable upload approvals:** newly filtered events and exact-content approvals commit atomically in encrypted SQLite. Only authenticated approvals can survive restart; fresh upload consent is still required. Older/unverifiable events remain blocked, and a blocked FIFO head can block later evidence. [E4.4](docs/event-approval-contract.md) adds capture-time assessment envelopes and RFC 8785 digests; the real R4.2D adapter can transmit only with matching scoped consent, credential-generation evidence and those original approvals. See also [E4.3](docs/durable-evidence-approval.md).

Workspace files and AI tools' original transcripts may contain plaintext outside the extension's store. Evidence exists transiently in memory. Encryption/filtering cannot protect against every leak, a compromised host or unsafe exports.

Read [privacy filtering](docs/privacy-filter.md), [encryption/key-management limits](docs/local-evidence-encryption.md) and [diagnostics, retention and cleanup](docs/secure-diagnostics-retention.md) before handling sensitive assessments.

## 9. Testing and Verification

Use the compile/lint/test commands in section 5. Tests cover recording, workspace boundaries, diffs, AI parsers, correlation, privacy, encryption, recovery, batching, delivery and mocked assessment lifecycle/security. Test totals are intentionally not fixed here; consult current runner output.

| Verification | What is established |
| --- | --- |
| Codex automated tests | Synthetic metadata/JSONL, confirmation/consent, supported messages/tools, incremental reading, privacy and isolation. Check installed-version behavior manually below. |
| Claude automated integration tests | Synthetic hooks/transcripts, real local hook IPC, consent/revocation, encrypted persistence and correlation have passed. Live Claude CLI/model testing remains pending. |
| Mock HTTPS tests | A local HTTPS server exercises recording-to-delivery behavior, failures, retries and explicit acknowledgments. Its self-signed certificate is trusted only by the test client; TLS verification is never disabled globally. |
| Mocked Rails tests | API doubles plus real collectors/filtering/SQLite/delivery bookkeeping verify lifecycle, security races and recovery. They do not prove real Rails endpoints or website integration work. |

### Manual Codex verification

1. Launch the Extension Development Host, open a non-sensitive scratch workspace and keep uploads disabled.
2. Run Start Recording and approve workspace consent. Create a **new** Codex session in that workspace after recording begins; old/resumed historical sessions are ineligible.
3. Run Review Codex Sessions, separately approve content capture and confirm only the intended session. Cancelling must leave it unconfirmed.
4. Submit a dummy prompt, obtain a visible response/tool action and edit/save an eligible file. Use Show Recorded Event Summary and Show Local Queue Health to inspect counts without exposing payloads.
5. Stop Recording and verify later activity is not collected. On reload, recording/AI/upload permissions must not resume automatically, and historical upload proofs must not be restored.

For Claude, follow [the launch/consent procedure](docs/claude-code-integration.md) and [live-testing checklist](docs/claude-e2e-verification.md); installed CLI/hook-policy and platform checks remain outstanding. More test details: [HTTPS end-to-end verification](docs/upload-e2e-verification.md), [assessment security verification](docs/assessment-security-verification.md).

## 10. Current Project Status / Roadmap

**Implemented and covered by automated tests:**

- Consent-based recording and normalized file/diff events.
- Codex discovery/reading/capture and the Claude Code adapter.
- Conservative AI/code correlation, privacy filtering and encrypted local persistence.
- Queue recovery, limits, health, safe diagnostics and controlled retention/deletion.
- Batch/HTTPS upload infrastructure, separate consent, retries and explicit acknowledgments.
- Mocked assessment workflow, session binding, server-timing checks and submission/recovery guards.

**Pending before a live integrated assessment:**

- Rails assessment lifecycle changes and official-start timing compatible with existing interviews.
- OTP-verified extension pairing and Rails-issued scoped upload credentials.
- Rails event ingestion/storage, durable receipt/completeness verification and assessment-scoped delivery.
- Live verification of real server-authoritative start, approved evidence delivery and R4.3 finalization (no upload grace is assumed).
- An agreed Rails event-privacy authorization protocol; old events without capture-time proofs remain blocked.
- Next.js candidate pairing/onboarding/start/submission integration.
- Recruiter evidence review and analytics UI.
- Live Claude Code verification and further platform/installed-version validation.

The backend/frontend foundations exist separately; this extension does not yet connect them into a production assessment workflow.
