import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { registerLinearAuth } from "../lib/linear-auth.js";
import { registerLinearOutbox } from "../lib/linear-outbox.js";
import { personalIdentity } from "./fixtures/linear.js";

test("only a server-granted thread can write, and its signature comes from the actual thread", async (t) => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "squadron", settings: { linearApiKey: "fake-key" },
    sdk: { threads: {
      get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "bb-project-1" }),
      defaultExecutionOptions: async () => ({ model: "actual-model", permissionMode: "auto", reasoningLevel: "high", serviceTier: "default", source: "client/turn/start" }),
    } },
  });
  t.after(() => harness.lifecycle.dispose());
  const writes: unknown[] = [];
  const auth = registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    writes.push(body.variables);
    return Response.json({ data: { commentCreate: { success: true, comment: { id: "77777777-7777-4777-8777-777777777777" } } } });
  } });
  const outbox = registerLinearOutbox(bb, auth, { uuid: () => "77777777-7777-4777-8777-777777777777" });
  const context = { threadId: "planner-thread", projectId: "bb-project-1", signal: new AbortController().signal };
  const input = { dedupeKey: "report-1", operation: { type: "comment", issueId: "seed-1", body: "The spec is drafted." } };
  await assert.rejects(harness.behavior.callAgentTool("squadron_linear_write", input, context), /not authorized/);
  await outbox.bindThread({ threadId: "planner-thread", bbProjectId: "bb-project-1", workspaceId: "workspace-1", teamId: "team-1", projectId: "project-1", role: "Planning thread", avatarUrl: "https://example.test/planner.png", issueIds: ["seed-1"], labelIds: ["route-1", "ready-1"], allowCreateIssues: true });
  await assert.rejects(harness.behavior.callAgentTool("squadron_linear_write", { ...input, ownerApproved: true }, context));
  await assert.rejects(harness.behavior.callAgentTool("squadron_linear_write", { ...input, operation: { ...input.operation, author: { role: "Owner", model: "fake" } } }, context));
  await assert.rejects(harness.behavior.callAgentTool("squadron_linear_write", { ...input, operation: { type: "status", issueId: "seed-1", stateId: "done" } }, context));
  await assert.rejects(harness.behavior.callAgentTool("squadron_linear_write", { ...input, operation: { ...input.operation, issueId: "unrelated" } }, context), /not authorized/);
  await harness.behavior.callAgentTool("squadron_linear_write", input, context);
  await outbox.flush();
  assert.deepEqual(writes, [{ input: { id: "77777777-7777-4777-8777-777777777777", issueId: "seed-1", body: "Planning thread · actual-model (via Squadron)\n\nThe spec is drafted." } }]);
});

test("an agent can inspect only its own safe receipts after a plugin reload", async (t) => {
  let { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" }, sdk: { threads: {
    get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "bb-project-1" }),
    defaultExecutionOptions: async () => ({ model: "actual-model", permissionMode: "auto", reasoningLevel: "high", serviceTier: "default", source: "client/turn/start" }),
  } } });
  t.after(() => harness.lifecycle.dispose());
  const fetcher: typeof fetch = async () => Response.json(personalIdentity);
  let outbox = registerLinearOutbox(bb, registerLinearAuth(bb, { fetch: fetcher }));
  await outbox.bindThread({ threadId: "planner-thread", bbProjectId: "bb-project-1", workspaceId: "workspace-1", teamId: "team-1", projectId: "project-1", role: "Planning thread", avatarUrl: "https://example.test/planner.png", issueIds: ["seed-1"], labelIds: [], allowCreateIssues: true });
  const context = { threadId: "planner-thread", projectId: "bb-project-1" };
  const input = { dedupeKey: "receipt", operation: { type: "issue", title: "A ticket", description: "Private fixture body", labelIds: [] } };
  const queued = JSON.parse(String(await harness.behavior.callAgentTool("squadron_linear_write", input, context)));
  const helper = await outbox.enqueue({ dedupeKey: "helper-receipt", operation: { type: "status", issueId: "seed-1", stateId: "state-1" } });
  ({ bb, harness } = await harness.lifecycle.reload((next) => { outbox = registerLinearOutbox(next, registerLinearAuth(next, { fetch: fetcher })); }));
  assert.deepEqual(JSON.parse(String(await harness.behavior.callAgentTool("squadron_linear_write", input, context))), queued);
  const receipt = await harness.behavior.callAgentTool("squadron_linear_receipt", { id: queued.id }, context);
  assert.deepEqual(JSON.parse(String(receipt)), { id: queued.id, status: "pending", attempts: 0, nextAttemptAt: 0, lastError: null });
  await assert.rejects(harness.behavior.callAgentTool("squadron_linear_receipt", { id: helper.id }, context), /not authorized/);
  await assert.rejects(harness.behavior.callAgentTool("squadron_linear_receipt", { id: queued.id }, { ...context, threadId: "other-thread" }), /not authorized/);
  await assert.rejects(harness.behavior.callAgentTool("squadron_linear_receipt", { id: queued.id, threadId: "planner-thread" }, context));
});

test("planning writes stay in the granted project and can link only seed and newly created issues", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" }, sdk: { threads: {
    get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "bb-project-1" }),
    defaultExecutionOptions: async () => ({ model: "actual-model", permissionMode: "auto", reasoningLevel: "high", serviceTier: "default", source: "client/turn/start" }),
  } } });
  t.after(() => harness.lifecycle.dispose());
  const writes: any[] = [];
  const auth = registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    writes.push(body.variables);
    const id = body.variables.input?.id ?? body.variables.id;
    return Response.json({ data: { issueCreate: { success: true, issue: { id } }, issueUpdate: { success: true, issue: { id } }, issueRelationCreate: { success: true, issueRelation: { id } } } });
  } });
  const outbox = registerLinearOutbox(bb, auth);
  await outbox.bindThread({ threadId: "planner-thread", bbProjectId: "bb-project-1", workspaceId: "workspace-1", teamId: "team-1", projectId: "project-1", role: "Planning thread", avatarUrl: "https://example.test/planner.png", issueIds: ["seed-1"], labelIds: ["route-1", "ready-1"], allowCreateIssues: true });
  const context = { threadId: "planner-thread", projectId: "bb-project-1" };
  const call = (dedupeKey: string, operation: unknown) => harness.behavior.callAgentTool("squadron_linear_write", { dedupeKey, operation }, context);
  const create = { type: "issue", title: "The spec", description: "Approved scope.", labelIds: ["ready-1"] };
  await assert.rejects(call("bad-project", { ...create, projectId: "other-project" }));
  await assert.rejects(call("bad-label", { ...create, labelIds: ["owner-approved"] }), /not authorized/);
  const spec = JSON.parse(String(await call("spec", create)));
  assert.deepEqual(JSON.parse(String(await call("spec", create))), spec);
  const ticket = JSON.parse(String(await call("ticket", { ...create, title: "The ticket", parentId: spec.entityId })));
  await call("parent", { type: "parent", issueId: "seed-1", parentId: spec.entityId });
  await call("blocks", { type: "blocks", issueId: "seed-1", blockedIssueId: ticket.entityId });
  await call("labels", { type: "labels", issueId: ticket.entityId, add: ["route-1"], remove: ["ready-1"] });
  await assert.rejects(call("external-blocker", { type: "blocks", issueId: "external", blockedIssueId: ticket.entityId }), /not authorized/);
  await outbox.flush();
  assert.equal(writes.length, 5);
  assert.deepEqual(writes[0], { input: { id: spec.entityId, teamId: "team-1", projectId: "project-1", title: "The spec", description: "Approved scope.", labelIds: ["ready-1"] } });
  assert.equal(writes[1].input.parentId, spec.entityId);
  assert.equal((await outbox.get(ticket.id))?.status, "delivered");
});
