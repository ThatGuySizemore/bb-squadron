# Glossary

BB Squadron uses two vocabularies. Use Owner words on the board, in the Doctor's messages and whenever you write for the owner. Factory words explain the machinery to agents and contributors. Squadron shows and starts work. Matt Pocock's skills and the agents do the work.

## Owner words

These one-line definitions are also exported by `lib/owner-words.ts` for the board's hover text. A test keeps the two copies identical.

**Board**: The Squadron page where you plan work, start it and see how it is going.

**Spec**: A plan whose tickets are its sub-issues.
_Avoid_: epic, feature issue, PRD → Spec

**Ticket**: One piece of a spec.
_Avoid_: story → Ticket; task for a piece of a spec → Ticket

**Work item**: An issue that stands alone: no parent spec, no tickets of its own.

**Ready**: A spec with a ticket that can start now, or a work item ready to start.

**Shaping**: A spec that still needs planning or has no ticket that can start now.

**Lane**: Work on one spec or work item, from Start to a merged pull request.

**Flying**: A spec or work item whose lane is underway.

**Landed**: A spec or work item whose work has merged into the main branch, with no open tickets left. A lane that merged only part of its spec stays Flying; held tickets don't count as open.

**Held**: A ticket set aside until its hold is cleared.
_Avoid_: paused, skipped ticket → Held; blocked for a hold → Held

**Needs you**: Questions, setup problems and work that needs your approval.

**Helper**: The optional agent thread you talk to about your project and ask to act for you.
_Avoid_: Chief → Helper; Helper for plugin code → Squadron

**House rules**: Your private rules for how work is done across all your projects.
_Avoid_: Playbook, global rules, harness rules → House rules

**Scope**: The Linear issues a project's board reads, as chosen in its settings.
_Avoid_: binding, filter → Scope

**Autopilot**: The option for starting ready lanes automatically.

## Factory words

These terms describe how the factory works. Owner definitions above stay short; the details below do not change them.

**Squadron**: The plugin, acting as the orchestrator: it reads the ticket tracker, shows the board and starts agent threads. It is never the conversational Helper.
_Avoid_: Helper for the orchestrator or plugin code → Squadron

**Task**: A repeatable procedure a runner carries out, such as Matt Pocock's `implement-spec`, `tdd` or `code-review`. A task is not a ticket.

**Trigger**: An event or owner action that starts a task, such as pressing Plan or Start on the board.

**Run**: One execution of a task. A spec lane runs `implement-spec`, carried out by a Lead with workers. A work item lane runs `implement` in one standalone thread. Each uses one branch and one pull request.

**Runner**: What executes a task. For an `implement-spec` run, this is the Lead's agent thread in BB.

**Orchestrator**: The code that shows and starts runs. In this project, it is Squadron; the agents and Matt's skills do the work.

**Ticket tracker**: Where a repo's issues live: Linear, GitHub Issues or Local markdown. A BB project reads one planning tracker.
_Avoid_: issue store → Ticket tracker

**Tracker**: The short name for the ticket tracker, also used by the `Tracker` override in project settings.

**Git host**: The service hosting the repo and its pull requests, currently GitHub.

**Owner**: The person the factory works for. Only the owner answers owner questions and approves changes to their settings. An `accept:owner` spec merges only on the owner's click or the owner's order to the Helper.

**Lead**: The agent thread that owns one spec until its pull request merges. It runs `implement-spec`, with its workers as BB child threads.
_Avoid_: supervisor, manager → Lead

**Worker**: A child thread of a Lead that builds one ticket with `tdd`, in its own worktree, on a branch cut from the integration branch.
_Avoid_: builder, implementer, subagent → Worker

**Reviewer**: A fresh thread that runs `code-review` once on a lane's whole integration branch before its pull request merges. With Final review `other`, it runs on the review route for the family that built most of the branch's tickets, read from launch records.

**Planning thread**: A thread started from the Plan button that runs `grill-with-docs` with the owner. Multi-ticket specs continue through `to-spec` and `to-tickets`; one-piece work becomes a work item.

**Blocker**: An issue that must be Done before another may start, as recorded in the repo's ticket tracker.
_Avoid_: dependency in owner-facing copy, prerequisite → Blocker

**Frontier**: The tickets of a spec whose blockers are all done and that nobody is working on yet. Factory-only; describe tickets that can start when writing for the owner.

**Held ticket**: An open ticket carrying `hold`, `needs-triage`, `needs-info`, `ready-for-human`, `wontfix`, or a hold label the repo adds. In trackers without labels, a `Status:` line can name a hold. The Lead skips it and the board shows Held. A lane can finish delivered with held tickets, leaving them and the spec open.

**Open issue**: An open issue waiting for planning, including a work item that is not ready to start.

**Outside lane**: Work started outside Squadron and shown read-only, with a link to its thread. Squadron offers no Stop, Resume or Merge for it.

**States**: Specs are Shaping or Ready before a lane starts. Lane states include Flying, Stopped, In review and Landed, read from threads, the tracker and the pull request or local merge, never stored. Ticket states are Waiting, Held, Working, In branch and Done. A Ready spec requires `ready-for-agent` and at least one open, unblocked ticket that is not held. A spec stays Shaping while planning is open or no ticket can start. A Ready work item requires `ready-for-agent`, no hold and no open planning thread. Other work items wait in Open issues with Plan.
_Avoid_: Lane state, Ticket state as separate entries → States

**Status mapping**: The table naming the Linear statuses for spec and ticket states. Only Linear repos need it; Held comes from hold labels rather than a mapped status.

**Integration branch**: The one branch a lane builds on. Workers branch from it and merge back into it, and its pull request goes to `main`.

**Family**: Which company's models a thread runs on: Claude through Claude Code or GPT through Codex.

**Route**: A resolved provider, model and effort for a role or ticket label. Claude Code and Codex supply the Claude and GPT families; other providers have an unknown family.

**Model routes**: The role defaults in the owner's House rules. A repo opts in with `Defaults: House rules` and supplies explicit exceptions in its Routes section. Named roles include Lead, Worker, Worker (hard), Planning, Planning (hard), Review of claude-code, Review of codex and Mechanical.

**Launch record**: The role, ticket, provider, model, effort and service tier a thread was launched with, plus any escalation reason. Squadron seeds it into the thread's own metadata at launch and never rewrites it; the board and reports set it beside what BB reports the thread runs.

**Run report**: `bb squadron report`, which derives how each ticket went from launch records, BB usage and the ticket's `squadron-result` block, on demand. Nothing is stored.

**Checkpoint**: An optional House rules setting. At that many completed routine tickets since a project's first verified policy-resolved Worker launch, Squadron sends the project's Helper one plain notice. It never pauses launches.

**Identity**: Who an agent appears as in Linear and in Git. It is set for each family, and Squadron never holds the credential.

**Two strikes**: Work reported done that then fails its quick check or review, or a worker that is truly stuck, is a strike. After two strikes on one ticket the Lead stops the lane and asks the owner.

**Stop**: A request that a Lead wind down, sent by the owner or recorded by the Lead when a lane rule requires it. Its workers save their work in progress to their branches and tickets, and the Lead posts a summary on the spec.
_Avoid_: cancel, kill → Stop

**Policy stop**: A Stop the Lead records because a lane rule requires it, such as two strikes. It records state in BB's thread history and grants no owner approval or Resume.

**Resume**: The owner's request that a stopped Lead carry on from its last summary.

**Stop list**: The project's list of problems that block a merge.

**Quick check**: The project's fast test command, run before every merge into the integration branch and before the pull request merges.

**Doctor**: The check that must pass before Start. It checks Matt's plugin and setup, Squadron's settings and the detected tracker's requirements. Reading the board needs no Doctor pass.

**Repo rules**: How to work on a repo's code: its `AGENTS.md` and Matt's `docs/agents/` setup. Checked in, and not Squadron's.

**Project settings**: How Squadron works in one repo: quick check, stop list, routes, final-review family, time limits, an optional Tracker override and Linear-only status mapping. Checked in as `docs/agents/squadron.md`.

**This machine**: What one machine has: devices and how to use them, tools for each family, identities and notes for each project. Private to the owner, in `~/.bb-squadron/machine.md`.
_Avoid_: Machine profile, personal settings, local config → This machine

**Secret**: A credential, kept only in BB's secret settings and never in a file.
