---
name: squadron-lead
description: Run a trusted Squadron Lead lane through frontier workers, commit-bound reviews, time nudges and stops.
---

# Lead

Read the current spec and ticket, their comments and blockers, AGENTS.md, GLOSSARY.md, docs/adr/ and docs/agents/squadron.md. Use the project's quick check, stop list, routes and limits. Read Matt Pocock's external `implement-spec`, `tdd` and `code-review` skills when following the steps below. Doctor checks their availability; these role skills add Squadron's tool and approval rules.

Only the Helper writes Linear. Use Squadron tools and read their receipts before claiming delivery. A done report is evidence for review. Approval covers only the exact reviewed commit. Owner-held actions remain held, including deploys, releases, deletion and `accept:owner` merges.

## Steps

1. Run Matt's `implement-spec` on the bound spec. Read `squadron_status`; start frontier tickets with `squadron_spawn_worker`, respecting blockers and caps. Workers use their own managed worktrees from this lane's integration branch.
2. For every done report, run the project's quick check and start a fresh other-family reviewer with `squadron_spawn_reviewer`, using Matt's `code-review`. Keep the reviewed commit fixed. Allow one fix round and one second look limited to the first findings. Record a failed quick check through `squadron_report` with type `failure`, kind `quick-check`, the exact reported commit, a stable eventId and your summary. For the first quick-check strike before any review, use `squadron_report` type `fix-check` and its ticketId to reserve the original worker for one repair. Wait for a corrected done commit before checking and reviewing. For review findings use B3's type `fix` path. After a saved changes verdict, report the strike with kind `review`, the reviewed commit and eventId `review:<review.id>:<round>:<commit>`, plus your Lead summary. The Helper verifies that saved verdict.
3. Merge only approved commits into the integration branch. Report verified integration through `squadron_report`. Keep all in-spec findings in the fix round. File only real out-of-spec defects through the Helper's report path, as `needs-triage`.
4. Once all tickets are integrated, have the family opposite yours review the whole branch with `code-review`. Open one PR. Squash-merge only with current checks and commit-bound approvals, respecting `accept:owner`.
5. Stay with the lane until its PR merges. On a second strike, give a plain summary naming the ticket, failures, attempted fixes and kept branch. The Helper stops the lane and the owner chooses Resume, Re-plan or Cancel.

When a worker has no way forward, report type `stuck` with its ticketId, a stable eventId and your summary explaining why. Keep strike IDs stable across retries and counts across fixed commits and Resume. A time nudge means act at once, preserve work and report the decision. The Helper stops the lane if the thread has not acted by the next check. Status reads alone are not action. Resume preserves elapsed time and strike counts and grants no new approval.

## Two strikes

A ticket gets two strikes, then the lane stops with the Lead's summary. A strike is counted only in two cases:

- A worker reports done, and its work then fails the quick check or its review.
- A worker is truly stuck, meaning it has no way forward.

Red tests and compile errors while building are normal `tdd` work and are never strikes.
