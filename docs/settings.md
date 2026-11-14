# Squadron project settings

Each repo keeps its lane settings in `docs/agents/squadron.md`. Doctor checks them before Start. The board can read a detected tracker without this file or a Doctor pass. The [settings for this repo](agents/squadron.md) are a complete Linear example.

## Tracker detection and override

Squadron reads the planning tracker from `docs/agents/issue-tracker.md`: Linear, GitHub or Local markdown. Each BB project reads one tracker. Doctor shows the detected kind and its reason. If detection is ambiguous, add this optional section to `docs/agents/squadron.md`:

```md
## Tracker

Local markdown
```

The entire section value must be `Linear`, `GitHub` or `Local markdown`. The override takes precedence over `issue-tracker.md`; omit the section to use detection. An invalid value leaves the tracker undetermined and Doctor explains how to fix it.

Only Linear projects need a Linear connection and binding. GitHub reads issues through `gh` under the owner's existing login. Local markdown reads the repo's `.scratch/` files. Squadron's code never writes to a tracker; agents follow the repo's `issue-tracker.md` when publishing work.

## Required lane settings

Every tracker needs these sections before Start:

| Section | Value |
|---|---|
| Quick check | The test command in a fenced code block. |
| Stop list | A bullet list of problems that stop a merge. |
| Time limits | A Setting / Value table with positive Lane time limit and Worker time limit durations, such as `8 h` and `3 h`. |
| Routes | A Label / Family / Model / Effort table with one `(default)` row. Families are Claude or GPT; effort is medium or high. |
| Final review | `other` or `same`, relative to the Lead's model family. |

## Status mapping applies only to Linear

Linear also requires `## Status mapping`. For the standard Linear statuses, use:

```md
## Status mapping

Default.
```

Default maps Ready and Waiting to Todo, Flying and Working to In Progress, In review and In branch to In Review, and Landed and Done to Done.

For a workspace with different status names, replace `Default.` with a State / Linear status table. Include each of Ready, Flying, In review, Landed, Waiting, Working, In branch and Done exactly once, with a nonempty status. See this repo's table for its Waiting to Merge status.

GitHub and Local markdown need no Status mapping section. Their readers supply the issue states; a Linear mapping does not configure those trackers. See the [tracker reader interface](tracker-readers.md) for the snapshot and detection contracts.
