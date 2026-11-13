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
  assert.deepEqual(writes, [{ input: { id: "77777777-7777-4777-8777-777777777777", issueId: "seed-1", body: "Planning thread · Actual Model (via Squadron)\n\nThe spec is drafted." } }]);
});

test("blocked agent receipts and project health expose safe reasons and references", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" }, sdk: { threads: {
    get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "bb-project-1" }),
    defaultExecutionOptions: async () => ({ model: "gpt-6.1-sol", permissionMode: "auto", reasoningLevel: "high", serviceTier: "default", source: "client/turn/start" }),
  } } });
  t.after(() => harness.lifecycle.dispose());
  const outbox = registerLinearOutbox(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    return Response.json({ detail: "fake-private-error-detail" }, { status: 403 });
  } }));
  await outbox.bindThread({ threadId: "planner-thread", bbProjectId: "bb-project-1", workspaceId: "workspace-1", teamId: "team-1", projectId: "project-1", role: "Planning thread", avatarUrl: "https://example.test/planner.png", issueIds: ["seed-1"], labelIds: [], allowCreateIssues: false });
  const context = { threadId: "planner-thread", projectId: "bb-project-1" };
  const queued = JSON.parse(String(await harness.behavior.callAgentTool("squadron_linear_write", { dedupeKey: "blocked", operation: { type: "comment", issueId: "seed-1", body: "fake-private-body" } }, context)));
  await outbox.flush();
  assert.equal(JSON.parse(String(await harness.behavior.callAgentTool("squadron_linear_receipt", { id: queued.id }, context))).status, "blocked");
  assert.deepEqual(await outbox.getHealth("bb-project-1"), { bbProjectId: "bb-project-1", pendingCount: 0, blockedCount: 1,
    blocked: [{ id: queued.id, threadId: "planner-thread", issueIds: ["seed-1"], reason: "authentication" }], hasMore: false });
});

test("a custom model's provider display name is used instead of its identifier", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" }, sdk: {
    threads: {
      get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "bb-project-1", providerId: "custom-provider" }),
      defaultExecutionOptions: async () => ({ model: "custom-model-id", permissionMode: "auto", reasoningLevel: "high", serviceTier: "default", source: "client/turn/start" }),
    },
    providers: { models: async () => ({ modelLoadError: null, models: [{ id: "catalog-id", model: "custom-model-id", displayName: "Fixture Model", defaultReasoningEffort: "high", description: "Fixture", isDefault: true, reasoningDiscovery: "known", supportedReasoningEfforts: [] }], permissionCeiling: "auto", providers: [], selectedOnlyModels: [] }) },
  } });
  t.after(() => harness.lifecycle.dispose());
  const outbox = registerLinearOutbox(bb, registerLinearAuth(bb, { fetch: async () => Response.json(personalIdentity) }));
  await outbox.bindThread({ threadId: "planner-thread", bbProjectId: "bb-project-1", workspaceId: "workspace-1", teamId: "team-1", projectId: "project-1", role: "Planning thread", avatarUrl: "https://example.test/planner.png", issueIds: ["seed-1"], labelIds: [], allowCreateIssues: false });
  const receipt = JSON.parse(String(await harness.behavior.callAgentTool("squadron_linear_write", { dedupeKey: "model", operation: { type: "comment", issueId: "seed-1", body: "The report." } }, { threadId: "planner-thread", projectId: "bb-project-1" })));
  assert.equal(receipt.signature, "Planning thread · Fixture Model");
});

test("new comments use readable model names and an identical key keeps its original signature after a model change", async (t) => {
  let model = "claude-opus-5-5";
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" }, sdk: { threads: {
    get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "bb-project-1" }),
    defaultExecutionOptions: async () => ({ model, permissionMode: "auto", reasoningLevel: "high", serviceTier: "default", source: "client/turn/start" }),
  } } });
  t.after(() => harness.lifecycle.dispose());
  const bodies: string[] = [];
  const outbox = registerLinearOutbox(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    bodies.push(body.variables.input.body);
    return Response.json({ data: { commentCreate: { success: true, comment: { id: body.variables.input.id } } } });
  } }));
  await outbox.bindThread({ threadId: "planner-thread", bbProjectId: "bb-project-1", workspaceId: "workspace-1", teamId: "team-1", projectId: "project-1", role: "Planning thread", avatarUrl: "https://example.test/planner.png", issueIds: ["seed-1"], labelIds: [], allowCreateIssues: false });
  const context = { threadId: "planner-thread", projectId: "bb-project-1" };
  const input = { dedupeKey: "report", operation: { type: "comment", issueId: "seed-1", body: "The approved plan." } };
  const original = JSON.parse(String(await harness.behavior.callAgentTool("squadron_linear_write", input, context)));
  assert.equal(original.signature, "Planning thread · Opus 5.5");
  model = "gpt-6.1-sol";
  assert.deepEqual(JSON.parse(String(await harness.behavior.callAgentTool("squadron_linear_write", input, context))), original);
  await assert.rejects(harness.behavior.callAgentTool("squadron_linear_write", { ...input, operation: { ...input.operation, body: "Changed logical content." } }, context), /already belongs/);
  await harness.behavior.callAgentTool("squadron_linear_write", { ...input, dedupeKey: "second-report", operation: { ...input.operation, body: "The new report." } }, context);
  await outbox.flush();
  assert.deepEqual(bodies, ["Planning thread · Opus 5.5 (via Squadron)\n\nThe approved plan.", "Planning thread · GPT-6.1 Sol (via Squadron)\n\nThe new report."]);
});

test("same-scope rebind retains only created issue ownership and a scope change drops it", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" }, sdk: { threads: {
    get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "bb-project-1" }),
    defaultExecutionOptions: async () => ({ model: "actual-model", permissionMode: "auto", reasoningLevel: "high", serviceTier: "default", source: "client/turn/start" }),
  } } });
  t.after(() => harness.lifecycle.dispose());
  const outbox = registerLinearOutbox(bb, registerLinearAuth(bb, { fetch: async () => Response.json(personalIdentity) }));
  const grant = { threadId: "planner-thread", bbProjectId: "bb-project-1", workspaceId: "workspace-1", teamId: "team-1", projectId: "project-1", role: "Planning thread" as const, avatarUrl: "https://example.test/planner.png", issueIds: ["seed-1"], labelIds: ["route-1", "ready-1"], allowCreateIssues: true };
  const context = { threadId: "planner-thread", projectId: "bb-project-1" };
  const call = (dedupeKey: string, operation: unknown) => harness.behavior.callAgentTool("squadron_linear_write", { dedupeKey, operation }, context);
  await outbox.bindThread(grant);
  const created = JSON.parse(String(await call("create", { type: "issue", title: "The ticket", description: "Scope", labelIds: ["ready-1"] })));
  await outbox.bindThread({ ...grant, issueIds: [], labelIds: ["route-1"], allowCreateIssues: false });
  await call("label-created", { type: "labels", issueId: created.entityId, add: ["route-1"], remove: [] });
  await assert.rejects(call("old-seed", { type: "comment", issueId: "seed-1", body: "No retained seed" }), /not authorized/);
  await assert.rejects(call("old-label", { type: "labels", issueId: created.entityId, add: ["ready-1"], remove: [] }), /not authorized/);
  await assert.rejects(call("new-issue", { type: "issue", title: "Not allowed", description: "Scope", labelIds: [] }), /not authorized/);
  await outbox.bindThread({ ...grant, projectId: "project-2", issueIds: [] });
  await assert.rejects(call("old-project", { type: "comment", issueId: created.entityId, body: "No carried grant" }), /not authorized/);
  await outbox.bindThread({ ...grant, issueIds: [] });
  await outbox.bindThread({ ...grant, issueIds: [] });
  await assert.rejects(call("old-tenure", { type: "comment", issueId: created.entityId, body: "No restored old ownership" }), /not authorized/);
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
  const helper = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "helper-receipt", operation: { type: "status", issueId: "seed-1", stateId: "state-1" } });
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
  const blocks = JSON.parse(String(await call("blocks", { type: "blocks", issueId: "seed-1", blockedIssueId: ticket.entityId })));
  await call("labels", { type: "labels", issueId: ticket.entityId, add: ["route-1"], remove: ["ready-1"] });
  await assert.rejects(call("external-blocker", { type: "blocks", issueId: "external", blockedIssueId: ticket.entityId }), /not authorized/);
  await outbox.flush();
  assert.equal(writes.length, 5);
  assert.deepEqual(writes[0], { input: { id: spec.entityId, teamId: "team-1", projectId: "project-1", title: "The spec", description: "Approved scope.", labelIds: ["ready-1"] } });
  assert.equal(writes[1].input.parentId, spec.entityId);
  assert.deepEqual(writes[3], { input: { id: blocks.entityId, issueId: "seed-1", relatedIssueId: ticket.entityId, type: "blocks" } });
  assert.deepEqual(writes[4], { id: ticket.entityId, input: { addedLabelIds: ["route-1"], removedLabelIds: ["ready-1"] } });
  assert.equal((await outbox.get(ticket.id))?.status, "delivered");
});

test("a granted blocker reference may only block issues the thread owns, as a literal native blocks relation", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" }, sdk: { threads: {
    get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "bb-project-1" }),
    defaultExecutionOptions: async () => ({ model: "actual-model", permissionMode: "auto", reasoningLevel: "high", serviceTier: "default", source: "client/turn/start" }),
  } } });
  t.after(() => harness.lifecycle.dispose());
  const sent: Array<{ query: string; variables: unknown }> = [];
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  const outbox = registerLinearOutbox(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    sent.push({ query: body.query.split("(")[0], variables: body.variables });
    const id = body.variables.input.id;
    return Response.json({ data: body.query.includes("issueCreate") ? { issueCreate: { success: true, issue: { id } } }
      : { issueRelationCreate: { success: true, issueRelation: { id } } } });
  } }), { uuid: () => ids.shift()! });
  await outbox.bindThread({ threadId: "planner-thread", bbProjectId: "bb-project-1", workspaceId: "workspace-1", teamId: "team-1", projectId: "project-1",
    role: "Planning thread", avatarUrl: "https://example.test/planner.png", issueIds: ["seed-1"], labelIds: ["ready-1"], allowCreateIssues: true,
    blockerIssueIds: ["existing-1"] });
  const context = { threadId: "planner-thread", projectId: "bb-project-1" };
  const call = async (dedupeKey: string, operation: unknown) =>
    JSON.parse(String(await harness.behavior.callAgentTool("squadron_linear_write", { dedupeKey, operation }, context))) as { id: string; entityId?: string };

  const ticket = await call("ticket", { type: "issue", title: "A ticket", description: "", labelIds: ["ready-1"] });
  await call("existing-blocks-ticket", { type: "blocks", issueId: "existing-1", blockedIssueId: ticket.entityId });
  await call("existing-blocks-seed", { type: "blocks", issueId: "existing-1", blockedIssueId: "seed-1" });
  for (const [key, operation] of [
    ["ticket-blocks-existing", { type: "blocks", issueId: ticket.entityId, blockedIssueId: "existing-1" }],
    ["unknown-blocks-ticket", { type: "blocks", issueId: "unknown-1", blockedIssueId: ticket.entityId }],
    ["existing-blocks-existing", { type: "blocks", issueId: "existing-1", blockedIssueId: "existing-1" }],
    ["comment-existing", { type: "comment", issueId: "existing-1", body: "Not owned." }],
    ["label-existing", { type: "labels", issueId: "existing-1", add: ["ready-1"], remove: [] }],
    ["parent-existing", { type: "parent", issueId: "existing-1", parentId: ticket.entityId }],
    ["parent-under-existing", { type: "parent", issueId: ticket.entityId!, parentId: "existing-1" }],
    ["issue-under-existing", { type: "issue", title: "Child", description: "", parentId: "existing-1", labelIds: [] }],
  ] as const) await assert.rejects(call(key, operation), /not authorized/, key);
  await outbox.flush();
  assert.deepEqual(sent.filter((write) => write.query.includes("Relation")), [
    { query: "mutation SquadronIssueRelationCreate", variables: { input: { id: "22222222-2222-4222-8222-222222222222", issueId: "existing-1", relatedIssueId: "11111111-1111-4111-8111-111111111111", type: "blocks" } } },
    { query: "mutation SquadronIssueRelationCreate", variables: { input: { id: "33333333-3333-4333-8333-333333333333", issueId: "existing-1", relatedIssueId: "seed-1", type: "blocks" } } },
  ]);
});
