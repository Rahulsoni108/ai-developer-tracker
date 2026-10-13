# Codex conversation and tool capture (Task 2.3)

Start Recording retains its existing file/diff consent. Selecting Codex candidates
opens a separate modal asking permission to save conversation content locally.
Cancel leaves the candidates unconfirmed. Approval applies only to the current
recording; each source session still requires explicit association confirmation.
Stop, disposal and extension restart expire consent. No content is delivered to
the parser without both consent and a currently confirmed session.

## Pipeline and supported records

Discovery supplies guarded files to the existing incremental reader. Its optional
content callback supplies a parsed record and an opaque file reference, record
index, generation and byte range. The reader awaits the parser/writer before
moving to the next line, preserving source order and bounding queued content.
The existing safe metadata callback never receives conversation text.

Supported shapes were checked against upstream [Codex response items](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs)
and [legacy event mappings](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/legacy_events.rs):

- `response_item.message`: user input text and assistant visible output text.
- `event_msg.user_message` and `event_msg.agent_message`: legacy visible messages.
- `response_item.function_call` / `custom_tool_call` and corresponding outputs.
- `event_msg.exec_command_begin/end` and `patch_apply_begin/end`.

System/developer roles, reasoning records/summaries, encrypted fields, analysis
channels, streaming deltas, non-user recipients, images and unrelated metadata are
excluded. Known injected instruction/environment blocks are removed from user
context wrappers. Unsupported or malformed shapes are ignored safely. Unfinished
assistant message records are not relabeled as completed responses.

## Events, ordering and deduplication

All emitted events use the existing v1 envelope, UUID event/recording identifiers,
source `codex`, source session UUID, workspace ID and canonical UTC timestamp.
Absent source timestamps use capture time. No existing or legacy records are
reinterpreted, and the existing file/diff event schema rules remain intact.

Message text is stored once. Multipart text is joined with newlines; optional
`partLengths` retains boundaries without copying the text again. Stable message
IDs and source record references suppress replay. For legacy mirrors without
shared IDs, opposite record types are paired by text hash within 64 records and
10 seconds, respecting known turn IDs. Same-origin repeated prompts remain valid.
Multipart mirrors may arrive as one flat string or separate visible parts.

Tool starts store input once. Results use `call_id` as `correlationId` and reference
the start's event UUID; completion does not repeat the input. Unmatched results
are marked `matched: false`, without fabricating starts or success. Explicit
status, success/error flags and available exit codes determine failure/success;
otherwise execution status remains `unknown`. Later explicit execution status can
emit a `statusUpdate` event without copying an identical output again.

Open calls on Stop, disposal, turn abort, stream reset or capacity eviction produce
`ai.tool.incomplete`, rather than claiming that execution failed. This is a local
capture boundary, not proof that the external process terminated. Pending writes
admitted while active finish on flush; new records after Stop are not admitted.

Every payload has a `sourceRecord` reference to its original JSONL file and byte
range, plus generation and reader index. Raw record bodies are not duplicated.
The first retained source reference represents a message whose other mirrors were
suppressed. Reader indices remain monotonic across generations; they are not
physical line numbers after a reset.

## Privacy and limits

Events are written only to the existing local `events.v1.jsonl` through runtime
validation and `JsonlWriter`, retaining its restrictive log permissions. Diagnostics
contain only static reason codes. Actual text, tool input/output, source code,
private paths and credentials are never printed in the diagnostic Output channel.

Tool text and explicit path fields reuse the existing excluded-path predicate.
For a filtered call, input and output are omitted with `contentOmitted:
privacy_filter`, while lifecycle metadata remains. Structured path-keyed patch
begin payloads are omitted conservatively instead of copying arbitrary files and
patches. References are inspected as text; the parser does not open referenced
files or follow their links. Actual prompts and otherwise eligible tool text may
still contain secrets; path filtering is not comprehensive secret redaction.

The reader's size/buffer/tick limits still apply. Each message, input or output is
capped at 256 KiB; oversized message text is skipped instead of truncated.
Parser state is capped at 64 source streams, 2,048 recent identifiers/hash keys
per source and 256 retained calls per source by default (constructor overrides
are available for tests). State overflow and write failure emit safe diagnostics.
Write failure disables conversation capture for that recording, without disrupting
file/diff tracking. Offsets, consent, deduplication history and call matching state
are memory-only. Unknown future Codex formats and ambiguous content-only mirrors
may require additional adapters; deduplication without shared IDs is best effort.

There are no backend APIs, external uploads, Claude integration, analysis or
scoring. Tests use synthetic transcripts, never real private conversations.

## Dummy normalized examples

Prompt and response examples use the same envelope and respective text payloads:

```json
{
  "schemaVersion": 1,
  "eventId": "3548ea58-acfd-4a35-bb7f-22a00676b291",
  "sessionId": "374a92cc-8156-485e-bd83-da4befbfde06",
  "source": "codex",
  "sourceSessionId": "0c2bfd5b-9876-4d7c-bb3c-857b08808507",
  "eventType": "ai.prompt.submitted",
  "timestamp": "2026-10-13T10:00:00.000Z",
  "workspaceId": "dummy-approved-workspace",
  "correlationId": "dummy-turn-1",
  "payload": {
    "text": "Add a greeting function.",
    "sourceRecord": {
      "sourceFileReference": "codex-file:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "recordIndex": 2, "generation": 0, "byteOffset": 200, "byteLength": 180,
      "recordType": "response_item"
    }
  }
}
```

For `ai.response.completed`, the payload text might be `Added greet(name).`.
For `ai.tool.started`, a payload might be:

```json
{
  "toolName": "exec_command", "callId": "dummy-call-1",
  "input": "{\"cmd\":\"npm test\"}", "status": "running", "matched": true,
  "sourceRecord": {
    "sourceFileReference": "codex-file:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "recordIndex": 4, "generation": 0, "byteOffset": 580, "byteLength": 160,
    "recordType": "response_item"
  }
}
```

Its `ai.tool.completed` payload links to the start UUID:

```json
{
  "toolName": "exec_command", "callId": "dummy-call-1", "output": "All tests passed.",
  "status": "succeeded", "exitCode": 0, "matched": true,
  "startedEventId": "619c6666-74af-4909-a72b-72b4e849b58c",
  "sourceRecord": {
    "sourceFileReference": "codex-file:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "recordIndex": 5, "generation": 0, "byteOffset": 740, "byteLength": 160,
    "recordType": "event_msg"
  }
}
```

The two tool envelopes have separate event UUIDs, the recording/source/workspace
identifiers above, their source timestamps, and `correlationId: dummy-call-1`.
