import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerLinearAuth } from "../lib/linear-auth.js";
import { registerLinearOutbox } from "../lib/linear-outbox.js";
import { personalIdentity } from "./fixtures/linear.js";

test("an invalid first write parks its dependent work while an independent issue progresses", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const writes: unknown[] = [];
  const outbox = registerLinearOutbox(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    writes.push(body.variables);
    if (body.variables.id === "issue-invalid") return Response.json({ errors: [{ message: "fake-private-validation-detail" }] });
    return Response.json({ data: { issueUpdate: { success: true, issue: { id: body.variables.id } } } });
  } }));
  const first = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "invalid", operation: { type: "status", issueId: "issue-invalid", stateId: "invalid-state" } });
  const dependent = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "dependent", operation: { type: "labels", issueId: "issue-invalid", add: ["route-1"], remove: [] } });
  const independent = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "independent", operation: { type: "status", issueId: "issue-other", stateId: "state-2" } });
  await outbox.flush();
  assert.equal((await outbox.get(first.id))?.status, "blocked");
  assert.equal((await outbox.get(first.id))?.lastError, "graphql");
  assert.equal((await outbox.get(dependent.id))?.status, "blocked");
  assert.equal((await outbox.get(dependent.id))?.lastError, "dependency_blocked");
  assert.equal((await outbox.get(independent.id))?.status, "delivered");
  assert.deepEqual(writes, [
    { id: "issue-invalid", input: { stateId: "invalid-state" } },
    { id: "issue-other", input: { stateId: "state-2" } },
  ]);
  const health = { bbProjectId: "bb-project-1", pendingCount: 0, blockedCount: 2, blocked: [
    { id: first.id, threadId: null, issueIds: ["issue-invalid"], reason: "graphql" },
    { id: dependent.id, threadId: null, issueIds: ["issue-invalid"], reason: "dependency_blocked" },
  ], hasMore: false };
  assert.deepEqual(await outbox.getHealth("bb-project-1"), health);
  assert.deepEqual(await harness.behavior.callRpc("linear.outboxHealth", { bbProjectId: "bb-project-1" }), health);
  assert.deepEqual(await outbox.getHealth("bb-project-other"), { bbProjectId: "bb-project-other", pendingCount: 0, blockedCount: 0, blocked: [], hasMore: false });
});

test("retrying a repaired issue creation releases its label and blocking-link dependencies in order", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let repaired = false;
  const mutations: string[] = [];
  let index = 0;
  const outbox = registerLinearOutbox(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    if (body.query.includes("OutboxIssue")) return Response.json({ data: { issues: { nodes: [] } } });
    mutations.push(body.query.includes("IssueCreate") ? "create" : body.query.includes("IssueRelationCreate") ? "blocks" : body.variables.id);
    if (!repaired && body.query.includes("IssueCreate")) return Response.json({ errors: [{ message: "invalid upstream configuration" }] });
    const id = body.variables.input?.id ?? body.variables.id;
    return Response.json({ data: { issueCreate: { success: true, issue: { id } }, issueUpdate: { success: true, issue: { id } }, issueRelationCreate: { success: true, issueRelation: { id } } } });
  } }), { uuid: () => ["11111111-aaaa-4111-8111-111111111111", "22222222-aaaa-4222-8222-222222222222", "33333333-aaaa-4333-8333-333333333333", "44444444-aaaa-4444-8444-444444444444"][index++] });
  const created = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "create", operation: { type: "issue", teamId: "team-1", projectId: "project-1", title: "The ticket", description: "Original payload", labelIds: [] } });
  const labels = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "labels", operation: { type: "labels", issueId: created.entityId!, add: ["route-1"], remove: [] } });
  const blocks = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "blocks", operation: { type: "blocks", issueId: "seed-1", blockedIssueId: created.entityId! } });
  await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "independent", operation: { type: "status", issueId: "issue-other", stateId: "state-2" } });
  await outbox.flush();
  assert.deepEqual(mutations, ["create", "issue-other"]);
  assert.equal((await outbox.get(labels.id))?.lastError, "dependency_blocked");
  assert.equal((await outbox.get(blocks.id))?.lastError, "dependency_blocked");
  repaired = true;
  await outbox.resume(created.id);
  await outbox.flush();
  assert.deepEqual(mutations, ["create", "issue-other", "create", "11111111-aaaa-4111-8111-111111111111", "blocks"]);
  assert.equal((await outbox.get(labels.id))?.status, "delivered");
  assert.equal((await outbox.get(blocks.id))?.status, "delivered");
  assert.equal((await outbox.getHealth("bb-project-1")).blockedCount, 0);
});

test("a conflicting upstream comment stays parked through retry and reload while unrelated work completes", async (t) => {
  let { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let now = 0;
  let commentCreates = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    if (body.query.startsWith("query")) return Response.json({ data: { comments: { nodes: [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", body: "Edited upstream body", issue: { id: "issue-original" } }] } } });
    if (body.query.includes("CommentCreate")) { commentCreates++; throw new Error("lost response"); }
    return Response.json({ data: { issueUpdate: { success: true, issue: { id: body.variables.id } } } });
  };
  let outbox = registerLinearOutbox(bb, registerLinearAuth(bb, { fetch: fetcher }), { now: () => now, uuid: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
  const original = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "conflict", operation: { type: "comment", issueId: "issue-original", body: "Original body", author: { role: "Worker", model: "GPT-6.1 Sol", avatarUrl: "https://example.test/worker.png" } } });
  await outbox.flush();
  now = 1_000;
  await outbox.flush();
  assert.equal((await outbox.get(original.id))?.status, "blocked");
  assert.equal((await outbox.get(original.id))?.lastError, "conflict");
  ({ bb, harness } = await harness.lifecycle.reload((next) => { outbox = registerLinearOutbox(next, registerLinearAuth(next, { fetch: fetcher }), { now: () => now }); }));
  const independent = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "independent", operation: { type: "status", issueId: "issue-other", stateId: "state-2" } });
  await assert.rejects(harness.behavior.callRpc("linear.outboxResume", { bbProjectId: "bb-project-1", id: original.id, force: true }));
  await assert.rejects(harness.behavior.callRpc("linear.outboxResume", { bbProjectId: "bb-project-1", id: original.id }, { experimental_caller: { kind: "plugin", pluginId: "other-plugin" } }));
  await harness.behavior.callRpc("linear.outboxResume", { bbProjectId: "bb-project-1", id: original.id });
  await outbox.flush();
  assert.equal((await outbox.get(original.id))?.status, "blocked");
  assert.equal((await outbox.get(original.id))?.lastError, "conflict");
  assert.equal((await outbox.get(independent.id))?.status, "delivered");
  assert.equal(commentCreates, 1);
});

test("a personal-to-app upgrade requires explicit recovery and preserves the original UUID and signed body", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-personal-key" } });
  t.after(() => harness.lifecycle.dispose());
  const writes: any[] = [];
  let nextId = 0;
  const outbox = registerLinearOutbox(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    if (body.query.startsWith("query")) return Response.json({ data: { comments: { nodes: [] } } });
    writes.push(body.variables);
    return Response.json({ data: { commentCreate: { success: true, comment: { id: body.variables.input.id } } } });
  } }), { uuid: () => nextId++ === 0 ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
  const author = { role: "Worker" as const, model: "GPT-6.1 Sol", avatarUrl: "https://example.test/worker.png" };
  const original = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "personal", operation: { type: "comment", issueId: "issue-original", body: "Original report.", author } });
  await harness.behavior.setSettings({ linearApiKey: null, linearCredentials: JSON.stringify({ accessToken: "fake-app-token", refreshToken: "fake-refresh", expiresAt: 9_999_999_999_999 }) });
  const independent = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "app", operation: { type: "comment", issueId: "issue-other", body: "App report.", author } });
  await outbox.flush();
  assert.equal((await outbox.get(original.id))?.status, "blocked");
  assert.equal((await outbox.get(original.id))?.lastError, "auth_mode_changed");
  assert.equal((await outbox.get(independent.id))?.status, "delivered");
  assert.equal(writes.length, 1);
  await harness.behavior.callRpc("linear.outboxResume", { bbProjectId: "bb-project-1", id: original.id });
  await outbox.flush();
  assert.deepEqual(writes, [
    { input: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", issueId: "issue-other", body: "App report.", createAsUser: "Worker · GPT-6.1 Sol", displayIconUrl: "https://example.test/worker.png" } },
    { input: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", issueId: "issue-original", body: "Worker · GPT-6.1 Sol (via Squadron)\n\nOriginal report.", createAsUser: "Worker · GPT-6.1 Sol", displayIconUrl: "https://example.test/worker.png" } },
  ]);
  assert.equal((await outbox.get(original.id))?.status, "delivered");
});

test("foreign-workspace writes park visibly and resume only in their original workspace", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let workspace = "workspace-1";
  const writes: unknown[] = [];
  const outbox = registerLinearOutbox(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json({ data: { viewer: { id: "person-1", name: "Fixture" }, organization: { id: workspace, name: "Fixture" } } });
    writes.push(body.variables);
    return Response.json({ data: { issueUpdate: { success: true, issue: { id: body.variables.id } } } });
  } }));
  const first = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "original", operation: { type: "status", issueId: "same-id", stateId: "state-old" } });
  workspace = "workspace-2";
  const other = await outbox.enqueue({ bbProjectId: "bb-project-2", dedupeKey: "other", operation: { type: "status", issueId: "same-id", stateId: "state-new" } });
  await outbox.flush();
  assert.equal((await outbox.get(first.id))?.status, "blocked");
  assert.equal((await outbox.get(first.id))?.lastError, "workspace_changed");
  assert.equal((await outbox.get(other.id))?.status, "delivered");
  await assert.rejects(outbox.resume(first.id), /workspace/);
  await assert.rejects(harness.behavior.callRpc("linear.outboxResume", { bbProjectId: "bb-project-2", id: first.id }));
  workspace = "workspace-1";
  await harness.behavior.callRpc("linear.outboxResume", { bbProjectId: "bb-project-1", id: first.id });
  await outbox.flush();
  assert.equal((await outbox.get(first.id))?.status, "delivered");
  assert.deepEqual(writes, [
    { id: "same-id", input: { stateId: "state-new" } },
    { id: "same-id", input: { stateId: "state-old" } },
  ]);
});
