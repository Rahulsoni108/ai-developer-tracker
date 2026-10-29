# Codex session discovery (Task 2.1)

Recording discovers metadata for newly created local Codex sessions. Nothing is
associated automatically: confirm candidates in the picker or run **AI Developer
Tracker: Review Codex Sessions**. Multiple matches stay ambiguous until reviewed.
Canceling leaves them unconfirmed; an explicit selection rejects the other shown
candidates. The picker shows session ID suffixes and UTC creation times, without
absolute paths or account information.

## Configuration

User/machine settings (reload the extension after changing them):

- `ai-developer-tracker.codex.enabled`: defaults to `true`.
- `ai-developer-tracker.codex.sessionsDirectory`: defaults to
  `~/.codex/sessions`; use an absolute canonical local path for testing.

Workspace settings cannot redirect discovery. Only workspace folders approved by
the existing recording consent are eligible. Tests use temporary synthetic
session files, never the user's conversations.

## Eligibility and privacy

Discovery reads the first `session_meta` envelope only. It keeps the session UUID,
creation timestamp, optional version, approved workspace ID and relative working
directory. Transcript references are opaque SHA-256 identifiers; no prompt,
response, tool input or source-code record is parsed. A byte-at-a-time asynchronous
reader avoids prefetching subsequent conversation records. The supported header
has its `type` before `payload`; the optional current Codex `ordinal` header is accepted
only as a non-negative safe integer. Unknown headers/duplicate members remain rejected;
metadata is capped at 64 KiB.

Both session creation time and file birth time must be at or after recording
started, and the canonical working directory must be within an approved folder.
These are eligibility signals, not proof of ownership. Confirmation revalidates
the header and recording session. Missing or uncertain metadata stays unverified.
Old or resumed historical sessions are excluded even when their directory matches.
Symbolic links and hard-linked transcript files are skipped. No session files are
modified, and nothing is sent externally.

## Lifecycle and bounds

The in-memory registry associates the recording UUID, Codex UUID, workspace ID,
opaque file reference and eligibility/confirmation status. It resets on the next
recording and does not restore associations after an extension restart.

File watchers discover new files; two-second bounded polling handles missing
directories and missed notifications. Scans inspect root-level JSONL files and
recent `YYYY/MM/DD` directories, with resumable directory cursors and cached
metadata. They process at most 500 entries per scan, retain at most 1,000 file
candidates, and inspect a rolling window of at most 32 date directories. Completed
headers are not reread on conversation appends. Stopping cancels new discovery and
drains pending operations.

This task does not extract conversations, emit Codex activity events, or store
the registry in a database or JSONL log. Unsupported metadata layouts, unreliable
file birth times and nonlocal or linked paths cannot establish a verified match.

## Discovery troubleshooting and consent

The recording/workspace/assessment approvals are separate from Codex ownership and
content approval. In **Review Codex Sessions**, a checked candidate explicitly selects
that session for the current recording. The subsequent **Allow Content Capture** dialog
is the tracker authorization to collect supported prompts, visible responses and tools
locally into privacy-filtered encrypted SQLite. A checkbox in Codex's own permissions UI
is not tracker content consent. Upload and recruiter disclosure require their existing,
separate approvals. None of these consents automatically makes a session discoverable.

Confirmed candidates are intentionally removed from the pending picker. Review now says
**Already confirmed for this recording** instead of incorrectly claiming no verified
candidates, and distinguishes active versus missing/unavailable content consent. This
message is not proof of successful capture; use reader diagnostics and event counts.

Each review writes a `Codex discovery review` entry to **Output → AI Developer Tracker**.
It contains only booleans, fixed codes and aggregate integer counts:

- `directorySource`: `default_home` or `user_setting` (never the actual path).
- `directoryStatus`: `ready`, `missing`, `unsafe` or `not_checked`.
- `codexHome`: `unset`, `matches`, `differs` or `invalid`; compares this extension host's
  `CODEX_HOME/sessions` with the configured tracker directory without searching elsewhere.
- Approved workspace, inspected-file, pending-candidate and confirmed-session counts.
- Aggregate reasons including `historical`, `outside_workspace`, `missing_metadata`,
  `invalid_metadata`, `incomplete_metadata`, `oversized_metadata`, `future_timestamp`,
  `working_directory_unverified`, duplicate/changed identities and explicit rejection.
- Scan/registry/read/path diagnostic codes and current local content-consent boolean.

No prompts, responses, cwd, paths, account IDs, session IDs, file references, credentials
or metadata bodies are printed. Reporting does not acknowledge, delete or modify evidence,
change consent, start the timer or attach an unrelated AI session.

### Confirmed compatibility defect

Locally observed Codex journals contain an `ordinal` key between `timestamp` and `type`.
The previous metadata reader stopped on any additional top-level key, returning
`missing_metadata` before recognizing `session_meta`. In a read-only check of seven
current-day local headers, six hit this failure; after the narrow parser fix all seven
validated. Only first-record metadata was inspected, never subsequent conversation lines.
This proves parser compatibility, not that any particular inspected thread belongs to the
candidate or satisfies current recording/workspace eligibility.

The fix allows only the bounded numeric ordinal. It does not read arbitrary extra fields,
search later records, accept metadata without type verification, auto-confirm ownership,
relax historical/symlink/workspace checks or raise size limits. Synthetic tests verify
exact read boundaries and reject malformed ordinals and non-metadata payloads.

### Session locations and Extension Development Host

The tracker still uses an explicitly configured **user/machine** sessions directory, or
`~/.codex/sessions`. Workspace settings cannot redirect it. The inspected installed Codex
extension resolves its local home from `CODEX_HOME`, otherwise `~/.codex`; remote/WSL or
custom host configurations can differ. The tracker does not silently follow another home.
If diagnostics show `codexHome: differs`, identify the intended local installation and
explicitly set `ai-developer-tracker.codex.sessionsDirectory` in that Development Host's
User Settings to its canonical sessions directory. Do not configure a broader home/root
or point it at unrelated conversations. Linked/remote paths remain unsupported.

A custom VS Code `--user-data-dir` or profile changes where its settings/extensions live;
it does not, by itself, change the Codex session directory. Terminal environment variables
also do not prove the already-running extension host inherited the same environment. Use
the new diagnostic from the actual host; missing permissions/profile/path information
must not be guessed or resolved by recursively scanning private storage.

### Manual verification

1. Run `npm run compile`, then reload the Extension Development Host to load the parser
   fix. Reload safely stops/drains capture and does not reset Rails timing or erase evidence.
   Use the existing same-assessment recovery/start workflow with fresh recording/upload
   consent if recording must resume; do not archive, delete logs or re-pair merely to
   diagnose discovery. If recovery is blocked, retain evidence and inspect Assessment Status.
2. Verify **Assessment: active** and local **Recording**, with the intended local workspace
   approved. A paired connection alone is insufficient. Review while stopped never scans.
3. Only after recording is active, open a **new Codex conversation** in the approved folder
   in that host. Send a dummy prompt. Sending a new message in an older thread is not a new
   session; old file creation or session timestamps remain `historical` by design.
4. Run **Review Codex Sessions** and inspect the safe Output summary. `missing`/`unsafe`
   requires checking the configured local location/access; `outside_workspace` requires the
   correct cwd; metadata/time/limit reasons remain unverified, never force-confirmed.
5. Select only the candidate that belongs to this work and approve **Allow Content Capture**
   if desired. If an automatic picker already confirmed it, Review should show the existing
   confirmation count and consent state, rather than the old misleading empty message.
6. Send another dummy prompt after confirmation. Check safe reader/capture diagnostics and
   **Show Recorded Event Summary** for actual `ai.prompt.submitted`/`ai.response.completed`
   counts. Missing responses depend on supported provider record shapes; do not infer capture
   solely from Codex displaying a response. Diagnostics/review do not upload evidence.

No live assessment or transcript was changed in this investigation. Unit/integration tests
use isolated synthetic journals and mocked assessment services; no real AI API calls occur.
