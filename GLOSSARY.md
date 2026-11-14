# Glossary

The words BB Squadron uses. Use these, and only these, in code, tickets, comments and the UI. Squadron shows and starts work. Matt Pocock's skills and the agents do the work.

## Work

**Spec**: A Linear issue holding a feature's `to-spec` write-up and labelled `ready-for-agent`. Its sub-issues are its tickets. One spec becomes one lane, one integration branch and one PR.
_Avoid_: epic, feature issue, PRD

**Ticket**: A sub-issue of a spec: one tracer-bullet slice that one worker can finish in one sitting.
_Avoid_: task, story

**Blocker**: An issue that must be Done before another may start, from Linear's native "blocks" relation.
_Avoid_: dependency (in UI copy), prerequisite

**Frontier**: The tickets of a spec whose blockers are all done and that nobody is working on yet.

**Unplanned**: An open issue that is neither a spec nor one of its tickets. It waits in the board's Unplanned row until planning turns it into a spec.

## Roles

**Owner**: The person the factory works for. Only the owner answers questions, merges `accept:owner` specs and changes settings.

**Chief**: An optional, long-running thread the owner talks to, running Matt's `chief-of-staff`. It can plan and press the board's buttons for the owner, but no lane depends on it.
_Avoid_: Helper, orchestrator, dispatcher

**Lead**: The agent thread that owns one spec until its PR merges. It runs `implement-spec`, with its workers as BB child threads.
_Avoid_: supervisor, manager

**Worker**: A child thread of a Lead that builds one ticket with `tdd`, in its own worktree, on a branch cut from the integration branch.
_Avoid_: builder, implementer, subagent

**Reviewer**: A fresh thread that runs `code-review` once on a lane's whole integration branch before its PR merges.

**Planning thread**: A thread started from the Plan button that runs `grill-with-docs`, then `to-spec` and `to-tickets`, with the owner.

## Running

**Lane**: One spec being worked: its Lead, workers, reviewer, integration branch and PR.

**Lane state**: Ready, Flying, In review or Landed. It is always read from the Lead thread, the PR and Linear, and never stored.

**Ticket state**: Waiting, Working, In branch or Done.

**Status mapping**: The table that names the Linear status for each lane state and ticket state.

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

**Doctor**: The check that must pass before Start: Matt's plugin in each family's harness, Matt's setup files, Squadron's settings, the Linear key and `gh` login.

## Board

**Board**: The Squadron page in BB's sidebar and the owner's front door for every action: Plan, Start, Stop, Resume and Merge.

**Needs you**: The board's first section: threads waiting on the owner, `accept:owner` PRs ready to merge, and setup problems.

**Binding**: The owner's choice of which Linear team and project a BB project's board reads.
