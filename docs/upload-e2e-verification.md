# End-to-end upload verification (Task 3.3.3B)

The suite in `src/test/uploadPipeline.e2e.test.ts` runs inside the VS Code extension test host. It uses real document `WorkspaceEdit`/save events, `RecordingController`, `FileTracker`, `DiffTracker`, `CodexEventParser`, `EventPersistence`, the SQLite storage worker, `EventBatchManager`, `UploadController`, `EventUploader` and the HTTPS transport.

Each scenario has its own temporary workspace, queue, diagnostic directory, in-memory SecretStorage fixture and localhost server. Only capture/upload confirmation UI, Codex discovery and filesystem watcher boundaries are fixtures; document edits/saves, privacy filtering, encryption, durable queue/batch/retry state and HTTPS transmission are real. No actual Codex session directory or external service is accessed. Restart verification drains/closes the old module graph and storage worker, then creates a fresh graph/worker on the same encrypted database, retaining test SecretStorage keys but no event-approval memory.

The mock uses a temporary self-signed certificate generated with OpenSSL. Only the injected test client's private HTTPS agent trusts it. No system trust store, global TLS variable or production configuration is altered. A separate ordinary client is tested to ensure it still rejects that certificate. Server requests are bounded to 4 MiB and stored in test memory only. The mock fsyncs an event-ID-only acceptance journal before returning explicit durable acknowledgments; it does not store conversation or code payloads on disk and is not a real backend.

The uploader controller drives one real upload attempt at a time in the test harness. Backoff is configured to 30–60 seconds (beyond test waits), and subsequent attempts are advanced by changing **only** the test database retry deadline. Assertions verify the persisted Retry-After deadline and that an attempt cannot run before it is due. No jitter sleeps, acknowledgment manipulation or approval-protection bypass are used. Gates have 5-second timeouts; test cases have 15-second limits. Capture and server teardown drain operations and remove isolated storage.

## Scenarios

| Scenario | Verified outcome |
| --- | --- |
| Real editor/save/diff capture and successful upload | Normalized IDs/session/order preserved; encrypted payload representation verified; server fsyncs acceptance before ACK; queue shows delivered batch and zero pending claims |
| Partial acknowledgment | Only listed IDs acknowledged; FIFO remainder is released and retried with original IDs/session IDs |
| HTTP 200 without valid acknowledgment | Protocol pause; no event acknowledged |
| HTTP 429, 500 and 503 | Pending evidence retained; bounded Retry-After persisted; explicit retry recovers |
| Lost response after durable server acceptance | Same original event IDs resent under a new batch ID; mock deduplicates them; queue acknowledges only after valid response |
| Authentication failure | Safe authentication pause; new recording events continue committing |
| Slow upload and upload-consent revocation | Real editor/save capture continues; in-flight request cancelled; pending evidence retained and claims released; recording/session unchanged |
| Same-host endpoint path change | Consent revoked; cancelled new consent sends nothing; separately confirmed new consent allows only the new endpoint |
| Extension lifecycle restart with pending evidence | Encrypted pending records and retry deadline survive; recording/upload stay disabled; historical and later FIFO events remain blocked without verifiable old approval |
| Dummy secrets in code, prompts, responses, tool inputs and outputs | Code is represented as a privacy gap; AI content redacted; fake secrets absent from received JSON payloads and diagnostic JSONL; authentication token absent from those bodies/logs |
| Server unavailable and restored on the same port | Capture continues while HTTPS fails; queue survives and later uploads recover |
| Default TLS client | Rejects the self-signed mock certificate without sending an HTTP request |

## Running

Requires the project's installed VS Code test runtime, OpenSSL, and permission to listen on loopback:

```sh
npm run compile
npm run lint
npm test -- --code-version 1.141.1 --grep 'Recording to HTTPS upload end-to-end'
npm test -- --code-version 1.141.1
```

The focused suite passes 14 scenarios. The full suite is run once after focused validation. No production integration defect was discovered by these scenarios, so no product behavior was changed in this task.

## Remaining prerequisites before Phase 4

- The assessment backend and deployment are absent. A future backend must implement the documented durable-acknowledgment contract and deduplicate by original event ID, rather than batch ID.
- Capture-time upload approvals remain intentionally memory-bound. Historical/evicted pending records can block FIFO delivery; this suite confirms that restriction instead of bypassing or fabricating approval. Durable historical approval/review requires a separately authorized task.
- Production deployment needs a valid trusted HTTPS endpoint and real SecretStorage authentication provisioning. This test-only server/certificate is not a production service or trust configuration.
- Existing heuristic privacy redaction and plaintext request memory limitations still apply. Encryption and consent controls are unchanged; this task does not assert removal of every possible sensitive value.
