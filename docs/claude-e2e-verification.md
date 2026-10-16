# Claude Code end-to-end verification — Task 2.5.2

Run from `ai-developer-tracker` with dependencies installed:

```sh
npm run compile
npm run lint
npm test -- --code-version 1.141.1 --grep 'Claude|[Rr]ecorded event summary'
npm test -- --code-version 1.141.1
```

`src/test/claudePipeline.e2e.test.ts` runs in an isolated VS Code test host. It needs neither Claude Code nor an account/subscription. The injected installation/consent/terminal UI uses fixtures; it never starts the Claude CLI or contacts a model API. The VS Code test runner may download its test runtime if that version is not cached.

## What is exercised

The suite uses actual `RecordingController`, `ClaudeCaptureUi`, `ClaudeCapture`, command-hook bridge, parser, transcript reader, `PrivacyFilter`, `EventPersistence`, SQLite worker/encryption, `FileTracker`, `DiffTracker`, `ActivityCorrelator` and recorded-event summary. One test executes the generated plugin's Node command as a real child process. Other fixture deliveries use the same bridge over authenticated local IPC. All storage and transcripts live in isolated temporary directories; runtime encryption keys are supplied through an in-memory SecretStorage double, never fixture files. No upload worker is created and no evidence is acknowledged.

Fixture builders represent SessionStart/End, UserPromptSubmit, multipart MessageDisplay, Stop, PreToolUse, PostToolUse and PostToolUseFailure. Transcript fixtures represent assistant text, reasoning, unrelated sessions, subagents, system records, invalid JSON, partial UTF-8 lines and pre-consent history. Every string is synthetic.

The 16 end-to-end cases verify:

- Lifecycle, prompts, supported visible responses, matched tool success/failure, normalization and ordering.
- Privacy redaction in prompts, tool input/output, error output and responses; encrypted SQLite envelopes; metadata-only diagnostics and worker-generated event counts.
- Multipart/delivery deduplication, incremental transcript fallback, missing transcripts, response-hook precedence and symlink rejection.
- Separate content consent, unavailable CLI behavior, revocation, workspace/source-session/subagent isolation and sensitive file exclusions.
- Malformed/unknown hooks and conflicting tool names; conflicting results cannot discard the actual pending call or suppress its valid result.
- Real VS Code edits/saves, external disk changes, file creation/deletion, ordered diff reconstruction and conservative tool-to-file relationships. Watcher notifications are injected deterministically rather than relying on OS scheduling.
- Redacted diffs produce reconstruction gaps and never become original correlation evidence.
- Session resume/generation boundaries, unsaved edit/incomplete-call flushing on Stop and queue reopening without restoring capture or historical upload approval.
- Simultaneous Codex/Claude capture with independent consent, secret filtering and isolated call identities, including matching call IDs.

Operations have bounded waits; no polling sleeps or Claude network requests are used. Dummy content is inspected only inside assertions. Summary output is checked for type/count-only behavior, and SQLite is inspected read-only to verify encryption envelopes.

Validation on VS Code 1.141.1: TypeScript compilation and ESLint passed; the focused Claude/summary run passed all 50 tests (including 16 new end-to-end cases); the complete suite ran once and passed all 513 tests.

## Defect found and fixed

A Claude tool result with a known call ID but a different tool name was persisted as unmatched, removed the real pending call and consumed its deduplication key. A later legitimate result could then be lost. The parser now rejects the conflict with the fixed `unverified` diagnostic before changing pending-call/deduplication state. The regression test exercises this through the bridge, encrypted queue and summary.

## Remaining limits and later live checklist

This tests the extension pipeline rather than a particular installed Claude release, its hook policy, terminal environment or real SecretStorage provider. Transcript fallback remains bounded and intentionally excludes old/unrelated/subagent content. Prompts without stable identifiers cannot reliably distinguish duplicate delivery from an intentional repeat. Claude receipt timestamps and declared paths do not prove file authorship. Secret filtering is heuristic; Claude's own transcript files are outside the extension's encrypted store. Other supported platforms still need native verification.

With an authorized test account and non-sensitive scratch workspace, later:

1. Verify the installed CLI supports the generated plugin, hook arguments and visible-response mechanism; ensure Node is on VS Code's PATH.
2. Start Recording, decline Claude capture once, then explicitly approve a fresh capture launch. Confirm unrelated terminals remain excluded and existing hooks/settings still work.
3. Submit a dummy prompt, request a file edit and a failing tool action; use **Show Recorded Event Summary** to verify lifecycle/prompt/response/tool/file/diff counts. Keep uploads disabled.
4. Revoke Claude capture and verify Claude counts stop while file recording continues. Stop Recording and verify no further evidence is captured.
5. Reload VS Code: verify retained counts remain available, recording stays stopped, and a fresh capture requires consent. Check diagnostics contain only safe metadata; never display evidence or encryption keys in logs.
