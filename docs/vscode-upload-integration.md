# VS Code uploader integration (Task 3.3.3A)

The extension creates one `UploadController` backed by the existing `EventUploader`, `EventBatchManager`, `AsyncLocalEventQueue` and `EventPersistence`. It does not start delivery during activation. No real assessment backend is supplied.

## Settings and commands

Only machine/user settings under `ai-developer-tracker.upload` are read. Workspace, folder and repository values cannot redirect or enable uploads.

| Setting | Default | Behavior |
| --- | --- | --- |
| `endpoint` | empty | Valid HTTPS URL without credentials, queries or fragments; empty disables configuration |
| `enabled` | false | Status mirror; setting true never grants consent; false revokes consent |
| `maxEvents` | 100 | 1–1000 events per batch |
| `maxBytes` | 1048576 | 1024–4194304 bytes per serialized request |
| `timeoutMs` | 30000 | 10–120000 milliseconds per upload operation |

Command palette entries:

- **AI Developer Tracker: Configure Upload Endpoint** — validates and saves the endpoint in user settings. Changing it disables uploads.
- **AI Developer Tracker: Configure Upload Authentication** — choose Configure Token or Remove Token. Token input is masked, never prefilled, and stored only under `ai-developer-tracker.upload-token.v1` in VS Code SecretStorage. Configuration/removal revokes consent; cancellation preserves the current state.
- **AI Developer Tracker: Enable Uploads** — checks endpoint/bounds/token, then shows a separate modal consent dialog naming the destination hostname and explaining that sanitized code and AI conversations may be transmitted. Confirmation applies to the exact endpoint including its path, with current batch/timeout settings.
- **AI Developer Tracker: Disable Uploads** — revokes consent, cancels/drains the upload and preserves pending evidence.
- **AI Developer Tracker: Show Upload Status** — displays only hostname, enablement/consent/authentication flags, fixed outcome/pause codes and pending count. It never displays a token, full URL or event content.

Consent is held in memory, independently of recording consent. Reload, upgrade and restart always disable uploads, even when an old enabled setting is true. Endpoint/batch-setting changes and upload-token SecretStorage changes revoke consent. Enable commands share a single pending confirmation; revocation, settings changes and shutdown invalidate late consent responses. The prior uploader drains before a replacement starts. Deactivation cancels/drains delivery before closing SQLite. Recording commands never await network operations.

## Verified upload evidence

`EventPersistence` records an exact-content SHA-256 proof and capture-time admission snapshot only after a privacy-filtered SQLite commit. It preserves original event/session IDs and keeps a cloneable snapshot of approved workspace, confirmed source session and content consent. Successfully verified absolute structured tool paths are included as exact path-resolution proofs; the uploader privacy worker uses those proofs without reading files or executing commands. Secrets are still redacted by the current PrivacyFilter before HTTPS transmission.

Queued events must match that committed content exactly to receive a context. Event-ID reuse, altered payloads/envelopes, unconfirmed source sessions and raw queue insertion cannot invent approval. Proofs survive Stop/session completion within the current extension lifetime, but are cleared on evidence cleanup and closure. JSONL remains metadata-only; SQLite encryption is unchanged.

Proof memory is capped at 4096 events and 8 MiB. Oversized path proof sets are withheld (128 paths/64 KiB). Evicted records, historical records from earlier extension runs and records without sufficient proof stay pending and pause upload. Because the existing batch manager selects FIFO, a blocked historical head also blocks later events; this task deliberately does not skip, delete, migrate or fabricate approval for it. Durable historical approval/review is outside this subtask. Existing explicit cleanup commands remain available and warn about pending evidence loss. Stop uploads before local cleanup; delivery and cleanup leases exclude one another.

The versioned request/acknowledgment, persisted retry, TLS and cancellation behavior remains as documented in [event-uploader.md](event-uploader.md). Only explicitly acknowledged IDs are marked delivered. A successful HTTP status alone never acknowledges evidence.

## Manual verification

1. Compile and launch the extension in the VS Code Extension Development Host. Run **Show Upload Status**: disabled, no endpoint/token. Starting recording must not enable uploads.
2. Run **Configure Upload Endpoint** with a trusted local mock HTTPS endpoint implementing the documented contract. Its certificate must be trusted by Node; invalid/self-signed untrusted certificates pause delivery. HTTP, credential-bearing and query-bearing endpoints must be rejected. Do not use a real endpoint for dummy-data verification.
3. Run **Enable Uploads** before configuring authentication: no upload consent should be granted and status should report missing authentication.
4. Run **Configure Upload Authentication**, choose Configure Token, and enter a dummy token into the masked box. Check that settings and the Output channel contain no token.
5. Start a fresh recording, edit/save an eligible dummy file, and run **Enable Uploads**. Cancel the modal first: pending count should remain unchanged. Repeat and confirm the hostname; only newly verified events should be sent. For confirmed Codex evidence, separate recording content consent is still required.
6. Have the mock return the batch ID and a subset of its event IDs in `durablyAcceptedEventIds`. Only those events should leave the pending queue; the remainder should retry. Return 429/503 to verify preserved pending evidence and backoff. Return an invalid acknowledgment to verify a protocol pause.
7. While recording, change the upload endpoint path on the same hostname, change batch settings, set enabled=false, or remove the token. Uploads should stop without stopping recording. Enable again only with a fresh confirmation.
8. Run **Disable Uploads** during a slow request, then **Show Upload Status**. Pending evidence should remain. Reload with enabled=true previously stored: delivery must remain disabled. Old queued events should stay blocked without capture-time proof; the extension must not reconstruct approval from their own metadata.

Automated tests cover controller lifecycle/consent races, exact-content provenance, sensitive payload filtering, verified tool paths, recording/network isolation, registered VS Code commands/settings, and the existing uploader/storage protections. No backend or dashboard was added.
