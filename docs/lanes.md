# Starting a lane

The board calls `lanes.start` with the BB project ID and the spec's Linear identifier. The server reads the selected project's default checkout, runs Doctor and refreshes its Linear mirror before asking the Helper core whether Start is allowed.

The core requires a ready spec with at least one open ticket whose blockers are done. Open spec blockers, a stale or failed mirror, invalid settings and the lane cap hold Start. Starting and stopped lanes keep their slots until lifecycle handling explicitly releases them.

`registerLanes` reserves a durable lane before calling `bb.sdk.threads.spawn`. The SDK creates a managed worktree and a new branch from the project's default branch. That actual branch is the lane's integration branch. The Lead prompt tells it to keep the branch until the PR merges. The service waits for provisioning, then records the environment and branch. It never changes the installed checkout.

The spec's own labels select the Lead route. Spawn sets the provider, model, effort, `auto` permission mode and `default` service tier explicitly. Thread plugin metadata includes the lane ID, spec identifier, Linear issue ID, route, role and start time. Metadata is for linking and reconstruction; it grants no authority.

After the Lead's worktree is ready, the Helper queues the spec's In Progress status and a signed Lead comment through the outbox. Keys are stable for the lane. The outbox checks the expected workspace before queuing each write, and retains its normal delivery and retry behavior. A pending receipt proves queuing, not delivery.

## Extension points

- `helperCore` accepts fixture snapshots, settings, time, durable `LaneRun` records and an optional Start action. It returns the board, a Start decision and typed commands. Board reads alone never launch agents.
- `lane-contract.ts` owns the durable record schema and board Start RPC contract.
- `registerLanes` returns `start`, `list`, `save` and `onChange`. Subsequent worker, reviewer and lifecycle handlers can use these service methods. `save` is trusted server code, never an agent tool or owner approval.
- `registerDoctor` returns `check`, shared by lane preflight and its existing RPC.
- The board service reads lane records and subscribes to their changes. Its existing Flying view links the Lead and displays the actual integration branch.

Starts are serialized per BB project, including different specs, and concurrent clicks for the same spec share one result. A failed or ambiguous launch keeps its reservation. When the Lead ID is known, failure attempts to stop it and keeps its link on the board. Automatic reconstruction of interrupted starts and later lane controls belong to subsequent Spec B tickets.

## Evidence boundaries

Tests use the approved Helper-core fixtures, board action handler and SDK plugin-host seams with synthetic recorded Linear responses. They cover Start eligibility, caps, route selection, thread metadata, managed-worktree requests, Flying links, outbox delivery, duplicate starts and failure/reload preservation. They do not prove real provider startup, managed worktree provisioning on an enrolled host, live Linear delivery or browser interactions.
