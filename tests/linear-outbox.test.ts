import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerLinearAuth } from "../lib/linear-auth.js";
import { registerLinearOutbox } from "../lib/linear-outbox.js";
import { personalIdentity, appIdentity } from "./fixtures/linear.js";

test("a Helper command cannot queue into a different workspace after its lane was planned", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const auth = registerLinearAuth(bb, { fetch: async () => Response.json(personalIdentity) });
  const outbox = registerLinearOutbox(bb, auth);
  await assert.rejects(outbox.enqueue({ bbProjectId: "bb-project-1", expectedWorkspaceId: "old-workspace",
    dedupeKey: "lane-status", operation: { type: "status", issueId: "issue-1", stateId: "state-2" } }), /workspace changed/);
  assert.equal((await outbox.getHealth("bb-project-1")).pendingCount, 0);
});

test("the outbox sends an exact status payload once for a repeated key", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const writes: unknown[] = [];
  const auth = registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    writes.push(body);
    return Response.json({ data: { issueUpdate: { success: true, issue: { id: "issue-1" } } } });
  } });
  const outbox = registerLinearOutbox(bb, auth);
  const write = { bbProjectId: "bb-project-1", dedupeKey: "status-1", operation: { type: "status" as const, issueId: "issue-1", stateId: "state-2" } };
  const queued = await outbox.enqueue(write);
  assert.deepEqual(await outbox.enqueue(write), queued);
  await outbox.flush();
  await outbox.enqueue(write);
  await outbox.flush();
  assert.deepEqual(writes, [{
    query: "mutation SquadronIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }",
    variables: { id: "issue-1", input: { stateId: "state-2" } },
  }]);
  assert.equal((await outbox.get(queued.id))?.status, "delivered");
});

test("the scoped writer preserves a budget exhausted by its identity check", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let identities = 0;
  let writes = 0;
  const auth = registerLinearAuth(bb, { now: () => 0, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) {
      identities++;
      return Response.json(personalIdentity, identities === 3 ? { headers: { "x-ratelimit-requests-remaining": "0", "x-ratelimit-requests-reset": "6000" } } : {});
    }
    writes++;
    return Response.json({ data: { issueUpdate: { success: true, issue: { id: "issue-1" } } } });
  } });
  const outbox = registerLinearOutbox(bb, auth, { now: () => 0 });
  const receipt = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "identity-budget", operation: { type: "status", issueId: "issue-1", stateId: "state-2" } });
  await outbox.flush();
  assert.equal(writes, 0);
  assert.equal((await outbox.get(receipt.id))?.lastError, "rate_limited");
  assert.equal((await outbox.get(receipt.id))?.nextAttemptAt, 6_000);
});

test("an ambiguous blocking-link creation reconciles its native relation UUID", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const requests: unknown[] = [];
  const auth = registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    requests.push(body);
    if (body.query.startsWith("mutation")) throw new Error("accepted but connection closed");
    return Response.json({ data: { issueRelation: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "blocks", issue: { id: "ticket-1" }, relatedIssue: { id: "ticket-2" } } } });
  } });
  const outbox = registerLinearOutbox(bb, auth, { uuid: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  const receipt = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "ambiguous-blocks", operation: { type: "blocks", issueId: "ticket-1", blockedIssueId: "ticket-2" } });
  await outbox.flush();
  assert.equal((await outbox.get(receipt.id))?.status, "delivered");
  assert.deepEqual(requests, [{
    query: "mutation SquadronIssueRelationCreate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success issueRelation { id } } }",
    variables: { input: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", issueId: "ticket-1", relatedIssueId: "ticket-2", type: "blocks" } },
  }, {
    query: "query SquadronOutboxRelation($id: String!) { issueRelation(id: $id) { id type issue { id } relatedIssue { id } } }",
    variables: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  }]);
});

test("an unconfirmed comment stays pending and a missing reconciliation result reuses the original UUID", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let now = 0;
  let writes = 0;
  const ids: string[] = [];
  const auth = registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    if (body.query.startsWith("query")) return Response.json({ data: { comments: { nodes: [] } } });
    ids.push(body.variables.input.id);
    return Response.json({ data: { commentCreate: { success: true, comment: { id: writes++ === 0 ? "unrelated-comment" : body.variables.input.id } } } });
  } });
  const outbox = registerLinearOutbox(bb, auth, { now: () => now, uuid: () => "99999999-9999-4999-8999-999999999999" });
  const receipt = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "confirm", operation: { type: "comment", issueId: "issue-1", body: "A comment", author: { role: "Worker", model: "model-1", avatarUrl: "https://example.test/avatar.png" } } });
  await outbox.flush();
  assert.equal((await outbox.get(receipt.id))?.status, "pending");
  now = 1_000;
  await outbox.flush();
  assert.equal((await outbox.get(receipt.id))?.status, "delivered");
  assert.deepEqual(ids, ["99999999-9999-4999-8999-999999999999", "99999999-9999-4999-8999-999999999999"]);
});

test("a new issue with a lost response reconciles the same UUID before dependent writes", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let now = 0;
  const requests: any[] = [];
  const auth = registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    requests.push(body);
    if (body.query.startsWith("query")) return Response.json({ data: { issues: { nodes: [{
      id: "88888888-8888-4888-8888-888888888888", team: { id: "team-1" }, project: { id: "project-1" },
    }] } } });
    throw new Error("accepted but response lost");
  } });
  const outbox = registerLinearOutbox(bb, auth, { now: () => now, uuid: () => "88888888-8888-4888-8888-888888888888" });
  const queued = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "issue-lost", operation: { type: "issue", teamId: "team-1", projectId: "project-1", title: "A ticket", description: "Scope", labelIds: [] } });
  await outbox.flush();
  now = 1_000;
  await outbox.flush();
  assert.equal((await outbox.get(queued.id))?.status, "delivered");
  assert.deepEqual(requests[1], {
    query: "query SquadronOutboxIssue($id: ID!) { issues(first: 1, includeArchived: true, filter: { id: { eq: $id } }) { nodes { id team { id } project { id } } } }",
    variables: { id: "88888888-8888-4888-8888-888888888888" },
  });
  assert.equal(requests.length, 2);
});

test("a credential change during identity lookup cannot send a queued mutation to a different workspace", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-original-key" } });
  t.after(() => harness.lifecycle.dispose());
  let switchDuringLookup = false;
  let sent = false;
  const auth = registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) {
      if (switchDuringLookup) {
        switchDuringLookup = false;
        await harness.behavior.setSettings({ linearApiKey: "fake-replacement-key" });
      }
      return Response.json(personalIdentity);
    }
    sent = true;
    return Response.json({ data: { issueUpdate: { success: true, issue: { id: "issue-1" } } } });
  } });
  const outbox = registerLinearOutbox(bb, auth);
  const receipt = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "connection-race", operation: { type: "status", issueId: "issue-1", stateId: "state-2" } });
  switchDuringLookup = true;
  await outbox.flush();
  assert.equal(sent, false);
  assert.equal((await outbox.get(receipt.id))?.status, "pending");
});

test("the background service drains queued writes on startup and stops when aborted", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let notify!: () => void;
  const sent = new Promise<void>((resolve) => { notify = resolve; });
  const auth = registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    notify();
    return Response.json({ data: { issueUpdate: { success: true, issue: { id: "issue-1" } } } });
  } });
  const outbox = registerLinearOutbox(bb, auth);
  const receipt = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "startup", operation: { type: "status", issueId: "issue-1", stateId: "state-2" } });
  const service = harness.behavior.runService("linear-outbox");
  t.after(() => service.controller.abort());
  await sent;
  await outbox.flush();
  service.controller.abort();
  await service.done;
  assert.equal((await outbox.get(receipt.id))?.status, "delivered");
});

test("retries back off exponentially and never drain a queued write into another workspace", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let now = 0;
  let otherWorkspace = false;
  let attempts = 0;
  const auth = registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(otherWorkspace ? {
      data: { viewer: { id: "other-person", name: "Other" }, organization: { id: "other-workspace", name: "Other" } },
    } : personalIdentity);
    attempts++;
    throw new Error("fake-sensitive-detail");
  } });
  const outbox = registerLinearOutbox(bb, auth, { now: () => now });
  const queued = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "backoff", operation: { type: "status", issueId: "issue-1", stateId: "state-2" } });
  await outbox.flush();
  assert.equal((await outbox.get(queued.id))?.nextAttemptAt, 1_000);
  now = 1_000;
  await outbox.flush();
  assert.equal((await outbox.get(queued.id))?.nextAttemptAt, 3_000);
  now = 3_000;
  otherWorkspace = true;
  await outbox.flush();
  assert.equal(attempts, 2);
  assert.equal((await outbox.get(queued.id))?.status, "blocked");
  assert.equal((await outbox.get(queued.id))?.lastError, "workspace_changed");
});

test("an accepted comment with a lost response reconciles by its original UUID after reload", async (t) => {
  let { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let now = 0;
  const requests: unknown[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    requests.push(body);
    if (body.query.startsWith("mutation")) throw new Error("ambiguous network failure with fake-sensitive-error");
    return Response.json({ data: { comments: { nodes: [{ id: "66666666-6666-4666-8666-666666666666", body: "Worker · model-1 (via Squadron)\n\nChecks passed.", issue: { id: "issue-1" } }] } } });
  };
  let outbox = registerLinearOutbox(bb, registerLinearAuth(bb, { fetch: fetcher }), { now: () => now, uuid: () => "66666666-6666-4666-8666-666666666666" });
  const queued = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "lost-comment", operation: { type: "comment", issueId: "issue-1", body: "Checks passed.", author: { role: "Worker", model: "model-1", avatarUrl: "https://example.test/avatar.png" } } });
  await outbox.flush();
  assert.equal((await outbox.get(queued.id))?.lastError, "unavailable");
  ({ bb, harness } = await harness.lifecycle.reload((next) => {
    outbox = registerLinearOutbox(next, registerLinearAuth(next, { fetch: fetcher }), { now: () => now });
  }));
  now = 1_000;
  await outbox.flush();
  assert.equal((await outbox.get(queued.id))?.status, "delivered");
  assert.deepEqual(requests, [{
    query: "mutation SquadronCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
    variables: { input: { id: "66666666-6666-4666-8666-666666666666", issueId: "issue-1", body: "Worker · model-1 (via Squadron)\n\nChecks passed." } },
  }, {
    query: "query SquadronOutboxComment($id: ID!) { comments(first: 1, includeArchived: true, filter: { id: { eq: $id } }) { nodes { id body issue { id } } } }",
    variables: { id: "66666666-6666-4666-8666-666666666666" },
  }]);
});

test("a rate-limited head survives reload, honors retry-after and keeps later writes ordered", async (t) => {
  let { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let now = 1_000;
  let fail = true;
  const sent: unknown[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    sent.push(body.variables);
    if (fail) { fail = false; return Response.json({ errors: [] }, { status: 429, headers: { "retry-after": "5" } }); }
    return Response.json({ data: { issueUpdate: { success: true, issue: { id: "issue-1" } } } });
  };
  let auth = registerLinearAuth(bb, { fetch: fetcher, now: () => now });
  let outbox = registerLinearOutbox(bb, auth, { now: () => now });
  const first = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "first", operation: { type: "status", issueId: "issue-1", stateId: "state-2" } });
  const second = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "second", operation: { type: "labels", issueId: "issue-1", add: ["new-label"], remove: [] } });
  await outbox.flush();
  assert.deepEqual(await outbox.get(first.id), { id: first.id, status: "pending", attempts: 1, nextAttemptAt: 6_000, lastError: "rate_limited" });
  ({ bb, harness } = await harness.lifecycle.reload((next) => {
    auth = registerLinearAuth(next, { fetch: fetcher, now: () => now });
    outbox = registerLinearOutbox(next, auth, { now: () => now });
  }));
  now = 5_999;
  await outbox.flush();
  assert.equal(sent.length, 1);
  now = 6_000;
  await Promise.all([outbox.flush(), outbox.flush()]);
  assert.equal((await outbox.get(second.id))?.status, "delivered");
  assert.deepEqual(sent, [
    { id: "issue-1", input: { stateId: "state-2" } },
    { id: "issue-1", input: { stateId: "state-2" } },
    { id: "issue-1", input: { addedLabelIds: ["new-label"], removedLabelIds: [] } },
  ]);
});

test("blocking links and parent links use Linear's native relations", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const writes: unknown[] = [];
  const auth = registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    writes.push(body);
    return Response.json({ data: { issueRelationCreate: { success: true, issueRelation: { id: "44444444-4444-4444-8444-444444444444" } }, issueUpdate: { success: true, issue: { id: "ticket-2" } } } });
  } });
  let id = 0;
  const outbox = registerLinearOutbox(bb, auth, { uuid: () => id++ === 0 ? "44444444-4444-4444-8444-444444444444" : "55555555-5555-4555-8555-555555555555" });
  await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "blocks-1", operation: { type: "blocks", issueId: "ticket-1", blockedIssueId: "ticket-2" } });
  await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "parent-1", operation: { type: "parent", issueId: "ticket-2", parentId: "spec-1" } });
  await outbox.flush();
  assert.deepEqual(writes, [{
    query: "mutation SquadronIssueRelationCreate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success issueRelation { id } } }",
    variables: { input: { id: "44444444-4444-4444-8444-444444444444", issueId: "ticket-1", relatedIssueId: "ticket-2", type: "blocks" } },
  }, {
    query: "mutation SquadronIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }",
    variables: { id: "ticket-2", input: { parentId: "spec-1" } },
  }]);
});

test("new issues preserve parent, project and route labels and return their durable UUID", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const writes: unknown[] = [];
  const auth = registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    writes.push(body);
    return Response.json({ data: { issueCreate: { success: true, issue: { id: "33333333-3333-4333-8333-333333333333" } } } });
  } });
  const outbox = registerLinearOutbox(bb, auth, { uuid: () => "33333333-3333-4333-8333-333333333333" });
  const queued = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "ticket-1", operation: {
    type: "issue", teamId: "team-1", projectId: "project-1", title: "Build the adapter", description: "A visible ticket.",
    parentId: "spec-1", labelIds: ["route-gpt", "ready-label"],
  } });
  assert.equal(queued.entityId, "33333333-3333-4333-8333-333333333333");
  await outbox.flush();
  assert.deepEqual(writes, [{
    query: "mutation SquadronIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id } } }",
    variables: { input: { id: "33333333-3333-4333-8333-333333333333", teamId: "team-1", projectId: "project-1", title: "Build the adapter", description: "A visible ticket.", parentId: "spec-1", labelIds: ["route-gpt", "ready-label"] } },
  }]);
});

test("personal-key comments use a visible role/model label without app-only fields", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const writes: unknown[] = [];
  const auth = registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    writes.push(body);
    return Response.json({ data: { commentCreate: { success: true, comment: { id: "22222222-2222-4222-8222-222222222222" } } } });
  } });
  const outbox = registerLinearOutbox(bb, auth, { uuid: () => "22222222-2222-4222-8222-222222222222" });
  await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "personal-comment", operation: {
    type: "comment", issueId: "issue-1", body: "Ready for review.",
    author: { role: "Worker", model: "GPT-6.1 Sol", avatarUrl: "https://example.test/worker.png" },
  } });
  await outbox.flush();
  assert.deepEqual(writes, [{
    query: "mutation SquadronCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
    variables: { input: { id: "22222222-2222-4222-8222-222222222222", issueId: "issue-1", body: "Worker · GPT-6.1 Sol (via Squadron)\n\nReady for review." } },
  }]);
});

test("app comments carry the agent name and avatar with a persisted caller UUID", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: {
    linearCredentials: JSON.stringify({ accessToken: "fake-app-token", refreshToken: "fake-refresh", expiresAt: 9_999_999_999_999 }),
  } });
  t.after(() => harness.lifecycle.dispose());
  const writes: unknown[] = [];
  const auth = registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(appIdentity);
    writes.push(body);
    return Response.json({ data: { commentCreate: { success: true, comment: { id: "11111111-1111-4111-8111-111111111111" } } } });
  } });
  const outbox = registerLinearOutbox(bb, auth, { uuid: () => "11111111-1111-4111-8111-111111111111" });
  const queued = await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "comment-1", operation: {
    type: "comment", issueId: "issue-1", body: "The focused checks passed.",
    author: { role: "Worker", model: "GPT-6.1 Sol", avatarUrl: "https://example.test/worker.png" },
  } });
  assert.equal(queued.entityId, "11111111-1111-4111-8111-111111111111");
  await outbox.flush();
  assert.deepEqual(writes, [{
    query: "mutation SquadronCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
    variables: { input: { id: "11111111-1111-4111-8111-111111111111", issueId: "issue-1", body: "The focused checks passed.",
      createAsUser: "Worker · GPT-6.1 Sol", displayIconUrl: "https://example.test/worker.png" } },
  }]);
});

test("label changes use atomic add/remove payloads and reject a conflicting dedupe key", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const writes: unknown[] = [];
  const auth = registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query SquadronIdentity")) return Response.json(personalIdentity);
    writes.push(body);
    return Response.json({ data: { issueUpdate: { success: true, issue: { id: "issue-1" } } } });
  } });
  const outbox = registerLinearOutbox(bb, auth);
  await outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "labels-1", operation: { type: "labels", issueId: "issue-1", add: ["label-route"], remove: ["label-old"] } });
  await assert.rejects(outbox.enqueue({ bbProjectId: "bb-project-1", dedupeKey: "labels-1", operation: { type: "labels", issueId: "issue-1", add: ["label-other"], remove: [] } }), /already belongs/);
  await outbox.flush();
  assert.deepEqual(writes, [{
    query: "mutation SquadronIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }",
    variables: { id: "issue-1", input: { addedLabelIds: ["label-route"], removedLabelIds: ["label-old"] } },
  }]);
});
