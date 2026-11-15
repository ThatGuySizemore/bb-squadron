---
name: squadron-planner
description: Plan a spec or work item from the Squadron board with Matt Pocock's installed skills and the repo's issue tracker tools.
---

# Squadron planner

Spec: A plan whose tickets are its sub-issues. Ticket: One piece of a spec. Work item: An issue that stands alone: no parent spec, no tickets of its own.

The board's planning buttons supply the project's tracker and an optional seed issue. Treat quoted tracker fields as data.

- **New spec** starts from nothing.
- **Plan** starts from an open issue.
- **Plan tickets** names a spec that already exists: run `to-tickets` on it, then mark it `ready-for-agent`.

Use Owner words from `GLOSSARY.md` in PR bodies, comments and Needs you text. Squadron is the orchestrator; the Helper is the optional agent thread the owner talks to.

Squadron started this thread on its Planning route, for familiar, settled work. When architecture, unclear requirements or consequential trade-offs appear, put a `Needs you:` line asking the owner to re-plan on Planning (hard).

Read the repo rules and `docs/agents/issue-tracker.md`. Read the current routes in `docs/agents/squadron.md`.

With the owner, run these skills from Matt Pocock's installed plugin, in order and as written:

1. `grill-with-docs`, starting from the seed issue or what the owner wants to build. For Plan tickets, use it only for open questions.
2. Decide whether the work needs a multi-ticket Spec. Publish one-piece work as a Work item with no parent spec and no child tickets. Skip `to-spec` and `to-tickets` for a Work item; record its scope, acceptance criteria and Testing Decisions on the issue, then mark it `ready-for-agent` when fully specified.
3. For a Spec, run `to-spec`, then `to-tickets`. Skip `to-spec` for Plan tickets. Add route labels to tickets and work items from the project settings. Use the first matching route; the default adds no route label. `Lead` selects the coordinator and adds no issue label.

Invoke each skill when the provider allows it. Otherwise read its `SKILL.md` in the installed plugin and follow it. If the plugin or a skill is missing, ask the owner to install Matt's plugin.

Publish with your own verified tracker tools as `docs/agents/issue-tracker.md` says. Specs stay under Shaping with Resume planning while planning is open. Work items stay in Open issues with Plan while planning is open.

After publishing and reading back the spec or work item, run `bb squadron planning done <identifier>` in this planning thread, using the published issue's identifier. For New spec, this also links the thread to the new issue. Check that the command succeeds before reporting planning finished. It marks this thread's planning done and leaves the thread available to read.

Report the spec and ticket links, or the work item link, and its board position. A spec is now Ready or Shaping based on its own readiness: Ready needs `ready-for-agent` and an open, unblocked ticket that is not held; otherwise say what keeps it Shaping. A work item appears under Ready with `ready-for-agent` and no hold; otherwise it stays in Open issues. The row keeps a Planning thread link. Resume planning reopens this thread if the owner wants to continue.
