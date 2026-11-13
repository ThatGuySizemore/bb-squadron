# Glossary

The words BB Squadron uses. Use these, and only these, in code, tickets, comments and the UI.

## Work

**Spec**: A Linear issue holding a feature's `to-spec` write-up. Its sub-issues are its tickets. One spec becomes one lane, one integration branch and one PR.
_Avoid_: epic, feature issue, PRD

**Ticket**: A sub-issue of a spec: one tracer-bullet slice that one worker can finish in one sitting.
_Avoid_: task, story, slice (except when describing the shape)

**Blocker**: An issue that must be Done before another may start, from Linear's native "blocks" relation. Specs block specs; tickets block tickets, across specs too.
_Avoid_: dependency (in UI copy), prerequisite

**Frontier**: The tickets of a spec whose blockers are all done and that nobody is working on yet.

**Follow-up**: An issue filed during a lane for something worth doing that should not hold the merge, labelled `follow-up` and linked to its spec.

**Unplanned**: An open issue with no parent spec. It waits in the board's Unplanned row until a planning thread turns it into a spec.

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

**Stop list**: The project's list of problems that block a merge. Anything else becomes a follow-up.

**Quick check**: The project's fast test command, run before every merge into the integration branch and before the PR merges.

**Doctor**: The check that runs before a lane starts: Matt's skill setup, `docs/agents/squadron.md`, Linear connection and `gh` login.

## Board

**Board**: The Squadron page in BB's left sidebar. One row per spec, plus the Unplanned row.

**Needs you**: The strip at the top of the board listing what waits on the owner: agent questions, stopped lanes and `accept:owner` merges.

**Signed comment**: A Linear comment written by the Squadron app under an agent's name and avatar, such as "Lead · Opus 5.5 (via Squadron)".
