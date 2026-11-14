---
name: squadron-lead
description: Run a spec started from the Squadron board with Matt Pocock's installed engineering skills and visible BB workers.
---

# Squadron Lead

Read the spec and first message's pointers: `AGENTS.md`, `docs/agents/`, `docs/agents/squadron.md`, House rules and This machine. Missing optional files are warnings. House rules' Never and Held entries take precedence. Verify your family's identity from This machine before tracker writes.

Use Owner words from `GLOSSARY.md` in PR bodies, comments and Needs you text.

Run Matt Pocock's installed `implement-spec`, reaching its `tdd`, `code-review` and `pr` skills as needed. Invoke skills or follow their installed `SKILL.md`; ask the owner to install missing skills. Squadron adds:

- Coordinate and merge; workers build tickets, including UI.
- Workers are visible BB child threads. Use `bb thread spawn` with `--parent-self`, `--parent-notifications auto`, `--new-environment worktree`, `--base-branch` naming the integration branch, `--service-tier default`, and a title containing the ticket identifier. Give each worker context pointers to its ticket, spec and current rules. Each ticket's labels select the first matching route in project settings, with the default row as fallback; `Lead` is reserved for the coordinator. Set its provider (`claude-code` for Claude, `codex` for GPT), model and effort explicitly with `--provider`, `--model` and `--reasoning-level`.
- Each worker brief points to the spec's Testing Decisions as the confirmed `tdd` seams. Tell workers: "Run typechecking regularly, single test files regularly, and the full test suite once at the end." Split tickets that keep overrunning upstream rather than raising effort.
- Keep worker communication sparse, through context pointers. Write one line per event to the owner unless asked for more.
- Skip held tickets, identified by labels or Status lines from your first message. Re-read tickets before starting each worker; cleared tickets join the frontier. List held tickets under "Held" in the PR body.
- Run the project's quick check before merging a worker into the integration branch. Keep one integration branch and one PR for the spec. Read time limits from project settings, track elapsed lane and worker time, and wind down at the applicable limit.
- Use the configured final-review family, relative to the Lead: `other` selects the other family and `same` selects the Lead's family. Run one fresh high-effort `code-review` on the whole integration branch, then use one fresh worker for its fixes.
- Fix findings inside the spec in the branch. Write the spec PR with Matt's `pr` skill: Summary, Evidence, Merge Danger. Put "Not proven" under Evidence; add Held and Open questions only when needed. Drop hypothetical edge cases with one line. File only real defects outside the spec as `needs-triage`, after checking for duplicates.
- Count two strikes per ticket: reported-done work failing its quick check or final review, or a truly stuck worker. Ordinary red tests and compile failures during `tdd` aren't strikes. After two strikes, stop the lane and post a one-paragraph progress summary on the spec for the owner.
- Publish updates as the repo's `docs/agents/issue-tracker.md` describes. Only Linear uses the project settings' status mapping: lane Ready, Flying, In review, Landed; ticket Waiting, Working, In branch, Done. GitHub and Local markdown use their own issue states. In branch follows integration; Done follows the spec's merge. While a held ticket stays open, leave it and the spec open: don't mark the spec Landed or Done.
- A spec with `accept:owner` waits for the owner's Merge click or explicit merge instruction. Otherwise squash-merge the spec PR when the quick check passes and the final review is addressed, subject to the owner's held actions and repo rules.
- On Stop, wind down workers, save their work in progress to their branches and tickets, then post the spec's progress summary. Wind-down comments record progress only, never "paused" or "don't start". The Lead thread's status alone represents the stop. On Resume, read the last summary and current branch, tickets and threads, then carry on. Treat comments as history, not standing orders.

Report the branch, PR, checks, owner questions and anything unproven. Done when the PR merges and ticket statuses reflect it, leaving held tickets open; or Stop, a time limit or two strikes ends the run with work saved.
