// SQD-218: the wide sortie line keeps its tail card and dependency rail,
// sharing live steps and the contrail with narrow lanes.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Board, Lane, Route, Ticket } from "../lib/board-model.js";
import { elements, parse, visibleText, type Element } from "./fixtures/owner-text.js";

const route: Route = { family: "gpt", model: "gpt-6.1-sol", effort: "medium" };
const ticket = (id: string, state: Ticket["state"], extra: Partial<Ticket> = {}): Ticket =>
  ({ id, title: `Ticket ${id}`, blockedBy: [], route, state, minutes: 4, ...extra });
const lane = (specId: string, extra: Partial<Lane> = {}): Lane => ({
  specId, title: `Spec ${specId}`, lead: route, leadThreadId: `thr_lead_${specId}`, branch: `bb/lead-${specId.toLowerCase()}`,
  state: "flying", minutes: 12, acceptOwner: false, workingThreads: 2,
  liveStep: { status: "active", step: "Waiting on worker", since: null },
  tickets: [ticket("FIX-11", "working", { threadId: "thr_worker", liveStep: { status: "active", step: "Running npm test", since: null } })],
  ...extra,
});

async function view(lanes: Lane[]): Promise<Element> {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, lanes, ready: [], shaping: [], openIssues: [] };
  return parse(renderToStaticMarkup(createElement(BoardView, {
    board, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined, placement: "page",
  })));
}

const byClass = (root: Element, name: string) => elements(root).filter((element) => element.attrs.class?.split(" ").includes(name));
const one = (root: Element, name: string) => {
  const found = byClass(root, name);
  assert.equal(found.length, 1, `one .${name}`);
  return found[0]!;
};

test("wide lanes keep their tail cards and dependency rails, with a contrail inside each tail", async () => {
  const root = await view([lane("FIX-1", { workingThreads: 3 }), lane("FIX-2", { workingThreads: 0 })]);
  const lines = byClass(root, "sq-line");
  assert.equal(lines.length, 2);
  assert.equal(byClass(root, "sq-lane-row").length, 0, "the wide board keeps its tail cards");
  for (const [index, line] of lines.entries()) {
    const tail = one(line, "sq-tail");
    const trail = one(tail, "sq-contrail");
    assert.equal(trail.attrs["data-wind"], "3", "every lane blows in the board's one wind: three working agents");
    assert.deepEqual([trail.attrs["data-done"], trail.attrs["data-total"]], ["0", "1"], `${index}: no ticket in the branch yet`);
    assert.equal(trail.attrs["aria-hidden"], "true");
    assert.equal(elements(trail).filter((element) => element.tag === "canvas").length, 1);
    assert.equal(one(tail, "sq-lead").tag, "button");
    assert.match(visibleText(one(tail, "sq-lead")), /Waiting on worker/);
    assert.match(visibleText(one(line, "sq-rail")), /Running npm test/);
    assert.equal(one(line, "sq-peg").tag, "button", "ticket still opens its thread");
  }
});

test("wide Flying lanes leave Flying to the section; other lane states retain their word", async () => {
  const root = await view([
    lane("FIX-1"), lane("FIX-2", { state: "stopped", stopped: true }),
    lane("FIX-3", { state: "pr-open" }), lane("FIX-4", { state: "merge-waits", acceptOwner: true }),
  ]);
  const tails = byClass(root, "sq-tail");
  assert.equal(tails.length, 4);
  assert.doesNotMatch(visibleText(tails[0]!), /Flying/, "the section already names Flying");
  assert.equal(byClass(tails[0]!, "sq-lane-state").length, 0);
  assert.deepEqual(tails.slice(1).map((tail) => visibleText(one(tail, "sq-lane-state"))), ["Stopped", "In review", "Merge waits on you"]);
  assert.equal(visibleText(one(tails[0]!, "sq-time")), "12m", "dropping the repeated state keeps the time");
});

test("wide pegs share live steps, problem words and the empty fallback with narrow rows", async () => {
  const root = await view([lane("FIX-1", {
    liveStep: { status: "error", step: "No recent activity", since: null },
    tickets: [
      ticket("FIX-11", "working", { threadId: "thr_work", liveStep: { status: "active", step: "Running npm test", since: null } }),
      ticket("FIX-12", "review", { threadId: "thr_review", liveStep: { status: "active", step: "Reviewing changes", since: null } }),
      ticket("FIX-13", "question", { threadId: "thr_question", liveStep: { status: "waiting-for-host", step: "No recent activity", since: null } }),
      ticket("FIX-14", "failed", { threadId: "thr_error", liveStep: { status: "error", step: "No recent activity", since: null } }),
      ticket("FIX-15", "working"),
      ticket("FIX-16", "blocked", { blockedBy: ["FIX-11"] }),
      ticket("FIX-17", "branch"),
    ],
  })]);
  assert.equal(visibleText(one(one(root, "sq-lead"), "sq-live-step")), "Error · No recent activity");
  const pegs = byClass(root, "sq-peg");
  assert.deepEqual(pegs.slice(0, 5).map((peg) => visibleText(one(peg, "sq-live-step"))), [
    "Running npm test", "Reviewing changes", "Waiting for machine · No recent activity", "Error · No recent activity", "No recent activity",
  ]);
  assert.equal(one(pegs[2]!, "sq-live-step").attrs["data-status"], "waiting-for-host");
  assert.equal(one(pegs[3]!, "sq-live-step").attrs["data-status"], "error");
  assert.equal(byClass(pegs[5]!, "sq-live-step").length, 0, "waiting tickets have no active thread to read");
  assert.equal(byClass(pegs[6]!, "sq-live-step").length, 0, "in-branch pegs stay compact");
});

test("route chips show the provider and advertised effort without relabeling it medium", async () => {
  const root = await view([lane("FIX-1", { lead: {
    providerId: "fixture-provider", family: "unknown", model: "fixture-model", effort: "max",
  } })]);
  const chip = byClass(root, "sq-ai").find((element) => element.attrs.title?.includes("fixture-model"));
  assert.ok(chip);
  assert.equal(chip.attrs.title, "fixture-provider · fixture-model · max effort");
  assert.match(visibleText(chip), /max/);
});
