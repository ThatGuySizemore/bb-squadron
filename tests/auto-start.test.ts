import { test } from "node:test";
import assert from "node:assert/strict";
import { helperCore } from "../lib/helper-core.js";
import { blocks, input, issue, snapshot } from "./fixtures/board-snapshots.js";
import type { LaneRun } from "../lib/lane-contract.js";

test("auto-start selects the next unblocked spec only when enabled and below capacity", () => {
  const snap = snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" }),
    issue("FIX-5", { labels: ["ready-for-agent", "ui"] }), issue("FIX-6", { parent: "FIX-5" }),
    issue("OUT-9", { outside: true }),
  ], [blocks("OUT-9", "FIX-1")]);
  assert.deepEqual(helperCore(input(snap, { action: { type: "reconcile" } })).commands, []);
  const enabled = input(snap, { autoStart: true, action: { type: "reconcile" } });
  assert.deepEqual(helperCore(enabled).commands, [{ type: "start-lead", specIssueId: "fix-5", specId: "FIX-5",
    route: { family: "claude", model: "claude-opus-5-5", effort: "high" } }]);
  const lanes: LaneRun[] = ["starting", "flying", "stopped"].map((state, i) => ({
    id: `lane-${i}`, bbProjectId: "proj-one", workspaceId: "fixture-workspace", specIssueId: `other-${i}`,
    specId: `FIX-${i + 10}`, title: "Existing lane", route: { family: "gpt", model: "gpt-6.1-sol", effort: "high" },
    state: state as LaneRun["state"], startedAt: 0, leadThreadId: null, environmentId: null, branch: null, acceptOwner: false,
  }));
  assert.deepEqual(helperCore({ ...enabled, lanes }).commands, []);
  lanes[0].state = "landed";
  assert.deepEqual(helperCore({ ...enabled, lanes }).commands.map((command) => command.type), ["start-lead"]);
  assert.equal(helperCore(enabled).board.autoStart, true);
  assert.deepEqual(helperCore(input(snap, { autoStart: true })).commands, [], "board reads never launch work");
});

test("auto-start uses the manual Start gates for freshness, connection, settings and a ticket frontier", () => {
  const snap = snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-5", { labels: ["ready-for-agent"] }), issue("FIX-6", { parent: "FIX-5" }),
    issue("OUT-9", { outside: true }),
  ], [blocks("OUT-9", "FIX-6")]);
  const overrides = { autoStart: true, action: { type: "reconcile" } };
  assert.deepEqual(helperCore(input(snap, overrides)).commands, [], "no tickets or a blocked frontier cannot start");
  const ready = snapshot([issue("FIX-5", { labels: ["ready-for-agent"] }), issue("FIX-6", { parent: "FIX-5" })]);
  assert.deepEqual(helperCore(input(ready, { ...overrides, settings: null })).commands, []);
  assert.deepEqual(helperCore(input(ready, { ...overrides, connection: { status: "disconnected", message: "Connect Linear." } })).commands, []);
  assert.deepEqual(helperCore(input({ ...ready, error: "Linear couldn't refresh." }, overrides)).commands, []);
  const stale = helperCore(input({ ...ready, syncedAt: null }, overrides));
  assert.deepEqual(stale.commands, [{ type: "sync", reason: "catch-up" }]);
});
