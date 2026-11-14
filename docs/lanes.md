# Starting a lane

The board calls `lanes.start` with the BB project ID and the spec's Linear identifier. The server reads the selected project's default checkout, runs Doctor and refreshes its Linear mirror before asking the Helper core whether Start is allowed.

The core requires a ready spec with at least one open ticket whose blockers are done. Open spec blockers, a stale or failed mirror, invalid settings and the lane cap hold Start. Starting and stopped lanes keep their slots until lifecycle handling explicitly releases them.

`registerLanes` reserves a durable lane before calling `bb.sdk.threads.spawn`. The SDK creates a managed worktree and a new branch from the project's default branch. That actual branch is the lane's integration branch. The Lead prompt tells it to keep the branch until the PR merges. The service records the environment and branch when provisioning is ready. It never changes the installed checkout.

The spec's own labels select the Lead route. Spawn sets the provider, model, effort, `auto` permission mode and `default` service tier explicitly. Thread plugin metadata includes the lane ID, spec identifier, Linear issue ID, route, role and start time. Metadata is for linking and reconstruction; it grants no authority.

After the Lead's worktree is ready, the Helper queues the spec's In Progress status and a signed Lead comment through the outbox. Keys are stable for the lane. The outbox checks the expected workspace before queuing each write, and retains its normal delivery and retry behavior. A pending receipt proves queuing, not delivery.

## Extension points

- `helperCore` accepts fixture snapshots, settings, time, durable `LaneRun` records, the project's auto-start setting and an optional Start or reconcile action. It returns the board, a Start decision and typed commands. Board reads alone never launch agents.
- `lane-contract.ts` owns the durable record schema and board Start RPC contract.
- `registerLanes` returns `start`, `list`, `save` and `onChange`. Subsequent worker, reviewer and lifecycle handlers can use these service methods. `save` is trusted server code, never an agent tool or owner approval.
- `registerDoctor` returns `check`, shared by lane preflight and its existing RPC.
- The board service reads lane records and subscribes to their changes. Its existing Flying view links the Lead and displays the actual integration branch.

Starts are serialized per BB project, including different specs, and concurrent clicks for the same spec share one result. A throwing or ambiguous spawn keeps its reservation visible as a stopped lane, with no invented Lead link. Its reason tells the owner to check BB threads before resuming.

Provisioning reads have a bounded wait. A timeout, failed read or creating/provisioning status leaves the lane starting and the same Lead active. The `lane-starts` service checks known starts every 15 seconds, without spawning another Lead. An explicit environment failure stops the Lead and keeps its link and reason visible. `reconcileStart(laneId)` is also available to trusted lifecycle handlers such as B8.

Once the branch is ready, a refusal to queue a status or comment keeps the lane flying and appears in Needs you. `LaneRun.startWrites` retains any receipt IDs already returned, and `writeError` names the operation that could not be queued. These IDs prove queuing only; the outbox owns pending, blocked and delivered state. `reconcileStart` can retry a flying lane's refused writes with the same keys after its original workspace connection is restored. The start watcher does not automatically retry refused writes.

`LaneStarted` is derived from its RPC schema. Its branch is null while provisioning continues, and its optional message explains provisioning or refused writes to the owner. `LaneRun` also retains the original host and In Progress state ID so later passes can finish the same start.

The shared signed-comment avatar module provides public origin-only URLs and constant role assets. The Lead has its own mark; planning retains its existing mark. Diagnostics retain the lane, operation and safe error class or known code. Raw provider messages and credentials never enter the log.

Full reconstruction of an interrupted or ambiguous spawn and later lane controls remain in subsequent Spec B tickets.

## Auto-start

The live board's `lanes.setAutoStart` RPC is client-only, like manual Start. It saves an explicit boolean per BB project in durable plugin storage. Projects with no saved value default off. This setting is independent of the Linear mirror and survives a plugin restart. The board reads the saved value through the lane service and refreshes after either a successful save or a refusal.

When enabled, trusted `lanes.reconcile(projectId)` fills the available slots. The Helper core's reconcile action first screens the cached mirror, local reservations and settings cached for up to a minute. It selects the first eligible spec in numeric identifier order, using the same blocker, frontier, freshness, settings and capacity checks as manual Start. Without a cached candidate, reconcile runs no Doctor check or Linear walk. Failed and pre-restart snapshots wait for the mirror poller's recovery and catch-up, preserving its quiet backoff and rate-limit budget.

Each candidate then shares manual Start's project queue, Doctor check, fresh mirror and settings reads, reservation, spawn and write path. The cached screen grants no dispatch by itself. The service repeats the decision with updated reservations before starting another spec. Disabling the setting while preflight is pending prevents that automatic launch.

Mirror changes and trusted lane `save` calls schedule a coalesced reconcile. A landed lane frees capacity; starting, flying and stopped lanes keep their slots. Disabling auto-start prevents future automatic launches and leaves current lanes running. The `lane-starts` service also periodically reconciles enabled projects after restart with no board open. Projects and provisioning continuations run concurrently, so one slow project does not delay another project's refill in the same pass. Provisioning continues to use `reconcileStart`, which never spawns a replacement Lead. The `autoStart(projectId)` read and `reconcile(projectId)` service methods add no agent tool or owner approval.

## Current conventions and open questions

The managed-worktree SDK chooses the integration branch name; it has no branch-name field. The route settings currently contain family, model and effort, so Start keeps the existing `auto` permission convention. Those limits remain questions for the eventual Spec B PR; this ticket changes neither convention.

## Evidence boundaries

Tests use the approved Helper-core fixtures, board action handler and SDK plugin-host seams with synthetic recorded Linear responses. They cover Start eligibility, caps, route selection, thread metadata, managed-worktree requests, Flying links, outbox delivery, duplicate starts and failure/reload preservation. They do not prove real provider startup, managed worktree provisioning on an enrolled host, live Linear delivery or browser interactions.
