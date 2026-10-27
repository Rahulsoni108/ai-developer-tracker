# E4.7 — Safe assessment archive and re-pair

**Archive Assessment Connection** is an explicit local operation. It preserves the old
assessment's audit/recovery state, stops associated capture and delivery, and makes room
for a fresh authenticated pairing. It is not a submission, server deletion check,
credential revocation, event acknowledgment, or destructive reset.

## Exact manual workflow

Use development data for the Session #2 → Session #3 integration test:

1. Reload the rebuilt extension (or restart its Extension Development Host). Keep the
   existing trusted HTTPS `ai-developer-tracker.assessment.apiOrigin` in user settings;
   keep `assessment.mock.enabled` false for real Rails testing.
2. Run **AI Developer Tracker: Show Assessment Status**. An old connection may show
   `recovery`, `authentication` and its last accepted deadline. A 401/403 does not prove
   that Rails deleted the session; the old deadline is an offline snapshot.
3. Run **AI Developer Tracker: Archive Assessment Connection**
   (`ai-developer-tracker.archiveAssessmentConnection`). Read the modal warning and
   select **Archive Connection**. Cancellation preserves recording and connection state.
   If submission was not previously verified, the warning explicitly says **UNCONFIRMED**.
4. Wait for the archive confirmation. Status should show **Ready to pair a new
   assessment**, with an **Archived assessment (submission unconfirmed)** count where
   applicable. Old timing disappears from the active view. If archival cannot be confirmed,
   the active slot remains blocked in recovery; resolve storage/active operations, then
   retry the command or reload. Never manually erase extension storage or credential keys.
5. Use the existing OTP-verified Session #3 browser flow to obtain a fresh pairing code.
   Run **AI Developer Tracker: Pair Assessment**, then enter that code. The normal Rails
   pairing exchange must succeed. The new connection is paired/prepared, with no inherited
   recording IDs, official deadline, upload approval or recording approval.
6. Run **Start Assessment** and approve recording/workspaces and destination upload
   consent afresh. Codex/Claude content/session approval is still separate. Modify only
   dummy eligible files. Confirm new events upload using the new assessment credential.
7. Use **Stop & Submit Assessment** before the new deadline. Only the new assessment's
   frozen manifests and durably acknowledged evidence are finalized. The old assessment
   remains archived and must not be assumed submitted.
8. Reload and check status. The new connection/receipt should recover normally, recording
   and uploads remain off, and the archive count remains visible. Old pending evidence
   remains locally retained and cannot be selected by either uploader.

No Rails records are modified by local archival. Starting, uploading and finalizing the
new assessment are normal separately authorized server operations during later manual
verification. This implementation's tests make no real Rails/API calls or invitations.

## Durable storage and crash boundaries

SQLite schema v10 adds `assessment_archives` and `assessment_archive_recordings`.
An indexed SHA-256 key of the pinned origin and Rails session ID quarantines the whole
assessment identity across credentials/windows. It is authenticated against the encrypted
snapshot on reads, and is only a local lookup key, not an execution attestation.
The existing storage worker commits an AES-256-GCM encrypted, versioned archive and its
recording quarantine in one durable transaction. Encryption uses the existing SecretStorage
key infrastructure and a distinct `archive` AAD domain bound to the stable credential
reference UUID; no bearer token or encryption key is copied into SQLite or settings.

The complete allowlisted connection snapshot includes original Rails/local identities,
credential reference, server timing/status and submission receipt, recording IDs, lifecycle
phase, submission request UUID, previous phase, safe last failure code and local archival
time. `remoteDisposition: unverified` prevents local archival from asserting server state.
The actual credential stays unchanged in SecretStorage. Events, capture approvals, consent
records, recording metadata, frozen manifests and delivery flags are not rewritten by the
archive transaction. Existing missing evidence is not recreated or retroactively approved.

The encrypted archive is the authoritative terminal marker for that connection. The old
`globalState` pointer is deliberately not cleared in a second write: `load()` ignores an
archived reference, and normal fresh pairing replaces the active pointer only after its
own successful credential exchange. Therefore:

- Before archive COMMIT: the old pointer remains recoverable; no slot is released.
- COMMIT succeeds but the worker reply/host update is lost: this host remains blocked
  until retry or reload verifies the archive. Restart sees the committed marker and can
  offer a new pairing, without overwriting the preserved old snapshot.
- Archive retry: the stable connection ID deduplicates the operation. Conflicting
  connection/request/recording associations reject; successful retries never replace the
  original archive ciphertext or recovery metadata.
- Restart: the worker authenticates archives and verifies their indexed recording sets.
  Missing keys, malformed/corrupt archives or unavailable storage fail closed. No recording,
  upload consent or archived credential is automatically activated.

Archive startup/index reads return only references, recording IDs and submission flags;
full archived metadata is not logged or exposed in status messages. Only fixed safe
failure codes and aggregate counts appear in UI/diagnostics.

## Lifecycle and upload isolation

Confirmation precedes mutation. Accepted archival cancels pending assessment operations,
turns off volatile upload consent, stops only associated recording, disables/drains both
delivery paths, waits for already-started consent work and flushes all collectors/local
writes. An unrelated manual recording blocks archival instead of being stopped/adopted.
Storage cannot archive recording IDs that are still active or have claimed upload batches.
If other same-assessment consent scopes are not covered by the connection metadata,
archival fails closed for explicit recovery. It never silently adopts missing bindings.

The worker permanently excludes archived IDs from global and assessment-scoped batch
selection, upload-context resolution, new capture and acknowledgment operations. Existing
frozen manifests remain readable but cannot authorize a new finalization. The controller
also restores an archive denylist before allowing generic uploads. Stale controllers cannot
reuse an archived connection for authenticated operations or delete its retained credential
through the normal store. New capture scopes and fresh pairing for an already archived
Rails session identity are rejected; re-pairing must target a distinct assessment. No events, scopes, permissions or credentials are migrated into
new assessment metadata.

Disabling delivery aborts/drains its single uploader before archive COMMIT. A response
arriving after cancellation is not an acknowledgment. A server may have accepted the old
request despite cancellation; that outcome stays unknown locally and pending evidence is
retained, never transferred to a new assessment. A different window's outstanding SQLite
batch claim blocks archival until released/recovered rather than racing the commit.

Archival itself does not call Rails. A previously initiated capture-window closure may
finish while it drains, but archival does not require a reachable/valid old Rails session,
claim remote closure, silently revoke consent or delete a credential. HTTP 401/403 never
triggers archival automatically. Normal upload, approval and finalization contracts are
unchanged.

## Retention and limitations

- Archived recording sets are pinned against automatic retention **and existing broad
  local-evidence cleanup**. Credentials and encrypted archive metadata remain retained.
  This release has no archive restore, export, purge or automatic credential-revocation
  command. A future recovery/cleanup workflow must explicitly handle those permissions.
- Storage is bounded by the existing queue capacity plus at most **128 archives**, each
  with up to 32 recording IDs and a 96 KiB plaintext metadata limit before encryption.
  Capacity, disk, permission, lock, encryption or commit failure never deletes evidence
  to make space; archival stays blocked. Review/increase approved local capacity as needed.
- Archiving a connection whose submission response was lost labels it unconfirmed unless
  a receipt was already verified locally. It does not look up or fabricate a receipt.
- Lost/deleted server records are not repaired, and original deadlines are never extended.
  Restoring archived delivery, rotating old credentials and adopting unknown server
  bindings remain outside this task. Preserve the profile and its SecretStorage access
  if later forensic/recovery work is needed.
- Live website → Rails → VS Code verification remains manual. Automated HTTPS fixtures
  use isolated storage and a test-only trusted certificate; TLS verification is never
  disabled and production services/data are untouched.

## Automated verification

```sh
npm run compile
npm run lint
npm test -- --code-version 1.141.1 --grep 'Assessment|assessment|Real Rails|queue'
npm test -- --code-version 1.141.1
```

Focused tests cover explicit approval/cancellation, active capture draining, failed writes
and rollback, interruption before/after COMMIT, idempotent retries, migration from schema
v9, corrupt ciphertext, credential/evidence preservation, fresh consent/deadline isolation,
manual recording isolation, late old HTTPS completion, unchanged frozen manifests/receipts,
retention guards, and a distinct new assessment's upload and R4.3 finalization.

E4.7 validation completed in the cached VS Code 1.141.1 test host:

- TypeScript compilation and ESLint: passed.
- Focused assessment/archive/queue/HTTPS regressions: **209 passed**.
- Final complete extension suite: **687 passed**, exit code 0.
- Whitespace/diff validation: passed.

An intermediate full run exposed a clock-sensitive new mock fixture. Its server clock
was made deterministic; the final complete run passed. No real Rails/Next.js integration,
assessment record changes, external uploads or candidate emails were performed.
