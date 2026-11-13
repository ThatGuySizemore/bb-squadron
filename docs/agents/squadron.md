# Squadron settings for this repo

BB Squadron reads this file before it starts a lane here. The Doctor refuses to start when a section is missing.

## Quick check

```sh
npm run check
```

## Stop list

A merge stops only for these:

- The plugin fails to build or to load in BB.
- A write to Linear that is not made by the Helper.
- An agent action that bypasses an owner approval: merging an `accept:owner` spec, deploying, releasing, or deleting something it didn't create.
- A test or assertion weakened to get a pass.

## Limits

| Setting | Value |
|---|---|
| Lanes at once | 3 |
| Workers per lane | 3 |
| Lane time limit | 8 h |
| Worker time limit | 3 h |

## Routes

The first matching label wins. Reviewers always come from the other family.

| Label | Family | Model | Effort |
|---|---|---|---|
| `ui` | Claude | claude-opus-5-5 | high |
| (default) | GPT | gpt-6.1-sol | high |
