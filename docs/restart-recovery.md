# Restart catch-up

`registerRestart` catches up on load through its background service, every 15
seconds, and after thread or mirror changes. A new Start waits for the initial
thread scan. Reads include hidden and archived plugin-origin threads and every
page. A failed scan refuses new dispatch until a later scan succeeds.

The mirror keeps its existing full-start catch-up, backoff and Linear rate-limit
budget. Recovery doesn't run a competing Linear poller. A mirror change requests
another recovery pass if one is already in progress.

## Durable state and disposable links

ADR-0005 separates the disposable mirror and reconstructed links from the
owner's binding and auto-start choice, execution bindings, outbox, thread grants,
and receipt evidence. These currently share the SDK's SQLite file but occupy
separate tables. Wiping that entire file is **not** safe cache maintenance.
Recovery never deletes any of these rows.

`squadron_lanes` holds trusted execution records. `squadron_recovered_links` is a
disposable display cache. A surviving execution record always wins, including
stopped or completed state and optional worker review/question fields. Recovery
serializes against Start through the project queue and against worker/lifecycle
commands through `workers.withLane`. `reconcileInLane` runs only while that queue
is held; callers must not recursively enter it.

If execution bindings are lost, the Helper can rebuild issue/thread/environment/
branch links using thread metadata, actual BB project/parent/environment fields,
and the current Linear mirror. Those lanes are stopped and explicitly marked
unproven. They retain capacity, expose their known links, and receive no worker
or report tools. Metadata never creates owner approval, grants, receipt IDs,
commit reports, integration proof or review verdicts. B6's PR reader can follow
the reconstructed environment and branch through BB's pull-request plugin;
metadata itself doesn't prove a PR or its checks.

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
Ordinary failed workers remain visible for explicit lifecycle recovery. Owner
stops and cancellations are preserved.

## Missed lifecycle events and writes

A linked Lead observed failed, archived, deleted, stopping or in another project
becomes a stopped lane retaining its branch and reservation. A linked worker in
those states retains its record as failed. Idle and assistant text never mean
done, approved, integrated or merged. A failed SDK read doesn't prove a Lead
stopped. Diagnostics contain safe error classes/codes, never provider messages.

Known provisioning continues through `reconcileStart`. Refused or interrupted
start writes retry through the same method and original dedupe keys. Existing
pending writes and receipt IDs remain in the outbox. Missing worker start writes
also retry from the preserved worker record. This establishes queuing only.

## Evidence boundary

The SDK-host tests use real temporary SQLite, recorded synthetic Linear reads,
and deterministic thread/queue snapshots. They exercise lost spawn responses,
failed releases, duplicate/edited candidates, missed lifecycle events, missing
receipts, and erased disposable snapshots or execution links. They do not prove
an actual process kill, real provider execution, live Linear delivery or a
plugin being unloaded at the 24-hour scheduled-prompt deadline. The dispatch hook
is present only while the plugin is loaded; unloaded-plugin deadline behavior
remains unproven.
