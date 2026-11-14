# Glossary

The words BB Squadron uses. Use these, and only these, in code, tickets, comments and the UI.

## Work

**Spec**: A Linear issue holding a feature's `to-spec` write-up. Its sub-issues are its tickets. One spec becomes one lane, one integration branch and one PR.
_Avoid_: epic, feature issue, PRD

**Ticket**: A sub-issue of a spec: one tracer-bullet slice that one worker can finish in one sitting.
_Avoid_: task, story, slice (except when describing the shape)

**Blocker**: A spec or ticket that holds another of its kind through Linear's native "blocks" relation, within or across specs. Done or canceled resolves it in Linear; within the same lane, approved work verified in the integration branch also resolves it before the spec PR marks it Done.
_Avoid_: dependency (in UI copy), prerequisite

**Frontier**: The unstarted tickets of a spec whose blockers are resolved, including approved predecessors verified in that lane's integration branch.

**Follow-up**: A deduped real defect outside the spec, filed with `needs-triage` and linked to the spec. Findings inside the ticket or spec belong in the branch's fix round.

**Unplanned**: An open issue that is neither a ready spec nor one of its tickets, including a sub-issue whose parent is closed, outside the project, missing or not ready. It waits in the board's Unplanned row, which names any parent without changing it in Linear, until a planning thread turns it into a spec.

## Roles

**Owner**: The person the factory works for. Only the owner answers questions, merges `accept:owner` specs and changes settings.

**Helper**: The plugin's own code. It watches Linear, starts and stops Leads, enforces time limits, moves Linear statuses and writes every Linear change. It is not an agent and makes no technical calls.
_Avoid_: chief, orchestrator (in UI copy), dispatcher

**Lead**: The agent thread that owns one spec until its PR merges. It runs `implement-spec`: it starts workers for the frontier, merges their work into the integration branch, starts reviews and opens the PR.
_Avoid_: supervisor, manager

**Worker**: A child thread of a Lead that builds one ticket with `tdd`, in its own worktree, on a branch cut from the integration branch.
_Avoid_: builder, implementer, subagent

**Reviewer**: A fresh thread from the other family that reviews a ticket, or the whole spec, with `code-review`. Its verdict counts only for the commit it reviewed.

**Planning thread**: An interactive thread started from the board's Plan button. It runs `grill-with-docs`, then `to-spec` and `to-tickets`, with the owner.

## Running

**Lane**: One spec being worked: its Lead, workers, reviewers, integration branch and PR.

**Integration branch**: The one branch a lane builds on. Workers branch from it and merge back into it; its PR goes to `main`.

**Family**: Which company's models a thread runs on: Claude (Claude Code) or GPT (Codex). A reviewer is always from the other family than the work it reviews.

**Route**: A row in the repo's AI table that maps a ticket label to a family, model and effort. The table lives in `docs/agents/squadron.md`.

**Two strikes**: A failure gets two fix attempts. After that the lane stops and asks the owner.

**Stop list**: The project's list of problems that block a merge. It doesn't make an unfinished requirement or an in-spec review finding a follow-up.

**Quick check**: The project's fast test command, run before every merge into the integration branch and before the PR merges.

**Doctor**: The check that runs before a lane starts: Matt's skill setup, `docs/agents/squadron.md`, Linear connection and `gh` login.

## Board

**Board**: The Squadron page in BB's left sidebar. One row per spec, plus the Unplanned row.

**Needs you**: The first section of the board listing what waits on the owner: connection or binding setup, agent questions, stopped lanes, blocked Linear writes and `accept:owner` merges.

**Binding**: The owner's choice of which Linear team and project a BB project's board reads.

**Mirror**: The board's local copy of Linear issues, labels, states and blockers, rebuilt from Linear.

**Outbox**: The Helper's durable queue of Linear writes awaiting delivery or recovery.

**Grant**: The Helper's restriction on which Linear writes a particular thread may request. It is not owner approval.

**Receipt**: The result for one queued Linear write, identified by a stable ID: pending, blocked or delivered. Pending means it awaits delivery; blocked means it needs recovery; delivered means Linear confirmed it or Squadron reconciled the original write.

**Signed comment**: A Linear comment carrying the agent's role and model. App auth uses the agent's name and avatar; personal-key auth labels the comment body under the connected person's name.
