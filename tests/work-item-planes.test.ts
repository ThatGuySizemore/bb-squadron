// SQD-241: work item lanes in the bolder board. A one-item lane flies a
// smaller plane on its own stand, through the same lifecycle as a spec's, and
// its Flying row says "Work item" where a spec's says "Spec · N tickets".
import { test } from "node:test";
import assert from "node:assert/strict";
import { LANDING_MS, needsYou, nextLandings, TAKEOFF_MS, type Board, type Lane, type Landings } from "../lib/board-model.js";
import { workingAgents } from "../lib/working-agents.js";
import { createSurface, type Surface } from "../lib/dither.js";
import { planeBox, runway, runwayLayout, runwayMotion, runwayState, RUNWAY_HEIGHT, RUNWAY_PLANE, RUNWAY_WORK_ENGINES, RUNWAY_WORK_PLANE,
  type Box, type RunwayInks, type RunwayStand, type RunwayState } from "../lib/runway.js";

const route = { family: "gpt", model: "gpt-6.1-sol", effort: "medium" } as const;
const specLane = (patch: Partial<Lane> = {}): Lane => ({ specId: "A-1", title: "A spec", lead: route, leadThreadId: "thr_lead", branch: "spec/a-1",
  state: "flying", minutes: 3, acceptOwner: false, workingThreads: 2,
  tickets: [{ id: "A-2", title: "A ticket", blockedBy: [], route, state: "working", minutes: 3, threadId: "thr_w" }], ...patch });
/** A work item lane: no tickets, the lane's own kind says what it is. */
const itemLane = (patch: Partial<Lane> = {}): Lane => ({ specId: "FIX-9", title: "A work item", kind: "work-item", lead: route, leadThreadId: "thr_item",
  branch: "item/fix-9", state: "flying", minutes: 2, acceptOwner: false, workingThreads: 1, tickets: [], ...patch });
const boardOf = (lanes: Lane[]): Board => ({ tick: 0, laneCapacity: 2, workersPerLane: 2, autoStart: false, lanes, ready: [], shaping: [], openIssues: [] });

function update(previous: Landings | null, board: Board, now: number) {
  const moments = nextLandings(previous, board.lanes, now);
  const state = runwayState(board.lanes, board.laneCapacity, workingAgents(board.lanes), { needs: needsYou(board), landings: moments, now });
  return { moments, state };
}

// ---------- the lane's kind, read in the board update ----------

test("a work item's plane keeps its kind through takeoff, needs you, stop, resume and landing, beside a spec's", () => {
  let now = 1_000_000;
  let step = update(null, boardOf([]), now);
  const both = (item: Partial<Lane> = {}) => boardOf([specLane(), itemLane(item)]);

  now += 5_000;
  step = update(step.moments, both(), now);
  assert.deepEqual(step.state.stands, [
    { kind: "takeoff", laneId: "A-1", since: now, beacon: null, workKind: "spec" },
    { kind: "takeoff", laneId: "FIX-9", since: now, beacon: null, workKind: "work-item" },
  ]);

  now += TAKEOFF_MS + 15_000;
  step = update(step.moments, both(), now);
  assert.deepEqual(step.state.stands[1], { kind: "flying", laneId: "FIX-9", beacon: null, workKind: "work-item" });

  now += 15_000;
  step = update(step.moments, both({ needs: [{ threadId: "thr_item", kind: "waiting", text: "Which width?" }] }), now);
  assert.deepEqual(step.state.stands[1], { kind: "flying", laneId: "FIX-9", beacon: "waiting:thr_item", workKind: "work-item" });

  now += 15_000;
  step = update(step.moments, both({ state: "stopped", stopped: true, workingThreads: 0 }), now);
  assert.deepEqual(step.state.stands[1], { kind: "holding", laneId: "FIX-9", beacon: "stopped:FIX-9", workKind: "work-item" });

  now += 15_000;
  step = update(step.moments, both(), now);
  assert.deepEqual(step.state.stands[1], { kind: "flying", laneId: "FIX-9", beacon: null, workKind: "work-item" });

  // Landing: the plane stays small all the way down, and lands with the lane's burst.
  now += 15_000;
  step = update(step.moments, both({ state: "landed", workingThreads: 0 }), now);
  assert.deepEqual(step.state.stands[1], { kind: "landing", laneId: "FIX-9", since: now, workKind: "work-item" });
  assert.equal(step.moments.until["FIX-9"]! - LANDING_MS, now);

  now += LANDING_MS + 1;
  step = update(step.moments, both({ state: "landed", workingThreads: 0 }), now);
  assert.deepEqual(step.state.stands[1], { kind: "empty" });
});

test("the kind comes from the lane, never from its ticket count", () => {
  // A spec lane whose tickets aren't read yet still flies a spec's plane; a work item with a stray thread still flies small.
  const state = runwayState([specLane({ tickets: [] }), itemLane({ tickets: [{ ...specLane().tickets[0]! }] })], 2, 0);
  assert.deepEqual(state.stands.map((stand) => "workKind" in stand && stand.workKind), ["spec", "work-item"]);
});

// ---------- the smaller plane, painted ----------

const INKS: RunwayInks = {
  cloud: 0xff111111, tarmac: 0xff222222, line: 0xff333333, rule: 0xff444444, stand: 0xff555555, plane: 0xff0000ff,
  trail: 0xff00ff00, beacon: 0xff00aaff, holding: 0xffff0000,
};
function paint(state: RunwayState, seconds: number, width = 1200): Surface {
  const s = createSurface(width, RUNWAY_HEIGHT.wide, 1);
  runway({ state, narrow: false, label: "", inks: INKS })(s, seconds);
  return s;
}
const at = (s: Surface, x: number, y: number) => s.buf[y * s.w + x]!;
/** The bounding box and pixel count of one ink inside a box. */
function inked(s: Surface, ink: number, box: Box) {
  let n = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(s.h, Math.ceil(box.y + box.h)); y++) {
    for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(s.w, Math.ceil(box.x + box.w)); x++) {
      if (at(s, x, y) !== ink) continue;
      n++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  return { n, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2 };
}
const grow = (b: Box, m: number): Box => ({ x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m });
const cells = (shape: readonly string[]) => shape.join("").split("#").length - 1;
const spec = (patch: Partial<Extract<RunwayStand, { kind: "flying" }>> = {}): RunwayStand => ({ kind: "flying", laneId: "A-1", beacon: null, workKind: "spec", ...patch });
const item = (patch: Partial<Extract<RunwayStand, { kind: "flying" }>> = {}): RunwayStand => ({ kind: "flying", laneId: "FIX-9", beacon: null, workKind: "work-item", ...patch });

test("the work item plane is the same jet, smaller: nose right, a tail fin at the left, engines behind its main wings", () => {
  const rows = RUNWAY_WORK_PLANE.length, cols = RUNWAY_WORK_PLANE[0]!.length, mid = (rows - 1) / 2;
  assert.ok(cols < RUNWAY_PLANE[0]!.length && rows < RUNWAY_PLANE.length, "fewer cells each way than the spec plane");
  assert.ok(RUNWAY_WORK_PLANE.every((row) => row.length === cols), "a rectangular sprite");
  const nose = RUNWAY_WORK_PLANE.map((row, y) => [y, row.lastIndexOf("#")] as const).sort((a, b) => b[1] - a[1]);
  assert.deepEqual(nose[0], [mid, cols - 1], "one nose cell leads on the centre row");
  assert.ok(nose[1]![1] < cols - 1);
  const tall = RUNWAY_WORK_PLANE.filter((row) => row[0] === "#").length;
  assert.ok(tall > 1 && tall < rows, "a fin at the left edge");
  assert.equal(RUNWAY_WORK_ENGINES.length, 2);
  for (const { col, row } of RUNWAY_WORK_ENGINES) {
    assert.equal(RUNWAY_WORK_PLANE[row]![col], "#", "the engine is on the wing");
    assert.equal(RUNWAY_WORK_PLANE[row]!.slice(0, col).trim(), "", "at its trailing edge, clear of the tail");
    assert.ok(Math.abs(row - mid) >= 2, "out on the wing");
  }
  assert.ok(RUNWAY_WORK_ENGINES[0]!.row < mid && RUNWAY_WORK_ENGINES[1]!.row > mid, "one each side");
});

test("a work item's plane is visibly smaller than a spec's, centred on its own stand", () => {
  for (const width of [1200, 760]) {
    const g = runwayLayout(width, false, 2, "");
    const s = paint({ stands: [spec(), item()], working: 3 }, 0, width);
    const big = inked(s, INKS.plane, grow(g.stands[0]!.air, 4)), small = inked(s, INKS.plane, grow(g.stands[1]!.air, 4));
    assert.equal(big.n, cells(RUNWAY_PLANE) * g.cell * g.cell, `${width}: the spec plane is whole`);
    assert.equal(small.n, cells(RUNWAY_WORK_PLANE) * g.cell * g.cell, `${width}: the work item plane is whole`);
    assert.ok(small.n <= big.n * 0.6, `${width}: about half the spec plane's ink (${small.n} vs ${big.n})`);
    assert.ok(small.w <= big.w * 0.75 && small.h <= big.h * 0.8, `${width}: shorter and narrower (${small.w}x${small.h} vs ${big.w}x${big.h})`);
    // Its own stand: centred where a spec plane on that stand would be, give or take the bob.
    const air = g.stands[1]!.air;
    assert.ok(Math.abs(small.cx - (air.x + air.w / 2)) <= 2 && Math.abs(small.cy - (air.y + air.h / 2)) <= 2, `${width}: centred over its stand`);
    const box = planeBox(g, 1, "air", "work-item");
    assert.ok(box.w === small.w && box.h === small.h, `${width}: planeBox is the drawn plane's size`);
    assert.deepEqual(planeBox(g, 0, "air", "spec"), g.stands[0]!.air, "a spec plane fills its stand's box");
  }
});

test("the work item plane's two trails start at its own engines and nowhere else", () => {
  const g = runwayLayout(1200, false, 2, ""), c = g.cell;
  const box = planeBox(g, 1, "air", "work-item");
  for (const seconds of [0, 0.8, 2.4]) {
    const s = paint({ stands: [{ kind: "empty" }, item()], working: 3 }, seconds);
    for (const { col, row } of RUNWAY_WORK_ENGINES) {
      const ex = box.x + col * c, ey = box.y + (row + 0.5) * c;
      assert.ok(inked(s, INKS.trail, { x: ex - 10, y: ey - c - 2, w: 10, h: 2 * c + 4 }).n > 6, `${seconds}s: a trail leaves the engine at ${ex},${ey}`);
    }
    assert.equal(inked(s, INKS.trail, { x: box.x + RUNWAY_WORK_ENGINES[0]!.col * c + 2, y: 0, w: s.w, h: s.h }).n, 0, "nothing ahead of the engines");
  }
});

test("every moment keeps the work item small: takeoff, beacon, holding and the landing back onto its stand, moving and still", () => {
  const g = runwayLayout(1200, false, 2, "");
  const { park, air } = g.stands[1]!;
  const small = cells(RUNWAY_WORK_PLANE) * g.cell * g.cell;
  const state = (stand: RunwayStand): RunwayState => ({ stands: [{ kind: "empty" }, stand], working: 3, at: 1000 });
  const total = (s: Surface, ink: number) => inked(s, ink, { x: 0, y: 0, w: s.w, h: s.h }).n;

  const takeoff = state({ kind: "takeoff", laneId: "FIX-9", since: 1000, beacon: null, workKind: "work-item" });
  assert.equal(inked(paint(takeoff, 0.05), INKS.plane, grow(park, 6)).n, small, "it rolls from its stand, small");
  assert.equal(inked(paint(takeoff, runwayMotion(takeoff).stillAt), INKS.plane, grow(air, 4)).n, small, "and is up over it at the still frame");

  const beacon = paint(state(item({ beacon: "waiting:thr_item" })), 0);
  const lit = inked(beacon, INKS.beacon, grow(air, 14));
  assert.ok(lit.n > small, "amber plane and brackets");
  assert.ok(lit.w < g.plane.w + 2 * 9, "the brackets hug the smaller plane");

  const holding = state({ kind: "holding", laneId: "FIX-9", beacon: null, workKind: "work-item" });
  for (const t of [0, 1, runwayMotion(holding).stillAt]) {
    const s = paint(holding, t);
    assert.ok(total(s, INKS.holding) > small, `${t}s: red plane and ring`);
    assert.equal(total(s, INKS.plane), 0);
  }

  const landing = state({ kind: "landing", laneId: "FIX-9", since: 1000, workKind: "work-item" });
  assert.equal(inked(paint(landing, 0), INKS.plane, grow(air, 4)).n, small, "the glide starts small, in the air");
  const down = paint(landing, LANDING_MS / 1000);
  assert.equal(inked(down, INKS.plane, grow(park, 2)).n, small, "and ends small, on its own stand");
  assert.equal(inked(paint(landing, runwayMotion(landing).stillAt), INKS.plane, grow(park, 2)).n, small, "the reduced-motion still shows it down, small");
});

// ---------- the board view ----------

async function mount(board: Board, placement: "page" | "panel" = "page") {
  await import("./fixtures/app-runtime.js");
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const browser = dom.window;
  browser.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof browser.matchMedia;
  browser.HTMLCanvasElement.prototype.getContext = (() => null) as typeof browser.HTMLCanvasElement.prototype.getContext;
  const width = placement === "panel" ? 560 : 1200;
  browser.HTMLElement.prototype.getBoundingClientRect = function () {
    return { top: 0, bottom: 164, left: 0, right: width, width, height: 164, x: 0, y: 0, toJSON() {} };
  };
  const globals = { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element,
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { BoardView } = await import("../board/Board.js");
  const root = createRoot(browser.document.getElementById("root")!);
  await act(async () => root.render(createElement(BoardView, {
    board, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined, placement })));
  return {
    doc: browser.document,
    async close() {
      await act(async () => root.unmount());
      browser.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
const px = (value: string) => Number(value.replace("px", ""));

test("in the view, a work item's plane button covers its smaller plane, and says what it is", async () => {
  const view = await mount(boardOf([specLane(), itemLane()]));
  try {
    const planes = [...view.doc.querySelectorAll<HTMLButtonElement>(".sq-runway-plane")];
    assert.deepEqual(planes.map((b) => b.dataset.workKind), ["spec", "work-item"]);
    const g = runwayLayout(1200, false, 2, "1 of 2 lanes flying");
    const pad = 10;
    planes.forEach((button, i) => {
      const box = planeBox(g, i, "air", i === 0 ? "spec" : "work-item");
      assert.deepEqual([px(button.style.left), px(button.style.top), px(button.style.width), px(button.style.height)],
        [box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2], `${button.dataset.workKind}: the click target is the plane as drawn`);
    });
    assert.ok(px(planes[1]!.style.width) < px(planes[0]!.style.width) && px(planes[1]!.style.height) < px(planes[0]!.style.height));
    assert.match(planes[1]!.getAttribute("aria-label")!, /^Work item FIX-9, A work item: flying\. Go to its lane\.$/);
    assert.match(planes[0]!.getAttribute("aria-label")!, /^A-1, A spec: flying\. Go to its lane\.$/);
  } finally { await view.close(); }
});

test("Flying rows say Work item or Spec · N tickets, wide and in the side panel, never guessed from the ticket count", async () => {
  // A spec with no tickets read yet still says Spec; its total comes from the tracker.
  const board = boardOf([specLane({ totalTicketCount: 4 }), itemLane(), specLane({ specId: "B-1", title: "Unread spec", tickets: [] })]);
  for (const placement of ["page", "panel"] as const) {
    const view = await mount(board, placement);
    try {
      const rows = [...view.doc.querySelectorAll<HTMLElement>("#sq-flying .sq-line, .sq-section .sq-line")];
      // What the owner reads: the tag's text without its hover definitions.
      const tag = (id: string) => {
        const found = rows.find((row) => row.getAttribute("aria-label")!.startsWith(`${id},`))?.querySelector(".sq-work-kind");
        const copy = found?.cloneNode(true) as HTMLElement | undefined;
        copy?.querySelectorAll('[role="tooltip"]').forEach((tip) => tip.remove());
        return copy?.textContent?.replace(/\s+/g, " ").trim();
      };
      assert.equal(tag("A-1"), "Spec · 4 tickets", placement);
      assert.equal(tag("FIX-9"), "Work item", placement);
      assert.equal(tag("B-1"), "Spec · 0 tickets", placement);
    } finally { await view.close(); }
  }
});
