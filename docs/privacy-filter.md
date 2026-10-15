# Centralized privacy filtering — Tasks 3.2.1 and 3.2.2

`src/privacyFilter.ts` remains a standalone filter. `EventPersistence` now applies it to every production collector event before SQLite or the metadata-only JSONL diagnostics. The recording and Codex content-consent dialogs remain unchanged. No encryption, retention policy, upload, filesystem read by the filter, or tool-command execution is introduced.

## API

```typescript
const filter = new PrivacyFilter();
const result = filter.filter(normalizedEvent, trustedAdmissionContext);
if (result.status !== 'rejected') {
  // EventPersistence converts requiresReconstructionGap patches into file.gap records.
  const sanitizedEvent = result.event;
}
```

Results are `accepted`, `redacted`, or `rejected`, with fixed `reasonCodes`. Rejected results contain no event or partial sensitive value. Accepted/redacted results contain independent event snapshots. Neither inputs nor protected envelope fields are changed: event ID, recording/source session IDs, source, timestamp, workspace ID, correlation ID, event type, schema version and attribution remain intact. Supported typed payload identifiers and source references are also preserved; detected secrets in them cause rejection rather than rewriting.

`PrivacyContext` must be supplied from trusted recording/session/workspace approval state, not derived from the incoming event. It identifies an active admitted recording, its session ID, approved workspace IDs, confirmed Codex sessions paired with workspace IDs, and Codex content consent. Only existing schema event types are allowed. File events must come from VS Code; AI events must come from Codex. AI/correlation events require the existing confirmed-session/content-consent boundaries. An optional eligible-file guard can further restrict relative paths. Absolute structured tool paths need a trusted resolver that returns an approved relative path; unresolved or traversal paths are rejected. The filter does not resolve symlinks itself.

`EventPersistence.attachRecording` registers before producers and obtains workspace approvals, confirmed session associations, and granted content consent from the existing components. It refreshes approvals during recording and freezes them before producer Stop handlers expire their live capture permissions. Stopped sessions retain only the authorization needed to drain previously admitted collector/correlation work; `completeSession` seals that scope after producers finish. Collectors still gate new activity on `RecordingController`. No independent recording state or new consent is introduced. Without trusted approvals, persistence fails closed.

`filterContent(value)` exposes the same bounded recursive filtering for JSON-like content previews/utilities. It does not authorize event capture or persistence. Supported content is strings, finite numbers, booleans, null, plain data objects and dense arrays. Accessors, proxies, cycles, class instances, functions, symbols, BigInts, nonfinite numbers, sparse arrays, prototype-pollution keys and malformed JSON are rejected. Duplicate JSON keys are rejected, including escaped duplicates, to prevent secrets hidden in discarded values.

## Rules

- Files: environment files, private-key/certificate stores, credentials/secrets files, SSH/cloud/Docker/GPG credential directories, dependency/VCS/generated folders, database sidecars, and the extension's event logs. Policy checks case, Unicode compatibility normalization and bounded percent decoding. Checks apply to typed paths, structured path/file fields and file lists; ordinary prose mentioning `.env` is retained.
- Recognizable keys: `sk-` OpenAI/Anthropic-style keys, AWS access-key IDs, GitHub, Google and Slack-style tokens, and JWT-shaped tokens. These are heuristics, not provider credential-validity checks.
- Authentication: bearer tokens, Basic/Bearer/Digest authorization headers, API/auth headers, cookie headers, and user/password URLs.
- Credential labels: passwords, passphrases, tokens, API keys, client secrets, secret/access/signing/private keys, authorization/cookies and credential subtrees. Labels work recursively in objects/arrays and JSON-encoded tool inputs/outputs, and in quoted/unquoted assignments and command-line flags. Sensitive numeric values become the string `[REDACTED]`; nonsecret booleans/null and surrounding fields are retained.
- Private keys: complete PKCS8/RSA/EC/DSA/OpenSSH/encrypted PEM blocks are redacted while retaining line breaks. Incomplete blocks, incomplete quoted credentials and ambiguous YAML block credentials are rejected.
- Harmless references: environment-variable expressions, explicit template placeholders, public-key blocks, short provider-prefix examples, and identifiers such as `passwordLength` are retained. Previously redacted values remain stable on repeat filtering.

Known matches use `[REDACTED]`; no match values, field paths, raw content, exceptions or credentials are logged. Reason codes are fixed categories such as `secret_redacted`, `sensitive_file_path`, `processing_limit`, or `source_session_not_confirmed`.

## Diffs and multipart messages

Unified diffs are filtered at hunk-content boundaries with line prefixes, counts and newline markers preserved. Header metadata is filtered too. Original before/after hashes remain original-content fingerprints. A sanitized patch **cannot reconstruct or hash-check the original source versions**; the result explicitly sets `requiresReconstructionGap=true` and `diff_reconstruction_changed`. `EventPersistence` therefore replaces the sanitized baseline/diff with a `file.gap` event having `reason: "privacy_filter"`. It retains the original event ID, session ID, source, timestamp, workspace, correlation identifiers, attribution, path and original hashes, but stores **no patch**. The correlator ignores these gaps and never sees the raw or modified patch. Later diffs may remain useful incremental evidence, but reconstruction across the gap requires an independent subsequent baseline. The new gap reason is an additive schema-v1 extension; existing records remain valid and are not reinterpreted.

Combined multipart text preserves its order and surrounding context. If text changes, optional original `partLengths` are removed with `multipart_metadata_removed` because old segmentation lengths would be invalid. Runtime schema validation is performed again before any successful event result is returned.

## Processing bounds

Defaults: 4 MiB input/output, 2 MiB per string, 8 MiB analyzed string work, depth 32, 10000 processing nodes, 100 embedded JSON parses and 10000 diff lines. Limits are configurable through constructor options with hard ceilings. Input descriptors are checked before runtime schema parsing, and JSON structure complexity and diff line counts are checked before allocating parsed trees. Limits never silently truncate content; overflow rejects the event. Byte/node budgets include snapshots and recursive decoding, so deeply encoded content can exceed a limit before reaching its nominal raw size.

## Limitations

Detection is conservative and best-effort. Unknown or arbitrarily encoded/split secrets, unlabeled opaque values, unusual credential syntax, shell-command file references, and sensitive data spread across separate records may escape heuristics. Opaque words following `Bearer` or credential labels may be false positives. This is not a shell/YAML parser, malware detector or guarantee that captured content is free of secrets. Structured JSON can be reformatted after redaction; unsupported/ambiguous structures are rejected.

Path rules are intentionally broader than just secret files and may exclude harmless fixtures, public key/certificate files or generated files. They mirror the existing tracker policy with additional credential stores; both the collectors’ existing exclusions and centralized persistence checks now apply. Physical workspace/symlink safety remains the responsibility of the existing approved-file guard and trusted resolver. JSONL/SQLite already on disk are not retroactively filtered. The filter is synchronous with explicit byte, node, depth and parse limits; unusually large/complex events may be rejected rather than blocking on unbounded processing. SQLite and rejection-health transactions stay on the existing storage worker.

## Persistence and rejection health

The production flow is `collector → EventPersistence → PrivacyFilter → SQLite commit → JSONL mirror → sanitized observers/correlation`. Accepted events retain their content; redacted events retain only the sanitized snapshot (with the gap exception above). Rejected events throw a content-free `EventPersistenceError`, never reach either event sink, and never notify correlation observers. The extension shows a Recording degraded status and rate-limited warnings for omissions/gaps. Existing collector write-failure handling can disable Codex content capture after rejection; no rejected value is substituted or retried without filtering.

Filtering exceptions, missing authorization, processing-limit violations, and invalid sanitized results fail closed. Failure to write safe rejection health is a queue failure and stops collection through the existing degradation handling. Queue commit precedes JSONL and observer delivery; a failed debug mirror cannot become a fallback or duplicate an SQLite event. SQLite and evidence observers receive independent sanitized snapshots. JSONL projects safe metadata only and never stores the event payload.

SQLite database schema 3 adds `recording_privacy_health` without rewriting queued events. Older schema-1/2 queues migrate transactionally. Each admitted recording stores only its rejection count and a bounded map of fixed reason codes to counts, e.g.:

```json
{"rejectedCount":2,"reasonCounts":{"sensitive_file_path":1,"filter_failed":1}}
```

`AsyncLocalEventQueue.getPrivacyHealth(sessionId)` reads this metadata. Offline inspection can also use `SELECT rejected_count, reason_counts FROM recording_privacy_health;` in the extension global-storage database. Counts reflect rejected persistence attempts; neither rejected event IDs nor payloads, source identifiers, paths or exception text are stored in this table. Startup checks validate the metadata. Health writes use the same durable worker transactions and storage limits as the queue.

The extension constructs its sole production `JsonlWriter` inside `EventPersistence`; no collector or fallback receives it directly. Low-level JSONL/queue APIs remain storage primitives for existing unit tests and must not be handed directly to production collectors. Reader debug output is restricted to allowlisted kinds, indexes, timestamps and fixed diagnostic codes; untrusted Codex source session strings are omitted.

Events already in SQLite or JSONL before this change are preserved, not retroactively sanitized, replayed through the correlator or relabeled. This implementation filters newly captured events; historical queue consumers must handle old data accordingly. Raw admitted content still exists transiently in collectors’ bounded in-memory state until processed. New SQLite events now use the [local evidence encryption foundation](local-evidence-encryption.md). The new JSONL diagnostics contain only safe metadata; historical raw JSONL and plaintext SQLite records remain subject to [explicit cleanup](secure-diagnostics-retention.md).
