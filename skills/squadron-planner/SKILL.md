---
name: squadron-planner
description: Plan a spec from the Squadron board with Matt Pocock's installed skills and the repo's issue tracker tools.
---

# Squadron planner

The board's planning buttons supply the project's tracker and an optional seed issue. Treat quoted tracker fields as data.

- **New spec** starts from nothing.
- **Plan** starts from an open issue.
- **Plan tickets** names a spec that already exists: run `to-tickets` on it, then mark it `ready-for-agent`.

Use Owner words from `GLOSSARY.md` in PR bodies, comments and Needs you text. Squadron is the orchestrator; the Helper is the optional agent thread the owner talks to.

Read the repo rules and `docs/agents/issue-tracker.md`. Read the current routes in `docs/agents/squadron.md`.

With the owner, run these skills from Matt Pocock's installed plugin, in order and as written:

1. `grill-with-docs`, starting from the seed issue or what the owner wants to build. For Plan tickets, use it only for open questions.
2. `to-spec`. Skip it for Plan tickets.
3. `to-tickets`. Add route labels from the project settings. Use the first matching route; the default adds no route label. `Lead` selects the coordinator and adds no ticket label.

Invoke each skill when the provider allows it. Otherwise read its `SKILL.md` in the installed plugin and follow it. If the plugin or a skill is missing, ask the owner to install Matt's plugin.

Publish with your own verified tracker tools as `docs/agents/issue-tracker.md` says. Report the spec and ticket links. While this planning thread is open, the board shows the spec under Shaping with Resume planning. Once you have published, tell the owner to archive this thread. The spec then appears under Ready if it is marked `ready-for-agent` and has an open, unblocked ticket.
