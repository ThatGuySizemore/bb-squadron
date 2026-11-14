# Autopilot controls

Each BB project's board has an Autopilot switch and a lane limit. Autopilot starts Off. The limit defaults to 3 and accepts whole numbers from 1 to 10. Both survive a plugin reload. Autopilot runs only while BB runs on this Mac, including when the board page is closed.

The existing board watcher considers one start per project per cycle, and on board-changed signals. A start's own signal refreshes the board without starting another lane in that cycle. The first Ready spec with no Start refusal uses the same Start function and first message as an owner click. Doctor is checked again by Start. Turning Autopilot Off while Doctor runs prevents that automatic start.

Lanes started by the owner count toward the limit, though an owner click can exceed it. Outside lanes, Landed lanes, stopped lanes and lanes waiting for an owner merge don't count. A lane waiting on an owner question keeps its slot. The board's formation uses the project's saved limit.

## Functions for follow-on tickets

`registerAutopilot` in `lib/autopilot.ts` returns `get`, `set`, `update`, `pause`, `resume`, `observe`, `isOn` and `enabledProjectIds`. `update` serializes read/modify/write per project and validates the resulting state. Public state contains `status` (`off`, `on`, `paused`), `laneLimit`, `consecutiveStops` and `pauseReason`. `resume` clears the reason and consecutive-stop count. Private outcome markers prevent repeated counting, as described below.

The board calls `autopilot.get` and the client-only `autopilot.set` RPC. Trusted server controls are reusable by the later CLI and brakes, which must establish their own owner-action checks. They are not exposed as agent tools.

`registerLaneStart` returns `start(projectId, specId, startedBy, allowed?)`. Both the board and watcher use it. It deduplicates concurrent starts of the same spec and accepts a final guard checked immediately before spawning. New Lead metadata includes `startedBy: owner | autopilot`, alongside `role` and `specId`.

`autopilotLaneCount` counts a derived board. The scheduler reads the board's Ready order. Queue ordering, the main quick-check brake and CLI commands belong to their own tickets. `pause` and `resume` provide reusable controls for them.

The watcher and existing Linear reader continue watching enabled projects. No additional service or polling loop is registered. Settings use per-project plugin KV keys; lane and ticket states remain derived from BB, the tracker and pull requests.

## Consecutive-stop brake (SQD-209)

Before scheduling, the board observes derived outcomes for Squadron lanes while Autopilot is On or Paused. Two stopped lanes pause it with `Two lanes in a row stopped`; a landing resets the count. An owner question isn't a stopped outcome. Outside lanes neither increment nor reset the count. An unread or failed tracker snapshot supplies no outcomes. Flying lanes are never messaged or changed by the brake.

`observe(projectId, board)` shares the controls' serialized write queue. Private `observedOutcomes` markers, keyed by Lead thread ID, are saved atomically with the count under the existing per-project KV key. They aren't lane state or a public RPC field. Existing settings migrate with an empty marker map. Reads, reloads and Resume retain these markers; the same historical stopped lane counts once, and a later landing resets once. New outcomes use `outcomeAt` (merge time or latest lane-thread update) then Lead ID for deterministic ordering within one read.

The client-only `autopilot.resume` RPC uses the trusted `resume(projectId)` control, clearing the reason and stop count. `needsYou(board)` emits one `autopilot-paused` item with key `autopilot-paused`, no spec or thread target, and the pause reason as text. The board's Resume calls that RPC and refreshes. SQD-220 connects the CLI to trusted controls; SQD-196's notifier consumes the Needs you item after Lead reconciles the branches. Neither is implemented here.

[ADR-0011](adr/0011-autopilot-brakes-and-local-lifetime.md) records the brakes and local BB lifetime.
