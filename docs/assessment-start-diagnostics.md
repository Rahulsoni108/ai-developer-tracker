# Assessment start: production prerequisites and safe diagnostics

## Investigated behavior

A paired/prepared assessment is not started by the first **Start Recording** button
alone. It confirms recording permission within **Start Assessment**. All local
prerequisites and the separate upload dialog must succeed before the authenticated
Rails `/api/v2/coding_session/extension/start` request. Recording becomes active only
after Rails timing/binding and the scoped evidence-consent receipt are validated.

The reported live host condition (first dialog accepted, no upload dialog, Rails still
prepared) was not reproduced against a live Rails session. No server records were changed.
It narrows the interruption to the recording/workspace/storage/baseline preparation path,
or to accidentally invoking the independent manual recording command. The user must not
be asked to delete evidence, bypass consent or set the timer manually to diagnose it.

Verified shortcomings addressed:

- Start failures had no assessment-specific Output trace or command warning. A subsequent
  Show Assessment Status could report paired and clear the generic reason when Rails
  correctly still reported prepared. The last failed start prerequisite now remains visible
  independently of the latest authoritative status, until the next attempt/pair/archive.
- Existing integration fixtures usually returned a boolean from recording consent and
  selected workspaces before starting. They did not exercise the actual asynchronous
  post-dialog workspace selection while a recording request was pending.
- The production callback checked open folders after selection but did not verify that
  FileTracker actually retained approval for those exact folders. It now fails closed if
  selection was discarded, superseded or unavailable. Existing cancellation/workspace
  change and privacy safeguards remain in place.

## Trace and authority

| Step | Work / safe diagnostic |
| --- | --- |
| Command | `ai-developer-tracker.startAssessment` invokes AssessmentController.start |
| Before recording | `requested`, `credential_check`, `server_status` verify connection, archive quarantine and Rails eligibility |
| First dialog | `recording_consent`; decline/cancellation is identified explicitly |
| Workspaces | `workspace_approval` indexes the current approved folders; success is `workspace_approved` |
| Storage | `local_storage` prepares the recording in the encrypted queue |
| Code baseline | `diff_baseline` reads eligible bounded files using existing exclusions; a large workspace may take time |
| Assessment listener | `assessment_authorization` reaches the assessment lifecycle preparation hook |
| Separate approval | `upload_consent` shows the destination-scoped upload dialog |
| Binding | `binding_write` durably stores the proposed original local UUID and request before the Rails call |
| Official start | `rails_start` sends the existing authenticated start contract; `binding_validation` checks original server timing and IDs |
| Evidence consent | `evidence_consent` registers/verifies the existing scoped receipt before collectors activate |
| Completion | `recording_activation`, then `assessment_active` only after local capture and durable metadata succeed |

A cancelled request, missing/changed/unapproved workspace, inaccessible files, degraded
storage or failed baseline cannot trigger an early server start. Refusing upload consent
also leaves Rails unstarted. A Rails start may already have committed if a later consent
registration fails; no success is claimed, no local timer is invented, and retries preserve
existing binding/deadline recovery rules.

The palette labels now distinguish **Start Recording (Manual / Development)** and
**Stop Recording (Without Submitting)**. The recording status bar still invokes the
manual command. When a Rails connection is paired (including recovery), it now asks
whether to use **Start Assessment** or deliberately **Start Manual Recording**; Cancel
changes nothing. The assessment choice invokes the normal command and fresh consents.
Manual recording never starts Rails, shows its upload consent or adopts evidence into
the paired attempt. Manual invocation and assessment prerequisites remain distinct in Output.

## Confirmed `recording_busy` conflict

A manual command followed by `recording_consent`, workspace approval, `local_storage`,
`diff_baseline` and `assessment_authorization`, but no upload dialog, is reproducible:
the assessment lifecycle listener is registered for every recording; its authorization
body returns immediately unless `AssessmentController.start()` initiated this start.
The preparation label alone does not prove a Rails request or assessment binding.

An active manual recording, or one still being prepared, then blocks assessment start.
That guard is required: the assessment must not reuse its recording UUID, baseline or
evidence. Previous archived connections do not cause this conflict. New diagnostics
identify `manual_recording_active` versus `recording_start_pending`, with safe retry
instructions. A local conflict now leaves the paired connection and durable metadata
unchanged instead of moving it into recovery through generic error handling.

To resolve safely, run **AI Developer Tracker: Stop Recording (Without Submitting)**
(**Stop Recording** on an older build) and wait for local producer/write draining.
This stops manual capture only. Its encrypted pending events remain retained; the paired
assessment is not finalized, archived, deleted, re-paired or reset. Then run **Start
Assessment** and approve fresh recording/workspace/upload permissions. It creates a new
local recording ID and requests Rails authorization through the existing contract.

Reproducing tests preserve a manual event in encrypted SQLite, exercise this exact
preparation sequence, reject adoption, stop/drain, and assert that the eventual Rails
binding contains only a fresh assessment recording. Tests also cover manual recording
starting during server-status lookup, pending preparation cancellation, explicit command
choices, archive-only/manual compatibility and drain failures. Mock HTTPS and archive
regressions remain included; no live assessment records are altered by these tests.

## Exact manual retry

1. Compile the current extension and reload the **Extension Development Host** so its
   activated JavaScript includes this change. Do not archive, re-pair or reset storage
   merely for diagnostics. Keep mock mode off and the trusted HTTPS origin unchanged.
2. In that host, open **View → Output → AI Developer Tracker**. Open the approved local
   assessment workspace and run **AI Developer Tracker: Show Assessment Status**.
3. Run **AI Developer Tracker: Start Assessment** from the Command Palette (not the manual
   Start Recording command or its status-bar toggle). Approve recording if you agree.
4. Watch the fixed prerequisite codes. Before a second dialog, the last message should
   identify workspace selection, local storage or baseline preparation. Show Assessment
   Status can display an in-progress preparation without waiting for its entire operation.
5. For workspace errors, check that the folders are local, readable, still open and outside
   extension storage. For `local_storage`/`storage_unavailable`, use **Show Local Queue Health**.
   For `diff_baseline`, allow initial preparation to finish and review workspace size,
   exclusions and access. For `request_cancelled`, check Stop, workspace changes or consent
   revocation. Do not weaken exclusions or storage protections to get past a failure.
6. Approve the separate upload dialog only if you agree. Then expect `rails_start`,
   `binding_validation`, `evidence_consent` and `assessment_active`. Only Rails sets the
   official start/deadline. A start warning or retained failed prerequisite explains an
   unsuccessful attempt even if later status is still paired.
7. If it still stops, report the final prerequisite/status/reason codes. Do not copy tokens,
   pairing codes, prompts, file names, paths, source content, diffs or raw API responses.

The new trace contains fixed allowlisted steps, statuses and safe reason codes only. Last
start diagnostics are process-local, not evidence, an authorization flag or a recording
state copy. New pairing and successful archival clear them. Archived IDs/assessment
identities remain quarantined and do not supply consent/workspace approval to a new start.

## Coverage

`Assessment production recording preparation` runs the actual shared workspace-approval
function with real FileTracker, DiffTracker, RecordingController, EventPersistence and
an isolated encrypted SQLite queue. It covers delayed selection/baselines, approval loss,
read failure, cancellation, workspace changes, recording/upload refusal, status refresh,
manual recording and a fresh assessment after archival. Existing mock HTTPS tests assert
real Rails adapter start success and safe diagnostics for start/consent failures.

```sh
npm run compile
npm run lint
npm test -- --code-version 1.141.1 --grep 'Assessment production recording preparation|Assessment lifecycle foundation|Recording controls'
npm test -- --code-version 1.141.1
```
