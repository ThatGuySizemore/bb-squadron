// SQD-226: planes that match their lanes. Each lit plane draws two contrails
// from its engines, behind the main wings, and its state comes from its lane in
// the same board update as the lane row: takeoff, beacon, holding, landing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countInk as count, pixelAt as at } from "./fixtures/pixel-count.js";
import { JSDOM } from "jsdom";
import { createSurface, type Surface } from "../lib/dither.js";
import { LANDING_MS, needsYou, nextLandings, TAKEOFF_MS, type Board, type Lane, type Landings } from "../lib/board-model.js";
import { windSpeed, workingAgents } from "../lib/working-agents.js";
import { runway, runwayLayout, runwayState, runwayTrails, RUNWAY_ENGINES, RUNWAY_HEIGHT, RUNWAY_PLANE, type RunwayInks, type RunwayStand, type RunwayState } from "../lib/runway.js";

const INKS: RunwayInks = {
  cloud: 0xff111111, tarmac: 0xff222222, line: 0xff333333, rule: 0xff444444, stand: 0xff555555, plane: 0xff0000ff,
  trail: 0xff00ff00, beacon: 0xff00aaff, holding: 0xffff0000,
};

function paint(state: RunwayState, seconds: number, width = 1200): Surface {
  const s = createSurface(width, RUNWAY_HEIGHT.wide, 1);
  runway({ state, narrow: false, label: "", inks: INKS })(s, seconds);
  return s;
}
const one = (stand: RunwayStand, extra: Partial<RunwayState> = {}): RunwayState => ({ stands: [stand, { kind: "empty" }], working: 3, ...extra });

// ---------- the sprite and its trails ----------

test("the plane faces right: one nose cell leads on the centre row, and the T tail is at the left", () => {
  const rows = RUNWAY_PLANE.length, cols = RUNWAY_PLANE[0]!.length, mid = (rows - 1) / 2;
  const nose = RUNWAY_PLANE.map((row, y) => [y, row.lastIndexOf("#")] as const).sort((a, b) => b[1] - a[1]);
  assert.equal(nose[0]![1], cols - 1, "the nose reaches the right edge");
  assert.equal(nose[0]![0], mid, "on the centre row");
  assert.ok(nose[1]![1] < cols - 1, "and nothing else reaches it");
  const tall = (x: number) => RUNWAY_PLANE.filter((row) => row[x] === "#").length;
  assert.ok(tall(0) > 1 && tall(0) < rows, "the tail's fin stands at the left edge");

  // Painted, the rightmost lit pixel of the plane is on its centre line.
  const s = paint(one({ kind: "flying", laneId: "A-1", beacon: null, workKind: "spec" }), 0);
  const g = runwayLayout(1200, false, 2, "");
  let right = -1, rightY = -1;
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (at(s, x, y) === INKS.plane && x > right) { right = x; rightY = y; }
  assert.ok(Math.abs(rightY - (g.stands[0]!.air.y + g.plane.h / 2)) <= g.cell, "the painted nose points right, on the centre line");
});

test("the engines sit under the main wings, at their trailing edge, clear of the tail", () => {
  assert.equal(RUNWAY_ENGINES.length, 2, "two engines, one under each main wing");
  const mid = (RUNWAY_PLANE.length - 1) / 2;
  for (const { col, row } of RUNWAY_ENGINES) {
    assert.equal(RUNWAY_PLANE[row]![col], "#", "the engine is on the wing");
    assert.equal(RUNWAY_PLANE[row]![col - 1], " ", "at the wing's trailing edge: nothing behind it in its row");
    assert.ok(RUNWAY_PLANE[row]!.slice(0, col).trim() === "", "its trail runs back clear of the tail");
    assert.ok(Math.abs(row - mid) >= 3, "out on the wing, not on the fuselage");
  }
  assert.ok(RUNWAY_ENGINES[0]!.row < mid && RUNWAY_ENGINES[1]!.row > mid, "one each side");
});

test("each lit plane draws two trails that start at its engines, behind the main wings, and none from the tail", () => {
  const g = runwayLayout(1200, false, 2, "");
  const air = g.stands[0]!.air, c = g.cell;
  for (const seconds of [0, 0.8, 2.4]) {
    const s = paint(one({ kind: "flying", laneId: "A-1", beacon: null, workKind: "spec" }), seconds);
    for (const { col, row } of RUNWAY_ENGINES) {
      const ex = air.x + col * c, ey = air.y + (row + 0.5) * c;
      const start = count(s, INKS.trail, { x: ex - 10, y: ey - c - 2, w: 10, h: 2 * c + 4 });
      assert.ok(start > 6, `${seconds}s: a trail leaves the engine at ${ex},${Math.round(ey)} (${start} px)`);
    }
    // Behind the tail, on the centre line, between the two trails: clear sky.
    const tail = count(s, INKS.trail, { x: air.x - 24, y: air.y + 3 * c, w: 24, h: 3 * c });
    assert.equal(tail, 0, `${seconds}s: no trail from the tail`);
    // Nothing trails ahead of the engines: every trail pixel is left of its engine.
    const ahead = count(s, INKS.trail, { x: air.x + RUNWAY_ENGINES[0]!.col * c + 2, y: 0, w: s.w, h: s.h });
    assert.equal(ahead, 0, `${seconds}s: trails start at the engines, not ahead of them`);
    assert.equal(count(s, INKS.trail, { x: 0, y: g.tarmac.y, w: s.w, h: s.h - g.tarmac.y }), 0, "trails stay in the sky, off the tarmac");
  }
});

test("trails blow on the board's wind, and hold still when nobody works", () => {
  // The plane itself bobs, so the trails are drawn alone, behind a plane held at one spot.
  const g = runwayLayout(1200, false, 2, "");
  const { x, y } = g.stands[0]!.air;
  const trails = (seconds: number, agents: number) => {
    const s = createSurface(1200, RUNWAY_HEIGHT.wide, 1);
    runwayTrails(s, INKS.trail, x, y, g, g.trail, seconds, windSpeed(agents), 0);
    return s;
  };
  assert.deepEqual(trails(0, 0).buf, trails(3, 0).buf, "nobody working: the trails hold still");
  const before = trails(0, 4), after = trails(0.5, 4);
  assert.notDeepEqual(before.buf, after.buf, "the grain moves on the wind");
  const box = { x: x - g.trail, y, w: g.trail, h: g.plane.h };
  assert.ok(count(before, INKS.trail, box) > 0 && count(after, INKS.trail, box) > 0, "and the trails stay put behind the plane");
});

// ---------- the lane's state, read in the board update ----------

const route = { family: "gpt", model: "gpt-6.1-sol", effort: "medium" } as const;
const lane = (patch: Partial<Lane> = {}): Lane => ({ specId: "A-1", title: "A spec", lead: route, leadThreadId: "thr_lead", branch: "spec/a-1",
  state: "flying", minutes: 3, acceptOwner: false, workingThreads: 2,
  tickets: [{ id: "A-2", title: "A ticket", blockedBy: [], route, state: "working", minutes: 3, threadId: "thr_w" }], ...patch });
const boardOf = (lanes: Lane[]): Board => ({ tick: 0, laneCapacity: 2, workersPerLane: 2, autoStart: false, lanes, ready: [], shaping: [], openIssues: [] });

/** What the board view derives in one update: the lanes' moments, then the banner from the same board. */
function update(previous: Landings | null, board: Board, now: number) {
  const moments = nextLandings(previous, board.lanes, now);
  const state = runwayState(board.lanes, board.laneCapacity, workingAgents(board.lanes), { needs: needsYou(board), landings: moments, now });
  return { moments, state, plane: state.stands[0]! };
}

test("one lane through start, needs you, stop, resume and land: its plane's state matches the lane after each step", () => {
  let now = 1_000_000;
  // The board opens with nothing flying: the quiet hangar, its plane parked.
  let step = update(null, boardOf([]), now);
  assert.equal(step.plane.kind, "parked");

  // Start: the lane appears, so its plane takes off from its stand, starting in this update.
  now += 5_000;
  step = update(step.moments, boardOf([lane()]), now);
  assert.deepEqual(step.plane, { kind: "takeoff", laneId: "A-1", since: now, beacon: null, workKind: "spec" });
  assert.equal(step.state.at, now, "the banner's moments are measured from this update");

  // The takeoff is over by the next read: flying.
  now += TAKEOFF_MS + 15_000;
  step = update(step.moments, boardOf([lane()]), now);
  assert.deepEqual(step.plane, { kind: "flying", laneId: "A-1", beacon: null, workKind: "spec" });

  // Needs you: a worker asks a question, so the plane beacons to that row.
  now += 15_000;
  const asking = boardOf([lane({ tickets: [{ ...lane().tickets[0]!, state: "question", question: "Which width?" }] })]);
  step = update(step.moments, asking, now);
  assert.deepEqual(step.plane, { kind: "flying", laneId: "A-1", beacon: "question:A-2", workKind: "spec" });
  assert.ok(needsYou(asking).some((item) => item.key === "question:A-2"), "the beacon names a real Needs you row");

  // Answered: the beacon goes out exactly when the row does.
  now += 15_000;
  step = update(step.moments, boardOf([lane()]), now);
  assert.deepEqual(step.plane, { kind: "flying", laneId: "A-1", beacon: null, workKind: "spec" });

  // Stop: the plane holds, and beacons to the stopped row that carries Resume.
  now += 15_000;
  const stopped = boardOf([lane({ state: "stopped", stopped: true, workingThreads: 0 })]);
  step = update(step.moments, stopped, now);
  assert.deepEqual(step.plane, { kind: "holding", laneId: "A-1", beacon: "stopped:A-1", workKind: "spec" });

  // Resume: back to flying, no takeoff replay.
  now += 15_000;
  step = update(step.moments, boardOf([lane()]), now);
  assert.deepEqual(step.plane, { kind: "flying", laneId: "A-1", beacon: null, workKind: "spec" });

  // Land: the plane lands from this update, the same start as the lane's burst, and keeps its stand until the burst ends.
  now += 15_000;
  const landed = boardOf([lane({ state: "landed", workingThreads: 0, pr: { number: 7, checks: "passing", url: "u", state: "merged" } })]);
  step = update(step.moments, landed, now);
  assert.deepEqual(step.plane, { kind: "landing", laneId: "A-1", since: now, workKind: "spec" });
  assert.equal(step.moments.until["A-1"]! - LANDING_MS, now, "the lane's burst starts in this same update");

  // After the landing, nothing flies: the plane is parked on its stand.
  now += LANDING_MS + 1;
  step = update(step.moments, landed, now);
  assert.equal(step.plane.kind, "parked");
});

test("a lane already flying when the board opens doesn't replay its takeoff, and a landed one doesn't land again", () => {
  const first = update(null, boardOf([lane(), lane({ specId: "B-1", state: "landed" })]), 5_000);
  assert.deepEqual(first.state.stands, [{ kind: "flying", laneId: "A-1", beacon: null, workKind: "spec" }, { kind: "empty" }]);
  assert.equal(first.state.at, undefined, "no moment is playing");
});

test("the beacon names the lane's first Needs you row, in the strip's order", () => {
  const board = boardOf([lane({ needs: [{ threadId: "thr_x", kind: "failed", text: "Tests failed" }],
    tickets: [{ ...lane().tickets[0]!, state: "question", question: "Which?" }] })]);
  const step = update(null, board, 1);
  assert.equal(step.plane.kind === "flying" && step.plane.beacon, needsYou(board).find((item) => item.specId === "A-1")!.key);
  assert.equal(step.plane.kind === "flying" && step.plane.beacon, "failed:thr_x");
});

// ---------- the moments, painted ----------

test("a takeoff rolls off the stand and lifts into the air over its stand", () => {
  const g = runwayLayout(1200, false, 2, "");
  const { park, air } = g.stands[0]!;
  const state = one({ kind: "takeoff", laneId: "A-1", since: 1000, beacon: null, workKind: "spec" }, { at: 1000 });
  const solid = RUNWAY_PLANE.join("").split("#").length - 1;
  const rolling = paint(state, 0.05);
  assert.ok(count(rolling, INKS.plane, park) > solid * g.cell * g.cell * 0.6, "it starts on its stand");
  const done = paint(state, TAKEOFF_MS / 1000 + 0.1);
  assert.ok(count(done, INKS.plane, air) > solid * g.cell * g.cell * 0.8, "and ends in the air over it");
  assert.equal(count(done, INKS.stand, park), 0);
});

test("a landing glides from the air back onto its stand", () => {
  const g = runwayLayout(1200, false, 2, "");
  const { park, air } = g.stands[0]!;
  const state = one({ kind: "landing", laneId: "A-1", since: 1000, workKind: "spec" }, { at: 1000 });
  const solid = RUNWAY_PLANE.join("").split("#").length - 1;
  assert.ok(count(paint(state, 0), INKS.plane, air) > solid * g.cell * g.cell * 0.8, "the glide starts in the air");
  const down = paint(state, LANDING_MS / 1000);
  assert.ok(count(down, INKS.plane, park) > solid * g.cell * g.cell * 0.8, "and ends on the stand");
  assert.equal(count(down, INKS.trail, { x: 0, y: 0, w: down.w, h: down.h }), 0, "its trails are gone once it's down");
});

test("moments that started in an earlier update keep their own clock", () => {
  // The banner is redrawn from a later update; the takeoff started 1s before it.
  const fresh = paint(one({ kind: "takeoff", laneId: "A-1", since: 1000, beacon: null, workKind: "spec" }, { at: 1000 }), 1.2);
  const later = paint(one({ kind: "takeoff", laneId: "A-1", since: 1000, beacon: null, workKind: "spec" }, { at: 2000 }), 0.2);
  assert.deepEqual(count(later, INKS.plane, { x: 0, y: 0, w: later.w, h: later.h }), count(fresh, INKS.plane, { x: 0, y: 0, w: fresh.w, h: fresh.h }));
});

test("a beacon blinks amber brackets around its plane; a holding plane circles red inside a red ring", () => {
  const g = runwayLayout(1200, false, 2, "");
  const air = g.stands[0]!.air;
  const around = { x: air.x - 12, y: air.y - 12, w: air.w + 24, h: air.h + 24 };
  const frames = [0, 0.3, 0.6, 0.9, 1.2, 1.5, 1.8, 2.1].map((t) => paint(one({ kind: "flying", laneId: "A-1", beacon: "question:A-2", workKind: "spec" }), t));
  const lit = frames.map((s) => count(s, INKS.beacon, around));
  assert.ok(lit.every((n) => n > 40), "the brackets and the plane stay amber");
  assert.ok(new Set(lit).size > 1, "and blink");
  assert.equal(count(frames[0]!, INKS.plane, around), 0, "a beaconing plane is amber, not sky");

  const holding = paint(one({ kind: "holding", laneId: "A-1", beacon: null, workKind: "spec" }), 1);
  const ring = { x: air.x - g.plane.w * 0.4, y: air.y - g.plane.h * 0.6, w: g.plane.w * 1.8, h: g.plane.h * 2.2 };
  assert.ok(count(holding, INKS.holding, ring) > 150, "the plane and its ring are red");
  assert.equal(count(holding, INKS.plane, ring), 0);
  assert.equal(count(holding, INKS.trail, { x: 0, y: 0, w: holding.w, h: holding.h }), 0, "a holding plane leaves no trail");
  const rows = (s: Surface) => s.buf.slice(0);
  assert.notDeepEqual(rows(holding), rows(paint(one({ kind: "holding", laneId: "A-1", beacon: null, workKind: "spec" }), 2)), "it circles");
});

test("under reduced motion each state keeps its form in one still frame", async () => {
  const { runwayMotion } = await import("../lib/runway.js");
  const g = runwayLayout(1200, false, 2, "");
  const { park, air } = g.stands[0]!;
  const still = (stand: RunwayStand) => {
    const state = one(stand, { at: 1000 });
    return paint(state, runwayMotion(state).stillAt);
  };
  const solid = RUNWAY_PLANE.join("").split("#").length - 1;
  const around = { x: air.x - 12, y: air.y - 12, w: air.w + 24, h: air.h + 24 };
  assert.ok(count(still({ kind: "flying", laneId: "A-1", beacon: "q", workKind: "spec" }), INKS.beacon, around) > solid * 4, "steady beacon brackets, lit");
  const hold = still({ kind: "holding", laneId: "A-1", beacon: null, workKind: "spec" });
  const ring = { x: air.x - g.plane.w * 0.4, y: air.y - g.plane.h * 0.6, w: g.plane.w * 1.8, h: g.plane.h * 2.2 };
  assert.ok(count(hold, INKS.holding, ring) > solid * 8, "a still plane inside its ring");
  assert.ok(count(still({ kind: "takeoff", laneId: "A-1", since: 1000, beacon: null, workKind: "spec" }), INKS.plane, air) > solid * 8, "a takeoff shows the plane up");
  assert.ok(count(still({ kind: "landing", laneId: "A-1", since: 1000, workKind: "spec" }), INKS.plane, park) > solid * 8, "a landing shows the plane down on its stand");
});

// ---------- the board view ----------

async function mount(boards: Board[]) {
  await import("./fixtures/app-runtime.js");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const browser = dom.window;
  browser.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof browser.matchMedia;
  browser.HTMLCanvasElement.prototype.getContext = (() => null) as typeof browser.HTMLCanvasElement.prototype.getContext;
  browser.HTMLElement.prototype.getBoundingClientRect = function () {
    return { top: 0, bottom: 164, left: 0, right: 1200, width: 1200, height: 164, x: 0, y: 0, toJSON() {} };
  };
  const scrolled: Element[] = [];
  browser.Element.prototype.scrollIntoView = function () { scrolled.push(this); };
  const globals = { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element,
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { BoardView } = await import("../board/Board.js");
  const root = createRoot(browser.document.getElementById("root")!);
  const show = async (board: Board) => act(async () => root.render(createElement(BoardView, {
    board, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined, placement: "page" })));
  for (const board of boards) await show(board);
  return {
    doc: browser.document, scrolled, show, act,
    async close() {
      await act(async () => root.unmount());
      browser.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("clicking a beaconing plane scrolls to its lane's Needs you row", async () => {
  const asking = boardOf([lane({ tickets: [{ ...lane().tickets[0]!, state: "question", question: "Which width?" }] })]);
  const view = await mount([asking]);
  try {
    const planes = [...view.doc.querySelectorAll<HTMLButtonElement>(".sq-runway-plane")];
    assert.equal(planes.length, 1, "one button over the one lit plane");
    const beacon = planes[0]!;
    assert.equal(beacon.dataset.plane, "flying");
    assert.equal(beacon.dataset.beacon, "question:A-2");
    assert.match(beacon.getAttribute("aria-label")!, /^A-1, A spec needs you\. Go to its Needs you row\.$/);
    await view.act(async () => beacon.click());
    const row = view.scrolled.at(-1) as HTMLElement | undefined;
    assert.ok(row, "the click scrolled");
    assert.equal(row.dataset.need, "question:A-2", "to the matching Needs you row");
    assert.ok(row.classList.contains("sq-need"));
  } finally { await view.close(); }
});

test("in the view, the plane follows the lane through every step, and the landing glide shares the burst's start", async () => {
  const view = await mount([boardOf([])]);
  const plane = () => view.doc.querySelector<HTMLElement>(".sq-runway-plane");
  try {
    assert.equal(plane(), null, "nothing flying, no plane");
    await view.show(boardOf([lane()]));
    assert.equal(plane()?.dataset.plane, "takeoff");
    await view.show(boardOf([lane({ tickets: [{ ...lane().tickets[0]!, state: "question", question: "Which?" }] })]));
    assert.equal(plane()?.dataset.beacon, "question:A-2");
    await view.show(boardOf([lane({ state: "stopped", stopped: true, workingThreads: 0 })]));
    assert.equal(plane()?.dataset.plane, "holding");
    assert.equal(plane()?.dataset.beacon, "stopped:A-1", "the stopped plane leads to the row with Resume");
    assert.ok([...view.doc.querySelectorAll(".sq-need button")].some((b) => b.textContent === "Resume"), "Resume stays in Needs you");
    await view.show(boardOf([lane()]));
    assert.notEqual(plane()?.dataset.plane, "holding");
    assert.equal(plane()?.dataset.beacon, undefined);
    await view.show(boardOf([lane({ state: "landed", workingThreads: 0 })]));
    assert.equal(plane(), null, "a landing plane has no button");
    const art = view.doc.querySelector<HTMLCanvasElement>(".sq-runway-art")!;
    const burst = view.doc.querySelector<HTMLCanvasElement>('.sq-contrail canvas[data-fx="burst"]');
    assert.ok(burst, "the lane's burst plays");
    assert.ok(art.dataset.born, "the banner's moments have a start");
    assert.equal(art.dataset.born, burst.dataset.born, "the glide and the burst start at the same moment");
  } finally { await view.close(); }
});

test("the Landed count flips digit by digit when it changes, never on first show", async () => {
  await import("./fixtures/app-runtime.js");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  const browser = dom.window;
  const globals = { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { FlipCount } = await import("../board/FlipCount.js");
  const root = createRoot(browser.document.getElementById("root")!);
  const show = (value: number) => act(async () => root.render(createElement(FlipCount, { value, className: "sq-count", digit: (d: string) => d })));
  const digits = () => [...browser.document.querySelectorAll<HTMLElement>(".sq-flip-digit")];
  try {
    await show(9);
    assert.equal(browser.document.querySelector(".sq-count .sq-sr")?.textContent, "9", "the whole number is read once");
    assert.equal(browser.document.querySelector(".sq-flip")?.getAttribute("aria-hidden"), "true");
    assert.deepEqual(digits().map((d) => d.dataset.flip), ["false"], "nothing flips when the count first shows");
    const nine = digits()[0];
    await show(10);
    assert.deepEqual(digits().map((d) => d.textContent), ["1", "0"]);
    assert.deepEqual(digits().map((d) => d.dataset.flip), ["true", "true"], "both digits changed, so both flip");
    assert.notEqual(digits()[1], nine, "a changed digit is a new face, so its flip plays");
    assert.deepEqual(digits().map((d) => d.style.animationDelay), ["90ms", "0ms"], "digit by digit, from the units up");
    const ten = digits();
    await show(11);
    assert.deepEqual(digits().map((d) => d.dataset.flip), ["false", "true"], "only the units change from 10 to 11");
    assert.equal(digits()[0], ten[0], "an unchanged digit stays put");
  } finally {
    await act(async () => root.unmount());
    browser.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("in the view, the path's Landed count flips when a lane arrives in Landed, and reads its number once", async () => {
  const landedLane = (specId: string) => lane({ specId, state: "landed", workingThreads: 0 });
  const view = await mount([boardOf([landedLane("A-1")])]);
  const station = () => [...view.doc.querySelectorAll<HTMLElement>(".sq-station")].at(-1)!;
  const digits = () => [...station().querySelectorAll<HTMLElement>(".sq-flip-digit")];
  try {
    assert.equal(station().querySelector(".sq-station-count .sq-sr")?.textContent, "1", "the whole count is read once");
    assert.equal(station().querySelectorAll(".sq-station-count .sq-sr").length, 1, "one copy of the count, none per digit");
    assert.deepEqual(digits().map((d) => d.dataset.flip), ["false"], "a count already landed when the board opens doesn't flip");
    assert.ok(digits()[0]!.querySelector("svg.sq-pixeltext"), "each digit is pixel lettering");
    // A lane this view never saw flying arrives already Landed: no burst plays, so the count changes in this update.
    await view.show(boardOf([landedLane("A-1"), landedLane("B-1")]));
    assert.equal(station().querySelector(".sq-station-count .sq-sr")?.textContent, "2");
    assert.deepEqual(digits().map((d) => d.dataset.flip), ["true"], "the changed digit flips");
  } finally { await view.close(); }
});

test("a stopped lane keeps its red holding form and matching amber beacon in motion and stills", async () => {
  const { runwayMotion } = await import("../lib/runway.js");
  for (const workKind of ["spec", "work-item"] as const) {
    const board = boardOf([lane({ kind: workKind, state: "stopped", stopped: true, workingThreads: 0 })]);
    const state = runwayState(board.lanes, 2, 0, { needs: needsYou(board), landings: null, now: 1000 });
    assert.deepEqual(state.stands[0], { kind: "holding", laneId: "A-1", beacon: "stopped:A-1", workKind });
    for (const seconds of [0, 1, runwayMotion(state).stillAt]) {
      const s = paint(state, seconds);
      const all = { x: 0, y: 0, w: s.w, h: s.h };
      assert.ok(count(s, INKS.holding, all) > 150, `${workKind}: red plane and holding ring remain`);
      assert.equal(count(s, INKS.beacon, all), 128, `${workKind}: all four amber brackets remain lit, including the still frame`);
      assert.equal(count(s, INKS.trail, all), 0, "holding still leaves no contrails");
    }
  }
  const stopped = boardOf([lane({ state: "stopped", stopped: true, workingThreads: 0 })]);
  const view = await mount([stopped]);
  try {
    const button = view.doc.querySelector<HTMLButtonElement>(".sq-runway-plane")!;
    assert.equal(button.dataset.beacon, "stopped:A-1");
    await view.act(async () => button.click());
    assert.equal((view.scrolled.at(-1) as HTMLElement).dataset.need, "stopped:A-1");
    assert.ok([...view.doc.querySelectorAll(".sq-need button")].some((button) => button.textContent === "Resume"));
  } finally { await view.close(); }
});
