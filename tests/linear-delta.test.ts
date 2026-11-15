import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { registerLinearReader, type ScopeSource } from "../lib/linear-reader.js";
import { registerLinearAuth } from "../lib/linear-auth.js";
import { specIssue, end, vocabularyResponse } from "./fixtures/linear-mirror.js";
import { scopeResponse } from "./fixtures/board-workspace.js";
import { helperFixture, settle as settlePlugin } from "./fixtures/helper-plugin.js";

const epoch = Date.parse("2026-11-14T12:00:00Z");
const settle = async () => { for (let i = 0; i < 40; i++) await setImmediate(); };
type Node = Omit<typeof specIssue, "parent" | "relations" | "inverseRelations"> & {
  parent: { id: string } | null;
  relations: { nodes: unknown[]; pageInfo: typeof end };
  inverseRelations: { nodes: unknown[]; pageInfo: typeof end };
};

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  const requests: { name: string; variables: any }[] = [];
  let nodes: Node[] = [specIssue];
  let shown = true;
  let lanes: string[] = [];
  let failPage = false;
  let source: ScopeSource = { ok: true, scope: { project: "Fixture project" } };
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const { query, variables = {} } = JSON.parse(String(init?.body));
    assert.ok(query.startsWith("query "), "no Linear writes");
    const name = /^query (\w+)/.exec(query)![1];
    requests.push({ name, variables });
    const filter = variables.filter;
    const page = (values: unknown[]) => ({ nodes: values, pageInfo: end });
    switch (name) {
      case "SquadronScope": return Response.json({ data: { ...scopeResponse.data,
        customViews: { nodes: [{ id: "view", name: "Agent work" }] } } });
      case "SquadronViewIssues": return Response.json({ data: { customView: { issues: page(nodes.filter((node) => node.labels.nodes.length)) } } });
      case "SquadronViewMembers": return Response.json({ data: { customView: { issues: page(nodes.filter((node) =>
        filter.id.in.includes(node.id) && node.labels.nodes.length).map(({ id }) => ({ id }))) } } });
      case "SquadronDelta": {
        if (variables.after && failPage) return Response.json({ errors: [{ message: "fixture page failure" }] });
        const result = page(nodes.filter((node) => Date.parse(node.updatedAt) > Date.parse(filter.updatedAt.gt)));
        return Response.json({ data: { issues: failPage ? { ...result,
          pageInfo: { hasNextPage: true, endCursor: "next" } } : result } });
      }
      case "SquadronIssues": return Response.json({ data: { issues: page(nodes.filter((node) =>
        filter.id ? filter.id.in.includes(node.id) : node.project?.id === "linear-one" && node.state.type === "unstarted")) } });
      case "SquadronScopeMembers": return Response.json({ data: { issues: page(nodes.filter((node) =>
        filter.id.in.includes(node.id) && node.project?.id === "linear-one").map(({ id }) => ({ id }))) } });
      case "SquadronVocabulary": return Response.json(vocabularyResponse);
      case "SquadronLaneSpec": return Response.json({ data: { issue: nodes.find((node) => node.id === variables.id)
        ? { ...nodes.find((node) => node.id === variables.id), children: page(nodes.filter((node) => node.parent?.id === variables.id && node.state.type === "completed")) }
        : null } });
      default: throw new Error(`Unexpected ${name}`);
    }
  };
  const reader = registerLinearReader(bb, registerLinearAuth(bb, { fetch }), {
    scope: async () => source, shouldPoll: () => shown, laneSpecIds: async () => lanes,
  });
  t.after(async () => { await harness.lifecycle.dispose(); t.mock.timers.reset(); });
  await reader.sync("one");
  return { reader, harness, requests,
    setNodes: (value: Node[]) => { nodes = value; },
    setShown: (value: boolean) => { shown = value; },
    setScope: (value: ScopeSource) => { source = value; },
    setLanes: (value: string[]) => { lanes = value; },
    failPage: (value: boolean) => { failPage = value; },
    advance: async (ms: number) => { t.mock.timers.tick(ms); await settle(); },
  };
}

test("a quiet open board uses one small request per poll and backs off to three minutes", async (t) => {
  const f = await fixture(t);
  f.harness.behavior.runService("linear-reader"); await settle();
  const initial = f.requests.length;
  let polls = 0;
  for (const delay of [30_000, 60_000, 120_000, 180_000, 180_000]) {
    await f.advance(delay - 1);
    assert.equal(f.requests.length, initial + polls);
    await f.advance(1);
    polls++;
    assert.equal(f.requests.length, initial + polls);
    assert.equal(f.requests.at(-1)?.name, "SquadronDelta");
  }
});

test("a delta shows changes in one poll, removes closed and moved issues, and resets the cadence", async (t) => {
  const f = await fixture(t);
  f.harness.behavior.runService("linear-reader"); await settle();
  await f.advance(30_000);
  f.setNodes([{ ...specIssue, title: "Changed title", labels: { nodes: [], pageInfo: end },
    updatedAt: new Date(epoch + 40_000).toISOString() }]);
  await f.advance(60_000);
  let snapshot = await f.harness.behavior.callRpc("linear.snapshot", { bbProjectId: "one" }) as { issues: Node[] };
  assert.equal(snapshot.issues[0].title, "Changed title");
  assert.deepEqual(snapshot.issues[0].labels, []);
  const count = f.requests.length;
  await f.advance(29_999);
  assert.equal(f.requests.length, count);
  await f.advance(1);
  assert.equal(f.requests.length, count + 1, "a change restores the 30 second cadence");
  f.setNodes([{ ...specIssue, state: { id: "done", name: "Done", type: "completed" },
    updatedAt: new Date(epoch + 125_000).toISOString() }]);
  await f.advance(60_000);
  assert.deepEqual(f.reader.getSnapshot("one").issues, [], "closed issues leave the open board");
  f.setNodes([{ ...specIssue, updatedAt: new Date(epoch + 185_000).toISOString() }]);
  await f.advance(30_000);
  assert.equal(f.reader.getSnapshot("one").issues.length, 1, "a reopened issue returns");
  f.setNodes([{ ...specIssue, project: { id: "elsewhere" }, updatedAt: new Date(epoch + 215_000).toISOString() }]);
  await f.advance(30_000);
  assert.deepEqual(f.reader.getSnapshot("one").issues, [], "a moved issue leaves immediately");
});

test("background polls are deltas, with full reads only at twenty minutes or a scope change", async (t) => {
  const f = await fixture(t);
  f.setShown(false);
  f.harness.behavior.runService("linear-reader"); await settle();
  // Service start is a full catch-up even when it already has a snapshot.
  await f.advance(300_000);
  const full = () => f.requests.filter((request) => request.name === "SquadronIssues" && !request.variables.filter.id).length;
  assert.equal(full(), 2);
  f.setNodes([]);
  for (let i = 0; i < 3; i++) await f.advance(300_000);
  assert.equal(full(), 2);
  assert.equal(f.reader.getSnapshot("one").issues.length, 1, "a deletion without an update waits for reconciliation");
  assert.equal(f.requests.filter((request) => request.name === "SquadronDelta").length, 3);
  await f.advance(300_000);
  assert.equal(full(), 3, "a full read reconciles deletions at twenty minutes");
  assert.deepEqual(f.reader.getSnapshot("one").issues, []);
  f.setScope({ ok: true, scope: { team: "FIX", project: "Fixture project" } });
  await f.reader.sync("one");
  assert.equal(full(), 4, "a changed scope starts with a full read");
});

test("Plan through the board restores a quiet project's 30 second cadence", async (t) => {
  const f = await helperFixture(t, epoch);
  f.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "planner", projectId: "one" }));
  await f.board("one");
  f.harness.behavior.runService("linear-reader"); await settlePlugin();
  for (let i = 0; i < 3; i++) { await f.advance(30_000); await f.board("one"); }
  const before = f.linear.operations.filter((name) => name === "SquadronDelta").length;
  await f.harness.behavior.callRpc("planning.start", { projectId: "one" });
  await f.advance(29_999);
  assert.equal(f.linear.operations.filter((name) => name === "SquadronDelta").length, before);
  await f.advance(1);
  assert.equal(f.linear.operations.filter((name) => name === "SquadronDelta").length, before + 1);
});

test("a changed issue that leaves a saved view disappears in one delta", async (t) => {
  const f = await fixture(t);
  f.setScope({ ok: true, scope: { view: "Agent work" } });
  await f.reader.sync("one");
  assert.equal(f.reader.getSnapshot("one").issues.length, 1);
  f.setNodes([{ ...specIssue, labels: { nodes: [], pageInfo: end }, updatedAt: new Date(epoch + 1_000).toISOString() }]);
  await f.reader.sync("one");
  assert.deepEqual(f.reader.getSnapshot("one").issues, []);
  assert.ok(f.requests.some((request) => request.name === "SquadronViewMembers"));
});

test("a failed delta page keeps the snapshot and watermark for a complete retry", async (t) => {
  const f = await fixture(t);
  const before = f.reader.getSnapshot("one");
  f.setNodes([{ ...specIssue, title: "Must survive retry", updatedAt: new Date(epoch + 1_000).toISOString() }]);
  f.failPage(true);
  await assert.rejects(f.reader.sync("one"), { code: "graphql" });
  assert.deepEqual(f.reader.getSnapshot("one").issues, before.issues);
  assert.equal(f.reader.getSnapshot("one").syncedAt, before.syncedAt);
  const since = f.requests.find((request) => request.name === "SquadronDelta")!.variables.filter.updatedAt;
  f.failPage(false);
  await f.reader.sync("one");
  assert.equal(f.reader.getSnapshot("one").issues[0].title, "Must survive retry");
  assert.deepEqual(f.requests.filter((request) => request.name === "SquadronDelta").at(-1)!.variables.filter.updatedAt, since);
});

test("lane reads follow changed completed children and are skipped on quiet polls", async (t) => {
  const f = await fixture(t);
  const child: Node = { ...specIssue, id: "child", identifier: "FIX-2", parent: { id: specIssue.id },
    state: { id: "done", name: "Done", type: "completed" } };
  f.setNodes([specIssue, child]);
  f.setLanes([specIssue.id]);
  await f.reader.sync("one");
  assert.equal(f.reader.getSnapshot("one").issues.find((issue) => issue.id === "child")?.inProject, true);
  const before = f.requests.length;
  await f.reader.sync("one");
  assert.equal(f.requests.length, before + 1, "unchanged lanes do not fetch the spec, children or vocabulary");
  f.setNodes([specIssue, { ...child, title: "Changed completed child", updatedAt: new Date(epoch + 1_000).toISOString() }]);
  await f.reader.sync("one");
  assert.equal(f.reader.getSnapshot("one").issues.find((issue) => issue.id === "child")?.title, "Changed completed child");
  assert.equal(f.requests.filter((request) => request.name === "SquadronLaneSpec").length, 2);
});

test("restoring a missing scope rebuilds its snapshot even inside the full-read interval", async (t) => {
  const f = await fixture(t);
  f.setScope({ ok: false, message: "Choose a Scope." });
  await f.reader.sync("one");
  assert.deepEqual(f.reader.getSnapshot("one").issues, []);
  f.setScope({ ok: true, scope: { project: "Fixture project" } });
  await f.reader.sync("one");
  assert.equal(f.reader.getSnapshot("one").issues[0]?.id, specIssue.id);
});

test("changed external blockers update their state and removed relations drop unused endpoints", async (t) => {
  const f = await fixture(t);
  const blocker: Node = { ...specIssue, id: "outside", identifier: "OUT-1", project: { id: "other" } };
  const relation = { id: "blocks", type: "blocks", issue: blocker, relatedIssue: specIssue };
  f.setNodes([{ ...specIssue, inverseRelations: { nodes: [relation], pageInfo: end },
    updatedAt: new Date(epoch + 1_000).toISOString() }, blocker]);
  await f.reader.sync("one");
  assert.equal(f.reader.getSnapshot("one").relations.length, 1);
  const finished: Node = { ...blocker, state: { id: "done", name: "Done", type: "completed" },
    updatedAt: new Date(epoch + 2_000).toISOString(), relations: { nodes: [relation], pageInfo: end } };
  f.setNodes([{ ...specIssue, updatedAt: new Date(epoch + 1_000).toISOString() }, finished]);
  await f.reader.sync("one");
  assert.equal(f.reader.getSnapshot("one").issues.find((issue) => issue.id === "outside")?.state.type, "completed");
  assert.equal(f.reader.getSnapshot("one").relations.length, 1);
  f.setNodes([{ ...specIssue, updatedAt: new Date(epoch + 3_000).toISOString() }, finished]);
  await f.reader.sync("one");
  assert.deepEqual(f.reader.getSnapshot("one").relations, []);
  assert.deepEqual(f.reader.getSnapshot("one").issues.map((issue) => issue.id), [specIssue.id]);
});
