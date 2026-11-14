import { test } from "node:test";
import assert from "node:assert/strict";
import { helperCore } from "../lib/helper-core.js";
import { blocks, input, issue, snapshot } from "./fixtures/board-snapshots.js";
import type { LaneRun } from "../lib/lane-contract.js";

test("Start on a ready spec asks the Helper to start its Lead with the spec route", () => {
  const result = helperCore({ ...input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent", "ui"] }),
    issue("FIX-2", { parent: "FIX-1" }),
  ])), action: { type: "start", specId: "FIX-1" } });
  assert.deepEqual(result.start, { allowed: true });
  assert.deepEqual(result.commands, [{ type: "start-lead", specIssueId: "fix-1", specId: "FIX-1",
    route: { family: "claude", model: "claude-opus-5-5", effort: "high" } }]);
  assert.equal(result.board.ready[0].startReason, null);
});

test("an open cross-spec blocker holds Start and a completed blocker releases it", () => {
  const start = (done: boolean) => helperCore({ ...input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" }),
    issue("OUT-9", { outside: true, done }),
  ], [blocks("OUT-9", "FIX-1")])), action: { type: "start", specId: "FIX-1" } });
  assert.deepEqual(start(false).start, { allowed: false, reason: "Waits on OUT-9 (outside this project)" });
  assert.deepEqual(start(false).commands, []);
  assert.deepEqual(start(true).start, { allowed: true });
});

test("starting, flying and stopped lanes hold capacity; landed lanes free a slot", () => {
  const lanes: LaneRun[] = ["starting", "flying", "stopped"].map((state, i) => ({
    id: `lane-${i}`, bbProjectId: "proj-one", workspaceId: "workspace-one", specIssueId: `other-${i}`,
    specId: `FIX-${i + 10}`, title: "Existing lane", route: { family: "gpt", model: "gpt-6.1-sol", effort: "high" },
    state: state as LaneRun["state"], startedAt: 0, leadThreadId: `thr_${i}`, environmentId: `env_${i}`,
    branch: `spec/other-${i}`, acceptOwner: false,
  }));
  const start = () => helperCore({ ...input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" }),
  ])), lanes, action: { type: "start", specId: "FIX-1" } });
  assert.deepEqual(start().start, { allowed: false, reason: "All lane slots are full." });
  assert.deepEqual(start().commands, []);
  lanes[0].state = "landed";
  assert.deepEqual(start().start, { allowed: true });
});
