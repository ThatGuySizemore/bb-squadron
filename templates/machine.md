# Machine profile

Keep this private file at `~/.bb-squadron/machine.md` on each machine. Both families read it.

This layer describes this machine: devices and their permitted use, tools for each family, identities and notes for each project. Keep cross-project preferences in the playbook, repo rules in `AGENTS.md` and `docs/agents/`, and checked-in project settings in `docs/agents/squadron.md`.

## Devices

List available devices and how the owner permits agents to use them.

## Tools

List the tools available to Claude Code and Codex. Install Matt Pocock's skills as a plugin in each provider used by the routes and final review. Copies and symlinks do not count.

## Identities

For each family, name the Linear tool and the account it should verify before writing. Record its Git author name and email. PRs use whoever `gh` is signed in as. Credentials stay in the owner's tools, never in this file or the repo.

## Project notes

Record machine-specific project notes here. Quick check, stop list, routes, final-review family, time limits, the optional Tracker override and Linear-only status mapping belong in that project's `docs/agents/squadron.md`.
