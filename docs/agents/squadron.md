# Squadron settings for this repo

BB Squadron reads this file before it starts a lane here. The Doctor refuses to start when a section is missing.

## Quick check

```sh
npm run check
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

The first matching label wins. The default row is used when no label matches.

| Label | Family | Model | Effort |
|---|---|---|---|
| `ui` | Claude | claude-opus-5-5 | high |
| (default) | GPT | gpt-6.1-sol | high |

## Final review

other

## Status mapping

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
