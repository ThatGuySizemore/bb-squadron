# Squadron project settings

Each repo keeps its lane settings in `docs/agents/squadron.md`. Doctor checks them before Start. The board can read a detected tracker without this file or a Doctor pass. The [settings for this repo](agents/squadron.md) are a complete Linear example.

The private owner files are House rules at `~/.bb-squadron/house-rules.md` and This machine at `~/.bb-squadron/machine.md`. Start points the Lead at House rules when present, or at the legacy `~/.bb-squadron/playbook.md` fallback. If both exist, Squadron reads `house-rules.md`. Doctor reports which file it uses and asks the owner to rename an old file; it never renames private files. The starters are [House rules](../templates/house-rules.md) and [This machine](../templates/machine.md).

## Tracker detection and override

Squadron reads the planning tracker from `docs/agents/issue-tracker.md`: Linear, GitHub or Local markdown. Each BB project reads one tracker. Doctor shows the detected kind and its reason. If detection is ambiguous, add this optional section to `docs/agents/squadron.md`:

```md
## Tracker

Local markdown
```

The entire section value must be `Linear`, `GitHub` or `Local markdown`, matched without regard to case. `local-markdown` is also accepted. The override takes precedence over `issue-tracker.md`; omit the section to use detection. An invalid value leaves the tracker undetermined and Doctor explains how to fix it.

Only Linear projects need a Linear connection and a Scope. GitHub reads issues through `gh` under the owner's existing login. Local markdown reads the repo's `.scratch/` files. Squadron's code never writes to a tracker; agents follow the repo's `issue-tracker.md` when publishing work.

## Required lane settings

Every tracker needs these sections before Start:

| Section | Value |
|---|---|
| Quick check | The test command in a fenced code block. |
| Stop list | A bullet list of problems that stop a merge. |
| Time limits | A Setting / Value table with positive Lane time limit and Worker time limit durations, such as `8 h` and `3 h`. |
| Routes | A Label / Family / Model / Effort table with one `(default)` row. Families are Claude or GPT; effort is medium or high. |
| Final review | `other` or `same`, relative to the Lead's model family. |

## Quick check

After a merge, Squadron runs the quick check on main with SQUADRON_BASE set to the commit before the merge.
Quick checks that select tests from changed files should compare against `$SQUADRON_BASE` when it is set. Lanes do not set it.

## Lead and worker routes

Routes may include one `Lead` row, such as `| Lead | GPT | gpt-6.1-sol | medium |`. It selects the Lead regardless of spec labels. The Lead coordinates and merges; workers build tickets, including UI. Without a Lead row, Start keeps the existing behaviour: the first matching spec label wins, then the default row.

Ticket labels still select worker routes in table order, with `(default)` as fallback. `Lead` is reserved for the coordinator, not a ticket label. This repo uses GPT medium for Lead and default, Claude Opus high for `ui`, and an unchanged high-effort final review.

## Hold labels

A held ticket is an open ticket that carries a hold label. The board shows it as Held, and the Lead starts no worker for it, picks it up if the label comes off while the lane runs, and lists it under "Held" in the PR body. A spec whose open tickets are all held stays Shaping. A lane that delivers the rest leaves its held tickets and the spec open.

The default hold labels are `hold` plus Matt's triage roles that mean "not for an agent": `needs-triage`, `needs-info`, `ready-for-human` and `wontfix`. An optional section adds more:

```md
## Hold labels

- blocked-externally
- wayfinder:*
```

List one label per bullet; other lines are prose. Labels match regardless of case, and a trailing `*` matches a prefix. The section only adds to the defaults; it never removes them. Trackers without labels, such as Local markdown, hold a ticket whose `Status:` line names a hold label, as they mark a spec ready with `Status: ready-for-agent`. Doctor flags a one-word line that isn't a bullet, an empty bullet, a lone `*`, a `*` before the end, or several labels on one bullet. A missing or prose-only section is fine.

## Scope applies only to Linear

A Linear project's board reads the issues its `## Scope` section names. Without a valid Scope the board shows no issues and Doctor reports a fix. Set at least one key, one per line:

```md
## Scope

Project: BB Squadron
```

| Key | Value | Board shows |
|---|---|---|
| Team | name, key or team URL | everything in that team |
| Project | name, project URL or id | the whole project, across teams |
| Initiative | name, initiative URL or id | issues in any project of that initiative |
| Label | name, `group/name`, or id | issues carrying that label |
| View | name, view URL or id | what the saved view shows, by its own filter |

Every key set narrows: the board shows open issues matching all of them. A team is not required; a project-only scope keeps working when issues move between teams. Squadron resolves each value through Linear on read. A value that matches nothing, or more than one record, is a board and Doctor error naming the key. A label name that several teams share needs a Team key or the label's id. Prose lines in the section are ignored; a line starting with an unknown `Word:` is an error.

`docs/agents/issue-tracker.md` must file new issues inside this scope, or they won't show on the board.

Membership includes closed issues: a blocker, parent or lane ticket is in scope when Linear says it matches. For a View, in scope means returned by the view. States and labels come from the teams of the issues read, plus the Team key's team, so status mapping by name works across teams.

## Status mapping applies only to Linear

Linear also requires `## Status mapping`. For the standard Linear statuses, use:

```md
## Status mapping

Default.
```

Default maps Ready and Waiting to Todo, Flying and Working to In Progress, In review and In branch to In Review, and Landed and Done to Done.

For a workspace with different status names, replace `Default.` with a State / Linear status table. Include each of Ready, Flying, In review, Landed, Waiting, Working, In branch and Done exactly once, with a nonempty status. See this repo's table for its Waiting to Merge status.

GitHub and Local markdown need no Status mapping section. Their readers supply the issue states; a Linear mapping does not configure those trackers. See the [tracker reader interface](tracker-readers.md) for the snapshot and detection contracts.
