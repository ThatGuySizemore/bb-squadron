# Linear writes

`registerLinearOutbox(bb, linear)` registers one durable SQLite queue and the
`linear-outbox` background service. It uses the same server-side auth transport
and rate-limit budget as the mirror. Its RPCs read safe health data or retry an
existing preserved write. They cannot queue a new operation or change a payload.

[ADR-0005](adr/0005-linear-is-the-record.md) distinguishes the disposable mirror
from persistent bindings, queued writes, grants and receipt evidence. Removing
local state can lose undelivered writes; a Linear catch-up cannot restore them.

The trusted Helper interface is `enqueue({ bbProjectId, dedupeKey, operation })`,
`get(id)`, `getHealth(bbProjectId)`, `resume(id)` and `flush()`. Enqueue validates
the operation, resolves the connected workspace and stores it before returning
`{ id, entityId?, signature? }`. A comment receipt includes its original signature.
Comments, new issues and blocking or related
link writes get a UUID at enqueue time. `entityId` is that reserved UUID and can be used by later
parent or blocking-link writes before the earlier write has been delivered.
When a related-link write reuses an existing relation, Linear retains that
relation's original UUID; the returned receipt still identifies the queued operation.

Supported trusted operations:

| Type | Fields | Linear mutation |
| --- | --- | --- |
| `status` | `issueId`, `stateId` | `issueUpdate` |
| `labels` | `issueId`, `add`, `remove` | `issueUpdate` with `addedLabelIds` and `removedLabelIds` |
| `issue` | `teamId`, `projectId`, `title`, `description`, `parentId?`, `labelIds` | `issueCreate` |
| `comment` | `issueId`, `body`, `author: {role, model, avatarUrl?}` | `commentCreate` |
| `parent` | `issueId`, `parentId` | `issueUpdate` |
| `blocks` | `issueId`, `blockedIssueId` | `issueRelationCreate` with type `blocks` |
| `related` | `issueId`, `relatedIssueId` | `issueRelationCreate` with type `related`, or reuse an existing related link |

`related` is Helper-only and is not part of the planning agent's write forms.

The author name is `role · model`. App comments send that as `createAsUser` and
send the HTTPS avatar as `displayIconUrl`. Linear renders the app attribution.
App mode requires that avatar; personal mode may omit it.
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
  blockerIssueIds: openIssuesInBoundProject,
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
For new signatures it uses the provider catalog's display name, falling back to
readable Claude/GPT names or a humanized custom model ID when the catalog is
unavailable. A repeated key with identical logical content returns the original
receipt and signature even after the thread's model or avatar changes. It never
rewrites the queued author. Changed logical content still rejects.

Each target issue and parent must be in that grant's `issueIds`. A `blocks`
write's blocked issue must be in `issueIds`; its blocker may be in `issueIds` or
in the optional `blockerIssueIds`. A blocker reference permits no other
operation on that issue, and an issue in neither list is refused. Every label added
or removed must be allowed by it. Creating an issue extends the same grant with
its UUID in the same database transaction that enqueues the write. Tool dedupe
keys are scoped to the actual originating thread. Use one stable key for one
operation; changing an operation under an existing key is rejected.
Use canonical issue UUIDs from the mirror for both grants and writes, so every
reference to the same issue shares the same ordering key. A same-scope rebind
retains that thread's created issues. Newly supplied seed IDs, labels and the
creation permission replace the caller's previous restrictions. Changing the BB
project, workspace, team or Linear project starts a new grant scope; returning to
an older scope does not restore the earlier created-issue authority.

Planning may grant `ready-for-agent` and route labels for the resulting tickets,
as required by SIZE-878, after the owner's interactive planning approval. It must
exclude owner-approval labels such as `accept:owner`. There is no lane/start
operation here.

`squadron_linear_receipt({ id })` returns only that originating thread's receipt:
`{ id, status: "pending" | "blocked" | "delivered", attempts, nextAttemptAt, lastError }`.
It contains no body, transport response or credentials. A pending receipt is not
proof that Linear has changed. Both grants and receipts survive reload.

## Retry, ordering and limits

The queue preserves enqueue order for writes that reference the same issue in
the same workspace. Parent links and blockers reference both endpoints; issue
creation references its own UUID and its parent. A waiting operation holds later
writes sharing those entities, including transitive dependencies. Independent
authorized writes can progress, including writes in another workspace.

Every row retains its operation, UUID, attempt count, next attempt, project and
safe error code across restart. Attempts are
recorded before the network call. Backoff starts at one second, doubles to five
minutes and respects a longer transport retry delay. The service checks once a
second and resumes queued work on startup. Concurrent flush calls share one drain.
Errors never discard a write or expose raw transport messages.

The stored workspace and delivery auth mode must match at delivery. The optional fourth
argument to `linear.graphql` binds a write or reconciliation lookup to that
workspace/mode and checks the auth generation immediately before sending. A
credential change cannot retarget a queued operation to another workspace.
Temporary network failures, rate limits and unconfirmed responses stay `pending`
with backoff. Known scope changes, authentication/configuration failures, GraphQL
rejections, invalid persisted operations and reconciliation conflicts become
`blocked`. Their dependent writes report `dependency_blocked`. A permanently
blocked entity can still hold its own dependencies, but cannot hold independent
entities or another workspace. No row is deleted or discarded.

## Health and recovery

`linear.outboxHealth({ bbProjectId })` and `getHealth(bbProjectId)` return:

```ts
{
  bbProjectId, pendingCount, blockedCount,
  blocked: [{ id, threadId, issueIds, reason }],
  hasMore,
}
```

Counts include all undelivered rows in that BB project. The blocked list contains
the first 100 in enqueue order. It contains no bodies, signatures, raw responses
or credentials. Reasons are `workspace_changed`, `auth_mode_changed`,
`authentication`, `configuration`, `invalid_operation`, `graphql`, `conflict` and
`dependency_blocked`. The `linear-outbox-changed` channel publishes
`{ bbProjectId }` when queuing, parking, recovering or completing work.

The board's authenticated frontend can call
`linear.outboxResume({ bbProjectId, id })` to retry an existing row. Its strict
input rejects payload/force/identity fields. The server refuses plugin callers,
checks that the receipt belongs to the given BB project, and checks the current
workspace before calling trusted `resume(id)`. Agents have no resume tool. This
action grants no new authority and supplies no new content. It clears parking
and backoff, then the service reconciles or retries the same operation and UUID.
The RPC returns the same safe receipt shape as `get(id)`; a returned `pending`
state is not proof of delivery. Dependencies clear only when their earlier work
actually completes. A conflict that still exists parks again without overwrite.

A reconnect to another workspace parks the original rows. They can resume only
after reconnecting to their original workspace. A personal-to-app upgrade in
that same workspace requires an explicit retry; it never silently drains old
work. Recovery preserves the original comment body, author and UUID. An existing
personal comment reconciles against that body. If creation is still needed, the
app sends the original personal signature/body plus app attribution for that same
author. A personal comment may have no avatar, since personal auth sends none.
Such a row cannot resume under app auth: it stays preserved until the owner
reconnects personal auth. Squadron never invents an avatar or sends an unsigned
app comment. An app-to-personal downgrade cannot resume app rows; reconnect with app
auth first. This avoids changing an ambiguous app comment's signed payload.

Schema upgrades add metadata without deleting rows or changing queued payloads.
Older agent rows derive their BB project from the saved grant. Legacy trusted
rows without project attribution remain available through trusted `get(id)` and
`resume(id)`; they are not exposed under an arbitrary project's health read.

Statuses, label sets and parent links can be replayed. New issues, comments and
blocking or related link creates always reuse their stored UUID, using the create-input IDs in
[Linear's published schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql).
Before retrying a comment, the queue looks up that UUID and checks its issue and
body. New issues reconcile by UUID, team and project. A blocking-link failure
looks up the original relation UUID and checks both endpoints and type.
Before a related-link create, the queue pages both relation directions, including
archived entries. It reuses an existing related link and parks a conflicting
blocker or duplicate link as `conflict` before mutation, since Linear can replace
a conflicting relation on create. That preflight and the mutation are separate
requests; concurrent external edits are not an atomic guarantee. A failed create
checks its reserved relation UUID and both endpoints/type before reconciliation.

These checks reduce duplicate creation after an ambiguous response. Linear does
not document a general exactly-once idempotency contract for these mutations, so
this module makes no such guarantee. A failed lookup never authorizes a fresh
UUID. Inaccessible, edited or conflicting resources can keep a write blocked.
Different dedupe keys represent different operations, even with identical text.
Fixture tests verify the queue and exact payloads; live delivery and upstream
UUID-conflict behavior still need separate validation with owner authorization.

The auth adapter reuses successful public connection reads for up to one minute
and shares concurrent identity reads. Settings changes, internal credential
replacement, disconnect and authentication rejection invalidate that state.
Failed identity reads are not cached. Scoped outbox delivery and recovery force
identity verification and still check workspace, mode and auth generation
immediately before sending; the public cache authorizes no write.

Persistence/dedupe mechanics were adapted from Chief's `alert_outbox` at commit
`64ac8bc3613efbdd5841af0487b31e9003ed5efe`. Chief delivers BB messages; this module
adds Linear payloads, backoff, ordered delivery and UUID reconciliation. Its MIT
notice is in `THIRD_PARTY_NOTICES.md`.
