import { test } from "node:test";
import assert from "node:assert/strict";
import { helperCore, rebuildLaneLinks } from "../lib/helper-core.js";
import { input, issue, snapshot } from "./fixtures/board-snapshots.js";

test("restart snapshot rebuilds issue, child, branch links without claiming execution or authority", () => {
  const mirror = snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" })]);
  const links = rebuildLaneLinks(mirror, [], [
    { threadId: "thr_lead", projectId: "proj-one", laneId: "lane-1", specIssueId: "fix-1", specId: "FIX-1", role: "Lead",
      parentThreadId: null, branch: "bb/integration", environmentId: "env-lead", startedAt: 100,
      route: { family: "gpt", model: "gpt-6.1-sol", effort: "high" } },
    { threadId: "thr_worker", projectId: "proj-one", laneId: "lane-1", specIssueId: "fix-1", specId: "FIX-1", role: "Worker", ticketIssueId: "fix-2", ticketId: "FIX-2",
      parentThreadId: "thr_lead", branch: "bb/worker", environmentId: "env-worker", startedAt: 110,
      route: { family: "gpt", model: "gpt-6.1-sol", effort: "high" } },
  ]);
  assert.equal(links.length, 1);
  assert.deepEqual([links[0].leadThreadId, links[0].branch, links[0].recoveryOnly, links[0].state], ["thr_lead", "bb/integration", true, "stopped"]);
  assert.deepEqual(links[0].workers?.map((w) => [w.threadId, w.branch, w.state, w.commit, w.writes]), [["thr_worker", "bb/worker", "failed", undefined, undefined]]);
  const result = helperCore({ ...input(mirror), lanes: links, action: { type: "spawn-worker", laneId: "lane-1", ticketId: "FIX-2" } });
  assert.equal(result.worker?.allowed, false);
  assert.equal(result.board.lanes.length, 1);
  assert.match(result.board.lanes[0].stopReason ?? "", /unproven/i);
  assert.deepEqual(result.commands, []);
});
