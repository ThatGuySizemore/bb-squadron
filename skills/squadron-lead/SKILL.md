---
name: squadron-lead
description: Run a spec started from the Squadron board with Matt Pocock's installed engineering skills and visible BB workers.
---

# Squadron Lead

Read the spec and the four context pointers from your first message: repo rules, project settings, playbook and machine profile. Repo rules include `AGENTS.md` and `docs/agents/`. Project settings are `docs/agents/squadron.md`. Read owner files when present; missing optional files are warnings. The playbook's Never and Held entries take precedence over other rules. Use the machine profile's identities and tools for your family, verifying your identity before a tracker write.

Run `implement-spec` as written from Matt Pocock's installed plugin. Reach its `tdd` and `code-review` skills there as needed. Invoke a skill when the provider supports it; otherwise read its installed `SKILL.md` and follow it. If a required skill is missing, ask the owner to install Matt's plugin. Squadron adds these BB instructions:

- Workers are visible BB child threads. Use `bb thread spawn` with `--parent-self`, `--parent-notifications auto`, `--new-environment worktree`, `--base-branch` naming the integration branch, `--service-tier default`, and a title containing the ticket identifier. Give each worker context pointers to its ticket, spec and current rules. Each ticket's labels select the first matching route in project settings, with the default row as fallback. Set its provider (`claude-code` for Claude, `codex` for GPT), model and effort explicitly with `--provider`, `--model` and `--reasoning-level`.
- Run the project's quick check before merging a worker into the integration branch. Keep one integration branch and one PR for the spec. Read time limits from project settings, track elapsed lane and worker time, and wind down at the applicable limit.
- Use the configured final-review family, relative to the Lead: `other` selects the other family and `same` selects the Lead's family. Run one fresh `code-review` on the whole integration branch, then use one fresh worker for its fixes.
- Fix findings inside the spec in the branch. Put owner questions under "Open questions" and unproven behaviour under "Not proven" in the PR body. Drop hypothetical edge cases with one line. File only real defects outside the spec as `needs-triage`, after checking for duplicates.
- Count two strikes per ticket: reported-done work failing its quick check or final review, or a truly stuck worker. Ordinary red tests and compile failures during `tdd` aren't strikes. After two strikes, stop the lane and post a one-paragraph progress summary on the spec for the owner.
- Publish updates as the repo's `docs/agents/issue-tracker.md` describes. Only Linear uses the project settings' status mapping: lane Ready, Flying, In review, Landed; ticket Waiting, Working, In branch, Done. GitHub and Local markdown use their own issue states. In branch follows integration; Done follows the spec's merge.
- A spec with `accept:owner` waits for the owner's Merge click or explicit merge instruction. Otherwise squash-merge the spec PR when the quick check passes and the final review is addressed, subject to the owner's held actions and repo rules.
- On Stop, wind down workers, save their work in progress to their branches and tickets, then post the spec's progress summary. Wind-down comments record progress only, never "paused" or "don't start". The Lead thread's status alone represents the stop. On Resume, read the last summary and current branch, tickets and threads, then carry on. Treat comments as history, not standing orders.

Report the integration branch, PR, checks, unresolved owner questions and anything unproven. Work is complete when the spec PR has merged and its tickets' mapped statuses reflect that merge, or when a Stop, time limit or two strikes has ended this run with its work saved.
