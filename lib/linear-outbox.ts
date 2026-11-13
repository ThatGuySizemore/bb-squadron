// Persistence and dedupe mechanics adapted from bb-plugin-chief (MIT).
// See THIRD_PARTY_NOTICES.md. Linear delivery semantics are implemented here.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { LinearRequestError, type LinearAuth } from "./linear-auth.js";

const text = z.string().min(1).max(256);
const authorSchema = z.object({
  role: z.enum(["Lead", "Worker", "Reviewer", "Planning thread"]), model: text,
  avatarUrl: z.url().refine((url) => new URL(url).protocol === "https:"),
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
}).strict();
export type LinearWriteGrant = z.infer<typeof grantSchema>;
type Operation = z.infer<typeof operationSchema>;
type Row = {
  id: string; dedupe_key: string; workspace_id: string; mode: "app" | "personal";
  operation: string; delivered_at: number | null; attempts: number;
  next_attempt_at: number; last_error: string | null;
  thread_id: string | null;
};
const updateQuery = "mutation SquadronIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }";
class ConnectionChanged extends Error {}

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
  let draining: Promise<void> | null = null;
  function store(dedupeKey: string, operation: Operation, workspaceId: string, mode: "app" | "personal", threadId: string | null = null) {
    db.prepare(`INSERT OR IGNORE INTO outbox_writes (id, dedupe_key, workspace_id, mode, operation, thread_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(uuid(), dedupeKey, workspaceId, mode, JSON.stringify(operation), threadId);
    const row = db.prepare(`SELECT * FROM outbox_writes WHERE workspace_id=? AND dedupe_key=?`).get(workspaceId, dedupeKey) as Row;
    if (row.operation !== JSON.stringify(operation) || row.thread_id !== threadId) throw new Error("This write key already belongs to another operation.");
    return { id: row.id, ...(["comment", "issue", "blocks"].includes(operation.type) ? { entityId: row.id } : {}) };
  }
  async function enqueue(input: { dedupeKey: string; operation: Operation }) {
    const dedupeKey = text.parse(input.dedupeKey);
    const operation = operationSchema.parse(input.operation);
    const connection = await auth.getConnection();
    if (connection.status !== "connected" || !connection.workspace || !connection.mode) throw new Error("Connect Linear before queuing a write.");
    return store(dedupeKey, operation, connection.workspace.id, connection.mode);
  }
  async function drain(signal: AbortSignal) {
    for (;;) {
      if (signal.aborted) return;
      const row = db.prepare(`SELECT * FROM outbox_writes WHERE delivered_at IS NULL ORDER BY sequence LIMIT 1`).get() as Row | undefined;
      if (!row || row.next_attempt_at > now()) return;
      const request = <T>(query: string, variables: Record<string, unknown>) => auth.graphql<T>(query, variables, signal,
        { workspaceId: row.workspace_id, mode: row.mode });
      // Charge before the request. A crash after remote acceptance still leaves
      // a durable attempt, so create operations can reconcile on restart.
      db.prepare(`UPDATE outbox_writes SET attempts=attempts+1 WHERE id=?`).run(row.id);
      try {
        const connection = await auth.getConnection();
        if (connection.status !== "connected" || connection.workspace?.id !== row.workspace_id || connection.mode !== row.mode) throw new ConnectionChanged();
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
            if (relation.id !== row.id || relation.type !== "blocks" || relation.issue.id !== operation.issueId || relation.relatedIssue.id !== operation.blockedIssueId) throw writeError;
          }
        } else if (operation.type === "issue") {
          const { type: _type, ...input } = operation;
          let reconciled = false;
          if (row.attempts > 0) {
            const found = z.object({ issues: z.object({ nodes: z.array(z.object({ id: z.string(), team: z.object({ id: z.string() }), project: z.object({ id: z.string() }).nullable() })) }) }).parse(
              await request("query SquadronOutboxIssue($id: ID!) { issues(first: 1, includeArchived: true, filter: { id: { eq: $id } }) { nodes { id team { id } project { id } } } }", { id: row.id }));
            const issue = found.issues.nodes[0];
            if (issue && (issue.id !== row.id || issue.team.id !== operation.teamId || issue.project?.id !== operation.projectId)) throw new Error("The existing issue differs from the queued write.");
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
            if (comment && (comment.id !== row.id || comment.body !== body || comment.issue.id !== operation.issueId)) throw new Error("The existing comment differs from the queued write.");
            reconciled = Boolean(comment);
          }
          if (!reconciled) {
            const result = await request<{ commentCreate: { success: boolean; comment?: { id: string } } }>(
              "mutation SquadronCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
              { input: { id: row.id, issueId: operation.issueId,
                body,
                ...(row.mode === "app" ? { createAsUser: `${operation.author.role} · ${operation.author.model}`, displayIconUrl: operation.author.avatarUrl } : {}) } });
            if (result.commentCreate?.success !== true || result.commentCreate.comment?.id !== row.id) throw new LinearRequestError("invalid_response");
          }
        } else {
          const result = await request<{ issueUpdate: { success: boolean } }>(updateQuery,
            { id: operation.issueId, input: operation.type === "status" ? { stateId: operation.stateId } :
              operation.type === "parent" ? { parentId: operation.parentId } : { addedLabelIds: operation.add, removedLabelIds: operation.remove } });
          if (result.issueUpdate?.success !== true) throw new Error("Linear did not confirm the write.");
        }
        db.prepare(`UPDATE outbox_writes SET delivered_at=?, last_error=NULL WHERE id=?`).run(now(), row.id);
      } catch (error) {
        const backoff = Math.min(300_000, 1_000 * 2 ** Math.min(row.attempts, 9));
        const delay = Math.max(backoff, error instanceof LinearRequestError ? error.retryAfterMs ?? 0 : 0);
        db.prepare(`UPDATE outbox_writes SET next_attempt_at=?, last_error=? WHERE id=?`)
          .run(now() + delay, error instanceof LinearRequestError ? error.code : error instanceof ConnectionChanged ? "connection_changed" : "unavailable", row.id);
        return;
      }
    }
  }
  function flush(signal: AbortSignal = lifetime.signal) {
    if (!draining) draining = drain(AbortSignal.any([signal, lifetime.signal])).finally(() => { draining = null; });
    return draining;
  }
  async function get(id: string) {
    const row = db.prepare(`SELECT * FROM outbox_writes WHERE id=?`).get(id) as Row | undefined;
    return row ? { id: row.id, status: row.delivered_at === null ? "pending" as const : "delivered" as const, attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at, lastError: row.last_error } : null;
  }
  async function bindThread(input: LinearWriteGrant) {
    const grant = grantSchema.parse(input);
    const thread = await bb.sdk.threads.get({ threadId: grant.threadId });
    if (thread.id !== grant.threadId || thread.projectId !== grant.bbProjectId || thread.deletedAt !== null || thread.archivedAt !== null) throw new Error("This thread is not authorized for the project.");
    db.prepare(`INSERT INTO outbox_thread_grants (thread_id, grant_json) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET grant_json=excluded.grant_json`)
      .run(grant.threadId, JSON.stringify(grant));
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
        auth.getConnection(),
      ]);
      context.signal.throwIfAborted();
      return db.transaction(() => {
        const saved = db.prepare(`SELECT grant_json FROM outbox_thread_grants WHERE thread_id=?`).get(context.threadId) as { grant_json: string } | undefined;
        const grant = saved ? grantSchema.parse(JSON.parse(saved.grant_json)) : null;
        if (!grant || thread.id !== context.threadId || thread.projectId !== context.projectId || grant.bbProjectId !== context.projectId ||
          thread.deletedAt !== null || thread.archivedAt !== null || !execution?.model || connection.status !== "connected" ||
          connection.workspace?.id !== grant.workspaceId || !connection.mode) throw new Error("This thread is not authorized for these Linear writes.");
        const operation = input.operation;
        const permitsIssue = (id: string) => { if (!grant.issueIds.includes(id)) throw new Error("This issue is not authorized for this thread."); };
        const permitsLabels = (ids: string[]) => { if (ids.some((id) => !grant.labelIds.includes(id))) throw new Error("This label is not authorized for this thread."); };
        let write: Operation;
        if (operation.type === "issue") {
          if (!grant.allowCreateIssues) throw new Error("Issue creation is not authorized for this thread.");
          if (operation.parentId) permitsIssue(operation.parentId);
          permitsLabels(operation.labelIds);
          write = { ...operation, teamId: grant.teamId, projectId: grant.projectId };
        } else {
          permitsIssue(operation.issueId);
          if (operation.type === "parent") permitsIssue(operation.parentId);
          if (operation.type === "blocks") permitsIssue(operation.blockedIssueId);
          if (operation.type === "labels") permitsLabels([...operation.add, ...operation.remove]);
          write = operation.type === "comment" ? { ...operation, author: { role: grant.role, model: execution.model, avatarUrl: grant.avatarUrl } } : operation;
        }
        const receipt = store(`thread:${context.threadId}:${input.dedupeKey}`, write, grant.workspaceId, connection.mode, context.threadId);
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
        thread.id !== context.threadId || thread.projectId !== context.projectId || grant.bbProjectId !== context.projectId ||
        thread.deletedAt !== null || thread.archivedAt !== null) throw new Error("This receipt is not authorized for this thread.");
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
  return { enqueue, flush, get, bindThread };
}
