# E4.4 — assessment event approval contract v1

**E4.9:** [Protocol-2 approvals](assessment-protocol2-approvals.md) add prospective disclosure authorization for new eligible events. Protocol 1 and historical events remain unchanged. Earlier availability notes below are historical.

E4.5 update: [real Rails assessment integration](rails-assessment-integration.md) now
connects the documented R4.2D control APIs and scoped uploader, with fresh upload consent,
exact capture-time approvals and credential-generation checks. The historical implementation
notes below describe earlier tasks. The real path is pinned to R4.2D; generic/manual uploads
remain unchanged, and no Rails finalization request is implemented.


## Availability and trust boundary

This implements **extension-side capture, durable verification and request preparation**.
It does not enable live assessment delivery. The sibling Rails documents inspected were
`assessment-evidence-privacy-authorization.md`, `assessment-evidence-consent.md`, and
`assessment-event-ingestion.md`. R4.2C currently permits only three request keys and
retains its production HTTP 403 approval-contract guard. The new four-key request below
is a proposed extension of that contract, not an endpoint Rails already accepts.

`EventUploader` refuses a prepared assessment request with safe status `protocol`
**before calling the transport**. There is no enable flag. The generic queue lookup
continues to reject assessment-bound events. Separate destination-scoped upload
enablement, credentials, and fresh consent after reload remain required. The production
assessment pairing/start/status and scoped delivery adapter is still missing. Manual,
non-assessment uploads retain their existing three-key request and behavior.

The envelope asserts consistency with an uncompromised client's capture decision.
**It does not prove trusted execution of PrivacyFilter.** A compromised client can
fabricate an envelope, hash and capture reference. Rails must independently authenticate
the bearer, resolve the CodingSession, enforce its durable consent/binding/workspace/
category/window/revocation rules, validate schemas, and reject recognizable sensitive
content. Neither a clean digest nor a receipt replaces those checks. Source confirmation,
actual human interaction, true capture time and complete secret absence are not remotely
attested.

## Envelope and request

Each assessment event has exactly one corresponding `eventApprovals` entry, in the same
array order. Neither the normalized event schema nor the flat acknowledgment changes.
All examples are dummy fixtures; the digest below is executable shared test data.

```json
{
  "contractVersion": 1,
  "batchId": "55555555-5555-4555-8555-555555555555",
  "events": [{
    "schemaVersion": 1,
    "eventId": "11111111-1111-4111-8111-111111111111",
    "sessionId": "22222222-2222-4222-8222-222222222222",
    "source": "vscode",
    "eventType": "file.modified",
    "timestamp": "2030-01-01T10:00:01.000Z",
    "workspaceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "attribution": "unknown",
    "payload": { "relativePath": "src/你好.ts" }
  }],
  "eventApprovals": [{
    "approvalProtocolVersion": 1,
    "eventId": "11111111-1111-4111-8111-111111111111",
    "localRecordingSessionId": "22222222-2222-4222-8222-222222222222",
    "consentReceiptId": "33333333-3333-4333-8333-333333333333",
    "workspaceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "captureApprovalReference": "44444444-4444-4444-8444-444444444444",
    "canonicalization": "RFC8785",
    "eventDigest": "e75286632c74c232a061a4f7b165fa3a19d1819a0bf3428c7561da33d2086703"
  }]
}
```

All eight approval fields are required; unknown fields/versions are unsupported.
Event, local recording, receipt and capture references are UUID v4 strings. Preserve
their original spelling; exact field comparisons are case-sensitive even though the
UUID syntax validator accepts either case. Workspace and digest are lowercase 64-digit
hex. `captureApprovalReference` is a random, public opaque reference assigned once at
capture, not a bearer secret, key, or cryptographic attestation. `eventType` and all
optional event fields are bound through the complete event digest, rather than copied
into another potentially inconsistent envelope field.

The builder rejects missing/mixed/duplicate associations. Each request has one recording,
one receipt, one authenticated Rails assessment and one HTTPS origin; it may contain
multiple workspaces only within that receipt's approved scope. Event IDs and capture
references must be unique in the batch. Internal `AssessmentApprovalBinding` carries
the trusted CodingSession/origin/receipt/current server time from authenticated status
and receipt handling; it is never serialized or accepted from event claims. No candidate,
challenge or Rails ownership IDs are added to the wire request.

The existing default 100-event/1 MiB and hard 1000-event/4 MiB request limits apply to
the **whole body**, including approvals. An oversized prepared body pauses safely rather
than truncating evidence. No delivery or batch claim is acknowledged merely by preparing
an envelope. A future scoped uploader should reserve sidecar overhead when selecting
batches; the current builder rejects oversize bodies without dropping events.

The response remains exactly:

```json
{
  "contractVersion": 1,
  "batchId": "55555555-5555-4555-8555-555555555555",
  "durablyAcceptedEventIds": ["11111111-1111-4111-8111-111111111111"]
}
```

Only IDs durably committed by Rails may be acknowledged. Missing IDs remain pending;
retries preserve original event IDs, envelopes and capture references even under a new
batch ID. Existing partial acknowledgment, cancellation and at-least-once semantics stay
unchanged. Do not echo private content or approval records in errors or diagnostics.

## Canonical bytes: RFC 8785 / JCS

`eventDigest = lowercase_hex(SHA256(UTF8(JCS(sanitizedNormalizedEvent))))`.
Hash only the exact sanitized event that will appear in `events`, excluding its approval,
batch ID and transport whitespace. UTF-8 has no BOM or trailing newline. A changed value,
array order or field presence invalidates approval; different object-member order does
not affect this wire digest. The existing local exact-byte check still rejects replacing
a stored event with a reordered snapshot.

Use [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html), not Ruby's ordinary
`JSON.generate` or a custom recursively sorted JSON dump:

- Recursively sort object property names by their **raw UTF-16 code units**; preserve
  array order. Numeric-looking property names are sorted as strings, not JavaScript's
  integer-property enumeration order. No insignificant whitespace is emitted.
- Preserve valid Unicode exactly, without normalization. Composed and decomposed text
  have different digests. Escape strings according to ECMAScript JSON serialization;
  reject lone surrogates/invalid Unicode. Do not apply HTML escaping.
- Use finite IEEE 754 binary64 values and ECMAScript's shortest round-tripping decimal
  representation, including exponent spelling and `-0` → `0`. For example `1.0` → `1`,
  `1e-6` → `0.000001`, `1e-7` → `1e-7`, and `1e21` → `1e+21`. JavaScript has already
  parsed numeric input into binary64; a Ruby arbitrary-precision integer/decimal must
  follow the same numeric domain **for canonical hashing**, without rewriting stored
  event contents. Event-schema integer constraints still apply independently. Large
  exact identifiers belong in strings, not numeric JSON values.
- A missing property and a property with `null` differ. Do not insert defaults or omit
  existing optional fields before hashing. Reject unsupported values rather than
  converting `undefined`/functions/NaN/Infinity to missing/null. No `toJSON`, getters,
  custom objects, cycles, sparse arrays, symbol properties or proxies are admitted by
  the TypeScript implementation.
- Raw JSON parsers must reject duplicate member names, invalid encodings and non-finite
  numbers **before losing that information during parsing**. The TypeScript canonicalizer
  accepts already-parsed, validated JSON data and is not a raw JSON parser. Its limits
  are depth 32, 20,000 visited values and 16 MiB canonical bytes; existing event, payload
  and Rails limits may be smaller and must also be enforced.

`src/canonicalJson.ts` uses native ECMAScript primitive formatting and emits sorted
members directly, without constructing an object that would reorder numeric keys.
Canonicalization and SHA-256 run in the existing storage/upload workers in production.
No local encryption key, AES tag, secret consent material or raw admission context is
included in the envelope.

## Durable capture and recovery

New assessment captures under a valid, already registered receipt use local approval
**version 2**, containing the wire **approvalProtocolVersion 1** envelope. The storage
worker creates it inside the same transaction that inserts the encrypted event and
approval. It retains the capture-time workspace, event category, recording/source-content
admission and Rails consent association. Current PrivacyFilter runs again and must
accept the exact sanitized snapshot. Redacted prompts get approvals only for their
sanitized form; rejected events and original redacted diffs never get approvals (diff
reconstruction gaps retain the existing rules).

Existing AES-256-GCM approval encryption/AAD, independent random nonces, SecretStorage
keys, SQLite schema **8**, queue deduplication and transaction boundaries are unchanged.
The legacy local `eventDigest` remains SHA-256 over exact `JSON.stringify` event bytes;
it is **not** the new JCS wire digest. Both must verify. Manual captures and historical
local v1 approvals retain their old format. No migration, backfill, upload-time minting,
or retroactive receipt association is performed. A new consent cannot authorize a
historical event that lacks this original capture-time envelope.

`getAssessmentUploadContext(event, binding)` is a read-only storage-worker operation.
It authenticates both encrypted records, compares exact stored bytes, verifies the
persisted envelope, then checks the current persisted consent, trusted target assessment/
origin/receipt, scope, server-time bounds, expiry, deadline and revocation. Tampering or
wrong identifiers cannot regenerate a proof. Missing proofs remain blocked after restart.

Pending revocation or capture-window mutations block preparation. A confirmed stopped
receipt can cover earlier in-window evidence while still unexpired and eligible; it
cannot reopen capture or extend the deadline. Restart may recover authentic proofs,
but never recording/upload consent or a missing server receipt. A later receipt or
credential generation must not silently inherit old proof authorization. These current
client receipt checks still require `upload_authorized: false` and
`privacy_authorization: "unverified"`; this task does not invent new capability semantics.

## Shared interoperability fixtures

`src/test/fixtures/assessment-approval-v1.json` contains 16 explicit canonical byte/SHA-256
vectors: nested objects/arrays, reordering, numeric property names, supplementary Unicode
and UTF-16 sorting, control characters, composed/decomposed Unicode, missing/null,
ECMAScript number thresholds, binary64 rounding/extremes, and complete normalized events.
Three invalid raw JSON vectors cover duplicate keys, lone surrogates and overflow.
Ten shared envelope/scope cases cover acceptance/retry, event tampering, incorrect
receipt/workspace/recording/version, revocation, expiry and unapproved categories.

TypeScript tests consume these fixtures and separately exercise real encrypted workers,
restart, immutable duplicate records, redaction/rejection and the transport denial.
The independent Ruby verifier uses Ruby JSON **3.1.0**'s native RFC 8785 mode and rejects
duplicate raw JSON keys. It is a fixture utility in this repository, not a Rails change
or production authorization implementation. Its mock authority data must never be
accepted from clients as server authorization.

With Ruby 3.4 and JSON 3.1.0 available, run from this extension repository:

```sh
gem install json --version 3.1.0 --install-dir /tmp/ai-tracker-e44-gems --no-document
GEM_PATH=/tmp/ai-tracker-e44-gems ruby src/test/fixtures/verify-approval-vectors.rb
npm run compile
node node_modules/mocha/bin/mocha.js --ui tdd --timeout 20000 out/test/canonicalJson.test.js out/test/assessmentEventApproval.test.js out/test/durableEvidenceApproval.test.js out/test/railsEvidenceConsent.test.js
```

Native RFC 8785 support is checked before fixtures run; unavailable serializers fail
safely. Ordinary Ruby JSON and the older `json-canonicalization` gem are not substitutes:
the latter's decimal rounding does not match these binary64 vectors. Ruby is a development
verification dependency only; no extension runtime/package dependency was added.

## Exact Rails follow-up before enabling uploads

No Rails or React files are modified. Current Rails rejects the new fourth request key
with 422; its three-key request still hits the R4.2C 403 guard after scope/privacy checks.
Do not use either response as a reason to downgrade or remove authorization.

1. Implement and document strict, bounded recognition of `eventApprovals` and protocol
   version 1 at the existing events endpoint. Require exactly one matching entry per
   event, unique references/IDs, matching recording/workspace, one scoped receipt, no
   unsupported fields/versions and no mixed legacy/assessment contract. Include sidecars
   in the existing body/count limits. Reject duplicate JSON names at parse time.
2. Recompute RFC 8785 UTF-8 SHA-256 over each schema-valid original event and check the
   envelope against it. Run these shared vectors on the selected Ruby implementation.
   Preserve Rails' existing storage deduplication digest separately; do not reinterpret
   old stored hashes as JCS or modify events to make a hash match.
3. Resolve the assessment solely from the bearer. Resolve the referenced receipt from
   authenticated database relationships and verify its original recording binding,
   current credential generation, configured destination, scopes, workspaces, category,
   timestamps/window, expiry/revocation and eligibility on **every** retry. A client
   reference is a lookup/consistency input, never an ownership or consent grant.
4. Retain strict independent schemas and bounded secret/sensitive-path rejection. Treat
   the envelope only as the agreed advisory client assertion. Do not accept a boolean,
   claim remote PrivacyFilter attestation, trust the public capture reference as a
   secret, or silently redact event contents under their existing IDs.
5. Persist the accepted approval association/digest with durable evidence using existing
   sensitive-data protections. Define idempotent replay/conflict handling for reused
   event IDs and capture references, including new batch IDs. Never retroactively approve
   stored legacy events. Commit before returning only original accepted IDs in the
   unchanged flat acknowledgment. Recheck authorization before acknowledging duplicates.
6. Jointly agree receipt/capability response semantics before removing the extension's
   hard transmission gate or Rails' terminal missing-contract denial. Implement and test
   the real authenticated assessment control adapter and recording/receipt-scoped batch
   selection separately. Fresh destination upload consent and valid tokens remain
   mandatory. No finalization endpoint or implicit upload grace is introduced here.

Only after both implementations and cross-implementation integration tests pass should
legitimate assessment transmission be enabled. E4.4 supplies no bypass or automatic
enablement, and the Ruby fixture verifier is not evidence that production Rails accepts
the contract.

## Implementation and validation

Created `src/canonicalJson.ts`, `src/assessmentEventApproval.ts`,
`src/uploadBatchSerialization.ts`, `src/test/canonicalJson.test.ts`,
`src/test/assessmentEventApproval.test.ts`, the shared JSON fixture and Ruby verifier
under `src/test/fixtures/`, and this document. Modified `src/evidenceApproval.ts`,
`src/localEventQueue.ts`, `src/asyncLocalEventQueue.ts`, `src/localEventQueueWorker.ts`,
`src/uploadPrivacyContext.ts`, `src/eventUploadPrivacyWorker.ts`, `src/eventUploader.ts`,
`README.md`, `docs/durable-evidence-approval.md`, and `docs/event-uploader.md`.
No database schema, normalized event schema, package dependency or encryption format
changes were required.

Validation on 2026-10-19:

- TypeScript compilation, ESLint and `git diff --check`: passed.
- Focused canonical/approval/durable-approval/Rails-consent tests: **40 passing**.
- Independent Ruby JSON 3.1.0 verifier: **16 byte/digest vectors, 3 rejection vectors,
  and 10 approval cases passed**. Installed only in a disposable temporary gem directory.
- Complete suite, run once using VS Code 1.141.1: **605 passing, 0 failing**. Existing
  manual recording, Codex/Claude capture, encrypted storage and upload regressions pass.
- No real assessment backend requests, Rails/React edits, migrations or finalization
  implementation. Mock HTTPS tests remain isolated and retain TLS verification.
