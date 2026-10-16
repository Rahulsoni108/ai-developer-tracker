# Show Recorded Event Summary

Command: `ai-developer-tracker.showRecordedEventSummary`.

1. Launch the extension with its existing encrypted local queue available.
2. Start a recording, make eligible edits/saves, then run **AI Developer Tracker: Stop Recording** to drain pending collector work.
3. Run **AI Developer Tracker: Show Recorded Event Summary** from the Command Palette.
4. Review the Output channel **Latest recording — retained pending event counts**. It lists event types and counts, plus the total. No payloads, paths, identifiers, tokens or keys are displayed.

The command works during recording too, but shows only the committed snapshot at the time of its read; it never stops or flushes recording. No upload or acknowledgment is initiated.

The existing storage worker chooses the latest non-cancelled recording by metadata start time, breaking equal timestamps by most recent metadata insertion. Empty, active, completed and interrupted sessions remain eligible; an empty latest session never falls back to older data. Cancelled sessions are excluded.

Within a deferred read transaction, the worker iterates every retained pending row for that session, authenticates/decrypts and validates it internally, and counts only allowlisted event types. The response contains only `total` and `counts`. There is no 1000-event truncation. The operation does not modify rows, claims, retry state or schema, and does not emit a queue-health update that could affect recording controls. Decryption/key/storage/validation failures return no partial result and produce a fixed safe UI message, without exception text or content.

A zero result means there are no retained pending events in the latest non-cancelled session, or no such session exists. Already acknowledged payloads have been cleared, so their event types are unavailable; this is deliberately **not** a full historical recording summary. Claimed but unacknowledged events are still pending and are counted. Metadata-only JSONL output is not used as a substitute for SQLite.

The output channel and command are registered/disposed with the extension. No schema, recording consent, encryption, privacy or delivery behavior changes are required.

Focused tests cover encrypted file/AI counts, latest-session and same-time selection, cancelled/empty/acknowledged sessions, claimed events, unchanged database/delivery state, more than 1000 events, restart, decryption failure and malformed event rejection, safe formatting and actual command registration in VS Code.
