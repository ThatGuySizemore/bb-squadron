# Issue tracker: Linear

Issues and specs for this repo live in Linear: team **Sizemore**, project **BB Squadron**. Agents write with the Linear MCP tools as their own verified identity (Claude as Claude Local, Codex as Codex Local).

## Conventions

- **Spec**: one issue holding the `to-spec` template. Its tickets are its sub-issues.
- **Create an issue**: `save_issue` with `team: "Sizemore"`, `project: "BB Squadron"`, `title` and `description`.
- **Read an issue**: `get_issue` with its identifier, such as `SIZE-123`, and `includeRelations: true` for blockers. Comments come from `list_comments`.
- **List issues**: `list_issues` with `team` and `project`, plus `state`, `label`, `parentId` or `query`. While `hasNextPage` is true, pass the returned `cursor`.
- **Make an issue a sub-issue of a parent**: `save_issue` with `parentId`.
- **Blocking**: Linear's native relations, through `blockedBy` or `blocks` on `save_issue`. A ticket with an open blocker waits.
- **Comment on an issue**: `save_comment` with `issueId` and `body`.
- **Apply or remove labels**: `save_issue` with `addLabels` / `removeLabels`. The `labels` field replaces the whole set, so leave it out.
- **Close**: post the explanation, then `save_issue` with `state: "Canceled"` for declined work. A ticket is Done when its spec's PR merges to `main`.

**PRs as a request surface: no.** Triage covers Linear issues only.

## When a skill says "publish to the issue tracker"

Create a Linear issue in team Sizemore, project BB Squadron.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above, then read its comments.
