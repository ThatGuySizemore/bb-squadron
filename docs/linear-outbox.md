# Linear writes

`registerLinearOutbox(bb, linear)` registers one durable SQLite queue and the
`linear-outbox` background service. It uses the same server-side auth transport
and rate-limit budget as the mirror. It registers no write RPC or HTTP endpoint.

The trusted Helper interface is `enqueue({ dedupeKey, operation })`, `get(id)` and
`flush()`. Enqueue validates the operation, resolves the connected workspace and
stores it before returning `{ id, entityId? }`. Comments, new issues and blocking
links get a UUID at enqueue time. `entityId` is that UUID and can be used by later
parent or blocking-link writes before the earlier write has been delivered.

Supported trusted operations:

| Type | Fields | Linear mutation |
| --- | --- | --- |
| `status` | `issueId`, `stateId` | `issueUpdate` |
| `labels` | `issueId`, `add`, `remove` | `issueUpdate` with `addedLabelIds` and `removedLabelIds` |
| `issue` | `teamId`, `projectId`, `title`, `description`, `parentId?`, `labelIds` | `issueCreate` |
| `comment` | `issueId`, `body`, `author: {role, model, avatarUrl}` | `commentCreate` |
| `parent` | `issueId`, `parentId` | `issueUpdate` |
| `blocks` | `issueId`, `blockedIssueId` | `issueRelationCreate` with type `blocks` |

The author name is `role · model`. App comments send that as `createAsUser` and
send the HTTPS avatar as `displayIconUrl`. Linear renders the app attribution.
Personal-key comments prepend `role · model (via Squadron)` to their body and
omit the app-only fields. This follows
[Linear's actor authorization](https://linear.app/developers/oauth-actor-authorization).

## Agent authority

Only trusted server code can call `bindThread(grant)`. There is no tool or RPC for
grant creation. The planning registration supplies the binding and safe label IDs
from the mirror, plus the seed issue when planning an existing issue:

```ts
await outbox.bindThread({
  threadId, bbProjectId, workspaceId, teamId, projectId,
  role: "Planning thread", avatarUrl,
  issueIds: seedIssueId ? [seedIssueId] : [],
  labelIds: safeRouteAndReadyLabelIds,
  allowCreateIssues: true,
});
```

A grant is not owner approval. The caller must establish any required owner
authority before granting writes. Thread metadata, agent text and comments never
establish that authority here. This module does not start lanes, merge, deploy,
release or implement Spec B.

`squadron_linear_write({ dedupeKey, operation })` accepts the operations above
except `status`. It rejects caller-supplied identity, approval, team and project
fields. For `issue`, omit `teamId` and `projectId`; they come from the server
grant. For `comment`, omit `author`; the role/avatar come from the grant and the
model comes from the actual thread's SDK execution options. The tool checks the
actual SDK thread and project on every call. No grant means no writes.

Each target issue, parent and blocker must be in that grant. Every label added
or removed must be allowed by it. Creating an issue extends the same grant with
its UUID in the same database transaction that enqueues the write. Tool dedupe
keys are scoped to the actual originating thread. Use one stable key for one
operation; changing an operation under an existing key is rejected.

`squadron_linear_receipt({ id })` returns only that originating thread's receipt:
`{ id, status: "pending" | "delivered", attempts, nextAttemptAt, lastError }`.
It contains no body, transport response or credentials. A pending receipt is not
proof that Linear has changed. Both grants and receipts survive reload.

## Retry, ordering and limits

The queue keeps a single global FIFO order. A pending first write holds all later
writes, including writes for another workspace. It retains its operation, UUID,
attempt count, next attempt and safe error code across restart. Attempts are
recorded before the network call. Backoff starts at one second, doubles to five
minutes and respects a longer transport retry delay. The service checks once a
second and resumes queued work on startup. Concurrent flush calls share one drain.
Errors never discard a write or expose raw transport messages.

The stored workspace and auth mode must match at delivery. The optional fourth
argument to `linear.graphql` binds a write or reconciliation lookup to that
workspace/mode and checks the auth generation immediately before sending. A
credential change cannot retarget a queued operation to another workspace.
Disconnects, permission errors and validation failures leave the first write
pending for recovery; they can hold the queue indefinitely.

Statuses, label sets and parent links can be replayed. New issues, comments and
blocking links always reuse their stored UUID, using the create-input IDs in
[Linear's published schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql).
Before retrying a comment, the queue looks up that UUID and checks its issue and
body. New issues reconcile by UUID, team and project. A blocking-link failure
looks up the original relation UUID and checks both endpoints and type.

These checks reduce duplicate creation after an ambiguous response. Linear does
not document a general exactly-once idempotency contract for these mutations, so
this module makes no such guarantee. A failed lookup never authorizes a fresh
UUID. Inaccessible, edited or conflicting resources can keep a write pending.
Different dedupe keys represent different operations, even with identical text.
Fixture tests verify the queue and exact payloads; live delivery and upstream
UUID-conflict behavior still need separate validation with owner authorization.

Persistence/dedupe mechanics were adapted from Chief's `alert_outbox` at commit
`64ac8bc3613efbdd5841af0487b31e9003ed5efe`. Chief delivers BB messages; this module
adds Linear payloads, backoff, ordered delivery and UUID reconciliation. Its MIT
notice is in `THIRD_PARTY_NOTICES.md`.
