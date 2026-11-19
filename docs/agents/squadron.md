# Squadron settings for this repo

BB Squadron reads this file before it starts a lane here. Doctor requires Quick check, Stop list, Time limits, Routes and Final review. Scope and Status mapping are required only for Linear. A Linear board reads its Scope from this file; GitHub and Local markdown boards need neither this file nor a Doctor pass once the tracker is detected.

The optional Tracker section overrides detection from `docs/agents/issue-tracker.md`. Its entire value must be `Linear`, `GitHub` or `Local markdown`. Omit it to use detection. This repo uses Linear. See [settings](../settings.md) for examples and tracker-specific requirements.

## Tracker

Linear

## Scope

The board shows open Linear issues matching every key set here. This repo names only its project, so issues stay on the board if they move between teams. New issues must be filed inside this scope, as `docs/agents/issue-tracker.md` says, or they won't show on the board.

Project: BB Squadron

## Quick check

```sh
npm run check
```

## Check setup

Before the merged-main quick check, prepare dependencies in its scratch worktree only.

```sh
npm ci
```

## Stop list

A merge stops only for these:

- The plugin fails to build or to load in BB.
- An agent action that bypasses an owner approval: merging an `accept:owner` spec, deploying, releasing, or deleting something it didn't create.
- A test or assertion weakened to get a pass.

## Time limits

| Setting | Value |
|---|---|
| Lane time limit | 8 h |
| Worker time limit | 3 h |

## Routes

Defaults: House rules

The owner's Model routes supply role defaults. This repo keeps only its UI exception.

| Label | Provider | Model | Effort |
|---|---|---|---|
| `ui` | claude-code | claude-opus-5-5 | high |

## Clean up

After landing

## Final review

other

## Status mapping

Required only for Linear. GitHub and Local markdown use their own issue states and need no mapping table. Linear can use `Default.` for the standard statuses, or a table naming all eight states below. This workspace uses Waiting to Merge for In review and In branch.

| State | Linear status |
|---|---|
| Ready | Todo |
| Flying | In Progress |
| In review | Waiting to Merge |
| Landed | Done |
| Waiting | Todo |
| Working | In Progress |
| In branch | Waiting to Merge |
| Done | Done |
