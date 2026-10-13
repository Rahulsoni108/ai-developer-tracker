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
has its `type` before `payload`; metadata is capped at 64 KiB.

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
