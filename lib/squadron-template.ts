// The default docs/agents/squadron.md that Set up writes with the owner.
// Every value is a starting point the setup thread confirms with the owner.

export const DEFAULT_SQUADRON_TEMPLATE = `# Squadron settings for this repo

BB Squadron reads this file before it starts a lane here. Doctor refuses to start when a section is missing.

## Scope

Linear only; delete this section for GitHub or Local markdown. The board shows open Linear issues matching every key set below. Set at least one of Team, Project, Initiative, Label or View, one per line, as a name, key, URL or id. New issues must be filed inside this scope, as docs/agents/issue-tracker.md says, or they won't show on the board.

Project: <Linear project name or URL>

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

## Hold labels

Optional. Tickets carrying Squadron's default hold labels (hold, needs-triage, needs-info, ready-for-human, wontfix) are held: the board shows them as Held and the Lead skips them. List more here, one per bullet, regardless of case. A trailing * matches a prefix. With no bullets, only the defaults apply.
`;
