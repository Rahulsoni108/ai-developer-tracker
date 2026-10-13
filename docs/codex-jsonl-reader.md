# Incremental Codex JSONL reader (Task 2.2)

Task 2.3 adds an optional content-consent gate and an awaited source-record callback
for [conversation capture](codex-conversation-capture.md). Without that opt-in,
the metadata-only behavior described below remains the default.

`CodexJsonlReader` reads only sessions marked `confirmed` / `user_confirmed` by
`CodexSessionDiscovery`, and only while the existing `RecordingController` is
active. Discovery grants guarded file handles without exposing transcript paths.
The recording UUID and confirmation grant are checked before and after each read
and before each emitted record. Symlinks, hard links, and replaced file identities
cannot bypass confirmation. The confirmation picker explicitly authorizes
metadata-only reading.

## Reading and output

On first confirmation, reading starts at byte zero for that current-recording
session. Subsequent ticks resume from an in-memory byte offset. Polls run once
per second and coalesce so the same file cannot be processed concurrently. Idle
files receive filesystem checks, without rereading record data. Appends incur a
boundary check of at most 64 previously read bytes to detect common rewrites.
The reader never rescans a directory or rereads an entire file for normal appends.

Complete newline-terminated records are parsed in source order. Partial lines,
including split UTF-8 sequences, wait for completion. Blank lines are ignored;
invalid JSON, invalid UTF-8, and oversized lines are skipped with sanitized
diagnostics. The next valid line remains readable. Identical records appended
separately count as separate records, while repeated polls do not replay them.

Output is verification metadata in the extension's Output channel:

```json
{
  "sourceSessionId": "0c2bfd5b-9876-4d7c-bb3c-857b08808507",
  "recordIndex": 2,
  "eventType": "response_item",
  "payloadType": "message",
  "timestamp": "2026-10-13T07:30:00.000Z"
}
```

Type names use fixed allowlists; unsupported values become `unknown`. Missing
payload types become `null`, and absent or invalid timestamps are omitted.
Timestamps are normalized to UTC. Raw records exist transiently for structural
JSON parsing; prompt text, responses, tool arguments, account IDs, and private
paths are never extracted, retained as output, or logged. Errors use static reason
codes, never exception messages or malformed record text. Partial byte buffers
are cleared on consumption, revocation, stop and disposal. There are no uploads.
The common activity event schema and existing JSONL activity writer are unchanged.

## Bounds and lifecycle

Default constructor limits (overridable in tests, without new extension settings):

- 16 KiB read chunks, 256 KiB per record, 2 MiB total retained partial bytes.
- 128 KiB per session per tick and 1 MiB across a tick, with round-robin scheduling.
- At most 1,000 session cursors, matching the discovery registry's default bound.

If partial-line memory is exhausted, that line is discarded through its next
newline and a `memory_limit` diagnostic records the gap. Oversized lines are
similarly discarded without retaining their bodies. Record indices include
invalid, oversized and blank lines, so skipped lines leave visible index gaps.

Temporary disappearance preserves the cursor and retries later. File replacement
revokes the grant and requires rediscovery and explicit confirmation. Detected
truncation or in-place rewrite revalidates the session header before restarting at
zero, discards the old partial line, and emits `stream_reset`. Indices continue
monotonically across file generations; replayed generation contents are distinct
from normal append processing. File identity, size, modification time and a
bounded boundary fingerprint detect common resets. Arbitrary earlier in-place
rewrites that preserve the boundary and grow the file can evade detection; the
normal format is assumed to be an append-only journal.

Stop cancels new work and drains in-flight operations without emitting their late
results. A final line without a newline waits while active and is discarded at
stop. There is no separate pause command; the reader follows active recording
state. Offsets and confirmations are not persisted. Extension restart creates a
fresh recording/discovery registry and never restores access to old conversations.

Task 2.3 prompt/response/tool extraction, backend storage, authentication and
external APIs are outside this implementation. Automated tests use temporary
synthetic sessions rather than real private conversations.
