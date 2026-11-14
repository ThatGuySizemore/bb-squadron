# Autopilot controls

Each BB project's board has an Autopilot switch and a lane limit. Autopilot starts Off. The limit defaults to 3 and accepts whole numbers from 1 to 10. Both survive a plugin reload. Autopilot runs only while BB runs on this Mac, including when the board page is closed.

The existing board watcher considers one start per project per cycle, and on board-changed signals. A start's own signal refreshes the board without starting another lane in that cycle. The first Ready spec with no Start refusal uses the same Start function and first message as an owner click. Doctor is checked again by Start. Turning Autopilot Off while Doctor runs prevents that automatic start.

Lanes started by the owner count toward the limit, though an owner click can exceed it. Outside lanes, Landed lanes, stopped lanes and lanes waiting for an owner merge don't count. A lane waiting on an owner question keeps its slot. The board's formation uses the project's saved limit.

## Functions for follow-on tickets

`registerAutopilot` in `lib/autopilot.ts` returns `get`, `set`, `update`, `pause`, `resume`, `isOn` and `enabledProjectIds`. `update` serializes read/modify/write per project and validates the resulting state. State contains `status` (`off`, `on`, `paused`), `laneLimit`, `consecutiveStops` and `pauseReason`. `resume` clears the reason and consecutive-stop count. No lane outcomes are stored here.

The board calls `autopilot.get` and the client-only `autopilot.set` RPC. Trusted server controls are reusable by the later CLI and brakes, which must establish their own owner-action checks. They are not exposed as agent tools.

`registerLaneStart` returns `start(projectId, specId, startedBy, allowed?)`. Both the board and watcher use it. It deduplicates concurrent starts of the same spec and accepts a final guard checked immediately before spawning. New Lead metadata includes `startedBy: owner | autopilot`, alongside `role` and `specId`.

`autopilotLaneCount` counts a derived board. The scheduler reads the board's existing Ready order; queue ordering, brake triggers and CLI commands belong to their own tickets. `pause` and `resume` provide controls for those tickets, without adding those triggers here.

The watcher and existing Linear reader continue watching enabled projects. No additional service or polling loop is registered. Settings use per-project plugin KV keys; lane and ticket states remain derived from BB, the tracker and pull requests.

## Ready queue

The board and scheduler share the Ready order from `sortQueue` in `lib/board-derive.ts`. Linear uses ascending `sortOrder`, then priority (Urgent first, no priority last), then oldest `createdAt`. These fields survive the Linear mirror and tracker snapshot. GitHub and Local markdown retain their reader's snapshot order; a reader that supplies `trackerOrder` can use equal ordinals with creation time as the tie-break. Snapshot order breaks remaining ties.

A Ready row's optional `waitingFor` contains the spec's open blockers. It is separate from ticket blockers: a partial ticket frontier can start, but an open blocker of the spec refuses Start. The Ready section links each waiting blocker and marks the first row without a Start refusal as Next, even while Autopilot is Off. Held specs and specs with open planning remain Shaping and never enter this queue.
