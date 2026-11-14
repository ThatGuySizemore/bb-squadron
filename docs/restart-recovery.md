# Restart catch-up

`registerRestart` catches up on load through its background service, every 15
seconds, and after thread or mirror changes. A new Start waits for the initial
thread scan. Reads include hidden and archived plugin-origin threads and every
page. A failed initial scan refuses new Start/auto-start until a later initial
scan succeeds. Once that gate has succeeded, a later scan failure retains the
last links and does not revoke existing bindings or gate every future dispatch.

The mirror keeps its existing full-start catch-up, backoff and Linear rate-limit
budget. Recovery doesn't run a competing Linear poller. A mirror change requests
another recovery pass if one is already in progress. Per-lane and per-project
failures are isolated, and the periodic service catches failures and keeps its
timer alive. Diagnostics retain safe error classes/codes only.

Metadata is mutable. The service caches its hints for the current plugin load,
fetches at most 200 uncached metadata records per pass, and continues remaining
records on later passes. Membership, parent, environment and lifecycle fields
come from fresh BB observations. An incomplete scan grants no unique-candidate
proof and never prunes links. Identical saved records cause no update or change
notification; already-linked working worktrees need no passive environment read.

## Durable state and disposable links

ADR-0005 separates the disposable mirror and reconstructed links from the
owner's binding and auto-start choice, execution bindings, outbox, thread grants,
and receipt evidence. These currently share the SDK's SQLite file but occupy
separate tables. Wiping that entire file is **not** safe cache maintenance.
Recovery never deletes durable owner, execution, grant, outbox or receipt rows.
It replaces disposable links only after a complete successful thread scan and a
usable Linear snapshot. Closed specs, deleted threads and superseded links then
stop occupying slots. Failed or incomplete scans retain the previous links.

`squadron_lanes` holds trusted execution records. `squadron_recovered_links` is a
disposable display cache. A surviving execution record always wins, including
stopped or completed state and optional worker review/question fields. Recovery
serializes against Start through the project queue and against worker/lifecycle
commands through `workers.withLane`. `reconcileInLane` runs only while that queue
is held; callers must not recursively enter it. Start reconciliation updates only
its owned fields, preserving newer review, question, safety, activity and owner
lifecycle fields. Passive recovery never marks agent progress or resets strikes
or nudge/action checkpoints.

If execution bindings are lost, the Helper can rebuild issue/thread/environment/
branch links using thread metadata, actual BB project/parent/environment fields,
and the current Linear mirror. Those lanes are stopped and explicitly marked
unproven. They retain capacity, expose their known links, and receive no worker
or report tools. Metadata never creates owner approval, grants, receipt IDs,
commit reports, integration proof or review verdicts. They also cannot reconfigure
a hinted thread's notification level.

The owner's Cancel can dismiss this display reservation. Its canceled record is
kept in `squadron_recovery_dismissals`, separate from trusted execution bindings.
It consumes no slot, returns the spec to Ready with its kept branch and holds
auto-start until the owner chooses Start. Later scans and restarts respect the
dismissal. Cancel sends no thread command or Linear write for these unproven
links. Stop and Resume cannot adopt them or restore their lost authority.
Adoption through Resume remains an explicit product question for the spec PR.

Loss of the owner's Linear binding requires the owner to bind the project again.
Loss of outbox/grant/receipt state cannot be repaired by reading Linear issues
or thread metadata. A missing referenced receipt produces a visible unproven
write reason and refuses replacement writes. Pending receipts remain pending;
only the outbox can establish delivered state.

## Interrupted launches

Before spawning, the Helper saves the launch reservation and a fingerprint of
its original first prompt. The prompt includes that reservation's ID. It still
uses B2's scheduled-first-prompt adapter and persists the returned thread binding
before releasing a provider session.

A lost spawn response can be correlated only when exactly one plugin-origin
thread in the correct project/parent has that reservation's exact pending prompt
and expected route, permission mode and tier. Metadata narrows candidates, but
is mutable and supplies no authority. Missing, changed or duplicate candidates
remain visibly unproven and reserved. Old records without the original launch
fingerprint cannot authorize automatic replay.

A known pending first prompt is released as the same queued row, after the
trusted binding is saved. Claimed, retry, grouped, edited, extra or missing queue
rows are not replayed. A send response lost after the queued row disappears is
unproven; the Helper doesn't invent a successful send or submit another prompt.
The code never calls spawn during recovery.

Failed worker reservations stay present. Only an interrupted spawn or original
prompt release can automatically continue. A worker occupies its existing slot
and is set working before release. Reported/integrated workers need a new active
reservation through the review/fix workflow before any automatic continuation.
Ordinary failed workers remain visible for explicit lifecycle recovery. The
approved lifecycle schema retains stoppedAt/canceledAt and canceled state.
Recovery preserves owner stops and cancellations; an explicit Resume can
continue the same known start. It doesn't erase question/notification identity.

## Missed lifecycle events and writes

A linked Lead observed failed, archived, deleted or in another project becomes
a stopped lane retaining its branch and reservation. A linked worker in those
states retains its record as failed. Stopping is a busy observation. An SDK read
failure leaves Lead/worker state intact for a later pass. Idle and assistant text
never mean done, approved, integrated or merged.

A missed owner answer can clear an existing question only with durable event
evidence: client/turn/requested after the question, initiator user, no sender
thread or plugin origin, joined by request ID to turn/input/accepted. Rejected,
agent, system, plugin-origin, old or unmatched requests do not clear it. The
reader is bounded to five pages of 200 filtered events. Missing or compacted
history keeps the question open. Prompt text, promptHistory and assistant claims
supply no ownership or approval evidence. This clears only that question; it
never grants a merge, deploy, release or new execution authority.

Initial reviewer launches use the same durable first-prompt evidence after the
reviewer implementation integrates. Recovery retains its exact commit, original
commit, round, findings and verdict fields. It releases only a proven initial
review in its existing reservation and saves reviewing state before dispatch.
Approved, changes, fixing and unproven second-look sends are not replayed as
initial launches. Automatic review continuation still requires reviewing or
second-look; worker continuation still requires a working cap reservation. A
legacy review without exact original prompt evidence stays unproven.

Known provisioning continues through `reconcileStart`. Refused or interrupted
start writes retry through the same method and original dedupe keys. Existing
pending writes and receipt IDs remain in the outbox. Missing worker start writes
also retry from the preserved worker record. This establishes queuing only.

## PR link projection

S6: `LaneService.list(projectId)` supplies the recovered Lead's actual BB `environmentId` and `branch` even when `recoveryOnly` is true. The `spec-merge` pass reads that environment through `bb--github-pr-status`'s built-in `pullRequests` reader and shows the PR on the stopped link when its head branch matches. The projection grants no execution, adoption or merge authority; metadata can't prove a PR, its checks or approval. See [Whole-branch review, PR and merge](spec-merge.md).

`tests/restart-plugin.test.ts` erases the execution-link store, rebuilds the stopped recovery-only lane, supplies the reader's recorded rows, and asserts issue, thread, branch and PR number, URL and checks on the board. It also asserts no tools, no Merge context or owner merge, no sends and no Done writes, even for a merged PR.

## Evidence boundary

The SDK-host tests use real temporary SQLite, recorded synthetic Linear reads,
and deterministic thread/queue snapshots. They exercise lost spawn responses,
failed releases, duplicate/edited candidates, missed lifecycle events, missing
receipts, complete/failed/incomplete scans, explicit display-only cancellation,
owner-answer history and a full plugin SQLite wipe followed by explicit owner
rebind and sync. That full-wipe test rebuilds stopped board links; it does not
restore lost outbox payloads, grants, receipts or prior owner settings. They do
not prove
an actual process kill, real provider execution, live Linear delivery or a
plugin being unloaded at the 24-hour scheduled-prompt deadline. The dispatch hook
is present only while the plugin is loaded; unloaded-plugin deadline behavior
remains unproven.
