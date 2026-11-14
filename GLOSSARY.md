# Glossary

The words BB Squadron uses. Use these, and only these, in code, tickets, comments and the UI. Squadron shows and starts work. Matt Pocock's skills and the agents do the work.

## Work

**Spec**: An issue holding a feature's `to-spec` write-up. Its child issues are its tickets. A spec can be Shaping or Ready before it becomes a lane.
_Avoid_: epic, feature issue, PRD

**Ticket**: A sub-issue of a spec: one tracer-bullet slice that one worker can finish in one sitting.
_Avoid_: task, story

**Blocker**: An issue that must be Done before another may start, as recorded in the repo's tracker.
_Avoid_: dependency (in UI copy), prerequisite

**Frontier**: The tickets of a spec whose blockers are all done and that nobody is working on yet.

**Held ticket**: An open ticket carrying a hold label: `hold`, `needs-triage`, `needs-info`, `ready-for-human`, `wontfix`, or one the repo's settings add. In trackers without labels, a `Status:` line naming one. The Lead skips it, the board shows it as Held, and the lane ends delivered with held tickets, leaving them and the spec open.
_Avoid_: blocked, paused, skipped ticket

**Open issue**: An open issue that is neither a spec nor one of its tickets. It waits in the board's Open issues section until planning turns it into a spec.

**Shaping**: A spec not yet Ready. It has an open planning thread, has tickets without the ready label, has the ready label without tickets, or has only held tickets.

**Ready**: A spec carrying `ready-for-agent` with at least one open, unblocked ticket that isn't held.

## Roles

**Owner**: The person the factory works for. Only the owner answers questions and changes settings, and an `accept:owner` spec merges only on the owner's click or the owner's order to the Chief.

**Chief**: An optional, long-running thread for one BB project that the owner talks to, running Matt's `chief-of-staff`. It can plan and press the board's buttons for the owner, but no lane depends on it.
_Avoid_: Helper, orchestrator, dispatcher

**Lead**: The agent thread that owns one spec until its PR merges. It runs `implement-spec`, with its workers as BB child threads.
_Avoid_: supervisor, manager

**Worker**: A child thread of a Lead that builds one ticket with `tdd`, in its own worktree, on a branch cut from the integration branch.
_Avoid_: builder, implementer, subagent

**Reviewer**: A fresh thread that runs `code-review` once on a lane's whole integration branch before its PR merges.

**Planning thread**: A thread started from the Plan button that runs `grill-with-docs`, then `to-spec` and `to-tickets`, with the owner.

## Running

**Lane**: One spec being worked: its Lead, workers, reviewer, integration branch and PR.

**Outside lane**: A lane started outside Squadron and shown read-only, with a link to its thread. Squadron offers no Stop, Resume or Merge for it.

**Lane state**: Ready, Flying, In review or Landed. It is read from threads, the tracker and the PR or local merge, and never stored.

**Ticket state**: Waiting, Held, Working, In branch or Done.

**Status mapping**: The table that names the Linear status for each lane state and ticket state. Only Linear repos need it.

**Integration branch**: The one branch a lane builds on. Workers branch from it and merge back into it, and its PR goes to `main`.

**Family**: Which company's models a thread runs on: Claude (Claude Code) or GPT (Codex).

**Route**: A row that maps a ticket label to a family, model and effort.

**Identity**: Who an agent appears as in Linear and in Git. It is set for each family, and Squadron never holds the credential.

**Two strikes**: Work reported done that then fails its quick check or review, or a worker that is truly stuck, is a strike. After two strikes on one ticket the Lead stops the lane and asks the owner.

**Stop**: The owner's request that a Lead wind down. Its workers save their work in progress to their branches and tickets, and the Lead posts a summary on the spec.
_Avoid_: cancel, kill

**Resume**: The owner's request that a stopped Lead carry on from its last summary.

**Stop list**: The project's list of problems that block a merge.

**Quick check**: The project's fast test command, run before every merge into the integration branch and before the PR merges.

**Doctor**: The check that must pass before Start. It checks Matt's plugin and setup, Squadron's settings and the detected tracker's requirements. Reading the board needs no Doctor pass.

## Configuration

**Repo rules**: How to work on a repo's code: its `AGENTS.md` and Matt's `docs/agents/` setup. Checked in, and not Squadron's.

**Tracker**: Where a repo's issues live: Linear, GitHub or Local markdown. A BB project reads one planning tracker.

**Project settings**: How the fleet flies one repo: quick check, stop list, routes, final-review family, time limits, an optional Tracker override and Linear-only status mapping. Checked in as `docs/agents/squadron.md`.

**Playbook**: How the owner likes work done in every project, read by both families. Private to the owner. Its Never and Held entries beat every other rule.
_Avoid_: global rules, harness rules

**Machine profile**: What one machine has: devices and how to use them, tools for each family, identities, and notes for each project. Private to the owner, one per machine.
_Avoid_: personal settings, local config

**Secret**: A credential, kept only in BB's secret settings and never in a file.

## Board

**Board**: The Squadron page in BB's sidebar and the owner's front door for every action: Plan, Start, Stop, Resume and Merge.

**Needs you**: The board's first section: threads waiting on the owner, `accept:owner` PRs ready to merge, and setup problems.

**Scope**: Which Linear issues a BB project's board reads, set in the `## Scope` section of the repo's `docs/agents/squadron.md`. Any of Team, Project, Initiative, Label and View; every key set narrows. An issue matching it is in scope. Only Linear uses a scope.
_Avoid_: binding, filter
