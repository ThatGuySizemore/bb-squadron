# Squadron settings with an early fallback

## Quick check

```sh
npm run check
```

## Stop list

- The plugin fails to build or load.

## Limits

| Setting | Value |
|---|---|
| Lanes at once | 3 |
| Workers per lane | 3 |
| Lane time limit | 8 h |
| Worker time limit | 3 h |

## Routes

| Label | Family | Model | Effort |
|---|---|---|---|
| (default) | GPT | gpt-6.1-sol | high |
| `ui` | Claude | claude-opus-5-5 | high |
| `data` | GPT | gpt-6.1-sol | medium |
