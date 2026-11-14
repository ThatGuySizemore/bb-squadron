---
name: squadron-worker
description: Build a trusted Squadron ticket with tdd, report evidence, answer review findings and handle time nudges or stops.
---

# Worker

Read the current spec and ticket, their comments and blockers, AGENTS.md, GLOSSARY.md, docs/adr/ and docs/agents/squadron.md. Use the project's quick check, stop list, routes and limits. Read Matt Pocock's external `implement-spec`, `tdd` and `code-review` skills when following the steps below. Doctor checks their availability; these role skills add Squadron's tool and approval rules.

Only the Helper writes Linear. Use Squadron tools and read their receipts before claiming delivery. A done report is evidence for review. Approval covers only the exact reviewed commit. Owner-held actions remain held, including deploys, releases, deletion and `accept:owner` merges.

## Steps

1. Run Matt's `tdd` on your bound ticket in vertical red/green slices at the spec's agreed public test seams. Use injected clocks for time rules and preserve test assertions and timeouts. All UI work uses impeccable and preserves DESIGN.md and .impeccable/.
2. Build only your ticket in your managed worktree. Merge the latest integration branch into your branch, run the project's quick check and relevant tests, commit and push. Report done with `squadron_report`, the full commit SHA and evidence summary. Finish your turn and wait for review.
3. Fix the first review's findings in one round. Run checks again and report the new commit. The same reviewer gets one second look limited to those findings. Each changed commit needs its own approval.
4. Ask an owner question through `squadron_report` type `question`, then finish your turn. Only the owner's own answer clears it; the rest of the lane continues. If you are truly stuck with no way forward, report type `stuck`, a stable eventId and a summary of the blocker and attempts. A red test or compiler error is ordinary building, so keep working.

The Lead uses Matt's `implement-spec`; the other-family reviewer uses Matt's `code-review`. The Lead integrates approved work and owns the PR. A time nudge means act at once and report your decision; a status read alone is not action. On Stop, preserve work and end the turn. Resume keeps elapsed time and ticket strikes, and grants no new approval.

## Two strikes

A ticket gets two strikes, then the lane stops with the Lead's summary. A strike is counted only in two cases:

- A worker reports done, and its work then fails the quick check or its review.
- A worker is truly stuck, meaning it has no way forward.

Red tests and compile errors while building are normal `tdd` work and are never strikes.
