import { test } from "node:test";
import assert from "node:assert/strict";
import type { Board } from "../lib/board-model.js";

test("the board starts a lane through RPC, opens its Lead, refreshes and reports refusals", async () => {
  await import("./fixtures/app-runtime.js");
  const { startLaneFromBoard } = await import("../board/Board.js");
  const calls: unknown[] = [];
  await startLaneFromBoard({
    start: async (input) => { calls.push(input); return { laneId: "lane-one", threadId: "thr_lead", branch: "bb/lead" }; },
    openThread: (id) => { calls.push(id); }, refresh: async () => { calls.push("refresh"); },
    notify: (text) => { calls.push(text); },
  }, "proj-one", "FIX-5");
  assert.deepEqual(calls, [{ projectId: "proj-one", specId: "FIX-5" }, "thr_lead", "refresh"]);
  calls.length = 0;
  await startLaneFromBoard({
    start: async () => { throw new Error("All lane slots are full."); },
    openThread: (id) => { calls.push(id); }, refresh: async () => { calls.push("refresh"); },
    notify: (text) => { calls.push(text); },
  }, "proj-one", "FIX-5");
  assert.deepEqual(calls, ["All lane slots are full.", "refresh"]);
});

test("Starting is visibly disabled and a Flying lane renders its Lead control and branch", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const route = { family: "gpt" as const, model: "gpt-6.1-sol", effort: "high" as const };
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, unplanned: [],
    ready: [{ id: "FIX-5", title: "Doctor", ticketCount: 1, routes: [route], blockedBy: [], acceptOwner: false, startReason: null }],
    lanes: [{ specId: "FIX-1", title: "Flying spec", lead: route, leadThreadId: "thr_lead", branch: "bb/lead-fix-1",
      state: "flying", minutes: 0, acceptOwner: false, tickets: [] }],
  };
  const html = renderToStaticMarkup(createElement(BoardView, { board, demo: false, modeSwitch: null, starting: "FIX-5",
    onPlan: () => undefined, dispatch: () => undefined }));
  assert.match(html, /<button[^>]*disabled=""[^>]*>Starting…<\/button>/);
  assert.match(html, /<button[^>]*class="sq-lead"/);
  assert.ok(html.includes("bb/lead-fix-1") && html.includes("Flying spec"));
});
