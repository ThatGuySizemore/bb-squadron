import { test } from "node:test";
import assert from "node:assert/strict";
import { helperCore } from "../lib/helper-core.js";
import { needsYou } from "../lib/board-model.js";
import { input, snapshot, issue } from "./fixtures/board-snapshots.js";
import type { LaneRun } from "../lib/lane-contract.js";

const route = { family: "gpt" as const, model: "gpt-6.1-sol", effort: "high" as const };
const lane: LaneRun = { id: "lane", bbProjectId: "proj-one", workspaceId: "workspace", specId: "FIX-1", specIssueId: "fix-1",
  title: "A spec", route, state: "flying", startedAt: 0, leadThreadId: "lead", environmentId: "env", branch: "spec/fix-1", acceptOwner: false };
const work = { id: "worker", ticketIssueId: "fix-2", ticketId: "FIX-2", route, startedAt: 0, state: "working" as const,
  threadId: "worker-thread", environmentId: "env-worker", branch: "bb/worker" };
const snap = () => snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" }), issue("FIX-3", { parent: "FIX-1" })]);

test("a worker's open question shows on its ticket and in Needs you with its worker thread", () => {
  const asked: LaneRun = { ...lane, workers: [{ ...work, question: { id: "q-1", text: "Which copy should the empty state use?", askedAt: 10 } }] };
  const { board } = helperCore({ ...input(snap()), lanes: [asked] });
  const ticket = board.lanes[0].tickets.find((item) => item.id === "FIX-2");
  assert.equal(ticket?.state, "question");
  assert.equal(ticket?.question, "Which copy should the empty state use?");
  assert.deepEqual(needsYou(board).map(({ kind, specId, ticketId, text, threadId, notifyKey }) => ({ kind, specId, ticketId, text, threadId, notifyKey })), [{
    kind: "question", specId: "FIX-1", ticketId: "FIX-2", text: "Which copy should the empty state use?", threadId: "worker-thread", notifyKey: "question:FIX-2:q-1",
  }]);
  const answered: LaneRun = { ...lane, workers: [{ ...work }] };
  assert.equal(helperCore({ ...input(snap()), lanes: [answered] }).board.lanes[0].tickets.find((item) => item.id === "FIX-2")?.state, "working");
  assert.deepEqual(needsYou(helperCore({ ...input(snap()), lanes: [answered] }).board), []);
});

test("each stop of a lane is a separate Needs-you item identity, and resuming clears it", () => {
  const stopped: LaneRun = { ...lane, state: "stopped", stopReason: "You stopped this lane.", stoppedAt: 100 };
  const first = needsYou(helperCore({ ...input(snap()), lanes: [stopped] }).board);
  assert.deepEqual(first.map(({ kind, specId, text, threadId, notifyKey }) => ({ kind, specId, text, threadId, notifyKey })), [{
    kind: "stopped", specId: "FIX-1", text: "You stopped this lane.", threadId: "lead", notifyKey: "stopped:FIX-1:100",
  }]);
  assert.deepEqual(needsYou(helperCore({ ...input(snap()), lanes: [{ ...stopped, state: "flying" }] }).board), []);
  assert.equal(needsYou(helperCore({ ...input(snap()), lanes: [{ ...stopped, stoppedAt: 200 }] }).board)[0].notifyKey, "stopped:FIX-1:200");
});

test("a canceled lane returns its spec to Ready with its kept branch, frees its slot and is skipped by auto-start", () => {
  const canceled: LaneRun = { ...lane, state: "canceled", canceledAt: 300, workers: [{ ...work, question: { id: "q-1", text: "Old question", askedAt: 10 } }] };
  const { board } = helperCore({ ...input(snap()), lanes: [canceled] });
  assert.deepEqual(board.lanes, []);
  assert.deepEqual(board.ready.map(({ id, startReason, keptBranch }) => ({ id, startReason, keptBranch })), [
    { id: "FIX-1", startReason: null, keptBranch: "spec/fix-1" },
  ]);
  assert.deepEqual(needsYou(board), []);
  const full = [2, 3, 4].map((i) => ({ ...lane, id: `other-${i}`, specId: `FIX-${i}0`, specIssueId: `fix-${i}0` }));
  assert.equal(helperCore({ ...input(snap()), lanes: [canceled, ...full.slice(0, 2)] }).board.ready[0].startReason, null,
    "a canceled lane holds no lane slot");
  assert.deepEqual(helperCore({ ...input(snap()), lanes: [canceled], autoStart: true, action: { type: "reconcile" } }).commands, [],
    "auto-start never restarts a spec the owner canceled");
  assert.deepEqual(helperCore({ ...input(snap()), lanes: [canceled], action: { type: "start", specId: "FIX-1" } }).start, { allowed: true },
    "the owner can start it again by hand");
});
