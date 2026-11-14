# Autopilot controls

Each BB project's board has an Autopilot switch and a lane limit. Autopilot starts Off. The limit defaults to 3 and accepts whole numbers from 1 to 10. Both survive a plugin reload. Autopilot runs only while BB runs on this Mac, including when the board page is closed.

The existing board watcher considers one start per project per cycle, and on board-changed signals. A start's own signal refreshes the board without starting another lane in that cycle. The first Ready spec with no Start refusal uses the same Start function and first message as an owner click. Doctor is checked again by Start. Turning Autopilot Off while Doctor runs prevents that automatic start.

Lanes started by the owner count toward the limit, though an owner click can exceed it. Outside lanes, Landed lanes, stopped lanes and lanes waiting for an owner merge don't count. A lane waiting on an owner question keeps its slot. The board's formation uses the project's saved limit.

A Landed spec returns to Ready when today's tracker still marks it ready and has an open, unblocked ticket that isn't held. The landed lane remains visible until a new Lead starts. If every remaining ticket is held, it stays Landed. An open PR keeps the existing lane in review.

A returning Start creates a new Lead in a new managed worktree based on the default branch. Its first message names the previous Lead and forbids reusing the landed integration branch. Previous Leads, workers, environments and branches stay intact in BB and Git. The board and lane controls use the newest Lead by creation time; PR evidence comes from that Lead's environment, and local ticket progress comes from its branch. Returning work is selected from the main tracker's current snapshot, rather than the landed branch's old ticket states.

## Functions for follow-on tickets

`registerAutopilot` in `lib/autopilot.ts` returns `get`, `set`, `update`, `pause`, `resume`, `observe`, `isOn` and `enabledProjectIds`. `update` serializes read/modify/write per project and validates the resulting state. Public state contains `status` (`off`, `on`, `paused`), `laneLimit`, `consecutiveStops` and `pauseReason`. `resume` clears the reason and consecutive-stop count. Private outcome markers prevent repeated counting, as described below.

The board calls `autopilot.get` and the client-only `autopilot.set` RPC. Trusted server controls are reusable by the later CLI and brakes, which must establish their own owner-action checks. They are not exposed as agent tools.

`registerLaneStart` returns `start(projectId, specId, startedBy, allowed?)`. Both the board and watcher use it. It deduplicates concurrent starts of the same spec and accepts a final guard checked immediately before spawning. New Lead metadata includes `startedBy: owner | autopilot`, alongside `role` and `specId`.

`autopilotLaneCount` counts a derived board. The scheduler reads the board's Ready order. Queue ordering, the main quick-check brake and CLI commands belong to their own tickets. `pause` and `resume` provide reusable controls for them.

The watcher and existing Linear reader continue watching enabled projects. No additional service or polling loop is registered. Settings use per-project plugin KV keys; lane and ticket states remain derived from BB, the tracker and pull requests.

## Ready queue

The board and scheduler share the Ready order from `sortQueue` in `lib/board-derive.ts`. Linear uses ascending `sortOrder`, then priority (Urgent first, no priority last), then oldest `createdAt`. These fields survive the Linear mirror and tracker snapshot. GitHub and Local markdown retain their reader's snapshot order; a reader that supplies `trackerOrder` can use equal ordinals with creation time as the tie-break. Snapshot order breaks remaining ties.

A Ready row's optional `waitingFor` contains the spec's open blockers. It is separate from ticket blockers: a partial ticket frontier can start, but an open blocker of the spec refuses Start. The Ready section links each waiting blocker and marks the first row without a Start refusal as Next, even while Autopilot is Off. Held specs and specs with open planning remain Shaping and never enter this queue.

## Consecutive-stop brake (SQD-209)

Before scheduling, the board observes derived outcomes for Squadron lanes while Autopilot is On or Paused. Two stopped lanes pause it with `Two lanes in a row stopped`; a landing resets the count. An owner question isn't a stopped outcome. Outside lanes neither increment nor reset the count. An unread or failed tracker snapshot supplies no outcomes. Flying lanes are never messaged or changed by the brake.

`observe(projectId, board)` shares the controls' serialized write queue. Private `observedOutcomes` markers, keyed by Lead thread ID, are saved atomically with the count under the existing per-project KV key. They aren't lane state or a public RPC field. Existing settings migrate with an empty marker map. Reads, reloads and Resume retain these markers; the same historical stopped lane counts once, and a later landing resets once. New outcomes use `outcomeAt` (merge time or latest lane-thread update) then Lead ID for deterministic ordering within one read.

The client-only `autopilot.resume` RPC uses the trusted `resume(projectId)` control, clearing the reason and stop count. `needsYou(board)` emits one `autopilot-paused` item with key `autopilot-paused`, no spec or thread target, and the pause reason as text. The board's Resume calls that RPC and refreshes. SQD-220 connects the CLI to trusted controls; SQD-196's notifier consumes the Needs you item after Lead reconciles the branches. Neither is implemented here.

[ADR-0011](adr/0011-autopilot-brakes-and-local-lifetime.md) records the brakes and local BB lifetime.

## Merged-main quick-check brake (SQD-212)

While Autopilot is On or Paused, any merged lane PR triggers the project's quick check before the watcher considers another start. The host reads the PR's merged commit, fetches remote main into its own temporary repository, verifies that the merge belongs to main, and checks that commit in a detached throwaway worktree. The owner's checkout supplies only read-only repo metadata; no fetch, checkout or worktree registration changes it. A later main commit cannot replace the PR's merge commit. The check receives `SQUADRON_BASE`, the merged commit's first parent, for diff-based checks. Lanes don't set it.

The host retains stdout and stderr in `quick-check.log` under its own temporary root, removes its scratch worktree and repository, and returns the log's host path. Failure pauses with `Main fails its quick check`; Needs you links the log beside Resume. Passing checks clear neither another pause nor the stop count. A host/setup read that cannot complete blocks scheduling rather than treating unknown main as passing.

Private `checkedMerges` receipts, keyed by PR URL, share the controls' serialized queue and KV key with the stop markers. The queue awaits each host result and saves the receipt together with any pause, so concurrent refreshes and reloads don't recheck a completed merge. Resume retains receipts and clears the failure log. An interrupted check without a saved result is retried. Paused projects remain watched; Off projects run no check. Outside merges also affect shared main and trigger its check without changing their threads or the stop brake. Local-only lanes don't trigger the remote-main check.
