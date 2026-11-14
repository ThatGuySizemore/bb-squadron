# Squadron settings

## Quick check

```sh
npm run check
```

## Stop list

- The plugin fails to build or load.
- A test assertion is weakened.

## Limits

| Setting | Value |
|---|---|
| Lanes at once | 3 |
| Workers per lane | 2 |
| Lane time limit | 8 h |
| Worker time limit | 90 m |

## Routes

| Label | Family | Model | Effort |
|---|---|---|---|
| `ui` | Claude | claude-opus-5-5 | high |
| `data` | GPT | gpt-6.1-sol | medium |
| (default) | GPT | gpt-6.1-sol | high |
