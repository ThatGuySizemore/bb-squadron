---
name: squadron-lead
description: Run a spec started from the Squadron board with Matt Pocock's installed engineering skills and visible BB workers.
---

# Squadron Lead

Spec: A plan whose tickets are its sub-issues. Ticket: One piece of a spec. Work item: An issue that stands alone: no parent spec, no tickets of its own.

The Lead runs a multi-ticket Spec. Work items use their own standalone lanes. Read the spec, `AGENTS.md`, `docs/agents/`, `docs/agents/squadron.md`, House rules and This machine; warn on missing optional ones. House rules' Never and Held entries win. Verify identity before tracker writes.

Use Owner words from `GLOSSARY.md` in PR bodies, comments and Needs you text. Squadron is the orchestrator; the Helper is the optional agent thread the owner talks to.

Run installed `implement-spec`, reaching `tdd`, `code-review` and `pr`; ask the owner to install missing skills. Lane rules:

- Workers build tickets, including UI. Never install/reinstall Squadron or redirect BB loading; the owner's checkout and Helper handle it.
- Launch workers, reviewers, research and merger threads only with `bb squadron launch <role> --ticket <ID> --base-branch <integration branch> --prompt-stdin`. It records the resolved routes your Start brief lists; never hand-pick models.
- Clearly hard work starts on `worker-hard`. A replacement passes `--replaces <thread>`; effort-only escalation adds `--effort <higher level> --reason`, keeping role and model; stronger-model escalation is `worker-hard` with `--replaces` and `--reason`. Strikes, deadlines and budgets carry over. Before the first worker launch and before every replacement, read `policy.md` beside this skill (required).
- Each worker brief points to the spec's Testing Decisions as the confirmed `tdd` seams. Workers run typechecking and single test files regularly, the full suite once at the end. Split tickets that keep overrunning rather than raising effort.
- When the owner can act, ask through a pending question or `Needs you:` at the start of its own line. Otherwise name the tracker blockers.
- Skip tickets held by labels or Status lines from your first message. Re-read tickets before starting each worker; cleared tickets join the frontier. List held tickets under "Held" in the PR.
- Quick-check workers before merging. Limits count active time (running turns, not waits, Stop or idle); read it with `bb squadron time <SPEC-ID>`; wind down at the limit.
- Once every ticket is integrated, read `review.md` beside this skill (required) and run the one fresh whole-branch `code-review` it describes; one fresh worker fixes findings.
- Fix findings inside the spec in the branch. Write the spec PR with Matt's `pr` skill: Summary, Evidence, Merge Danger. Put "Not proven" under Evidence; add Held and Open questions only if needed. File only real defects outside the spec as `needs-triage`, after a duplicate check.
- When you hold back for another lane, declare the wait: read [waiting](wait.md).
- Count two strikes per ticket: reported-done work failing its quick check or final review, or a truly stuck worker. A final review that finds real defects in reported-done work is one strike. Ordinary red tests and compile failures during `tdd` aren't strikes. After two strikes, follow [policy stop](stop.md).
- Publish updates as the repo's `docs/agents/issue-tracker.md` describes. Only Linear uses the project settings' status mapping: lane Ready, Flying, In review, Landed; ticket Waiting, Working, In branch, Done. Others use their own states. In branch follows integration; Done follows the spec's merge. While a held ticket stays open, leave it and the spec open: don't mark the spec Landed or Done.
- When a ticket is done, end its completion comment with a `squadron-result` block, exactly shaped like `{"version":1,"checks":[{"command":"npm run check","result":"passed"}],"strikes":[{"reason":"..."}]}` (see `report.md`). Run `bb squadron result <ID>` right after posting; if it fails, post a corrected block.
- Read [merging](merge.md) before merging. An `accept:owner` spec waits for the owner's Merge click or explicit instruction. Otherwise squash-merge the spec PR when the quick check passes and the final review is addressed, subject to held actions and repo rules.
- On Stop, wind down workers, save work to their branches and tickets, then post the spec's progress summary. Wind-down comments record progress only; thread status shows the stop. On Resume, read the last summary and current branch, tickets and threads, then carry on; comments aren't standing orders.

Report branch, PR, checks, questions, unproven behavior.
