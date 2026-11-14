// The default docs/agents/squadron.md that Set up writes with the owner.
// Every value is a starting point the setup thread confirms with the owner.

export const DEFAULT_SQUADRON_TEMPLATE = `# Squadron settings for this repo

BB Squadron reads this file before it starts a lane here. Doctor refuses to start when a section is missing.

## Quick check

\`\`\`sh
npm test
\`\`\`

## Stop list

A merge stops only for these:

- The quick check fails.
- An agent action that bypasses an owner approval: merging an \`accept:owner\` spec, deploying, releasing, or deleting something it didn't create.
- A test or assertion weakened to get a pass.

## Time limits

| Setting | Value |
|---|---|
| Lane time limit | 8 h |
| Worker time limit | 3 h |

## Routes

The first matching label wins, regardless of case. The default row is used when no label matches.

| Label | Family | Model | Effort |
|---|---|---|---|
| \`ui\` | Claude | claude-opus-5-5 | high |
| (default) | GPT | gpt-6.1-sol | high |

## Final review

other

## Status mapping

Default
`;
