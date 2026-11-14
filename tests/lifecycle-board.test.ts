import { test } from "node:test";
import assert from "node:assert/strict";
import type { Board } from "../lib/board-model.js";

const route = { family: "gpt" as const, model: "gpt-6.1-sol", effort: "high" as const };

async function render(board: Board, props: Record<string, unknown> = {}) {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  return renderToStaticMarkup(createElement(BoardView, { board, demo: false, modeSwitch: null, onPlan: () => undefined, dispatch: () => undefined, ...props }));
}

test("a stopped lane offers Resume, Re-plan and Cancel in Needs you, and a question offers Answer in thread", async () => {
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, unplanned: [], ready: [], lanes: [
    { specId: "FIX-5", title: "Stopped spec", lead: route, leadThreadId: "thr_lead", branch: "bb/integration", state: "stopped", minutes: 3,
      acceptOwner: false, stopReason: "You stopped this lane.", stoppedAt: 1, tickets: [] },
    { specId: "FIX-9", title: "Flying spec", lead: route, leadThreadId: "thr_lead_9", branch: "bb/nine", state: "flying", minutes: 3, acceptOwner: false,
      tickets: [{ id: "FIX-10", title: "Asks", blockedBy: [], route, state: "question", question: "Which wording?", questionId: "q", minutes: 1, threadId: "thr_worker" }] },
  ] };
  const html = await render(board);
  const needs = html.slice(html.indexOf('class="sq-needs"'), html.indexOf('id="sq-flying-h"'));
  for (const label of ["Resume", "Re-plan", "Cancel", "Answer in thread"]) assert.match(needs, new RegExp(`>${label}</button>`), label);
  assert.ok(needs.includes("Which wording?"));
  assert.match(html, /<button[^>]*>Stop<\/button>/, "a flying lane offers Stop");
});

test("lane controls show their pending state, and an unconfirmed Lead can't be resumed", async () => {
  const lane = { specId: "FIX-5", title: "Stopped spec", lead: route, leadThreadId: "thr_lead", branch: "bb/integration", state: "stopped" as const,
    minutes: 3, acceptOwner: false, stopReason: "You stopped this lane.", tickets: [] };
  let html = await render({ tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, unplanned: [], ready: [], lanes: [lane] },
    { controlling: { specId: "FIX-5", action: "resume" } });
  assert.match(html, /<button[^>]*disabled=""[^>]*>Resuming…<\/button>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Cancel<\/button>/, "other controls wait for the pending one");
  assert.match(html, /role="status"[^>]*>Resuming FIX-5/);
  html = await render({ tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, unplanned: [], ready: [],
    lanes: [{ ...lane, leadThreadId: null, stopReason: "The Lead spawn result is unknown. Check BB threads." }] });
  assert.doesNotMatch(html, /<button[^>]*data-tone="amber"[^>]*>Resume<\/button>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Resume<\/button>/);
});

test("a canceled spec waits in Ready with its kept branch", async () => {
  const html = await render({ tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, unplanned: [], lanes: [],
    ready: [{ id: "FIX-5", title: "Canceled spec", ticketCount: 2, routes: [route], blockedBy: [], acceptOwner: false, startReason: null, keptBranch: "bb/integration" }] });
  assert.match(html, /Kept branch <span class="sq-mono">bb\/integration<\/span>/);
});

test("the board's lane controls call their RPC, then refresh, and report refusals", async () => {
  await import("./fixtures/app-runtime.js");
  const { laneControlFromBoard } = await import("../board/Board.js");
  const calls: unknown[] = [];
  const deps = { call: async (method: string, input: unknown) => { calls.push([method, input]); return { state: "stopped" }; },
    refresh: async () => { calls.push("refresh"); }, notify: (text: string) => { calls.push(text); } };
  await laneControlFromBoard(deps, "proj-one", "stop", "FIX-5");
  assert.deepEqual(calls, [["lanes.stop", { projectId: "proj-one", specId: "FIX-5" }], "refresh"]);
  calls.length = 0;
  await laneControlFromBoard({ ...deps, call: async () => { throw new Error("Only a stopped lane can resume."); } }, "proj-one", "resume", "FIX-5");
  assert.deepEqual(calls, ["Only a stopped lane can resume.", "refresh"]);
});
