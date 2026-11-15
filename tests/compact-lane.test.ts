// SQD-216: in narrow layouts (the side panel, and boards 900px wide and under)
// each Flying lane is one compact row, with a thin pace line along its bottom
// edge, instead of the tall tail card and its separate airstream band.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Board, Lane, Route, Ticket } from "../lib/board-model.js";
import { elements, parse, visibleText, type Element } from "./fixtures/owner-text.js";
import { airstream, createSurface } from "../lib/dither.js";

const route: Route = { family: "claude", model: "claude-opus-5-5", effort: "high" };
const ticket = (id: string, state: Ticket["state"], extra: Partial<Ticket> = {}): Ticket =>
  ({ id, title: `Ticket ${id}`, blockedBy: [], route, state, minutes: 0, ...extra });
const lane = (specId: string, extra: Partial<Lane> = {}): Lane => ({
  specId, title: `Spec ${specId}`, lead: route, leadThreadId: `thr_lead_${specId}`, branch: `bb/lead-${specId.toLowerCase()}-thr_x`,
  state: "flying", minutes: 12, acceptOwner: false, workingThreads: 2,
  liveStep: { status: "active", step: "Waiting on worker", since: null },
  tickets: [ticket(`${specId}-A`, "done"), ticket(`${specId}-B`, "working", { threadId: "thr_w" }), ticket(`${specId}-C`, "blocked")],
  ...extra,
});
const board = (lanes: Lane[]): Board =>
  ({ tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, lanes, ready: [], shaping: [], openIssues: [] });

async function view(lanes: Lane[], placement: "page" | "panel" = "panel"): Promise<Element> {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  return parse(renderToStaticMarkup(createElement(BoardView, {
    board: board(lanes), demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined, placement,
  })));
}

const hasClass = (element: Element, name: string) => element.attrs.class?.split(" ").includes(name) ?? false;
const byClass = (root: Element, name: string) => elements(root).filter((element) => hasClass(element, name));
const one = (root: Element, name: string) => {
  const found = byClass(root, name);
  assert.equal(found.length, 1, `one .${name}`);
  return found[0]!;
};

test("work items use the compact row at both widths, with their tag and live step but no ticket list", async () => {
  for (const placement of ["page", "panel"] as const) {
    const root = await view([lane("FIX-9", { kind: "work-item", title: "One standalone fix", tickets: [] })], placement);
    const row = one(root, "sq-lane-row");
    assert.equal(visibleText(one(row, "sq-work-kind")), "Work item");
    assert.match(visibleText(one(row, "sq-live-step")), /Waiting on worker/);
    assert.equal(byClass(root, "sq-tail").length, 0);
    assert.equal(byClass(root, "sq-all").length, 0);
    assert.equal(byClass(root, "sq-progress").length, 0);
    assert.equal(byClass(root, "sq-rail").length, 0);
    assert.ok(elements(row).some((element) => element.tag === "button" && visibleText(element) === "Stop"));
    assert.ok(elements(row).some((element) => element.attrs["data-term"] === "Work item"), "shared glossary hover text");
  }
});

test("Flying specs show their total ticket tag in wide tails and narrow rows", async () => {
  for (const placement of ["page", "panel"] as const) {
    const root = await view([lane("FIX-1", { totalTicketCount: 5 })], placement);
    assert.equal(visibleText(one(root, "sq-work-kind")), "Spec · 5 tickets");
  }
});

test("in a narrow layout each Flying lane is one compact row: tail number, title, Lead and step, time, PR and actions", async () => {
  const root = await view([
    lane("FIX-1", { pr: { number: 11, url: "https://github.com/o/r/pull/11", checks: "passing" } }),
    lane("FIX-2"), lane("FIX-3"),
  ]);
  const rows = byClass(root, "sq-lane-row");
  assert.equal(rows.length, 3, "one row per lane");
  assert.equal(byClass(root, "sq-tail").length, 0, "no tall tail card");
  assert.equal(byClass(root, "sq-air-band").length, 0, "no separate airstream band");

  const first = rows[0]!;
  const number = one(first, "sq-tail-number");
  assert.equal(visibleText(number), "FIX-1");
  const svg = elements(number).find((element) => element.tag === "svg")!;
  assert.equal(svg.attrs.height, "14", "the tail number drops to the 2px cell (7 rows, no gap)");
  assert.equal(visibleText(one(first, "sq-line-title")), "Spec FIX-1");
  const lead = one(first, "sq-lead");
  assert.equal(lead.tag, "button");
  assert.match(visibleText(lead), /Lead/);
  assert.match(visibleText(one(lead, "sq-live-step")), /Waiting on worker/);
  assert.equal(visibleText(one(first, "sq-time")), "12m");
  assert.equal(one(first, "sq-pr").attrs["aria-label"], "PR #11, checks pass. Open on GitHub.");
  assert.ok(elements(one(first, "sq-actions")).some((element) => element.tag === "button" && visibleText(element) === "Stop"));
  assert.equal(byClass(rows[1]!, "sq-pr").length, 0, "no PR chip without a PR");
});

test("a Flying lane row doesn't repeat Flying; Stopped, In review and Merge waits keep their word", async () => {
  const root = await view([
    lane("FIX-1"),
    lane("FIX-2", { state: "stopped", stopped: true, workingThreads: 0 }),
    lane("FIX-3", { state: "pr-open", pr: { number: 3, url: "https://github.com/o/r/pull/3", checks: "pending" } }),
    lane("FIX-4", { state: "merge-waits", acceptOwner: true, pr: { number: 4, url: "https://github.com/o/r/pull/4", checks: "passing" } }),
  ]);
  const rows = byClass(root, "sq-lane-row");
  assert.equal(rows.length, 4);
  assert.doesNotMatch(visibleText(rows[0]!), /Flying/, "the section header already says Flying");
  assert.equal(byClass(rows[0]!, "sq-lane-state").length, 0);
  assert.deepEqual(rows.slice(1).map((row) => visibleText(one(row, "sq-lane-state"))), ["Stopped", "In review", "Merge waits on you"]);
  const lines = byClass(root, "sq-line");
  assert.deepEqual(lines.map((line) => /Flying/.test(visibleText(line))), [false, false, false, false],
    "no lane says Flying anywhere in its line");
});

test("the branch isn't shown as text in the row; it is the row's hover title and sits in the lane's ticket list", async () => {
  const root = await view([lane("FIX-1")]);
  const row = one(root, "sq-lane-row");
  assert.doesNotMatch(visibleText(row), /bb\/lead-fix-1/);
  assert.equal(row.attrs.title, "Branch bb/lead-fix-1-thr_x");
  const details = elements(root).find((element) => element.tag === "details" && hasClass(element, "sq-all"))!;
  assert.equal(visibleText(one(details, "sq-all-branch")), "Branch bb/lead-fix-1-thr_x");
});

test("the pace line runs along the row's bottom edge at the lane's working-thread pace, still when none work", async () => {
  const root = await view([lane("FIX-1", { workingThreads: 3 }), lane("FIX-2", { workingThreads: 0 }), lane("FIX-3", { workingThreads: undefined })]);
  const rows = byClass(root, "sq-lane-row");
  const paces = rows.map((row) => one(row, "sq-pace-line"));
  assert.deepEqual(paces.map((pace) => pace.attrs["data-pace"]), ["3", "0", "0"]);
  for (const pace of paces) {
    assert.equal(pace.attrs["aria-hidden"], "true", "motion carries no meaning on its own; the ticket rows say who works");
    assert.equal(rows.includes(pace.parent!), true, "the pace line sits inside the lane row");
    assert.equal(elements(pace).filter((element) => element.tag === "canvas").length, 1);
  }

  // The airstream painter fills an 8px strip at 2x density, and stays still with no work.
  const ink = 0xffd6a73f;
  const strip = createSurface(320, 8, 2);
  airstream({ pace: 3, ink })(strip, 1);
  assert.ok(strip.buf.some((pixel) => pixel === ink), "a working lane's strip carries sky pixels");
  const still = createSurface(320, 8, 2);
  const paintStill = airstream({ pace: 0, ink });
  paintStill(still, 0);
  const first = [...still.buf];
  paintStill(still, 5);
  assert.deepEqual([...still.buf], first, "no working threads: the same frame at any time");
});

test("the full page takes the narrow layout at 900px wide and under; a side panel always does", async () => {
  await import("./fixtures/app-runtime.js");
  const { boardLayout } = await import("../board/Board.js");
  assert.equal(boardLayout("page", 1200), "wide");
  assert.equal(boardLayout("page", 901), "wide");
  assert.equal(boardLayout("page", 900), "narrow");
  assert.equal(boardLayout("page", 560), "narrow");
  assert.equal(boardLayout("page", null), "wide", "before the page is measured, the full page stays wide");
  assert.equal(boardLayout("panel", null), "narrow");
  assert.equal(boardLayout("panel", 1400), "narrow");

  const page = await view([lane("FIX-1")], "page");
  assert.equal(byClass(page, "sq-lane-row").length, 0, "the wide page keeps its tail card");
  assert.equal(byClass(page, "sq-tail").length, 1);
});


test("compact Merge waits controls retain both actions and allow each flex group to wrap", async () => {
  const root = await view([lane("FIX-1", { state: "merge-waits", stopped: true, acceptOwner: true,
    pr: { number: 11, url: "https://github.com/o/r/pull/11", checks: "passing", state: "open" } })]);
  const end = one(root, "sq-lane-row-end");
  assert.equal(visibleText(one(end, "sq-lane-state")), "Merge waits on you");
  assert.deepEqual(elements(one(end, "sq-actions")).filter((node) => node.tag === "button").map(visibleText), ["Merge", "Resume"]);
  assert.equal(one(end, "sq-pr").attrs["aria-label"], "PR #11, checks pass. Open on GitHub.");
  // Static style contract only. JSDOM cannot prove rendered widths or line wrapping.
  const css = readFileSync("board/board.css", "utf8");
  const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split("}")[0]!;
  assert.match(rule(".sq-lane-row-end"), /flex-wrap:\s*wrap;/);
  assert.match(rule(".sq-lane-row-end"), /flex:\s*0 1 auto;/, "controls can shrink when the group exceeds the panel");
  assert.match(rule(".sq-lane-row-end"), /min-width:\s*0;/);
  assert.match(rule(".sq-lane-row .sq-actions"), /flex-wrap:\s*wrap;/);
  assert.match(rule(".sq-lane-row .sq-actions"), /min-width:\s*0;/);
});
