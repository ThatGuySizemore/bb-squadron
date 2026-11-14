# Linear connection

Save a personal API key in Squadron's secret setting in BB, then press Check connection. The settings page receives only the workspace, account and a safe connection message. The key stays on the server in BB's secret settings.

The board reads the open issues in the repo's Scope (the `## Scope` section of `docs/agents/squadron.md`, see [settings](settings.md#scope-applies-only-to-linear)), with their labels, states and blocking links, about every 30 seconds while a board shows the project. Snapshots stay in memory, and the plugin stores no scope. A reload rebuilds the board with a full read from Linear. The plugin makes no Linear writes. Agents publish through their own tools as the repo's issue tracker instructions say.

## Server interface

`registerLinearAuth` in `lib/linear-auth.ts` registers `linearApiKey` and the `linear.connection` RPC. Its server-only `graphql` method reads the current key for every request. `getConnection` caches public identity for at most 60 seconds and invalidates it when the key changes.

The adapter respects Linear's request and complexity budget reset headers and rate-limit responses. Requests time out after 20 seconds and abort when the plugin unloads. Errors return a stable code, optional retry delay and a safe message, without provider response details. When Linear answers with GraphQL errors, each error's `message` and `extensions.code` go to the plugin log at warn level; the headers, variables and key never do.

Linear refuses a query above about 10,000 complexity points (each property 0.1, each object 1, each connection multiplied by its `first`, default 50). Every query lives in `lib/linear-queries.ts` with small first pages, and `tests/linear-complexity.test.ts` fails any query above 2,500. The reader's pagination walks fetch what a first page leaves.

## Validation

Tests use recorded API response shapes with invented identities and fake credentials through the SDK testing host. Live credential and workspace behavior requires a separate owner check.
