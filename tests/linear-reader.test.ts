import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerLinearAuth } from "../lib/linear-auth.js";
import { registerLinearReader, type ScopeSource } from "../lib/linear-reader.js";
import { SCOPE_MISSING, type LinearScope } from "../lib/squadron-settings.js";
import { remember, scopeMembers, scopeResponse } from "./fixtures/board-workspace.js";
import {
  blockedSpec, closedBlockerGraph, end, issuePageOne, issuePageTwo, label, ready, remainingBlockers, specIssue, vocabularyResponse,
} from "./fixtures/linear-mirror.js";

type Request = { operation: string; query: string; variables: Record<string, any> };
type Handler = (request: Request) => Response | undefined | Promise<Response | undefined>;

/** Recorded Linear answers: the handler first, then the fixture Scope, membership and vocabulary. */
function linear(handler: Handler = () => undefined) {
  const requests: Request[] = [];
  const seen = new Map<string, { team?: { id: string }; project?: { id: string } | null }>();
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const { query, variables = {} } = JSON.parse(String(init?.body));
    assert.ok(query.trimStart().startsWith("query "), "the reader never writes to Linear");
    const request = { operation: /^\s*query\s+(\w+)/.exec(query)?.[1] ?? "unknown", query, variables };
    requests.push(request);
    const answer = await handler(request);
    if (answer) return remember(seen, answer);
    switch (request.operation) {
      case "SquadronScope": return Response.json(scopeResponse);
      case "SquadronScopeMembers": return scopeMembers(seen, variables);
      case "SquadronVocabulary": return Response.json(vocabularyResponse);
      default: throw new Error(`Unexpected Linear query ${request.operation}`);
    }
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const fixtureScope: LinearScope = { team: "FIX", project: "Fixture project" };
const scoped = (scope: LinearScope = fixtureScope) => async (): Promise<ScopeSource> => ({ ok: true, scope });
const issuesOf = (nodes: unknown[]) => Response.json({ data: { issues: { nodes, pageInfo: end } } });

test("each BB project reads its own Scope, and a missing Scope reads nothing from Linear", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const api = linear(({ operation }) => operation === "SquadronIssues" ? issuesOf([specIssue]) : undefined);
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: api.fetch }), {
    scope: async (id) => id === "proj-one" ? { ok: true, scope: fixtureScope } : { ok: false, message: SCOPE_MISSING },
  });
  const one = await mirror.sync("proj-one");
  assert.deepEqual(one.scope, { name: "Fixture team · Fixture project" });
  assert.equal(one.issues[0].identifier, "FIX-1");
  const before = api.requests.length;
  const two = await mirror.sync("proj-two");
  assert.deepEqual([two.scope, two.issues, two.error], [null, [], SCOPE_MISSING]);
  assert.equal(api.requests.length, before, "no Scope, no Linear request");
  assert.equal(mirror.scopeProblem("proj-two"), SCOPE_MISSING);
  assert.equal(mirror.scopeProblem("proj-one"), null);
  const viaRpc = await harness.behavior.callRpc("linear.snapshot", { bbProjectId: "proj-one" }) as { scope: { name: string } };
  assert.deepEqual(viaRpc.scope, { name: "Fixture team · Fixture project" });
});

test("a complete recorded issue walk exposes labels, states and sub-issues through the snapshot", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const pages = [issuePageOne, issuePageTwo];
  const api = linear(({ operation, variables }) => {
    if (operation === "SquadronScope") {
      assert.equal(variables.withTeam && variables.withProject && !variables.withInitiative && !variables.withLabel && !variables.withView, true);
      return undefined;
    }
    if (operation !== "SquadronIssues") return undefined;
    assert.deepEqual(variables.filter, {
      team: { id: { eq: "team-one" } }, project: { id: { eq: "linear-one" } },
      state: { type: { nin: ["completed", "canceled"] } },
    });
    assert.equal(variables.after, pages.length === 2 ? null : "issues-page-two");
    return Response.json(pages.shift());
  });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: api.fetch }), { scope: scoped() });
  const snapshot = await mirror.sync("proj-one");
  assert.deepEqual(snapshot.issues.map((issue) => ({
    id: issue.id, parentId: issue.parentId, state: issue.state.name, labels: issue.labels.map((item) => item.name), inProject: issue.inProject,
  })), [
    { id: "spec-one", parentId: null, state: "Ready", labels: ["ready-for-agent"], inProject: true },
    { id: "ticket-one", parentId: "spec-one", state: "Ready", labels: [], inProject: true },
  ]);
  assert.ok(snapshot.syncedAt !== null);
  assert.equal(snapshot.error, null);
  assert.equal(pages.length, 0);
  assert.ok(!api.requests.some((request) => request.operation === "SquadronScopeMembers"), "open issues in the walk need no membership check");
});

test("every Scope key narrows the issue filter, and a View walks the view's own issues", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let scope: LinearScope = { initiative: "WordWell", label: "area/reader" };
  const api = linear(({ operation, variables }) => {
    if (operation === "SquadronScope") return Response.json({ data: {
      initiatives: variables.withInitiative ? { nodes: [{ id: "init-one", name: "WordWell" }] } : undefined,
      issueLabels: variables.withLabel ? { nodes: [{ id: "label-reader", name: "reader" }] } : undefined,
      customViews: variables.withView ? { nodes: [{ id: "view-one", name: "Agent work" }] } : undefined,
    } });
    if (operation === "SquadronIssues") return issuesOf([specIssue]);
    if (operation === "SquadronViewIssues") return Response.json({ data: { customView: { issues: { nodes: [specIssue], pageInfo: end } } } });
    if (operation === "SquadronViews") return Response.json({ data: { customViews: variables.after
      ? { nodes: [{ id: "view-one", name: "Agent work", slugId: "0123456789ab" }], pageInfo: end }
      : { nodes: [{ id: "view-other", name: "Other", slugId: "ffffffffffff" }], pageInfo: { hasNextPage: true, endCursor: "views-two" } } } });
    return undefined;
  });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: api.fetch }), { scope: async () => ({ ok: true, scope }) });
  assert.deepEqual((await mirror.sync("proj-one")).scope, { name: "WordWell · reader" });
  assert.deepEqual(api.requests.find((request) => request.operation === "SquadronIssues")?.variables.filter, {
    project: { initiatives: { some: { id: { eq: "init-one" } } } }, labels: { some: { id: { eq: "label-reader" } } },
    state: { type: { nin: ["completed", "canceled"] } },
  });
  scope = { view: "https://linear.app/fixture/view/agent-work-0123456789ab" };
  const viewed = await mirror.sync("proj-one");
  assert.deepEqual([viewed.scope, viewed.issues.map((issue) => [issue.identifier, issue.inProject])], [{ name: "Agent work" }, [["FIX-1", true]]]);
  assert.equal(api.requests.filter((request) => request.operation === "SquadronScope").at(-1)?.variables.withView, false,
    "CustomViewFilter has no slugId, so a view URL is not a filter");
  assert.deepEqual(api.requests.filter((request) => request.operation === "SquadronViews").map((request) => request.variables.after),
    [null, "views-two"], "the views walk pages until the slug matches");
  assert.deepEqual(api.requests.find((request) => request.operation === "SquadronViewIssues")?.variables, {
    view: "view-one", filter: { state: { type: { nin: ["completed", "canceled"] } } }, after: null,
  });
});

test("a view URL whose slug no view has is a Scope error naming View", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const api = linear(({ operation }) => operation === "SquadronScope" ? Response.json({ data: {} })
    : operation === "SquadronViews" ? Response.json({ data: { customViews: { nodes: [{ id: "v", name: "Other", slugId: "ffffffffffff" }], pageInfo: end } } })
    : undefined);
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: api.fetch }),
    { scope: scoped({ view: "https://linear.app/fixture/view/gone-0123456789ab" }) });
  const snapshot = await mirror.sync("proj-one");
  assert.deepEqual([snapshot.scope, snapshot.error], [null,
    "Scope View \"https://linear.app/fixture/view/gone-0123456789ab\" matches no Linear view. Fix it in docs/agents/squadron.md."]);
  assert.ok(!api.requests.some((request) => request.operation === "SquadronIssues" || request.operation === "SquadronViewIssues"));
});

test("a Scope value that matches nothing or more than one record names its key and reads no issues", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let projects = [{ id: "linear-one", name: "Fixture project" }];
  const api = linear(({ operation }) => {
    if (operation === "SquadronScope") return Response.json({ data: { projects: { nodes: projects } } });
    if (operation === "SquadronIssues") return issuesOf([specIssue]);
    return undefined;
  });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: api.fetch }), {
    scope: scoped({ project: "Fixture project" }), now: (() => { let at = 0; return () => (at += 10 * 60_000); })(),
  });
  assert.equal((await mirror.sync("proj-one")).issues.length, 1);
  projects = [];
  const missing = await mirror.sync("proj-one");
  assert.deepEqual([missing.scope, missing.issues, missing.error],
    [null, [], "Scope Project \"Fixture project\" matches no Linear project. Fix it in docs/agents/squadron.md."]);
  projects = [{ id: "a", name: "Fixture project" }, { id: "b", name: "Fixture project" }];
  assert.equal((await mirror.sync("proj-one")).error,
    "Scope Project \"Fixture project\" matches more than one Linear project. Use its URL or id in docs/agents/squadron.md.");
  assert.equal(mirror.scopeProblem("proj-one"), "Scope Project \"Fixture project\" matches more than one Linear project. Use its URL or id in docs/agents/squadron.md.");
});

test("blocking links keep both directions and paginated external blockers with their states", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const api = linear(({ operation, variables }) => {
    if (operation === "SquadronIssues") return issuesOf([blockedSpec]);
    if (operation !== "SquadronInverseRelations") return undefined;
    assert.deepEqual(variables, { id: "spec-one", after: "inverse-two" });
    return Response.json(remainingBlockers);
  });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: api.fetch }), { scope: scoped() });
  const snapshot = await mirror.sync("proj-one");
  assert.deepEqual(snapshot.relations, [
    { id: "blocks-ticket", type: "blocks", issueId: "spec-one", relatedIssueId: "ticket-one" },
    { id: "external-block", type: "blocks", issueId: "outside-one", relatedIssueId: "spec-one" },
    { id: "external-block-two", type: "blocks", issueId: "outside-two", relatedIssueId: "spec-one" },
  ]);
  assert.deepEqual(snapshot.issues.filter((issue) => !issue.inProject).map((issue) => [issue.id, issue.state.type]), [
    ["ticket-one", "unstarted"], ["outside-one", "completed"], ["outside-two", "unstarted"],
  ], "an open endpoint the walk didn't return is outside the scope");
});

test("a label on a later page remains available with the mirrored state vocabulary", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const api = linear(({ operation, variables }) => {
    if (operation === "SquadronIssues") return issuesOf([{ ...specIssue, labels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "labels-two" } } }]);
    if (operation !== "SquadronIssueLabels") return undefined;
    assert.deepEqual(variables, { id: "spec-one", after: "labels-two" });
    return Response.json({ data: { issue: { labels: { nodes: [label], pageInfo: end } } } });
  });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: api.fetch }), { scope: scoped() });
  const snapshot = await mirror.sync("proj-one");
  assert.deepEqual(snapshot.issues[0].labels, [{ id: "label-ready", name: "ready-for-agent", color: "#00aa00" }]);
  assert.deepEqual(snapshot.labels, [{ id: "label-ready", name: "ready-for-agent", color: "#00aa00" }]);
  assert.deepEqual(snapshot.states, [{ id: "state-ready", name: "Ready", type: "unstarted" }]);
});

test("an incomplete later page retains the last complete snapshot and reports a safe failure", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let failing = false;
  const api = linear(({ operation, variables }) => {
    if (operation !== "SquadronIssues") return undefined;
    if (!failing) return issuesOf([specIssue]);
    if (variables.after) return Response.json({ errors: [{ message: "fake-private-provider-detail" }] }, { status: 503 });
    return Response.json({ data: { issues: { nodes: [{ ...specIssue, title: "Partial new title" }],
      pageInfo: { hasNextPage: true, endCursor: "failed-page-two" } } } });
  });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: api.fetch }), { scope: scoped() });
  const good = await mirror.sync("proj-one");
  failing = true;
  await assert.rejects(mirror.sync("proj-one"), { name: "LinearRequestError", code: "graphql" });
  const snapshot = mirror.getSnapshot("proj-one");
  assert.equal(snapshot.issues[0].title, "A fixture spec");
  assert.equal(snapshot.syncedAt, good.syncedAt);
  assert.deepEqual(snapshot.scope, good.scope);
  assert.equal(snapshot.error, "Linear could not complete the request.");
  assert.equal(mirror.scopeProblem("proj-one"), null, "a Linear failure is not a Scope problem");
  assert.ok(!JSON.stringify(snapshot).includes("fake-private-provider-detail"));
});

test("polling reads the projects a board has read every 30 seconds, and each service start catches up in full", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let now = 1_000_000;
  const delays: number[] = [];
  let hasIssue = true;
  let stop = () => {};
  const api = linear(({ operation, variables }) => {
    if (operation !== "SquadronIssues") return undefined;
    assert.equal(variables.after, null, "each catch-up begins at the first page");
    return issuesOf(hasIssue ? [specIssue] : []);
  });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { now: () => now, fetch: api.fetch }), {
    scope: scoped(), now: () => now, wait: async (ms, signal) => {
      delays.push(ms); now += ms;
      if (delays.length === 3) hasIssue = false;
      if (delays.length >= 4) stop();
      assert.ok(signal instanceof AbortSignal);
    } });
  await mirror.sync("proj-one");
  const run = harness.behavior.runService("linear-reader");
  stop = () => run.controller.abort();
  await run.done;
  assert.deepEqual(delays, [30_000, 30_000, 30_000, 30_000]);
  assert.deepEqual(mirror.getSnapshot("proj-one").issues, []);
  assert.equal(mirror.getSnapshot("proj-one").syncedAt, 1_090_000);
  hasIssue = true;
  const restarted = harness.behavior.runService("linear-reader");
  stop = () => restarted.controller.abort();
  await restarted.done;
  assert.equal(mirror.getSnapshot("proj-one").issues[0].identifier, "FIX-1", "a restart reads at once, not after the old schedule");
  assert.equal(mirror.getSnapshot("proj-one").error, null);
});

test("a slow sync of the previous Scope cannot overwrite the new one", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let release!: (response: Response) => void;
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let scope: LinearScope = { project: "Fixture project" };
  const api = linear(({ operation, variables }) => {
    if (operation === "SquadronScope") {
      const name = variables.project.name.eqIgnoreCase as string;
      return Response.json({ data: { projects: { nodes: [{ id: name === "Two" ? "linear-two" : "linear-one", name }] } } });
    }
    if (operation !== "SquadronIssues") return undefined;
    if (variables.filter.project.id.eq === "linear-two") return issuesOf([]);
    started();
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: api.fetch }), { scope: async () => ({ ok: true, scope }) });
  const oldSync = mirror.sync("proj-one");
  await start;
  scope = { project: "Two" };
  await mirror.sync("proj-one");
  release(issuesOf([specIssue]));
  await oldSync;
  assert.deepEqual(mirror.getSnapshot("proj-one").scope, { name: "Two" });
  assert.deepEqual(mirror.getSnapshot("proj-one").issues, []);
});

test("the poller shares auth's rate budget and retries only after its reset", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let now = 1_000_000;
  let issueReads = 0;
  const delays: number[] = [];
  let stop = () => {};
  const api = linear(({ operation }) => {
    if (operation !== "SquadronIssues") return undefined;
    issueReads++;
    if (issueReads === 1) return Response.json({ data: { issues: { nodes: [specIssue], pageInfo: end } } }, { headers: {
      "x-ratelimit-requests-remaining": "0", "x-ratelimit-requests-reset": "1120000",
    } });
    assert.equal(now, 1_120_000);
    return issuesOf([specIssue]);
  });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { now: () => now, fetch: api.fetch }), {
    scope: scoped(), now: () => now, wait: async (ms) => {
      delays.push(ms);
      if (delays.length === 1) {
        assert.equal(issueReads, 1, "the exhausted budget prevents a network request");
        assert.equal(mirror.getSnapshot("proj-one").error, "Linear's request budget is exhausted. Try again after the reset.");
      } else stop();
      now += ms;
    } });
  await assert.rejects(mirror.sync("proj-one"), { code: "rate_limited" });
  const run = harness.behavior.runService("linear-reader");
  stop = () => run.controller.abort();
  await run.done;
  assert.deepEqual(delays, [120_000, 30_000]);
  assert.equal(issueReads, 2);
  assert.equal(mirror.getSnapshot("proj-one").error, null);
});

test("disposing the plugin cancels a mirror request without committing a partial snapshot", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let requestSignal: AbortSignal | undefined;
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: async (_url, init) => {
    const { query } = JSON.parse(String(init?.body));
    if (query.includes("SquadronScope(")) return Response.json(scopeResponse);
    requestSignal = init?.signal as AbortSignal;
    started();
    return new Promise<Response>((_resolve, reject) => {
      requestSignal!.addEventListener("abort", () => reject(new Error("fake-private-cancel-detail")), { once: true });
    });
  } }), { scope: scoped() });
  const syncing = mirror.sync("proj-one");
  const rejected = assert.rejects(syncing, { name: "LinearRequestError", code: "unavailable" });
  await start;
  await harness.lifecycle.dispose();
  assert.equal(requestSignal?.aborted, true);
  await rejected;
});

test("overlapping reads of one project share a single complete walk", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let issueReads = 0;
  const api = linear(async ({ operation }) => {
    if (operation !== "SquadronIssues") return undefined;
    issueReads++; started();
    await gate;
    return issuesOf([specIssue]);
  });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: api.fetch }), { scope: scoped() });
  const first = mirror.sync("proj-one");
  const second = mirror.sync("proj-one");
  await start;
  release();
  const results = await Promise.all([first, second]);
  assert.equal(issueReads, 1);
  assert.deepEqual(results.map((snapshot) => snapshot.issues[0].identifier), ["FIX-1", "FIX-1"]);
});

test("states and labels come from the teams of the issues read, with later vocabulary pages", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const api = linear(({ operation, variables }) => {
    if (operation === "SquadronScope") return Response.json({ data: { projects: { nodes: [{ id: "linear-one", name: "Fixture project" }] } } });
    // A project spans two teams; no Team key is set.
    if (operation === "SquadronIssues") return issuesOf([specIssue, { ...specIssue, id: "other-team", identifier: "OTH-1", team: { id: "team-two" } }]);
    if (operation !== "SquadronVocabulary") return undefined;
    assert.deepEqual(variables.teamIds, ["team-one", "team-two"]);
    if (variables.statesAfter) {
      assert.equal(variables.statesAfter, "states-two");
      return Response.json({ data: { workflowStates: { nodes: [{ id: "state-working", name: "In Progress", type: "started" }], pageInfo: end },
        issueLabels: { nodes: [], pageInfo: end } } });
    }
    return Response.json({ data: {
      workflowStates: { nodes: [ready], pageInfo: { hasNextPage: true, endCursor: "states-two" } },
      issueLabels: { nodes: [{ id: "label-ui", name: "ui", color: "#0000aa" }], pageInfo: end },
    } });
  });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: api.fetch }), { scope: scoped({ project: "Fixture project" }) });
  const snapshot = await mirror.sync("proj-one");
  assert.deepEqual(snapshot.labels, [label, { id: "label-ui", name: "ui", color: "#0000aa" }]);
  assert.deepEqual(snapshot.states, [
    { id: "state-ready", name: "Ready", type: "unstarted" },
    { id: "state-working", name: "In Progress", type: "started" },
  ]);
});

test("more than 50 labels keep paging after the states finish, without asking Linear for a zero-size page", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const labelPage = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `label-${from + i}`, name: `l${from + i}`, color: "#888888" }));
  const api = linear(({ operation, variables }) => {
    if (operation === "SquadronIssues") return issuesOf([specIssue]);
    if (operation !== "SquadronVocabulary") return undefined;
    if (!variables.labelsAfter) {
      assert.deepEqual([variables.withStates, variables.withLabels], [true, true]);
      return Response.json({ data: {
        workflowStates: { nodes: [ready], pageInfo: end },
        issueLabels: { nodes: labelPage(0, 50), pageInfo: { hasNextPage: true, endCursor: "labels-two" } },
      } });
    }
    assert.deepEqual([variables.withStates, variables.withLabels, variables.labelsAfter], [false, true, "labels-two"],
      "finished states are left out, not asked for with first: 0");
    return Response.json({ data: { issueLabels: { nodes: labelPage(50, 7), pageInfo: end } } });
  });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: api.fetch }), { scope: scoped() });
  const snapshot = await mirror.sync("proj-one");
  assert.equal(snapshot.labels.filter((item) => item.id.startsWith("label-") && item.id !== "label-ready").length, 57);
  assert.deepEqual(snapshot.states, [ready]);
  for (const request of api.requests.filter((item) => item.operation === "SquadronVocabulary")) {
    assert.ok(!Object.values(request.variables).includes(0), "no first: 0");
  }
});

test("closed blockers are in scope when Linear says they match it, and keep their status off open rows", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const api = linear(({ operation }) => operation === "SquadronIssues" ? Response.json(closedBlockerGraph) : undefined);
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: api.fetch }), { scope: scoped() });
  const snapshot = await mirror.sync("proj-one");
  assert.deepEqual(api.requests.find((request) => request.operation === "SquadronScopeMembers")?.variables.filter, {
    team: { id: { eq: "team-one" } }, project: { id: { eq: "linear-one" } },
    id: { in: ["same-done", "same-canceled", "outside-one"] },
  }, "only closed endpoints are asked; open ones are in scope exactly when the walk returned them");
  assert.deepEqual(snapshot.issues.filter((issue) => issue.inProject).map((issue) => [issue.id, issue.state.type]), [
    ["spec-one", "unstarted"], ["ticket-one", "unstarted"], ["same-done", "completed"], ["same-canceled", "canceled"],
  ]);
  assert.deepEqual(snapshot.issues.filter((issue) => !issue.inProject).map((issue) => [issue.id, issue.state.type]), [
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

test("a lane spec Linear can't read is logged and skipped without stopping the read", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  const api = linear(({ operation }) => {
    if (operation === "SquadronIssues") return issuesOf([specIssue]);
    if (operation === "SquadronLaneSpec") return Response.json({ errors: [{ message: "Entity not found", extensions: { code: "INVALID_INPUT" } }] });
    return undefined;
  });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: api.fetch }), { scope: scoped(), laneSpecIds: async () => ["gone-spec"] });
  const snapshot = await mirror.sync("proj-one");
  assert.equal(snapshot.error, null);
  const warnings = harness.inspection.logEntries.filter((entry) => entry.level === "warn").map((entry) => entry.message);
  assert.ok(warnings.includes("lane spec gone-spec unreadable: graphql"), warnings.join("\n"));
  assert.ok(warnings.some((line) => line.includes("Entity not found") && line.includes("INVALID_INPUT")), "linear-auth logs Linear's own error");
});
