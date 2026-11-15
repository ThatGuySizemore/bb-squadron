# Autopilot controls

Each BB project's board has an Autopilot switch and a lane limit. Autopilot starts Off. The limit defaults to 3 and accepts whole numbers from 1 to 10. Both survive a plugin reload. Autopilot runs only while BB runs on this Mac, including when the board page is closed.

The existing board watcher considers one start per project per cycle, and on board-changed signals. A start's own signal refreshes the board without starting another lane in that cycle. The first Ready spec with no Start refusal uses the same Start function and first message as an owner click. Doctor is checked again by Start. Turning Autopilot Off while Doctor runs prevents that automatic start.

Immediately before an automatic spawn, Squadron rechecks that the selected spec is still Ready with no Start refusal, Autopilot is still On, and capacity remains. A hold applied while Doctor runs prevents that start.

Lanes started by the owner count toward the limit, though an owner click can exceed it. Outside lanes, Landed lanes, stopped lanes and lanes waiting for an owner merge don't count. A lane waiting on an owner question keeps its slot. The board's formation uses the project's saved limit.

A Landed spec returns to Ready when today's tracker still marks it ready and has an open, unblocked ticket that isn't held. The landed lane remains visible until a new Lead starts. If every remaining ticket is held, it stays Landed. An open PR keeps the existing lane in review.

A returning Start creates a new Lead in a new managed worktree based on the default branch. Its first message names the previous Lead and forbids reusing the landed integration branch. Previous Leads, workers, environments and branches stay intact in BB and Git. The board and lane controls use the newest Lead by creation time; PR evidence comes from that Lead's environment, and local ticket progress comes from its branch. Returning work is selected from the main tracker's current snapshot, rather than the landed branch's old ticket states.

## Functions for follow-on tickets

`registerAutopilot` in `lib/autopilot.ts` returns `get`, `set`, `update`, `pause`, `resume`, `observe`, `isOn` and `enabledProjectIds`. `update` serializes read/modify/write per project and validates the resulting state. Public state contains `status` (`off`, `on`, `paused`), `laneLimit`, `consecutiveStops` and `pauseReason`, with optional check progress, failure log and skipped-main-check notices. `resume` refuses unless paused, then clears the reason, failure log and consecutive-stop count. Private outcome markers prevent repeated counting, as described below.

The board calls `autopilot.get` and the client-only `autopilot.set` RPC. The CLI and brakes reuse the trusted server controls. Board RPCs remain client-only; no agent RPC tools are added. The CLI follows SQD-196's owner/Helper contract: the Helper acts only on the owner's own words, and neither a command nor a notification grants approval.

`registerLaneStart` returns `start(projectId, specId, startedBy, allowed?)`. Both the board and watcher use it. It deduplicates concurrent starts of the same spec and accepts a final guard checked immediately before spawning. New Lead metadata includes `startedBy: owner | autopilot`, alongside `role` and `specId`.

`autopilotLaneCount` counts a derived board. The scheduler reads the board's Ready order. Queue ordering, the main quick-check brake and CLI commands belong to their own tickets. `pause` and `resume` provide reusable controls for them.

The watcher and existing Linear reader continue watching enabled projects. No additional service or polling loop is registered. Settings use per-project plugin KV keys; lane and ticket states remain derived from BB, the tracker and pull requests.

## Ready queue

The board and scheduler share the Ready order from `sortQueue` in `lib/board-derive.ts`. Linear uses ascending `sortOrder`, then priority (Urgent first, no priority last), then oldest `createdAt`. These fields survive the Linear mirror and tracker snapshot. GitHub and Local markdown retain their reader's snapshot order; a reader that supplies `trackerOrder` can use equal ordinals with creation time as the tie-break. Snapshot order breaks remaining ties.

A Ready row's optional `waitingFor` contains the spec's open blockers. It is separate from ticket blockers: a partial ticket frontier can start, but an open blocker of the spec refuses Start. The Ready section links each waiting blocker and marks the first row without a Start refusal as Next, even while Autopilot is Off. Held specs and specs with open planning remain Shaping and never enter this queue.

## Consecutive-stop brake (SQD-209)

Before scheduling, the board observes derived outcomes for Squadron lanes while Autopilot is On or Paused. Two stopped lanes pause it with `Two lanes in a row stopped`; a landing resets the count. An owner question isn't a stopped outcome. Outside lanes neither increment nor reset the count. An unread or failed tracker snapshot supplies no outcomes. Flying lanes are never messaged or changed by the brake.

`observe(projectId, board)` shares the controls' serialized write queue. Private `observedOutcomes` markers, keyed by Lead thread ID, are saved atomically with the count under the existing per-project KV key. They aren't lane state or a public RPC field. Existing settings migrate with an empty marker map. Reads, reloads and Resume retain these markers; the same historical stopped lane counts once, and a later landing resets once. New outcomes use `outcomeAt` (merge time or latest lane-thread update) then Lead ID for deterministic ordering within one read.

The client-only `autopilot.resume` RPC uses the trusted `resume(projectId)` control, clearing the reason and stop count. `needsYou(board)` emits one `autopilot-paused` item with key `autopilot-paused`, no spec or thread target, and the pause reason as text. The board's Resume calls that RPC and refreshes. The CLI uses the same trusted Resume control and refusal. SQD-196's notifier consumes the same Needs you item.

[ADR-0011](adr/0011-autopilot-brakes-and-local-lifetime.md) records the brakes and local BB lifetime.

## Merged-main quick-check brake (SQD-212)

Switching Autopilot from Off to On first reads existing merge evidence, even if the board has never opened. Those merged PRs become a saved baseline and don't trigger checks. This read runs no Doctor, quick check or lane start. If existing merges can't be read, switch-on refuses with `Couldn't read existing merges. Try again shortly.`

While Autopilot is On or Paused, a newly observed merged lane PR outside that baseline triggers the project's quick check before the watcher considers another automatic start. The host reads the PR's merged commit, fetches remote main into its own temporary repository, verifies that the merge belongs to main, and checks that commit in a detached throwaway worktree. The owner's checkout supplies only read-only repo metadata; no fetch, checkout or worktree registration changes it. A later main commit cannot replace the PR's merge commit. The check receives `SQUADRON_BASE`, the merged commit's first parent, for diff-based checks. Lanes don't set it.

The host retains stdout and stderr in `quick-check.log` under its own temporary root, removes its scratch worktree and repository, and returns the log's host path. Failure pauses with `Main fails its quick check`; Needs you links the log beside Resume. Passing checks clear neither another pause nor the stop count. A host/setup read that cannot complete blocks scheduling rather than treating unknown main as passing.

Main checks run in the background, outside the controls' serialized save queue and the board load. Private `pendingMainChecks` entries retain observed merges until a result is saved. Each project tracks one background check at a time; concurrent refreshes don't duplicate it. A detached host command may still be finishing when a new check starts. Private `checkedMerges` receipts, keyed by PR URL, are saved with any resulting pause in the same serialized write and KV key as the stop markers. Completed merges aren't rechecked after a reload. Resume retains the baseline and receipts and clears the failure log. An interrupted check without a saved result is retried. Paused projects remain watched. Outside merges also affect shared main and follow the same baseline and check rules without changing their threads or the stop brake. Local-only lanes don't trigger the remote-main check.

While a check is pending, the board shows `Checking main…` and automatic starts wait for that project. Board reads and owner controls still finish while the host runs. The existing watcher continues its 30-second discovery and observation, including other projects; it creates no additional polling loop. An unavailable host check keeps automatic starts waiting and is retried on a later watcher pass.

Switching Off detaches a running check and clears pending checks. It doesn't cancel the host command, but its late result cannot save a receipt or pause Autopilot. Switching On again records a fresh merge baseline, so a detached check's late failure cannot pause the new run.

Private `pendingOutsideEnvironments` references retain observed Outside merge sources even if their specs close and disappear from the tracker before the next refresh or plugin restart. PR reads use the existing batches of at most 200 environment IDs. A reference stays while its lane is visible or its PR is unresolved. Missing and unavailable PR rows block automatic starts for up to 30 minutes from their first unreadable observation. That time survives reload, including when the source disappears. A readable PR clears its unreadable time and follows the normal main check. An explicit `absent` row is readable evidence of no PR: it clears the unreadable time, never blocks starts and retires a hidden source. A readable merged PR whose host check is unavailable keeps its normal retry barrier; the PR-read timeout does not bypass it.

At 30 minutes Squadron drops the unreadable reference and saves one stable Needs you notice, "Couldn't check main after PR #N; Autopilot carried on." It remembers the last known PR number, or names the spec if the number was never readable. The notice and dropped-source marker survive reload; later reads cannot re-add that source or repeat its notification. Switching Off clears pending references and unreadable times, so switching On starts a fresh merge baseline. Existing notices remain visible. Once hidden, a closed PR retires its reference, and a merged PR retires it after its check receipt is saved. Retired sources need no historical PR scan. These references supply merge evidence only: Outside lanes remain read-only and occupy no Autopilot slot.

An optional [Check setup](settings.md#check-setup) command prepares dependencies only in the scratch worktree before Quick check. A setup failure retains the log, skips Quick check and applies the same main-check brake.

## Command line (SQD-220)

`bb squadron autopilot on|off|pause|resume|lanes <n>` uses the shared controls. Each command accepts `--project <id-or-unique-name>`, otherwise uses the caller's project, or the only project when unambiguous. Success and action refusals print one short line; refusals exit nonzero.

Parent SQD-197 story 23 explicitly includes Pause, although its implementation command list omits it. `pause` calls the existing shared pause control with `Paused at your request`. It preserves the stop count, leaves flying lanes alone, and produces the existing Autopilot-paused Needs you item for the Helper. `resume` refuses from Off or On with `Autopilot isn't paused.` and resets the count only from Paused. `lanes` accepts whole counts from 1 to 10 without changing the current pause or count. On and Off retain the board switch's existing semantics.
