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
| Routes | `Defaults: House rules` plus optional label exceptions, or a legacy table with one `(default)` row. |
| Final review | `other` or `same`, relative to the Lead's model family. |

## Quick check

After a merge, Squadron runs the quick check on main with SQUADRON_BASE set to the commit before the merge.
Quick checks that select tests from changed files should compare against `$SQUADRON_BASE` when it is set. Lanes do not set it.

## Check setup

A merged-main check starts in a clean scratch worktree without the owner's dependencies. If the quick check needs preparation, add an optional command in `docs/agents/squadron.md`, for example:

````md
## Check setup

```sh
npm ci
```
````

Use your project's own preparation command. Squadron assumes no package manager or language and never borrows dependencies from the owner's checkout. Omit this section if the quick check needs no preparation; a present section must contain a nonempty fenced command.

Squadron runs Check setup only in the isolated worktree at the merged main commit, then runs Quick check there if setup succeeds. Both receive `SQUADRON_BASE` set to the commit before the merge and share a 30-minute command budget. Setup output and quick-check output stay in the check's log. A setup failure skips Quick check and pauses Autopilot through the main-check brake with the log link. The owner's checkout is never used to execute either command. Lane checks keep their existing behavior.

## Squadron policy

House rules can add a `## Squadron policy` table, read like Model routes: a Setting / Value table where a missing file, section or row keeps the default. Squadron reads only this section, stopping at the next heading; `## Models and effort` prose is never policy.

| Setting | Values | Default |
|---|---|---|
| Escalation | `diagnose first` or `retry` | `retry` |
| Low effort | `mechanical only` or `off` | `off` |
| Checkpoint | a positive whole number | none |

`retry` keeps a retry, then a stop after two strikes. `diagnose first` diagnoses after the first qualifying strike before the replacement. `off` refuses every low route; `mechanical only` allows low for the Mechanical role alone. A route whose effort is `default` counts as low when BB advertises low as that model's default; when BB doesn't report the default, Doctor and the Lead's brief say the low-effort limit isn't proved for that route. The two-strike stop, and carrying strike counts, deadlines and budgets to replacement workers, are fixed for everyone. Checkpoint is an optional evaluation point that never affects launches; see [the run report](report.md).

Doctor shows the resolved values and where each came from. An unknown setting or value is a Doctor fix that names it, and Start refuses until it is fixed. Start puts the resolved policy in the Lead's brief.

## Lead and worker routes

House rules can supply a `## Model routes` table with these fixed Role names: Lead, Worker, Worker (hard), Planning, Planning (hard), Review of claude-code, Review of codex and Mechanical. The other columns are Provider, Model and Effort. Use BB provider IDs and exact model IDs from `bb provider models <provider>`. An effort can be any level that model advertises, or `default` to use its native default. Low is allowed only for Mechanical; later policy enforcement may disable low entirely. Worker (hard) and Planning (hard) are separate roles, resolved explicitly rather than selected by similarly named ticket labels.

Squadron parses only `## Model routes`, stopping at the next section. It does not interpret policy prose under `## Models and effort`. The private file is read on the selected checkout's machine. House rules wins over playbook.md, including when the selected file has no Model routes section; absence of a section does not trigger a fallback to the other file.

Opt in at the top of the repo's Routes section:

```md
## Routes

Defaults: House rules

| Label | Provider | Model | Effort |
|---|---|---|---|
```

The empty table is valid: all roles use House rules. Add label exceptions using your approved provider and model IDs. The first matching ticket label wins, ignoring case; Worker supplies the default. Lead always uses the Lead role, regardless of spec labels. The resolved provider and effort appear on the board and reach Start unchanged. Start keeps service tier `default`.

A repo role exception must add a Note column with `override: <task category or ticket>, <approval source>`. A bare `override` is refused. An example of the required note shape is `override: storage work, owner approval on PROJ-123`. The note must describe the scope and cite the approval; it does not itself grant authority. This applies to Lead, Worker, `(default)`, hard roles, Planning, Mechanical and named review roles. Use the full review role name rather than a generic Review row.

Doctor validates every configured row, including legacy Family rows, against BB's advertised provider, model and effort on that machine. For capability lookup, Claude means claude-code and GPT means codex; this keeps valid legacy route selection and resolved objects unchanged. A failed catalogue read or unsupported value blocks Start with the row name and problem. Squadron never substitutes another model. The family is derived from the provider: claude-code is Claude and codex is GPT. Other providers can build work, but cannot be named in review roles until their independence is defined.

Without `Defaults: House rules`, repos retain their own ordered label routes and one `(default)` fallback. An optional Lead row selects the coordinator; without it, spec labels select the Lead as before. The legacy Label / Family / Model / Effort table still accepts Claude or GPT with medium/high effort. A Provider column enables other providers and efforts. Doctor warns when shared Model routes exist but the repo has not opted in. It does not change the repo's routes automatically.

This repo opts in and keeps only its approved `ui` exception. Launch records, builder-based final review and configurable Squadron policy are delivered separately under SQD-229.

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
