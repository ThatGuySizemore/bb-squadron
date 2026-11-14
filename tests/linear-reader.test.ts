import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerLinearAuth } from "../lib/linear-auth.js";
import { registerLinearReader } from "../lib/linear-reader.js";

const binding = { bbProjectId: "proj-one", teamId: "team-one", projectId: "linear-one" };
const target = { data: {
  team: { id: "team-one", name: "Fixture team", key: "FIX" },
  project: { id: "linear-one", name: "Fixture project", teams: {
    nodes: [{ id: "team-one" }], pageInfo: { hasNextPage: false, endCursor: null },
  } },
} };

test("a binding belongs to one BB project and survives a plugin restart", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const install = (api: typeof bb) => registerLinearReader(api,
    registerLinearAuth(api, { fetch: async () => Response.json(target) }));
  let mirror = install(bb);
  await mirror.bind(binding);
  assert.deepEqual(mirror.getSnapshot("proj-one").binding, {
    bbProjectId: "proj-one", team: { id: "team-one", name: "Fixture team", key: "FIX" },
    project: { id: "linear-one", name: "Fixture project" },
  });
  assert.equal(mirror.getSnapshot("proj-two").binding, null);
  const replacement = await harness.lifecycle.reload((api) => { mirror = install(api); });
  t.after(() => replacement.harness.lifecycle.dispose());
  assert.equal(mirror.getSnapshot("proj-one").binding?.project.id, "linear-one");
  assert.equal(mirror.getSnapshot("proj-two").binding, null);
});

import { issuePageOne, issuePageTwo, vocabularyResponse } from "./fixtures/linear-mirror.js";

test("a complete recorded issue walk exposes labels, states and sub-issues through the snapshot", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const pages = [target, issuePageOne, issuePageTwo];
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.includes("SquadronVocabulary")) return Response.json(vocabularyResponse);
    if (body.query.includes("SquadronIssues")) {
      assert.deepEqual(body.variables.filter, {
        team: { id: { eq: "team-one" } }, project: { id: { eq: "linear-one" } },
        state: { type: { nin: ["completed", "canceled"] } },
      });
      assert.equal(body.variables.after, pages.length === 2 ? null : "issues-page-two");
    }
    assert.ok(pages.length, "unexpected request");
    return Response.json(pages.shift());
  } }));
  await mirror.bind(binding);
  await mirror.sync("proj-one");
  const snapshot = mirror.getSnapshot("proj-one");
  assert.deepEqual(snapshot.issues.map((issue) => ({
    id: issue.id, parentId: issue.parentId, state: issue.state.name, labels: issue.labels.map((item) => item.name), inProject: issue.inProject,
  })), [
    { id: "spec-one", parentId: null, state: "Ready", labels: ["ready-for-agent"], inProject: true },
    { id: "ticket-one", parentId: "spec-one", state: "Ready", labels: [], inProject: true },
  ]);
  assert.ok(snapshot.syncedAt !== null);
  assert.equal(snapshot.error, null);
  assert.equal(pages.length, 0);
});

import { blockedSpec, remainingBlockers, end } from "./fixtures/linear-mirror.js";

test("blocking links keep both directions and paginated external blockers with their states", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("SquadronVocabulary")) return Response.json(vocabularyResponse);
    if (query.includes("SquadronBinding")) return Response.json(target);
    if (query.includes("SquadronIssues")) return Response.json({ data: { issues: { nodes: [blockedSpec], pageInfo: end } } });
    assert.ok(query.includes("SquadronInverseRelations"));
    assert.deepEqual(variables, { id: "spec-one", after: "inverse-two" });
    return Response.json(remainingBlockers);
  } }));
  await mirror.bind(binding);
  const snapshot = await mirror.sync("proj-one");
  assert.deepEqual(snapshot.relations, [
    { id: "blocks-ticket", type: "blocks", issueId: "spec-one", relatedIssueId: "ticket-one" },
    { id: "external-block", type: "blocks", issueId: "outside-one", relatedIssueId: "spec-one" },
    { id: "external-block-two", type: "blocks", issueId: "outside-two", relatedIssueId: "spec-one" },
  ]);
  assert.deepEqual(snapshot.issues.filter((issue) => !issue.inProject).map((issue) => [issue.id, issue.state.type]), [
    ["outside-one", "completed"], ["outside-two", "unstarted"],
  ]);
});

import { specIssue, label, ready, done } from "./fixtures/linear-mirror.js";

test("a label on a later page remains available with the mirrored state vocabulary", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("SquadronVocabulary")) return Response.json(vocabularyResponse);
    if (query.includes("SquadronBinding")) return Response.json(target);
    if (query.includes("SquadronIssues")) return Response.json({ data: { issues: {
      nodes: [{ ...specIssue, labels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "labels-two" } } }], pageInfo: end,
    } } });
    assert.ok(query.includes("SquadronIssueLabels"));
    assert.deepEqual(variables, { id: "spec-one", after: "labels-two" });
    return Response.json({ data: { issue: { labels: { nodes: [label], pageInfo: end } } } });
  } }));
  await mirror.bind(binding);
  const snapshot = await mirror.sync("proj-one");
  assert.deepEqual(snapshot.issues[0].labels, [{ id: "label-ready", name: "ready-for-agent", color: "#00aa00" }]);
  assert.deepEqual(snapshot.labels, [{ id: "label-ready", name: "ready-for-agent", color: "#00aa00" }]);
  assert.deepEqual(snapshot.states, [{ id: "state-ready", name: "Ready", type: "unstarted" }]);
});

test("an incomplete later page retains the last complete snapshot and reports a safe failure", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let failing = false;
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("SquadronVocabulary")) return Response.json(vocabularyResponse);
    if (query.includes("SquadronBinding")) return Response.json(target);
    if (!failing) return Response.json({ data: { issues: { nodes: [specIssue], pageInfo: end } } });
    if (variables.after) return Response.json({ errors: [{ message: "fake-private-provider-detail" }] }, { status: 503 });
    return Response.json({ data: { issues: { nodes: [{ ...specIssue, title: "Partial new title" }],
      pageInfo: { hasNextPage: true, endCursor: "failed-page-two" } } } });
  } }));
  await mirror.bind(binding);
  const good = await mirror.sync("proj-one");
  failing = true;
  await assert.rejects(mirror.sync("proj-one"), { name: "LinearRequestError", code: "graphql" });
  const snapshot = mirror.getSnapshot("proj-one");
  assert.equal(snapshot.issues[0].title, "A fixture spec");
  assert.equal(snapshot.syncedAt, good.syncedAt);
  assert.equal(snapshot.error, "Linear could not complete the request.");
  assert.ok(!JSON.stringify(snapshot).includes("fake-private-provider-detail"));
});

test("the binding catalog follows all team, project and membership pages without exposing auth", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-private-key" } });
  t.after(() => harness.lifecycle.dispose());
  registerLinearReader(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("SquadronVocabulary")) return Response.json(vocabularyResponse);
    assert.ok(query.startsWith("query "), "the catalog is read-only");
    if (query.includes("SquadronTeams")) return Response.json({ data: { teams: variables.after ? {
      nodes: [{ id: "team-other", name: "Other team", key: "OUT" }], pageInfo: end,
    } : { nodes: [target.data.team], pageInfo: { hasNextPage: true, endCursor: "teams-two" } } } });
    if (query.includes("SquadronProjectTeams")) {
      assert.deepEqual(variables, { id: "linear-one", after: "members-two" });
      return Response.json({ data: { project: { teams: { nodes: [{ id: "team-one" }], pageInfo: end } } } });
    }
    assert.ok(query.includes("SquadronProjects"));
    return Response.json({ data: { projects: variables.after ? { nodes: [], pageInfo: end } : {
      nodes: [{ id: "linear-one", name: "Fixture project", teams: {
        nodes: [{ id: "team-other" }], pageInfo: { hasNextPage: true, endCursor: "members-two" },
      } }], pageInfo: { hasNextPage: true, endCursor: "projects-two" },
    } } });
  } }));
  assert.deepEqual(await harness.behavior.callRpc("linear.catalog", null), {
    teams: [{ id: "team-one", name: "Fixture team", key: "FIX" }, { id: "team-other", name: "Other team", key: "OUT" }],
    projects: [{ id: "linear-one", name: "Fixture project", teamIds: ["team-other", "team-one"] }],
  });
});

test("polling reads every 30 seconds and every service start catches up in full", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let now = 1_000_000;
  const delays: number[] = [];
  let hasIssue = true;
  const install = (api: typeof bb) => registerLinearReader(api, registerLinearAuth(api, {
    now: () => now,
    fetch: async (_url, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("SquadronVocabulary")) return Response.json(vocabularyResponse);
      if (query.includes("SquadronBinding")) return Response.json(target);
      assert.equal(variables.after, null, "each catch-up begins at the first page");
      return Response.json({ data: { issues: { nodes: hasIssue ? [specIssue] : [], pageInfo: end } } });
    },
  }), { now: () => now, wait: async (ms, signal) => {
    delays.push(ms); now += ms;
    if (delays.length === 3) hasIssue = false;
    if (delays.length >= 4) stop();
    assert.ok(signal instanceof AbortSignal);
  } });
  let mirror = install(bb);
  await mirror.bind(binding);
  let stop = () => {};
  const run = harness.behavior.runService("linear-reader");
  stop = () => run.controller.abort();
  await run.done;
  assert.deepEqual(delays, [30_000, 30_000, 30_000, 30_000]);
  assert.deepEqual(mirror.getSnapshot("proj-one").issues, []);
  assert.equal(mirror.getSnapshot("proj-one").syncedAt, 1_090_000);
  const replacement = await harness.lifecycle.reload((api) => { mirror = install(api); });
  t.after(() => replacement.harness.lifecycle.dispose());
  hasIssue = true;
  const restarted = replacement.harness.behavior.runService("linear-reader");
  stop = () => restarted.controller.abort();
  await restarted.done;
  assert.equal(mirror.getSnapshot("proj-one").issues[0].identifier, "FIX-1");
  assert.equal(mirror.getSnapshot("proj-one").error, null);
});

test("a slow sync from the previous binding cannot overwrite the owner's new project", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let release!: (response: Response) => void;
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("SquadronVocabulary")) return Response.json(vocabularyResponse);
    if (query.includes("SquadronBinding")) return Response.json({ data: {
      ...target.data, project: { ...target.data.project, id: variables.projectId },
    } });
    if (variables.filter.project.id.eq === "linear-two") return Response.json({ data: { issues: { nodes: [], pageInfo: end } } });
    started();
    return new Promise<Response>((resolve) => { release = resolve; });
  } }));
  await mirror.bind(binding);
  const oldSync = mirror.sync("proj-one");
  await start;
  await mirror.bind({ ...binding, projectId: "linear-two" });
  await mirror.sync("proj-one");
  release(Response.json({ data: { issues: { nodes: [specIssue], pageInfo: end } } }));
  await oldSync;
  assert.equal(mirror.getSnapshot("proj-one").binding?.project.id, "linear-two");
  assert.deepEqual(mirror.getSnapshot("proj-one").issues, []);
});

test("the poller shares auth's rate budget and retries only after its reset", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let now = 1_000_000;
  let requests = 0;
  const delays: number[] = [];
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, {
    now: () => now,
    fetch: async (_url, init) => {
      const { query } = JSON.parse(String(init?.body));
    if (query.includes("SquadronVocabulary")) return Response.json(vocabularyResponse);
      requests++;
      if (query.includes("SquadronBinding")) return Response.json(target, { headers: {
        "x-ratelimit-requests-remaining": "0", "x-ratelimit-requests-reset": "1120000",
      } });
      assert.equal(now, 1_120_000);
      return Response.json({ data: { issues: { nodes: [specIssue], pageInfo: end } } });
    },
  }), { now: () => now, wait: async (ms) => {
    delays.push(ms);
    if (delays.length === 1) {
      assert.equal(requests, 1, "the exhausted budget prevents a network request");
      assert.equal(mirror.getSnapshot("proj-one").error, "Linear's request budget is exhausted. Try again after the reset.");
    } else stop();
    now += ms;
  } });
  await mirror.bind(binding);
  let stop = () => {};
  const run = harness.behavior.runService("linear-reader");
  stop = () => run.controller.abort();
  await run.done;
  assert.deepEqual(delays, [120_000, 30_000]);
  assert.equal(requests, 2);
  assert.equal(mirror.getSnapshot("proj-one").error, null);
});

test("disposing the plugin cancels a mirror request without committing a partial snapshot", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let requestSignal: AbortSignal | undefined;
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const { query } = JSON.parse(String(init?.body));
    if (query.includes("SquadronVocabulary")) return Response.json(vocabularyResponse);
    if (query.includes("SquadronBinding")) return Response.json(target);
    requestSignal = init?.signal as AbortSignal;
    started();
    return new Promise<Response>((_resolve, reject) => {
      requestSignal!.addEventListener("abort", () => reject(new Error("fake-private-cancel-detail")), { once: true });
    });
  } }));
  await mirror.bind(binding);
  const syncing = mirror.sync("proj-one");
  const rejected = assert.rejects(syncing, { name: "LinearRequestError", code: "unavailable" });
  await start;
  await harness.lifecycle.dispose();
  assert.equal(requestSignal?.aborted, true);
  await rejected;
});

test("overlapping reads of one bound project share a single complete walk", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let issueReads = 0;
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const { query } = JSON.parse(String(init?.body));
    if (query.includes("SquadronVocabulary")) return Response.json(vocabularyResponse);
    if (query.includes("SquadronBinding")) return Response.json(target);
    issueReads++; started();
    await gate;
    return Response.json({ data: { issues: { nodes: [specIssue], pageInfo: end } } });
  } }));
  await mirror.bind(binding);
  const first = mirror.sync("proj-one");
  const second = mirror.sync("proj-one");
  await start;
  release();
  const results = await Promise.all([first, second]);
  assert.equal(issueReads, 1);
  assert.deepEqual(results.map((snapshot) => snapshot.issues[0].identifier), ["FIX-1", "FIX-1"]);
});

test("team labels and states on later vocabulary pages survive even when no open issue uses them", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.query.includes("SquadronBinding")) return Response.json(target);
    if (request.query.includes("SquadronIssues")) return Response.json({ data: { issues: { nodes: [], pageInfo: end } } });
    assert.ok(request.query.includes("SquadronVocabulary"));
    assert.equal(request.variables.teamId, "team-one");
    if (request.variables.statesAfter) {
      assert.equal(request.variables.statesAfter, "states-two");
      return Response.json({ data: { workflowStates: { nodes: [{ id: "state-working", name: "In Progress", type: "started" }], pageInfo: end },
        issueLabels: { nodes: [], pageInfo: end } } });
    }
    return Response.json({ data: {
      workflowStates: { nodes: [ready], pageInfo: { hasNextPage: true, endCursor: "states-two" } },
      issueLabels: { nodes: [{ id: "label-ui", name: "ui", color: "#0000aa" }], pageInfo: end },
    } });
  } }));
  await mirror.bind(binding);
  const snapshot = await mirror.sync("proj-one");
  assert.deepEqual(snapshot.labels, [{ id: "label-ui", name: "ui", color: "#0000aa" }]);
  assert.deepEqual(snapshot.states, [
    { id: "state-ready", name: "Ready", type: "unstarted" },
    { id: "state-working", name: "In Progress", type: "started" },
  ]);
});

test("the owner binding RPC syncs immediately and rejects a project outside the selected team", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  registerLinearReader(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.query.includes("SquadronVocabulary")) return Response.json(vocabularyResponse);
    if (request.query.includes("SquadronIssues")) return Response.json({ data: { issues: { nodes: [specIssue], pageInfo: end } } });
    return Response.json({ data: { ...target.data, project: { ...target.data.project,
      id: request.variables.projectId, teams: { nodes: request.variables.projectId === "linear-wrong" ? [] : [{ id: "team-one" }], pageInfo: end },
    } } });
  } }));
  const snapshot = await harness.behavior.callRpc("linear.bind", binding) as { issues: { identifier: string }[] };
  assert.equal(snapshot.issues[0].identifier, "FIX-1");
  await assert.rejects(harness.behavior.callRpc("linear.bind", { ...binding, projectId: "linear-wrong" }),
    /Choose a project in the selected Linear team/);
  const retained = await harness.behavior.callRpc("linear.snapshot", { bbProjectId: "proj-one" }) as { binding: { project: { id: string } }; issues: { identifier: string }[] };
  assert.equal(retained.binding.project.id, "linear-one");
  assert.equal(retained.issues[0].identifier, "FIX-1");
});

import { closedBlockerGraph } from "./fixtures/linear-mirror.js";

test("completed and canceled project blockers retain their status without entering open board rows", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.query.includes("SquadronBinding")) return Response.json(target);
    if (request.query.includes("SquadronVocabulary")) return Response.json(vocabularyResponse);
    assert.ok(request.query.includes("SquadronIssues"));
    return Response.json(closedBlockerGraph);
  } }));
  await mirror.bind(binding);
  const snapshot = await mirror.sync("proj-one");
  assert.deepEqual(snapshot.issues.filter((issue) => issue.inProject).map((issue) => issue.id), ["spec-one", "ticket-one"]);
  assert.deepEqual(snapshot.issues.filter((issue) => !issue.inProject).map((issue) => [issue.id, issue.state.type]), [
    ["same-done", "completed"], ["same-canceled", "canceled"],
    ["outside-one", "completed"], ["outside-two", "unstarted"],
  ]);
  assert.deepEqual(snapshot.relations, [
    { id: "blocks-ticket", type: "blocks", issueId: "spec-one", relatedIssueId: "ticket-one" },
    { id: "same-done-block", type: "blocks", issueId: "same-done", relatedIssueId: "spec-one" },
    { id: "same-canceled-block", type: "blocks", issueId: "same-canceled", relatedIssueId: "spec-one" },
    { id: "external-done-block", type: "blocks", issueId: "outside-one", relatedIssueId: "spec-one" },
    { id: "external-open-block", type: "blocks", issueId: "outside-two", relatedIssueId: "spec-one" },
  ]);
});
