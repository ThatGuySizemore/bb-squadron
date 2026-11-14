import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBoard } from "../lib/board-derive.js";
import { needsYou } from "../lib/board-model.js";
import { blocks, input, issue, snapshot } from "./fixtures/board-snapshots.js";

test("ready-for-agent specs show under Ready with their tickets, and parentless issues under Unplanned", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { title: "Board reads Linear", labels: ["ready-for-agent"] }),
    issue("FIX-2", { title: "Mirror issues", parent: "FIX-1", labels: ["ready-for-agent"] }),
    issue("FIX-3", { title: "Board page", parent: "FIX-1", labels: ["ui", "ready-for-agent"] }),
    issue("FIX-4", { title: "Webhooks", labels: ["v2"] }),
  ])));
  assert.deepEqual(board.ready.map(({ id, title, ticketCount, routes }) => ({ id, title, ticketCount, routes })), [{
    id: "FIX-1", title: "Board reads Linear", ticketCount: 2, routes: [
      { family: "gpt", model: "gpt-6.1-sol", effort: "high" },
      { family: "claude", model: "claude-opus-5-5", effort: "high" },
    ],
  }]);
  assert.deepEqual(board.unplanned.map(({ id, title, labels }) => ({ id, title, labels })), [
    { id: "FIX-4", title: "Webhooks", labels: ["v2"] },
  ]);
  assert.deepEqual(board.lanes, []);
  assert.equal(board.laneCapacity, 3);
  assert.equal(board.workersPerLane, 2);
});

test("open blockers across specs, inside or outside the project, hold Start with the reason", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1" }),
    issue("FIX-10", { labels: ["ready-for-agent"] }),
    issue("FIX-11", { parent: "FIX-10" }),
    issue("FIX-20", { labels: ["ready-for-agent"] }),
    issue("FIX-21", { parent: "FIX-20" }),
    issue("OUT-9", { title: "Outside work", outside: true }),
    issue("FIX-30", { labels: ["ready-for-agent"] }),
    issue("FIX-31", { parent: "FIX-30" }),
    issue("FIX-8", { done: true }),
    issue("OUT-7", { outside: true, done: true }),
  ], [blocks("FIX-1", "FIX-10"), blocks("OUT-9", "FIX-20"), blocks("FIX-1", "FIX-20"),
    blocks("FIX-8", "FIX-30"), blocks("OUT-7", "FIX-30")])));
  const rows = Object.fromEntries(board.ready.map((spec) => [spec.id, spec]));
  assert.deepEqual(rows["FIX-10"].blockedBy, ["FIX-1"]);
  assert.equal(rows["FIX-10"].startReason, "Waits on FIX-1");
  assert.deepEqual(rows["FIX-20"].blockedBy, ["FIX-1", "OUT-9"]);
  assert.deepEqual(rows["FIX-20"].blockers, [
    { id: "FIX-1", title: "Issue FIX-1", url: "https://linear.app/fixture/issue/FIX-1", outside: false },
    { id: "OUT-9", title: "Outside work", url: "https://linear.app/fixture/issue/OUT-9", outside: true },
  ]);
  assert.equal(rows["FIX-20"].startReason, "Waits on FIX-1 and OUT-9 (outside this project)");
  assert.deepEqual(rows["FIX-30"].blockedBy, []);
  assert.deepEqual(board.unplanned.map((row) => row.id), [], "outside and closed blockers never become rows");
});

test("a spec with no blockers still can't start in this version, and says why", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1" }),
    issue("FIX-5", { labels: ["ready-for-agent"] }),
    issue("FIX-6", { labels: ["ready-for-agent"] }),
    issue("FIX-7", { parent: "FIX-6" }),
  ], [blocks("FIX-2", "FIX-7")])));
  assert.deepEqual(board.ready.map((spec) => [spec.id, spec.startReason]), [
    ["FIX-1", "Squadron can't start lanes yet. This version only reads Linear."],
    ["FIX-5", "Has no open tickets. Plan its tickets first."],
    ["FIX-6", "Every ticket waits on a blocker: FIX-2"],
  ]);
});

test("Ready shows open blockers of its tickets while preserving a partially available frontier", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1" }), issue("FIX-3", { parent: "FIX-1" }),
    issue("FIX-10", { labels: ["ready-for-agent"] }), issue("FIX-11", { parent: "FIX-10" }),
    issue("OUT-9", { outside: true }), issue("FIX-8", { done: true }),
  ], [blocks("FIX-11", "FIX-2"), blocks("OUT-9", "FIX-2"), blocks("FIX-8", "FIX-3"),
    blocks("FIX-11", "FIX-3")])));
  const row = board.ready[0];
  assert.deepEqual(row.blockedBy, ["FIX-11", "OUT-9"]);
  assert.deepEqual(row.blockers, [
    { id: "FIX-11", title: "Issue FIX-11", url: "https://linear.app/fixture/issue/FIX-11", outside: false },
    { id: "OUT-9", title: "Issue OUT-9", url: "https://linear.app/fixture/issue/OUT-9", outside: true },
  ]);
  assert.equal(row.startReason, "Every ticket waits on a blocker: FIX-11, OUT-9");

  const partial = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1" }), issue("FIX-3", { parent: "FIX-1" }),
    issue("OUT-9", { outside: true }), issue("FIX-8", { done: true }),
  ], [blocks("OUT-9", "FIX-2"), blocks("FIX-8", "FIX-3")]))).board.ready[0];
  assert.deepEqual(partial.blockedBy, ["OUT-9"]);
  assert.equal(partial.startReason, "Squadron can't start lanes yet. This version only reads Linear.");
});

test("Start waits on a valid docs/agents/squadron.md before anything else after blockers", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1" }),
  ]), { settings: { ok: false, issues: [{ section: "Routes", message: "Add routes." }] } }));
  assert.equal(board.ready[0].startReason, "Fix docs/agents/squadron.md first: Routes. Open Doctor for details.");
  assert.deepEqual(board.ready[0].routes, []);
});

test("every open issue stays visible: a child without a Ready parent waits in Unplanned with its parent named", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-49", { done: true }),
    issue("FIX-50", { parent: "FIX-49" }),
    issue("FIX-60", { parent: "GONE-1" }),
    issue("FIX-69", { title: "Draft spec" }),
    issue("FIX-70", { parent: "FIX-69" }),
    issue("OUT-3", { outside: true }),
    issue("FIX-80", { parent: "OUT-3" }),
  ])));
  assert.deepEqual(board.unplanned.map(({ id, under }) => ({ id, under })), [
    { id: "FIX-50", under: "Under FIX-49, which is closed" },
    { id: "FIX-60", under: "Under an issue this board can't see" },
    { id: "FIX-69", under: undefined },
    { id: "FIX-70", under: "Under FIX-69" },
    { id: "FIX-80", under: "Under OUT-3, outside this project" },
  ]);
});

test("disconnected, unbound and failed reads say what happened without asking for a sync", () => {
  const disconnected = deriveBoard(input(snapshot([issue("FIX-4")], [], { syncedAt: null }), {
    connection: { status: "disconnected", message: "Connect Linear in Squadron settings." },
  }));
  assert.deepEqual([disconnected.board.linear?.state, disconnected.board.linear?.message],
    ["disconnected", "Connect Linear in Squadron settings."]);

  const unbound = deriveBoard(input(snapshot([], [], { binding: null, syncedAt: null })));
  assert.deepEqual([unbound.board.linear?.state, unbound.board.linear?.project], ["unbound", null]);

  const failed = deriveBoard(input(snapshot([issue("FIX-4")], [], { error: "Linear is unavailable. Try again shortly." })));
  assert.deepEqual([failed.board.linear?.state, failed.board.linear?.message],
    ["failed", "Linear is unavailable. Try again shortly."]);
  assert.deepEqual(failed.board.unplanned.map((row) => row.id), ["FIX-4"], "the last good copy stays on the board");
});

test("connecting Linear and choosing a project wait on the owner before anything else", () => {
  const { board } = deriveBoard(input(snapshot([], [], { binding: null, syncedAt: null })));
  assert.deepEqual(needsYou(board).map(({ kind, text }) => ({ kind, text })), [
    { kind: "setup", text: "Choose the Linear team and project for this BB project." },
  ]);
});
