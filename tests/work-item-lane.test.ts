import { test } from "node:test";
import assert from "node:assert/strict";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { deriveBoard } from "../lib/board-derive.js";
import { boardSchema, needsYou } from "../lib/board-model.js";
import type { LeadThread } from "../lib/lead-threads.js";
import { input, issue, snapshot } from "./fixtures/board-snapshots.js";

const lead: LeadThread = {
  specId: "fix-9", kind: "work-item", branch: "work/fix-9",
  route: { family: "gpt", model: "gpt-6.1-sol", effort: "medium" },
  thread: makeThreadResponse({ id: "work-thread", environmentId: "work-env", projectId: "proj-one",
    status: "active", createdAt: Date.parse("2026-11-13T20:00:00Z") }),
};

test("a discovered work item stays Flying without a ready label or any child tickets", () => {
  const board = deriveBoard(input(snapshot([issue("FIX-9", { status: "In Progress" })]), { leads: [lead] })).board;
  assert.equal(board.lanes.length, 1);
  assert.equal(board.lanes[0].kind, "work-item");
  assert.equal(board.lanes[0].state, "flying");
  assert.deepEqual(board.lanes[0].tickets, []);
  assert.deepEqual([board.ready, board.shaping, board.openIssues], [[], [], []]);
  assert.equal(boardSchema.parse(board).lanes[0].kind, "work-item", "kind survives the shared RPC schema");
});

test("a no-remote work item exposes owner review from its own branch issue, then lands from main", () => {
  const snap = snapshot([issue("FIX-9", { labels: ["accept:owner"] })]);
  const branch = input(snapshot([issue("FIX-9", { labels: ["accept:owner"], done: true })]), { kind: "local-markdown" }).snapshot;
  const repository = { hasRemote: false, mergedBranches: [], mergedBranchUpdatedAt: {}, mainUpdatedAt: null };
  const board = deriveBoard(input(snap, { kind: "local-markdown", leads: [lead], repository,
    laneSnapshots: { "fix-9": branch } })).board;
  assert.equal(board.lanes[0].state, "merge-waits");
  assert.equal(board.lanes[0].localMerge, true);
  assert.deepEqual(board.lanes[0].tickets, []);
  assert.deepEqual(needsYou(board).map(({ kind }) => kind), ["merge"]);
  const landed = deriveBoard(input(snapshot([issue("FIX-9", { done: true })]), {
    kind: "local-markdown", leads: [lead], repository,
  })).board;
  assert.equal(landed.lanes[0].state, "landed");
  assert.equal(landed.lanes[0].kind, "work-item");
});

test("work-item stops, questions and failures retain the normal Needs you deduplication", () => {
  for (const [extra, expected] of [
    [{}, "stopped"],
    [{ hasPendingInteraction: true }, "waiting"],
    [{ status: "error" }, "failed"],
    [{ queuedWork: "failed" }, "blocked"],
  ] as const) {
    const board = deriveBoard(input(snapshot([issue("FIX-9")]), { leads: [{ ...lead,
      thread: { ...lead.thread, status: "idle", runtime: { displayStatus: "idle" }, ...extra },
    }] })).board;
    assert.equal(board.lanes[0].stopped, true);
    assert.deepEqual(needsYou(board).map(({ kind, threadId }) => [kind, threadId]), [[expected, "work-thread"]]);
  }
  const normal = deriveBoard(input(snapshot([issue("FIX-9")]), { now: 400_000, leads: [{ ...lead,
    idleSince: 100_000, thread: { ...lead.thread, status: "idle", runtime: { displayStatus: "idle" } },
  }] })).board;
  assert.equal(normal.lanes[0].stopped, false, "a normal idle turn keeps the existing quiet-question rule");
  assert.deepEqual(needsYou(normal).map(({ kind }) => kind), ["waiting"]);
});

test("a work item's accept:owner PR waits for passing checks and suppresses the quiet question", () => {
  const source = input(snapshot([issue("FIX-9", { labels: ["accept:owner"] })]), {
    now: 400_000, leads: [{ ...lead, idleSince: 100_000, thread: { ...lead.thread, status: "idle", runtime: { displayStatus: "idle" } } }],
  });
  for (const [checks, state, needs] of [["passing", "merge-waits", ["merge"]], ["failing", "pr-open", ["waiting"]]] as const) {
    const board = deriveBoard({ ...source, pullRequests: { "work-env": { outcome: "available", pullRequest: {
      number: 99, state: "open", url: "https://example.invalid/pull/99", updatedAt: "2026-11-13T20:00:00Z", checks: { state: checks },
    } } } }).board;
    assert.equal(board.lanes[0].state, state);
    assert.deepEqual(needsYou(board).map(({ kind }) => kind), [...needs]);
  }
});
