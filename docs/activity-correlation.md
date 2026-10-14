# AI activity and code change correlation (Task 2.4)

`ActivityCorrelator` observes successful local JSONL writes from the existing
Codex parser and file/diff trackers. It does not reopen a transcript, read source
files, execute commands, or change an existing event's attribution. Codex content
still passes the existing session confirmation and explicit content-consent gates.

## Structured evidence

The parser extracts approved relative paths from an allowlist of structured
`write_file`, `edit_file`, `create_file`, `delete_file` and `read_file` arguments.
Those paths are declared intent, not proof of execution. Shell commands, command
arguments and freeform patch input are never interpreted as file effects.

Codex's structured `patch_apply_begin/end.changes` metadata supports stronger
evidence. These shapes were checked against the upstream [FileChange and patch
execution protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs).
Approved paths, operations and hashes are retained; raw structured code/patch
content is not duplicated. Updates use hashes of exact ordered edit blocks and
line positions, independent of patch labels/context. Creates and deletes use
before/after content hashes. Moves remain conservative.

Workspace-relative cwd and the existing FileTracker path exclusions resolve tool
paths. Absolute paths must map to the same approved workspace as the source
session. URI paths, traversal, excluded/generated paths and the extension's own
storage are rejected. Resolution never reads the referenced file.

## Confidence and relationships

Each relationship joins a tool event to a `file.diff` using the recording UUID,
workspace ID, Codex source session UUID, call ID, source file/generation references,
relative path and execution window. A diff with an explicit source-session ID is
restricted to that source. Different source sessions never share tool starts or
results just because their call IDs match.

- **confirmed**: a successful applied patch result matches the observed edit
  signature or create/delete hash pair and operation, within the actual source
  execution window, with no competing write-capable tool or editor checkpoint.
- **possible**: declared path/window overlap, timestamp-only overlap, conflicting
  tools, editor/save checkpoints, or other indirect evidence.
- **unknown**: missing starts/results, unsuccessful or incomplete execution,
  read-only tools, conflicting references, capture-time timestamps, insufficient
  retained history, or a previously possible relationship outside a late result's
  execution window.

Confirmed means directly supported association, not a declaration of file
authorship. Original AI/human/unknown attribution is never overwritten. Timestamps
alone never produce confirmed relationships. No AI evaluation or scoring occurs.

Relationships append `activity.relationship.created` and, when late evidence
changes the conclusion, `activity.relationship.updated`. The stable relationship
ID, revision and previous relationship event UUID form an update chain. Evidence
references contain source event UUIDs and optional existing source-record pointers,
without repeating prompts, arguments, outputs or diffs.

## Incremental processing and boundaries

Processing queues asynchronously and indexes recent summaries by workspace,
relative path and timestamp bucket. Only affected diffs and existing relationships
are reconsidered when a tool start/result arrives. Out-of-order results, diffs
and metadata are supported; repeated event UUIDs and unchanged conclusions do not
create duplicate relationships. Relationship writes cannot feed back into the
correlator. Primary writes that fail never notify observers.

The default live cache covers ten minutes, with at most 256 tool summaries and
1,000 diffs per workspace. Each recording retains at most 20,000 seen UUIDs and
4,000 relationship memos; at most two active/draining recordings are retained.
The queue holds at most 32 source events. Missing-start/result time searches are
bounded to two minutes, with one-second timing tolerance for possible relationships.
Exact confirmations require timestamps inside the actual execution window.

Capacity overflow emits a static diagnostic; missing correlation history cannot
raise a relationship to confirmed. Original events remain in JSONL even when a
correlation limit is reached. Correlation write failures disable correlation for
that recording without changing existing primary event persistence.

On Stop, events already captured with pre-Stop timestamps can finish correlation
while existing producers drain. Post-Stop activity is rejected. Synthetic incomplete
records may close an already admitted call. The recording is sealed after flushing;
new recording UUIDs never reuse its state. Workspace changes and deactivation also
drain pending work. State is memory-only: restart does not replay or correlate the
entire existing log.

## Dummy workflow example

1. At `10:00:01Z`, Codex starts `apply_patch` for `src/app.ts`, changing
   `const value = 1;` to `const value = 2;`.
2. At `10:00:02Z`, DiffTracker records that exact external diff, still attributed
   `unknown`.
3. At `10:00:03Z`, the structured patch result reports success and the applied
   change hash. The initially unknown relationship is updated to confirmed.

Example relationship envelope (dummy IDs and evidence):

```json
{
  "schemaVersion": 1,
  "eventId": "3548ea58-acfd-4a35-bb7f-22a00676b291",
  "sessionId": "374a92cc-8156-485e-bd83-da4befbfde06",
  "source": "vscode",
  "sourceSessionId": "0c2bfd5b-9876-4d7c-bb3c-857b08808507",
  "eventType": "activity.relationship.created",
  "timestamp": "2026-10-13T10:00:04.000Z",
  "workspaceId": "dummy-approved-workspace",
  "correlationId": "dummy-call-1",
  "attribution": "unknown",
  "payload": {
    "relationshipId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sourceEventId": "619c6666-74af-4909-a72b-72b4e849b58c",
    "targetEventId": "7107bca0-410d-4fc8-a433-e2a7da6d00c3",
    "relationshipType": "tool_file_change",
    "relativePath": "src/app.ts",
    "confidence": "confirmed",
    "explanationCode": "applied_change_matches_diff",
    "callId": "dummy-call-1",
    "revision": 1,
    "evidence": [
      { "eventId": "619c6666-74af-4909-a72b-72b4e849b58c", "kind": "tool_start" },
      { "eventId": "7107bca0-410d-4fc8-a433-e2a7da6d00c3", "kind": "time_window" },
      { "eventId": "50f4df4f-82bf-42c0-b473-19cb6d6b80ae", "kind": "tool_result" },
      { "eventId": "50f4df4f-82bf-42c0-b473-19cb6d6b80ae", "kind": "applied_change" },
      { "eventId": "7107bca0-410d-4fc8-a433-e2a7da6d00c3", "kind": "change_hash_match" }
    ]
  }
}
```

If another tool overlaps on the same file, an update preserves the relationship
ID and changes confidence to possible with `overlapping_tools`. If the checkpoint
is an editor edit/save, it stays possible. If tool input is only a shell command,
no filename is guessed: overlap can at most be possible.

## Limitations

Confirmed associations require supported structured applied-change evidence;
older or third-party tool formats may remain possible/unknown. Combined diffs
covering several operations may not match a single patch signature. Relationships
outside the retained cache/window cannot be recovered without a future explicit
offline replay feature. Source logs are evidence, not cryptographic proof of
external authorship, and timing/capture delays remain uncertain. No backend,
uploads, Claude integration, evaluation or scoring is implemented.
