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

test("a stopped lane with an unconfirmed spawn shows its reason without a Lead button", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const route = { family: "gpt" as const, model: "gpt-6.1-sol", effort: "high" as const };
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, unplanned: [], ready: [],
    lanes: [{ specId: "FIX-5", title: "Unconfirmed lane", lead: route, leadThreadId: null, branch: "Preparing integration branch",
      state: "stopped", minutes: 0, acceptOwner: false, tickets: [], stopReason: "The Lead spawn result is unknown. Check BB threads." }],
  };
  const html = renderToStaticMarkup(createElement(BoardView, { board, demo: false, modeSwitch: null,
    onPlan: () => undefined, dispatch: () => undefined }));
  assert.ok(html.includes("Lead not confirmed") && html.includes("Check BB threads."));
  assert.ok(!html.includes('class="sq-lead"'), "an unknown thread has no Lead navigation control");
});

test("a Start response that is still provisioning opens the Lead and explains its reserved slot", async () => {
  await import("./fixtures/app-runtime.js");
  const { startLaneFromBoard } = await import("../board/Board.js");
  const calls: string[] = [];
  await startLaneFromBoard({ start: async () => ({ laneId: "lane-one", threadId: "thr_lead", branch: null, message: "Still preparing; slot reserved." }),
    openThread: (id) => { calls.push(id); }, notify: (message) => { calls.push(message); }, refresh: async () => { calls.push("refresh"); } }, "proj-one", "FIX-5");
  assert.deepEqual(calls, ["thr_lead", "Still preparing; slot reserved.", "refresh"]);
});

test("live ticket cards link workers and offer named route controls only before work starts", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const route = { family: "gpt" as const, model: "gpt-6.1-sol", effort: "high" as const };
  const choices = [route, { family: "claude" as const, model: "claude-opus-5-5", effort: "high" as const }];
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, ready: [], unplanned: [], lanes: [{
    specId: "FIX-5", title: "A lane", lead: route, leadThreadId: "thr_lead", branch: "bb/integration", state: "flying", minutes: 1, acceptOwner: false,
    tickets: [
      { id: "FIX-6", title: "Worker's ticket", blockedBy: [], route, state: "working", minutes: 1, threadId: "thr_worker" },
      { id: "FIX-7", title: "Next ticket", blockedBy: ["FIX-6"], route, routeChoices: choices, state: "blocked", minutes: 0 },
      { id: "FIX-8", title: "Ready ticket", blockedBy: [], route, routeChoices: choices, state: "ready", minutes: 0 },
      { id: "FIX-9", title: "Reported ticket", blockedBy: [], route, state: "review", reportPending: true, minutes: 1, threadId: "thr_reported" },
    ],
  }] };
  const html = renderToStaticMarkup(createElement(BoardView, { board, demo: false, modeSwitch: null,
    onPlan: () => undefined, dispatch: () => undefined, onRoute: async () => undefined }));
  assert.match(html, /Worker&#x27;s ticket: Working\. Open thread/);
  assert.equal((html.match(/<select/g) ?? []).length, 2);
  assert.match(html, /aria-label="Route for FIX-7"/);
  assert.match(html, /aria-label="Route for FIX-8"/);
  assert.ok(!html.includes('aria-label="Route for FIX-6"'));
  assert.ok(html.includes("Reported done"));
});

test("reviewer card names the saved reviewer AI and its thread rather than inferring a model from the worker", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const route = { family: "gpt" as const, model: "gpt-6.1-sol", effort: "high" as const };
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, ready: [], unplanned: [], lanes: [{
    specId: "FIX-5", title: "A lane", lead: route, leadThreadId: "lead", branch: "bb/integration", state: "flying", minutes: 0, acceptOwner: false,
    tickets: [{ id: "FIX-6", title: "Reviewed ticket", route, blockedBy: [], state: "review", minutes: 1, threadId: "worker",
      reviewer: { route: { family: "claude", model: "Actual reviewer model", effort: "high" }, threadId: "reviewer", state: "second-look", commit: "a".repeat(40), round: 1 } }],
  }] };
  const render = () => renderToStaticMarkup(createElement(BoardView, { board, demo: false, modeSwitch: null,
    onPlan: () => undefined, dispatch: () => undefined }));
  const html = render();
  assert.ok(html.includes("Actual reviewer model"));
  assert.ok(html.includes("Second look"));
  board.lanes[0].tickets[0].reviewer!.state = "fixing";
  assert.match(render(), /class="sq-peg-state">Awaiting second look<\/span>/);
  board.lanes[0].tickets[0].reviewer!.state = "second-look";
  assert.match(html, /aria-label="[^"]*Actual reviewer model[^"]*high[^"]*Open reviewer thread/);
  board.lanes[0].tickets[0].reviewer = { ...board.lanes[0].tickets[0].reviewer!, threadId: null, state: "spawning" };
  assert.ok(!render().includes("Open reviewer thread"), "an unconfirmed reviewer has no navigation button");
  board.lanes[0].tickets[0].reviewer = { ...board.lanes[0].tickets[0].reviewer!, state: "failed", threadId: "reviewer" };
  const failed = render();
  assert.ok(failed.includes("Review unconfirmed"));
  assert.doesNotMatch(failed, /aria-label="FIX-6,[^"]*: In review/);
  assert.match(failed, /class="sq-peg-state">Review unconfirmed<\/span>/);
  assert.match(failed, /Open reviewer thread/);
  board.lanes[0].tickets[0].reviewer.threadId = null;
  assert.ok(!render().includes("Open reviewer thread"));
  delete board.lanes[0].tickets[0].reviewer;
  assert.ok(render().includes("Reported done"), "a missing reviewer must never invent reviewer identity");
});
