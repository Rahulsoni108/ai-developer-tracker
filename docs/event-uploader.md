# HTTPS event uploader (Task 3.3.2)

E4.5 update: [real Rails assessment integration](rails-assessment-integration.md) now
connects the documented R4.2D control APIs and scoped uploader, with fresh upload consent,
exact capture-time approvals and credential-generation checks. The historical implementation
notes below describe earlier tasks. The real path is pinned to R4.2D; generic/manual uploads
remain unchanged, and no Rails finalization request is implemented.


`EventUploader` is standalone and disabled on construction/restart. It is not connected to event collectors, recording commands or extension activation. No real backend or automatic external upload is configured. Endpoint and bounds are constructor options; `enable()` requires a separate explicit upload confirmation callback and `start()` begins the optional retry driver. `uploadOnce()` performs one eligible attempt; simultaneous calls share the same operation. `cancel()` stops the driver and aborts the current operation, `disable()` additionally revokes enablement and drains it, and `dispose()` drains and closes the private transport.

## Host contract and consent

Pass `context.secrets` as the SecretStorage dependency. Authentication is read before each attempt from `ai-developer-tracker.upload-token.v1`. There is no token setting or diagnostic output. The future host UI must provision this secret without logging it, and display a **separate upload** consent dialog through `confirmUpload(origin)`, making clear that filtered prompts, responses, tool activity and code evidence are transmitted to that destination. Returning false or failing the callback leaves uploading disabled. A setting or recording consent must never implement this callback by automatically returning true. Consent is volatile and must be requested again after restart. Configuration changes require a new uploader and new approval.

`privacyContext(event)` must return a trusted approval snapshot for that original recording session/workspace and its confirmed Codex sessions, with Codex content consent where applicable. **Never construct approval from the event's own claims.** `recordingActive` in the existing privacy context represents the authorized capture admission snapshot; uploads may occur after that recording has stopped. Historical records with no trusted scope remain pending and pause delivery. This subtask does not persist or reconstruct historical approval snapshots, add token/consent commands, or wire uploading into activation.

The uploader reruns the current `PrivacyFilter` over every prepared event, including legacy plaintext queue records. Missing approvals, boundary violations and filtering failures pause the entire batch before any request. Ordinary redactions send only the sanitized copy while preserving original envelope IDs/timestamps. Historical patches requiring new redaction pause rather than transmit a changed patch with original reconstruction evidence. Original local payloads are not rewritten. Privacy contexts must be structured-cloneable data snapshots; function-based path guards are rejected. Absolute tool paths without verifiable resolution fail closed through the existing filter. Filtering and JSON serialization run in a dedicated worker, outside the critical recording path.

## Version 1 wire contract

E4.4 defines an [assessment-only `eventApprovals` sidecar](event-approval-contract.md)
without changing normalized events or acknowledgments. The worker prepares and validates
that extended body, but the uploader rejects it before transport until Rails implements
the contract. Non-assessment requests remain exactly the three fields shown below.

POST to a configured HTTPS endpoint. No URL credentials, query strings, fragments or whitespace are permitted. Headers include `Authorization: Bearer <SecretStorage token>`, `Content-Type: application/json`, and `Accept: application/json`.

Request (dummy data; complete normalized event objects are supplied):

```json
{
  "contractVersion": 1,
  "batchId": "8a2e9248-833d-4394-af9b-9cb8056e8cc0",
  "events": [{
    "schemaVersion": 1,
    "eventId": "b7fa5399-e6d5-4d56-99c2-3a2a7eb99b6d",
    "sessionId": "1c794eae-cfea-44b7-aaf6-cc0b5665e22a",
    "timestamp": "2026-10-14T10:00:00.000Z",
    "source": "vscode",
    "eventType": "file.saved",
    "workspaceId": "dummy-workspace",
    "payload": { "relativePath": "src/example.ts" }
  }]
}
```

A 2xx JSON response must contain exactly these three fields, with the submitted batch ID and unique original event IDs from that request:

```json
{
  "contractVersion": 1,
  "batchId": "8a2e9248-833d-4394-af9b-9cb8056e8cc0",
  "durablyAcceptedEventIds": ["b7fa5399-e6d5-4d56-99c2-3a2a7eb99b6d"]
}
```

The backend must list IDs **only after durable acceptance** and deduplicate by original `eventId`, including when retransmissions have new batch IDs. It must preserve recording session IDs/schema versions/order. TLS authenticates the configured destination; the client cannot independently prove the server's internal commit. HTTP success, 204, unknown IDs, mismatched batch/version, repeated keys/IDs, extra fields, non-JSON content and oversized/malformed responses never establish delivery. Empty accepted-ID lists and partial acknowledgments keep the remainder pending for retry. Only validated IDs pass to `EventBatchManager.markDelivered`; all remaining claims are released after each attempt. No request/response body is logged.

## Retry state and bounds

Default bounds: 100 events, 1 MiB entire request body, 30-second operation timeout, 1-second base backoff and 1-hour maximum delay. Hard limits: 1000 events, 4 MiB request, 120-second timeout, 24-hour maximum delay. Responses are capped at 128 KiB and headers at 16 KiB. Oversized oldest events remain pending and pause configuration rather than being skipped. SQLite preparation is drained safely; SecretStorage, filtering and HTTPS operations support cancellation/timeouts.

Network failures/timeouts, HTTP 408, 429 and 5xx retry with exponential backoff and equal jitter (half-to-full exponentially capped delay). Valid integer-seconds or IMF-fixdate Retry-After headers increase the delay within the configured maximum. Partial or empty acknowledgment also backs off. Authentication errors (401/403/missing token) pause; other non-2xx including redirects, invalid TLS/configuration, protocol violations and privacy/storage failures pause. A fresh explicit `enable()` may unpause after remediation, but preserves the retry deadline and attempts. Full acknowledgment resets attempts. No failed operation automatically acknowledges evidence.

SQLite schema 7 adds a metadata-only retry singleton: endpoint SHA-256 digest, capped attempt count, next-attempt time, fixed pause code and worker owner ID. It contains no URL, token or payload. An attempt acquires a transaction-protected global lease and commits its recovery deadline **before** any transmission. Separate uploader instances/windows cannot overlap attempts. On owner loss the existing queue recovery releases lease/batch claims, retaining the retry deadline and original events. Clean closure also releases ownership. This provides at-least-once delivery; loss of a successful response can resend an already accepted event. Cleanup maintenance and active upload attempts exclude each other.

The transport uses Node's [HTTPS request API](https://nodejs.org/api/https.html#httpsrequestoptions-callback), a private agent, certificate/hostname verification and minimum TLS 1.2. It never follows redirects or falls back to HTTP. Optional custom trust roots exist for the local HTTPS test server; validation remains enabled. There is no certificate bypass option.

## Limitations and validation

- The real assessment backend, authentication/token provisioning UI and host approval-snapshot integration are intentionally absent. Exported API consumers must supply explicit consent and trusted scope; no production upload is enabled by this task.
- No delivery guarantee is possible without a backend honoring the durable-acknowledgment/idempotency contract. Ordering is preserved within a batch; unrelated callers can independently prepare other batches.
- Restart recovery conservatively waits the timeout plus maximum delay for an interrupted attempt. Clock changes may delay retries. Paused privacy-blocked head records need explicit review; they are never silently deleted or acknowledged.
- Plaintext exists in bounded worker/request memory for HTTPS transmission. It is never written to new tables or diagnostic logs; existing encryption/privacy/retention behavior remains intact.
- Local HTTPS tests generate a temporary certificate/key with OpenSSL, require loopback-listening permission, and remove fixture files after execution. They contact no external service.

## VS Code integration update

Task 3.3.3A adds opt-in command/configuration integration and volatile exact-event approval snapshots. The standalone defaults and wire contract remain unchanged. See [VS Code uploader integration](vscode-upload-integration.md) for current activation, consent, token and historical-record limitations. Verified tool-path proofs are now passed as data to the privacy worker; executable path callbacks are still rejected.
