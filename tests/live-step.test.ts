import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerBoard } from "../lib/board-service.js";
import { input, issue, snapshot } from "./fixtures/board-snapshots.js";
import type { Board } from "../lib/board-model.js";
import type { LeadThread } from "../lib/lead-threads.js";

type Timeline = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>>;
const route = { family: "gpt", model: "gpt-6.1-sol", effort: "medium" } as const;
const thread = makeThreadResponse({ id: "lead", projectId: "proj-one", status: "active", runtime: { displayStatus: "active" } });
const lead: LeadThread = { specId: "fix-1", thread, route, branch: "spec/fix-1", workers: [
  { ...makeThreadResponse({ id: "worker", title: "Worker FIX-2", status: "active", runtime: { displayStatus: "active" } }) },
] };
function timeline(text: string, startedAt = 123): Timeline {
  return { rows: [{ kind: "turn", children: [{ kind: "conversation", role: "assistant", text,
    startedAt, sourceSeqStart: 2, sourceSeqEnd: 2 }] }] } as unknown as Timeline;
}
function setup(t: import("node:test").TestContext) {
  let leads = [lead];
  let now = 1_000;
  const host = createFakePluginHost({ pluginId: "squadron", sdk: { projects: { get: async () => ({ id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0, sources: [] }) }, threads: {
    get: async ({ threadId }) => makeThreadResponse({ id: threadId, runtime: { displayStatus: "waiting-for-host" } }),
    timeline: async () => timeline("Checking the confirmed testing decisions before running the focused checks for this ticket.\n```\nprivate fixture body\n```"),
  } } });
  t.after(() => host.harness.lifecycle.dispose());
  const snap = input(snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }), { ...issue("FIX-2", { parent: "FIX-1" }), state: { id: "working", name: "In Progress", type: "started" } }]), { kind: "github" }).snapshot;
  registerBoard(host.bb, { connection: async () => ({ status: "connected", message: "", mode: null, workspace: null, actor: null }),
    tracker: { getSnapshot: () => snap, onChange: () => () => {} }, leads: async () => leads }, { now: () => now });
  return { ...host, setLeads: (value: LeadThread[]) => { leads = value; }, advance: (ms: number) => { now += ms; } };
}

test("board RPC reads the Flying Lead and active worker's latest step, status and start time", async (t) => {
  const { harness } = setup(t);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.lanes[0].liveStep, { status: "waiting-for-host",
    step: "Checking the confirmed testing decisions before running the…", since: 123 });
  assert.deepEqual(board.lanes[0].tickets[0].liveStep, board.lanes[0].liveStep);
  assert.deepEqual(harness.inspection.sdk.callsTo("threads.timeline").map((call) => (call[0] as { threadId: string }).threadId).sort(), ["lead", "worker"]);
  assert.ok(!JSON.stringify(board).includes("private fixture body"));
});

test("empty timelines, tools and every runtime status return safe live steps", async (t) => {
  const { bb, harness } = setup(t);
  const { readLiveStep } = await import("../lib/live-step.js");
  harness.sdk.stub("threads.timeline", async () => ({ rows: [] }) as unknown as Timeline);
  for (const status of ["active", "idle", "error", "waiting-for-host", "pending", "provisioning", "starting", "stopping"] as const) {
    harness.sdk.stub("threads.get", async () => makeThreadResponse({ runtime: { displayStatus: status } }));
    assert.deepEqual(await readLiveStep(bb, "worker"), { status, step: "No recent activity", since: null });
  }
  harness.sdk.stub("threads.timeline", async () => ({ rows: [{ kind: "work", workKind: "command", command: "npm test",
    output: "private fixture file body", startedAt: 456, sourceSeqEnd: 3 }] }) as unknown as Timeline);
  assert.equal((await readLiveStep(bb, "worker"))?.step, "Running npm test");
});

test("only visible Flying lanes are read, and repeated/concurrent reads share a 15-second lane budget", async (t) => {
  const { harness, advance, setLeads } = setup(t);
  const read = (extra = {}) => harness.behavior.callRpc("board", { projectId: "proj-one", ...extra }) as Promise<Board>;
  await read({ visibleLaneIds: [] });
  assert.equal(harness.inspection.sdk.callsTo("threads.timeline").length, 0);
  await Promise.all([read(), read(), read()]);
  assert.equal(harness.inspection.sdk.callsTo("threads.timeline").length, 2);
  advance(14_999);
  await read();
  assert.equal(harness.inspection.sdk.callsTo("threads.timeline").length, 2);
  advance(1);
  await read();
  assert.equal(harness.inspection.sdk.callsTo("threads.timeline").length, 4);
  await read({ refreshLive: true });
  assert.equal(harness.inspection.sdk.callsTo("threads.timeline").length, 6, "board-changed may refresh before the timer");
  setLeads([{ ...lead, thread: { ...thread, status: "idle" }, workers: [] }]);
  const stopped = await read({ refreshLive: true });
  assert.equal(stopped.lanes[0].state, "stopped");
  assert.equal(stopped.lanes[0].liveStep, undefined);
  assert.equal(harness.inspection.sdk.callsTo("threads.timeline").length, 6);
});

test("private bodies and credential-shaped prose never enter a live step, and failures discard stale activity", async (t) => {
  const { bb, harness } = setup(t);
  const { readLiveStep } = await import("../lib/live-step.js");
  for (const text of ["```swift\nprivate fixture body", "token = fake-private-value", "Authorization: fake-private-value", "https://example.com/private?key=fixture"]) {
    harness.sdk.stub("threads.timeline", async () => timeline(text));
    assert.equal((await readLiveStep(bb, "worker"))?.step, "Agent message");
  }
  harness.sdk.stub("threads.timeline", async () => { throw new Error("private fixture failure"); });
  assert.equal(await readLiveStep(bb, "worker"), undefined);
});


test("a worker change cannot spend a second lane read inside the 15-second budget", async (t) => {
  const { harness, setLeads } = setup(t);
  const read = () => harness.behavior.callRpc("board", { projectId: "proj-one" });
  await read();
  setLeads([{ ...lead, workers: [{ ...lead.workers![0], id: "replacement" }] }]);
  await read();
  assert.equal(harness.inspection.sdk.callsTo("threads.timeline").length, 2);
});
