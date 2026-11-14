// Persistence and dedupe mechanics adapted from bb-plugin-chief (MIT).
// See THIRD_PARTY_NOTICES.md. Linear delivery semantics are implemented here.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { LinearRequestError, type LinearAuth } from "./linear-auth.js";
import { linearOutboxContract, type OutboxHealth, type OutboxBlockedReason } from "./linear-outbox-contract.js";
import { isActiveProjectThread } from "./project-thread.js";
import { linearOutboxChanged, publishSquadronSignal } from "./realtime-contract.js";
import { linearAvatarUrlSchema } from "./linear-avatar.js";

const text = z.string().min(1).max(256);
const authorSchema = z.object({
  role: z.enum(["Lead", "Worker", "Reviewer", "Planning thread"]), model: text,
  avatarUrl: linearAvatarUrlSchema.optional(),
}).strict();
const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), issueId: text, stateId: text }).strict(),
  z.object({ type: z.literal("labels"), issueId: text, add: z.array(text).max(100), remove: z.array(text).max(100) }).strict(),
  z.object({ type: z.literal("comment"), issueId: text, body: z.string().min(1).max(100_000), author: authorSchema }).strict(),
  z.object({ type: z.literal("issue"), teamId: text, projectId: text, title: z.string().min(1).max(500),
    description: z.string().max(100_000), parentId: text.optional(), labelIds: z.array(text).max(100) }).strict(),
  z.object({ type: z.literal("blocks"), issueId: text, blockedIssueId: text }).strict(),
  z.object({ type: z.literal("parent"), issueId: text, parentId: text }).strict(),
]);
const agentOperationSchema = z.discriminatedUnion("type", [
  operationSchema.options[1], operationSchema.options[2].omit({ author: true }),
  operationSchema.options[3].omit({ teamId: true, projectId: true }),
  operationSchema.options[4], operationSchema.options[5],
]);
const agentWriteSchema = z.object({ dedupeKey: text, operation: agentOperationSchema }).strict();
const grantSchema = z.object({
  threadId: text, bbProjectId: text, workspaceId: text, teamId: text, projectId: text,
  role: authorSchema.shape.role, avatarUrl: authorSchema.shape.avatarUrl,
  issueIds: z.array(text).max(10_000), labelIds: z.array(text).max(100), allowCreateIssues: z.boolean(),
  // Existing issues that may block issues this thread owns. A reference grants
  // no other write on that issue.
  blockerIssueIds: z.array(text).max(10_000).optional(),
}).strict();
export type LinearWriteGrant = z.infer<typeof grantSchema>;
type Operation = z.infer<typeof operationSchema>;
type Row = {
  id: string; dedupe_key: string; workspace_id: string; mode: "app" | "personal";
  operation: string; delivered_at: number | null; attempts: number;
  next_attempt_at: number; last_error: string | null;
  thread_id: string | null;
  bb_project_id: string | null; resources_json: string; blocked_reason: OutboxBlockedReason | null;
  delivery_mode: "app" | "personal" | null;
  grant_scope_id: string | null;
};
const updateQuery = "mutation SquadronIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }";
class WriteDeliveryBlocked extends Error {
  constructor(readonly reason: OutboxBlockedReason) { super(reason); }
}
function issueReferences(operation: Operation, id: string): string[] {
  if (operation.type === "issue") return [id, ...(operation.parentId ? [operation.parentId] : [])];
  return [...new Set([operation.issueId, ...(operation.type === "blocks" ? [operation.blockedIssueId] : operation.type === "parent" ? [operation.parentId] : [])])];
}
export function modelDisplayName(model: string): string {
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)[.-](\d+)/.exec(model);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/.exec(model);
  const words = (value: string) => value.split(/[-_\s]+/).map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${words(gpt[2])}` : ""}`;
  return words(model);
}
function logicalOperation(operation: Operation) {
  return operation.type === "comment" ? { type: operation.type, issueId: operation.issueId, body: operation.body } : operation;
}

export function registerLinearOutbox(bb: BbPluginApi, auth: LinearAuth, options: { uuid?: () => string; now?: () => number } = {}) {
  const uuid = options.uuid ?? randomUUID;
  const now = options.now ?? Date.now;
  const lifetime = new AbortController();
  const db = bb.storage.database();
  // Independent table creation avoids sharing ordered migration indexes with
  // other features that use this same plugin database.
  db.exec(`CREATE TABLE IF NOT EXISTS outbox_writes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE, dedupe_key TEXT NOT NULL, workspace_id TEXT NOT NULL,
    mode TEXT NOT NULL, operation TEXT NOT NULL, thread_id TEXT,
    delivered_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    UNIQUE (workspace_id, dedupe_key)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS outbox_writes_pending ON outbox_writes (sequence) WHERE delivered_at IS NULL`);
  db.exec(`CREATE TABLE IF NOT EXISTS outbox_thread_grants (thread_id TEXT PRIMARY KEY, grant_json TEXT NOT NULL)`);
  const columns = new Set((db.pragma("table_info(outbox_writes)") as { name: string }[]).map((column) => column.name));
  for (const [name, type] of [["bb_project_id", "TEXT"], ["resources_json", "TEXT NOT NULL DEFAULT '[]'"], ["blocked_reason", "TEXT"], ["delivery_mode", "TEXT"], ["grant_scope_id", "TEXT"]]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE outbox_writes ADD COLUMN ${name} ${type}`);
  }
  if (!(db.pragma("table_info(outbox_thread_grants)") as { name: string }[]).some((column) => column.name === "scope_id")) db.exec(`ALTER TABLE outbox_thread_grants ADD COLUMN scope_id TEXT`);
  // Add attribution/ordering metadata to old rows without changing their payloads.
  for (const row of db.prepare(`SELECT * FROM outbox_writes WHERE resources_json='[]'`).all() as Row[]) {
    let resources: string[] = [];
    try { resources = issueReferences(operationSchema.parse(JSON.parse(row.operation)), row.id); } catch { /* The drain parks invalid rows. */ }
    const saved = row.thread_id ? db.prepare(`SELECT grant_json FROM outbox_thread_grants WHERE thread_id=?`).get(row.thread_id) as { grant_json: string } | undefined : undefined;
    const grant = saved ? grantSchema.safeParse(JSON.parse(saved.grant_json)) : null;
    db.prepare(`UPDATE outbox_writes SET resources_json=?, bb_project_id=COALESCE(bb_project_id,?) WHERE id=?`)
      .run(JSON.stringify(resources), grant?.success ? grant.data.bbProjectId : null, row.id);
  }
  const changed = (bbProjectId: string | null) => { if (bbProjectId) publishSquadronSignal(bb.realtime, linearOutboxChanged, { bbProjectId }); };
  let draining: Promise<void> | null = null;
  function store(dedupeKey: string, operation: Operation, workspaceId: string, mode: "app" | "personal", bbProjectId: string, threadId: string | null = null, scopeId: string | null = null) {
    const id = uuid();
    db.prepare(`INSERT OR IGNORE INTO outbox_writes (id, dedupe_key, workspace_id, mode, operation, thread_id, bb_project_id, resources_json, grant_scope_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, dedupeKey, workspaceId, mode, JSON.stringify(operation), threadId, bbProjectId, JSON.stringify(issueReferences(operation, id)), scopeId);
    const row = db.prepare(`SELECT * FROM outbox_writes WHERE workspace_id=? AND dedupe_key=?`).get(workspaceId, dedupeKey) as Row;
    const original = operationSchema.parse(JSON.parse(row.operation));
    if (JSON.stringify(logicalOperation(original)) !== JSON.stringify(logicalOperation(operationSchema.parse(operation))) || row.thread_id !== threadId || row.bb_project_id !== bbProjectId || row.grant_scope_id !== scopeId) throw new Error("This write key already belongs to another operation.");
    changed(bbProjectId);
    return { id: row.id, ...(["comment", "issue", "blocks"].includes(operation.type) ? { entityId: row.id } : {}),
      ...(original.type === "comment" ? { signature: `${original.author.role} · ${original.author.model}` } : {}) };
  }
  async function enqueue(input: { bbProjectId: string; dedupeKey: string; operation: Operation; expectedWorkspaceId?: string }) {
    const bbProjectId = text.parse(input.bbProjectId);
    const dedupeKey = text.parse(input.dedupeKey);
    const operation = operationSchema.parse(input.operation);
    const connection = await auth.getConnection({ throwOnFailure: true });
    if (connection.status !== "connected" || !connection.workspace || !connection.mode) throw new Error("Connect Linear before queuing a write.");
    if (input.expectedWorkspaceId && connection.workspace.id !== input.expectedWorkspaceId) throw new Error("The Linear workspace changed before the write was queued.");
    if (connection.mode === "app" && operation.type === "comment" && !operation.author.avatarUrl) throw new Error("App comments need a public HTTPS avatar.");
    return store(dedupeKey, operation, connection.workspace.id, connection.mode, bbProjectId);
  }
  async function drain(signal: AbortSignal) {
    const waiting = new Map<string, "pending" | "blocked">();
    for (const row of db.prepare(`SELECT * FROM outbox_writes WHERE delivered_at IS NULL ORDER BY sequence`).all() as Row[]) {
      if (signal.aborted) return;
      const resources = z.array(z.string()).parse(JSON.parse(row.resources_json)).map((id) => `${row.workspace_id}:${id}`);
      const dependency = resources.some((id) => waiting.get(id) === "blocked") ? "blocked" : resources.some((id) => waiting.has(id)) ? "pending" : null;
      const hold = (status: "pending" | "blocked") => { for (const id of resources) waiting.set(id, status); };
      const park = (reason: OutboxBlockedReason | null) => {
        if (row.blocked_reason !== reason) {
          db.prepare(`UPDATE outbox_writes SET blocked_reason=?, last_error=? WHERE id=?`).run(reason, reason, row.id);
          changed(row.bb_project_id);
          row.blocked_reason = reason;
        }
      };
      if (row.blocked_reason === "dependency_blocked") park(null);
      if (dependency === "blocked") { if (!row.blocked_reason) park("dependency_blocked"); hold("blocked"); continue; }
      if (row.blocked_reason) { hold("blocked"); continue; }
      if (dependency || row.next_attempt_at > now()) { hold("pending"); continue; }
      const request = <T>(query: string, variables: Record<string, unknown>) => auth.graphql<T>(query, variables, signal,
        { workspaceId: row.workspace_id, mode: row.delivery_mode ?? row.mode });
      // Charge before the request. A crash after remote acceptance still leaves
      // a durable attempt, so create operations can reconcile on restart.
      db.prepare(`UPDATE outbox_writes SET attempts=attempts+1 WHERE id=?`).run(row.id);
      try {
        const connection = await auth.getConnection({ throwOnFailure: true });
        if (connection.status !== "connected") throw new LinearRequestError("not_connected");
        if (connection.workspace?.id !== row.workspace_id) throw new WriteDeliveryBlocked("workspace_changed");
        if (connection.mode !== (row.delivery_mode ?? row.mode)) throw new WriteDeliveryBlocked("auth_mode_changed");
        const operation = operationSchema.parse(JSON.parse(row.operation));
        if (operation.type === "blocks") {
          try {
            const result = await request<{ issueRelationCreate: { success: boolean; issueRelation?: { id: string } } }>(
              "mutation SquadronIssueRelationCreate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success issueRelation { id } } }",
              { input: { id: row.id, issueId: operation.issueId, relatedIssueId: operation.blockedIssueId, type: "blocks" } });
            if (result.issueRelationCreate?.success !== true || result.issueRelationCreate.issueRelation?.id !== row.id) throw new LinearRequestError("invalid_response");
          } catch (writeError) {
            // The singular lookup errors for absent relations. Keep the original
            // write failure/backoff unless the exact UUID and endpoints agree.
            let found: { issueRelation: { id: string; type: string; issue: { id: string }; relatedIssue: { id: string } } };
            try {
              found = z.object({ issueRelation: z.object({ id: z.string(), type: z.string(), issue: z.object({ id: z.string() }), relatedIssue: z.object({ id: z.string() }) }) }).parse(
                await request("query SquadronOutboxRelation($id: String!) { issueRelation(id: $id) { id type issue { id } relatedIssue { id } } }", { id: row.id }));
            } catch { throw writeError; }
            const relation = found.issueRelation;
            if (relation.id !== row.id || relation.type !== "blocks" || relation.issue.id !== operation.issueId || relation.relatedIssue.id !== operation.blockedIssueId) throw new WriteDeliveryBlocked("conflict");
          }
        } else if (operation.type === "issue") {
          const { type: _type, ...input } = operation;
          let reconciled = false;
          if (row.attempts > 0) {
            const found = z.object({ issues: z.object({ nodes: z.array(z.object({ id: z.string(), team: z.object({ id: z.string() }), project: z.object({ id: z.string() }).nullable() })) }) }).parse(
              await request("query SquadronOutboxIssue($id: ID!) { issues(first: 1, includeArchived: true, filter: { id: { eq: $id } }) { nodes { id team { id } project { id } } } }", { id: row.id }));
            const issue = found.issues.nodes[0];
            if (issue && (issue.id !== row.id || issue.team.id !== operation.teamId || issue.project?.id !== operation.projectId)) throw new WriteDeliveryBlocked("conflict");
            reconciled = Boolean(issue);
          }
          if (!reconciled) {
            const result = await request<{ issueCreate: { success: boolean; issue?: { id: string } } }>(
              "mutation SquadronIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id } } }",
              { input: { id: row.id, ...input } });
            if (result.issueCreate?.success !== true || result.issueCreate.issue?.id !== row.id) throw new LinearRequestError("invalid_response");
          }
        } else if (operation.type === "comment") {
          const body = row.mode === "app" ? operation.body : `${operation.author.role} · ${operation.author.model} (via Squadron)\n\n${operation.body}`;
          let reconciled = false;
          if (row.attempts > 0) {
            const found = z.object({ comments: z.object({ nodes: z.array(z.object({ id: z.string(), body: z.string(), issue: z.object({ id: z.string() }) })) }) }).parse(
              await request("query SquadronOutboxComment($id: ID!) { comments(first: 1, includeArchived: true, filter: { id: { eq: $id } }) { nodes { id body issue { id } } } }", { id: row.id }));
            const comment = found.comments.nodes[0];
            if (comment && (comment.id !== row.id || comment.body !== body || comment.issue.id !== operation.issueId)) throw new WriteDeliveryBlocked("conflict");
            reconciled = Boolean(comment);
          }
          if (!reconciled) {
            if ((row.delivery_mode ?? row.mode) === "app" && !operation.author.avatarUrl) throw new WriteDeliveryBlocked("configuration");
            const result = await request<{ commentCreate: { success: boolean; comment?: { id: string } } }>(
              "mutation SquadronCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
              { input: { id: row.id, issueId: operation.issueId,
                body,
                ...((row.delivery_mode ?? row.mode) === "app" ? { createAsUser: `${operation.author.role} · ${operation.author.model}`, displayIconUrl: operation.author.avatarUrl } : {}) } });
            if (result.commentCreate?.success !== true || result.commentCreate.comment?.id !== row.id) throw new LinearRequestError("invalid_response");
          }
        } else {
          const result = await request<{ issueUpdate: { success: boolean } }>(updateQuery,
            { id: operation.issueId, input: operation.type === "status" ? { stateId: operation.stateId } :
              operation.type === "parent" ? { parentId: operation.parentId } : { addedLabelIds: operation.add, removedLabelIds: operation.remove } });
          if (result.issueUpdate?.success !== true) throw new Error("Linear did not confirm the write.");
        }
        db.prepare(`UPDATE outbox_writes SET delivered_at=?, last_error=NULL WHERE id=?`).run(now(), row.id);
        changed(row.bb_project_id);
      } catch (error) {
        const backoff = Math.min(300_000, 1_000 * 2 ** Math.min(row.attempts, 9));
        const delay = Math.max(backoff, error instanceof LinearRequestError ? error.retryAfterMs ?? 0 : 0);
        db.prepare(`UPDATE outbox_writes SET next_attempt_at=?, last_error=? WHERE id=?`)
          .run(now() + delay, error instanceof LinearRequestError ? error.code : "unavailable", row.id);
        const permanent = error instanceof WriteDeliveryBlocked ? error.reason : error instanceof z.ZodError || error instanceof SyntaxError ? "invalid_operation" :
          error instanceof LinearRequestError && ["graphql", "authentication", "configuration", "workspace_changed", "auth_mode_changed"].includes(error.code) ? error.code as OutboxBlockedReason : null;
        if (permanent) { park(permanent); hold("blocked"); }
        else { hold("pending"); changed(row.bb_project_id); }
      }
    }
  }
  function flush(signal: AbortSignal = lifetime.signal) {
    if (!draining) draining = drain(AbortSignal.any([signal, lifetime.signal])).finally(() => { draining = null; });
    return draining;
  }
  async function get(id: string) {
    const row = db.prepare(`SELECT * FROM outbox_writes WHERE id=?`).get(id) as Row | undefined;
    return row ? { id: row.id, status: row.delivered_at !== null ? "delivered" as const : row.blocked_reason ? "blocked" as const : "pending" as const, attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at, lastError: row.last_error } : null;
  }
  async function getHealth(bbProjectId: string): Promise<OutboxHealth> {
    text.parse(bbProjectId);
    const rows = db.prepare(`SELECT * FROM outbox_writes WHERE bb_project_id=? AND delivered_at IS NULL ORDER BY sequence`).all(bbProjectId) as Row[];
    const blocked = rows.filter((row) => row.blocked_reason !== null);
    return { bbProjectId, pendingCount: rows.length - blocked.length, blockedCount: blocked.length, hasMore: blocked.length > 100,
      blocked: blocked.slice(0, 100).map((row) => ({ id: row.id, threadId: row.thread_id, issueIds: z.array(z.string()).parse(JSON.parse(row.resources_json)), reason: row.blocked_reason! })) };
  }
  async function resume(id: string) {
    await draining;
    const row = db.prepare(`SELECT * FROM outbox_writes WHERE id=?`).get(id) as Row | undefined;
    if (!row) throw new Error("This write is not available.");
    const connection = await auth.getConnection({ throwOnFailure: true });
    if (connection.status !== "connected" || connection.workspace?.id !== row.workspace_id) throw new Error("Reconnect to the original workspace before retrying this write.");
    if (row.mode === "app" && connection.mode !== "app") throw new Error("Reconnect with app auth before retrying this write.");
    const operation = operationSchema.parse(JSON.parse(row.operation));
    if (connection.mode === "app" && operation.type === "comment" && !operation.author.avatarUrl) throw new Error("This preserved personal comment has no app avatar. Reconnect with personal auth to retry it.");
    if (row.delivered_at === null) {
      db.prepare(`UPDATE outbox_writes SET blocked_reason=NULL, next_attempt_at=0, last_error=NULL, delivery_mode=? WHERE id=?`).run(connection.mode, id);
      changed(row.bb_project_id);
    }
    return (await get(id))!;
  }
  bb.rpc.register(linearOutboxContract, {
    "linear.outboxHealth": ({ bbProjectId }) => getHealth(bbProjectId),
    "linear.outboxResume": async ({ bbProjectId, id }, context) => {
      if (context.experimental_caller.kind !== "client") throw new Error("Retry this write from the Squadron board.");
      const row = db.prepare(`SELECT bb_project_id FROM outbox_writes WHERE id=?`).get(id) as { bb_project_id: string | null } | undefined;
      if (!row || row.bb_project_id !== bbProjectId) throw new Error("This write is not available in this project.");
      return resume(id);
    },
  });
  async function bindThread(input: LinearWriteGrant) {
    const grant = grantSchema.parse(input);
    const thread = await bb.sdk.threads.get({ threadId: grant.threadId });
    if (!isActiveProjectThread(thread, grant.threadId, grant.bbProjectId)) throw new Error("This thread is not authorized for the project.");
    db.transaction(() => {
      const saved = db.prepare(`SELECT grant_json, scope_id FROM outbox_thread_grants WHERE thread_id=?`).get(grant.threadId) as { grant_json: string; scope_id: string | null } | undefined;
      const previous = saved ? grantSchema.parse(JSON.parse(saved.grant_json)) : null;
      const sameScope = previous && previous.bbProjectId === grant.bbProjectId && previous.workspaceId === grant.workspaceId && previous.teamId === grant.teamId && previous.projectId === grant.projectId;
      const scopeId = sameScope && saved?.scope_id ? saved.scope_id : randomUUID();
      if (sameScope) {
        const owned = db.prepare(`SELECT * FROM outbox_writes WHERE thread_id=? AND (grant_scope_id=? OR (? AND grant_scope_id IS NULL))`).all(grant.threadId, scopeId, saved?.scope_id === null ? 1 : 0) as Row[];
        for (const row of owned) {
          const operation = operationSchema.safeParse(JSON.parse(row.operation));
          if (row.bb_project_id === grant.bbProjectId && row.workspace_id === grant.workspaceId && operation.success && operation.data.type === "issue" && operation.data.teamId === grant.teamId && operation.data.projectId === grant.projectId) {
            grant.issueIds = [...new Set([...grant.issueIds, row.id])];
            db.prepare(`UPDATE outbox_writes SET grant_scope_id=? WHERE id=?`).run(scopeId, row.id);
          }
        }
      }
      db.prepare(`INSERT INTO outbox_thread_grants (thread_id, grant_json, scope_id) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET grant_json=excluded.grant_json, scope_id=excluded.scope_id`)
        .run(grant.threadId, JSON.stringify(grant), scopeId);
    })();
  }
  bb.agents.registerTool({
    name: "squadron_linear_write",
    description: "Queue a signed Linear write within this thread's server-granted planning scope. Reuse a dedupeKey only for the same operation. Returns a durable receipt and an entityId for new issues/comments/block links. No owner approvals or status changes.",
    parameters: agentWriteSchema,
    async execute(input, context) {
      context.signal.throwIfAborted();
      const [thread, execution, connection] = await Promise.all([
        bb.sdk.threads.get({ threadId: context.threadId, signal: context.signal }),
        bb.sdk.threads.defaultExecutionOptions({ threadId: context.threadId, signal: context.signal }),
        auth.getConnection({ throwOnFailure: true }),
      ]);
      context.signal.throwIfAborted();
      let displayName = execution?.model ? modelDisplayName(execution.model) : "";
      if (input.operation.type === "comment" && execution?.model) {
        try {
          const catalog = await bb.sdk.providers.models({ providerId: thread.providerId,
            ...(thread.environmentId ? { environmentId: thread.environmentId } : { projectId: context.projectId }), preferCached: true, signal: context.signal });
          const entry = [...catalog.models, ...catalog.selectedOnlyModels].find((model) => model.model === execution.model);
          if (entry?.displayName && text.safeParse(entry.displayName).success) displayName = entry.displayName;
        } catch { /* A missing catalog still has a readable model-ID fallback. */ }
        context.signal.throwIfAborted();
      }
      return db.transaction(() => {
        const saved = db.prepare(`SELECT grant_json, scope_id FROM outbox_thread_grants WHERE thread_id=?`).get(context.threadId) as { grant_json: string; scope_id: string | null } | undefined;
        const grant = saved ? grantSchema.parse(JSON.parse(saved.grant_json)) : null;
        if (!grant || !isActiveProjectThread(thread, context.threadId, context.projectId) || grant.bbProjectId !== context.projectId ||
          !execution?.model || connection.status !== "connected" ||
          connection.workspace?.id !== grant.workspaceId || !connection.mode) throw new Error("This thread is not authorized for these Linear writes.");
        const operation = input.operation;
        if (connection.mode === "app" && operation.type === "comment" && !grant.avatarUrl) throw new Error("App comments need a public HTTPS avatar. Open a fresh planning thread.");
        const permitsIssue = (id: string) => { if (!grant.issueIds.includes(id)) throw new Error("This issue is not authorized for this thread."); };
        const permitsLabels = (ids: string[]) => { if (ids.some((id) => !grant.labelIds.includes(id))) throw new Error("This label is not authorized for this thread."); };
        let write: Operation;
        if (operation.type === "issue") {
          if (!grant.allowCreateIssues) throw new Error("Issue creation is not authorized for this thread.");
          if (operation.parentId) permitsIssue(operation.parentId);
          permitsLabels(operation.labelIds);
          write = { ...operation, teamId: grant.teamId, projectId: grant.projectId };
        } else if (operation.type === "blocks") {
          permitsIssue(operation.blockedIssueId);
          if (!grant.blockerIssueIds?.includes(operation.issueId)) permitsIssue(operation.issueId);
          write = operation;
        } else {
          permitsIssue(operation.issueId);
          if (operation.type === "parent") permitsIssue(operation.parentId);
          if (operation.type === "labels") permitsLabels([...operation.add, ...operation.remove]);
          write = operation.type === "comment" ? { ...operation, author: { role: grant.role, model: displayName, avatarUrl: grant.avatarUrl } } : operation;
        }
        const receipt = store(`thread:${context.threadId}:${input.dedupeKey}`, write, grant.workspaceId, connection.mode, grant.bbProjectId, context.threadId, saved!.scope_id);
        if (operation.type === "issue" && receipt.entityId && !grant.issueIds.includes(receipt.entityId)) {
          grant.issueIds.push(receipt.entityId);
          db.prepare(`UPDATE outbox_thread_grants SET grant_json=? WHERE thread_id=?`).run(JSON.stringify(grant), context.threadId);
        }
        return JSON.stringify(receipt);
      })();
    },
  });
  bb.agents.registerTool({
    name: "squadron_linear_receipt", description: "Read this thread's Linear write receipt. Pending writes retain their place for automatic retry; delivered means Linear confirmed the write or the original UUID was reconciled. Returns no comment body or credentials.",
    parameters: z.object({ id: z.uuid() }).strict(),
    async execute(input, context) {
      context.signal.throwIfAborted();
      const thread = await bb.sdk.threads.get({ threadId: context.threadId, signal: context.signal });
      context.signal.throwIfAborted();
      const saved = db.prepare(`SELECT grant_json FROM outbox_thread_grants WHERE thread_id=?`).get(context.threadId) as { grant_json: string } | undefined;
      const grant = saved ? grantSchema.parse(JSON.parse(saved.grant_json)) : null;
      const row = db.prepare(`SELECT * FROM outbox_writes WHERE id=?`).get(input.id) as Row | undefined;
      if (!grant || !row || row.thread_id !== context.threadId || row.workspace_id !== grant.workspaceId ||
        !isActiveProjectThread(thread, context.threadId, context.projectId) || grant.bbProjectId !== context.projectId) throw new Error("This receipt is not authorized for this thread.");
      return JSON.stringify(await get(input.id));
    },
  });
  bb.background.service("linear-outbox", { async start(signal) {
    while (!signal.aborted) {
      await flush(signal);
      try { await delay(1_000, undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
  } });
  bb.onDispose(async () => { lifetime.abort(); await draining; });
  function toolsForThread(projectId: string, threadId: string): string[] {
    const saved = db.prepare(`SELECT grant_json FROM outbox_thread_grants WHERE thread_id=?`).get(threadId) as { grant_json: string } | undefined;
    const grant = saved ? grantSchema.safeParse(JSON.parse(saved.grant_json)) : null;
    return grant?.success && grant.data.bbProjectId === projectId ? ["squadron_linear_write", "squadron_linear_receipt"] : [];
  }
  return { enqueue, flush, get, getHealth, resume, bindThread, toolsForThread };
}
