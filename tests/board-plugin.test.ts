// Spec A's end-to-end test: the real server.ts on the SDK's fake plugin host,
// a recorded Linear workspace behind fetch, and the board read through RPC.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { Board } from "../lib/board-model.js";
import { needsYou } from "../lib/board-model.js";
import { registerLinearAuth } from "../lib/linear-auth.js";
import { registerLinearOutbox } from "../lib/linear-outbox.js";
import { registerLinearMirror } from "../lib/linear-mirror.js";
import { registerBoard } from "../lib/board-service.js";
import { binding, workspace, workspaceIssues } from "./fixtures/board-workspace.js";

const settingsFile = readFileSync("tests/fixtures/squadron.md", "utf8");

function host(settings: Record<string, string> = { linearApiKey: "fake-board-e2e-key" }) {
  return createFakePluginHost({
    pluginId: "squadron",
    settings,
    sdk: {
      projects: { get: async () => ({
        id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId: "proj-one", hostId: "repo-machine", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }],
      }) },
      files: { read: async ({ path }) => {
        assert.equal(path, "/repo/docs/agents/squadron.md");
        return { content: settingsFile, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: settingsFile.length };
      } },
    },
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), `timed out waiting for ${what}`);
}

test("install, bind a recorded workspace, sync it and read the real board through RPC", async (t) => {
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.lifecycle.install();

  const unbound = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(unbound.linear?.state, "unbound");
  assert.deepEqual([unbound.ready, unbound.unplanned], [[], []]);

  await harness.behavior.callRpc("linear.bind", binding);
  await until(() => harness.inspection.realtimeSignals.some((signal) => signal.channel === "board-changed"), "board-changed");
  assert.deepEqual(harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").at(-1)?.payload,
    { projectId: "proj-one" });

  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.linear?.state, "current");
  assert.equal(board.linear?.project, "Fixture team · Fixture project");
  assert.deepEqual(board.ready.map(({ id, ticketCount, blockedBy, startReason, routes }) => ({ id, ticketCount, blockedBy, startReason, models: routes.map((route) => route.model) })), [
    { id: "FIX-1", ticketCount: 2, blockedBy: ["OUT-10"], startReason: "Waits on OUT-10 (outside this project)", models: ["gpt-6.1-sol", "claude-opus-5-5"] },
    { id: "FIX-5", ticketCount: 1, blockedBy: [], startReason: "Squadron can't start lanes yet. This version only reads Linear.", models: ["gpt-6.1-sol"] },
  ]);
  assert.deepEqual(board.unplanned.map((row) => [row.id, row.title]), [["FIX-9", "Linear webhooks"]]);
  assert.deepEqual(board.lanes, []);
  assert.ok(!linear.operations.some((name) => !name.startsWith("Squadron")));
});

const withNewIssue = () => Response.json({ data: { issues: { ...workspaceIssues.data.issues, nodes: [
  ...workspaceIssues.data.issues.nodes,
  { ...workspaceIssues.data.issues.nodes[5], id: "fix-12", identifier: "FIX-12", title: "Added in Linear", url: "https://linear.app/fixture/issue/FIX-12" },
] } } });

test("a change in Linear reaches open boards as board-changed on the mirror's next poll", async (t) => {
  let changed = false;
  const linear = workspace({ issues: () => changed ? withNewIssue() : Response.json(workspaceIssues) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("linear.bind", binding);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  const before = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length;
  changed = true;
  const poll = harness.behavior.runService("linear-mirror");
  t.after(() => poll.controller.abort());
  await until(() => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length > before, "board-changed after the poll");
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.unplanned.map((row) => row.id), ["FIX-9", "FIX-12"]);
});

test("after a restart the board shows the last copy as catching up, then the full read", async (t) => {
  let changed = false;
  const linear = workspace({ issues: () => changed ? withNewIssue() : Response.json(workspaceIssues) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const first = host();
  await plugin(first.bb);
  await first.harness.behavior.callRpc("linear.bind", binding);
  changed = true; // Linear changes while the plugin is down.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const { harness } = await first.harness.lifecycle.reload((api) => plugin(api));
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });

  const restarted = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(restarted.linear?.state, "catching-up");
  assert.deepEqual(restarted.unplanned.map((row) => row.id), ["FIX-9"], "the copy from before the restart");
  await until(() => harness.inspection.realtimeSignals.some((signal) => signal.channel === "board-changed"), "board-changed after catch-up");
  const caughtUp = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(caughtUp.linear?.state, "current");
  assert.deepEqual(caughtUp.unplanned.map((row) => row.id), ["FIX-9", "FIX-12"]);
});

test("without a Linear credential the board asks the owner to connect and reads nothing", async (t) => {
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host({});
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.linear, { state: "disconnected", message: "Connect Linear in Squadron settings.", syncedAt: null, project: null });
  assert.deepEqual(linear.operations, []);
});

test("board RPC refreshes reuse identity for a minute and invalidate it when credentials change", async (t) => {
  const linear = workspace();
  const { bb, harness } = host();
  t.after(() => harness.lifecycle.dispose());
  let now = Date.now();
  const auth = registerLinearAuth(bb, { fetch: linear.fetch, now: () => now });
  const mirror = registerLinearMirror(bb, auth);
  registerBoard(bb, { connection: auth.getConnection, mirror }, { now: () => now });
  const identities = () => linear.operations.filter((name) => name === "SquadronIdentity").length;
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  assert.equal(identities(), 1);
  await Promise.all(Array.from({ length: 5 }, () => harness.behavior.callRpc("board", { projectId: "proj-one" })));
  assert.equal(identities(), 1, "five page refreshes share the recent public identity");
  now += 60_001;
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  assert.equal(identities(), 2, "the next read after a minute verifies identity again");
  await harness.behavior.setSettings({ linearApiKey: "fake-replacement-key" });
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  assert.equal(identities(), 3, "a credential replacement discards the cached connection immediately");
});

test("a failed read keeps the last good copy and shows Linear's safe reason", async (t) => {
  let failing = false;
  const linear = workspace({ issues: () => failing
    ? Response.json({ errors: [{ message: "fake-private-provider-detail" }] }, { status: 503 })
    : Response.json(workspaceIssues) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("linear.bind", binding);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  const signalsBeforeFailure = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length;
  failing = true;
  const poll = harness.behavior.runService("linear-mirror");
  t.after(() => poll.controller.abort());
  await until(() => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length > signalsBeforeFailure, "board-changed after the failure");
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual([board.linear?.state, board.linear?.message], ["failed", "Linear could not complete the request."]);
  assert.deepEqual(board.unplanned.map((row) => row.id), ["FIX-9"]);
  assert.ok(!JSON.stringify(board).includes("fake-private-provider-detail"));
});

test("the board page renders the RPC board model: Ready, Unplanned, reasons and the Linear line", async (t) => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardPage, BoardView } = await import("../board/Board.js");
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("linear.bind", binding);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;

  const html = renderToStaticMarkup(createElement(BoardView, {
    board, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined,
  }));
  for (const text of ["Fixture team · Fixture project", "The board reads Linear", "Waits on OUT-10 (outside this project)",
    "Squadron can&#x27;t start lanes yet. This version only reads Linear.", "Doctor checks", "Linear webhooks", "No lanes flying."]) {
    assert.ok(html.includes(text), `the board shows ${text}`);
  }
  assert.equal((html.match(/<button[^>]*disabled=""[^>]*>Start<\/button>/g) ?? []).length, 2, "both Start buttons are disabled");
  assert.ok(!html.includes("Synthetic data"), "the real board carries no synthetic label");

  const page = renderToStaticMarkup(createElement(BoardPage));
  assert.ok(page.includes('aria-checked="false"') && page.includes("Synthetic demo"), "the demo is a switch, off by default");
  assert.ok(!page.includes("Synthetic data") && !page.includes("SQD-"), "no synthetic data before the owner turns the demo on");
  const demo = renderToStaticMarkup(createElement(BoardView, {
    board: { ...board, ready: [{ id: "SQD-40", title: "Invented spec", ticketCount: 1, routes: [], blockedBy: [], acceptOwner: false }] },
    demo: true, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined,
  }));
  assert.ok(demo.includes("Synthetic data"), "demo data is labelled in the header");
});

test("empty, disconnected, unbound and failed boards each say what to do", async () => {
  await import("./fixtures/app-runtime.js");
  const { liveNotice } = await import("../board/Board.js");
  const base = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, lanes: [], ready: [], unplanned: [] };
  const status = (state: NonNullable<Board["linear"]>["state"], syncedAt: number | null = null): Board =>
    ({ ...base, linear: { state, message: "", syncedAt, project: null } });
  assert.equal(liveNotice({ projectId: null, board: null, failed: false }), "Choose a BB project to see its board.");
  assert.equal(liveNotice({ projectId: "p", board: null, failed: false }), "Reading the board.");
  assert.equal(liveNotice({ projectId: "p", board: null, failed: true }), "Couldn't load the board. Make sure BB is running, then try again.");
  assert.equal(liveNotice({ projectId: "p", board: status("disconnected"), failed: false }), "Connect Linear to see this project's issues.");
  assert.equal(liveNotice({ projectId: "p", board: status("unbound"), failed: false }), "Choose this project's Linear team and project above.");
  assert.equal(liveNotice({ projectId: "p", board: status("catching-up"), failed: false }), "Reading this project's issues from Linear.");
  assert.equal(liveNotice({ projectId: "p", board: status("failed", 1), failed: false }), null, "a failed read keeps the last copy");
});

test("a blocked Linear write waits in Needs you until the owner's Retry sends it back to the outbox", async (t) => {
  const linear = workspace();
  const sent: string[] = [];
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    if (!query.trimStart().startsWith("mutation")) return linear.fetch(url, init);
    sent.push(query.trim().split(/[\s({]/)[1]);
    return Response.json({ errors: [{ message: "fake-private-rejection-detail" }] });
  });
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  // The same wiring as server.ts, keeping the outbox handle so the test can queue a write.
  const auth = registerLinearAuth(bb);
  const outbox = registerLinearOutbox(bb, auth);
  const mirror = registerLinearMirror(bb, auth);
  registerBoard(bb, { connection: () => auth.getConnection(), mirror, writes: (id) => outbox.getHealth(id) });
  await harness.behavior.callRpc("linear.bind", binding);
  const write = await outbox.enqueue({ bbProjectId: "proj-one", dedupeKey: "status-fix-9",
    operation: { type: "status", issueId: "fix-9", stateId: "state-started" } });
  await outbox.flush();

  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(needsYou(board).map(({ kind, specId, issueId, writeId, text }) => ({ kind, specId, issueId, writeId, text })), [{
    kind: "write", specId: "", issueId: "FIX-9", writeId: write.id,
    text: "A Linear write for FIX-9 couldn't go through. Linear refused the write. Check the issue in Linear, then retry.",
  }]);
  assert.ok(!JSON.stringify(board).includes("fake-private-rejection-detail"));

  const receipt = await harness.behavior.callRpc("linear.outboxResume", { bbProjectId: "proj-one", id: write.id }) as { status: string };
  assert.equal(receipt.status, "pending");
  const retried = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual([retried.writes?.blocked, retried.writes?.pendingCount], [[], 1]);
  assert.ok(sent.length >= 1, "the write went to Linear only through the outbox");
});

test("repeated signals with no change in the board model publish nothing", async (t) => {
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  const auth = registerLinearAuth(bb);
  const mirror = registerLinearMirror(bb, auth);
  const board = registerBoard(bb, { connection: () => auth.getConnection(), mirror });
  await harness.behavior.callRpc("linear.bind", binding);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  const before = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length;
  await Promise.all([board.refresh("proj-one"), board.refresh("proj-one"), board.refresh("proj-one")]);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  assert.equal(harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length, before);
});
