// SQD-227: the quiet hangar and the fly-past. With nothing flying, every stand
// holds a parked plane and the Flying section points to New spec. When the last
// Ready spec lands, the whole formation flies past once in a long V, then parks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countInk as count, pixelAt as at } from "./fixtures/pixel-count.js";
import { createSurface, type Surface } from "../lib/dither.js";
import { LANDING_MS, needsYou, nextLandings, type Board, type Lane, type Landings } from "../lib/board-model.js";
import { FLYPAST_MS, nextFlyPast, type FlyPast } from "../lib/fly-past.js";
import { workingAgents } from "../lib/working-agents.js";
import { runway, runwayFormation, runwayLayout, runwayMotion, runwayState, RUNWAY_ENGINES, RUNWAY_HEIGHT, RUNWAY_PLANE, type Box, type RunwayInks, type RunwayState } from "../lib/runway.js";

const INKS: RunwayInks = {
  cloud: 0xff111111, tarmac: 0xff222222, line: 0xff333333, rule: 0xff444444, stand: 0xff555555, plane: 0xff0000ff,
  trail: 0xff00ff00, beacon: 0xff00aaff, holding: 0xffff0000,
};
const SOLID = RUNWAY_PLANE.join("").split("#").length - 1;

function paint(state: RunwayState, seconds: number, width = 1200, narrow = false): Surface {
  const s = createSurface(width, narrow ? RUNWAY_HEIGHT.narrow : RUNWAY_HEIGHT.wide, 1);
  runway({ state, narrow, label: "", inks: INKS })(s, seconds);
  return s;
}
const all = (s: Surface): Box => ({ x: 0, y: 0, w: s.w, h: s.h });

const route = { family: "gpt", model: "gpt-6.1-sol", effort: "medium" } as const;
const lane = (patch: Partial<Lane> = {}): Lane => ({ specId: "A-1", title: "A spec", lead: route, leadThreadId: "thr_lead", branch: "spec/a-1",
  state: "flying", minutes: 3, acceptOwner: false, workingThreads: 2,
  tickets: [{ id: "A-2", title: "A ticket", blockedBy: [], route, state: "working", minutes: 3, threadId: "thr_w" }], ...patch });
const boardOf = (lanes: Lane[]): Board => ({ tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, lanes, ready: [], shaping: [], openIssues: [] });

// ---------- the quiet hangar ----------

test("with nothing flying, every stand holds a solid parked plane, and the banner holds still", () => {
  const state = runwayState([], 3, 0);
  assert.deepEqual(state.stands, [{ kind: "parked" }, { kind: "parked" }, { kind: "parked" }]);
  assert.equal(runwayMotion(state).animated, false, "a quiet hangar doesn't move");

  const g = runwayLayout(1200, false, 3, "");
  const s = paint(state, 0);
  for (const { park } of g.stands) {
    assert.equal(count(s, INKS.stand, park), SOLID * g.cell * g.cell, "a whole plane, every cell solid, on its stand");
  }
  assert.equal(count(s, INKS.plane, all(s)), 0, "parked planes aren't lit");
  assert.equal(count(s, INKS.trail, all(s)), 0, "and leave no trails");
  assert.deepEqual(paint(state, 3).buf, s.buf, "nothing moves over time");

  // Landed lanes are history: the hangar is still quiet.
  const landed = runwayState([lane({ state: "landed" })], 3, 0);
  assert.ok(landed.stands.every((stand) => stand.kind === "parked"));
});

test("while a lane flies, its plane is lit and the free stands stay dotted, not parked", () => {
  const state = runwayState([lane()], 3, 2);
  assert.equal(state.stands[0]!.kind, "flying");
  assert.deepEqual(state.stands.slice(1), [{ kind: "empty" }, { kind: "empty" }]);
  const g = runwayLayout(1200, false, 3, "");
  const s = paint(state, 0);
  const free = g.stands[1]!.park;
  const dots = count(s, INKS.stand, free);
  assert.ok(dots > 0 && dots < SOLID * g.cell * g.cell / 2, `a free stand is a dotted outline (${dots} px)`);
});

test("an empty Flying section is one plain line pointing to New spec, with the New spec button", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const html = renderToStaticMarkup(createElement(BoardView, {
    board: boardOf([lane({ state: "landed" })]), demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined,
  }));
  const flying = html.slice(html.indexOf('id="sq-flying-h"'), html.indexOf('id="sq-ready-h"'));
  const lines = flying.match(/<p class="sq-clear">[^<]*<\/p>/g) ?? [];
  assert.deepEqual(lines, ['<p class="sq-clear">Nothing is flying. Plan the next spec with New spec.</p>'], "one plain line");
  assert.match(flying, /<button[^>]*>(<span>)?New <span[^>]*>/, "its button is New spec");
});

// ---------- the fly-past, once ----------

const spec = (id: string) => ({ id, title: id, ticketCount: 1, routes: [], blockedBy: [], acceptOwner: false, startReason: null });
const withReady = (board: Board, ...ids: string[]): Board => ({ ...board, ready: ids.map(spec) });
const landedLane = (specId: string) => lane({ specId, state: "landed", workingThreads: 0 });

interface Step { moments: Landings; fly: FlyPast; state: RunwayState }
/** What the board view derives in one update: the lanes' moments, the fly-past, then the banner from the same board. */
function update(previous: Step | null, board: Board, now: number): Step {
  const moments = nextLandings(previous?.moments ?? null, board.lanes, now);
  const fly = nextFlyPast(previous?.fly ?? null, { before: previous?.moments ?? null, landings: moments, lanes: board.lanes, ready: board.ready.length });
  const state = runwayState(board.lanes, board.laneCapacity, workingAgents(board.lanes),
    { needs: needsYou(board), landings: moments, now, flyPast: fly.since });
  return { moments, fly, state };
}
/** Reads the same board again at later moments, collecting every fly-past start the banner shows. */
function passes(steps: Array<[Board, number]>, from: Step | null = null): { last: Step; starts: number[] } {
  let step = from;
  const starts = new Set<number>();
  for (const [board, now] of steps) {
    step = update(step, board, now);
    if (step.state.flyPast) starts.add(step.state.flyPast.since);
  }
  return { last: step!, starts: [...starts] };
}

test("the fly-past plays once, when the last Ready spec lands, starting as its landing ends", () => {
  let now = 1_000_000;
  // A lane flies with one more spec Ready.
  let step = update(null, withReady(boardOf([lane()]), "B-1"), now);
  assert.equal(step.state.flyPast, undefined);
  // It lands with B-1 still Ready: no fly-past.
  now += 10_000;
  step = update(step, withReady(boardOf([landedLane("A-1")]), "B-1"), now);
  assert.equal(step.fly.since, null, "a landing with work still Ready is just a landing");
  // B-1 starts and the queue empties.
  now += 10_000;
  step = update(step, boardOf([landedLane("A-1"), lane({ specId: "B-1" })]), now);
  // B-1 lands: the last Ready spec. The fly-past is set to start when its landing glide ends.
  now += 10_000;
  const empty = boardOf([landedLane("A-1"), landedLane("B-1")]);
  step = update(step, empty, now);
  assert.equal(step.fly.since, now + LANDING_MS, "the pass follows the landing, from the same update");
  assert.equal(step.state.flyPast?.since, now + LANDING_MS);
  assert.equal(step.state.at, now, "the banner's clock still starts with the landing, shared with the burst");
  const start = now + LANDING_MS;

  // The same empty queue, read again and again or changed elsewhere, never repeats it.
  const later = passes([[empty, start + 10], [empty, start + FLYPAST_MS - 1], [empty, start + FLYPAST_MS], [empty, start + 60_000],
    [{ ...empty, tick: 9 }, start + 70_000]], step);
  assert.deepEqual(later.starts, [start], "one pass");
  assert.equal(later.last.state.flyPast, undefined, "and then the formation parks");
  assert.ok(later.last.state.stands.every((stand) => stand.kind === "parked"));
});

test("the fly-past never plays on page load or reload, nor for an empty update without a landing", () => {
  const empty = boardOf([landedLane("A-1"), landedLane("B-1")]);
  // A fresh view, opened on a cleared queue (a reload just after the last landing).
  assert.deepEqual(passes([[empty, 1_000], [empty, 2_000], [empty, 60_000]]).starts, [], "opening on a cleared queue");
  assert.deepEqual(passes([[boardOf([]), 1_000], [boardOf([]), 9_000]]).starts, [], "opening on an empty board");
  // Ready empties without anything landing (a spec moved back to planning): not a landing.
  assert.deepEqual(passes([[withReady(boardOf([]), "B-1"), 1_000], [boardOf([]), 2_000], [boardOf([]), 9_000]]).starts, [], "Ready emptied by hand");
  // A lane leaves the board without landing.
  assert.deepEqual(passes([[boardOf([lane()]), 1_000], [boardOf([]), 2_000], [boardOf([]), 9_000]]).starts, [], "a lane gone without a landing");
});

test("while the board can't read Ready, a landing never counts as the last one", () => {
  const first = nextFlyPast(null, { before: null, landings: nextLandings(null, [lane()], 1_000), lanes: [lane()], ready: 0 });
  const before = nextLandings(null, [lane()], 1_000);
  const landings = nextLandings(before, [landedLane("A-1")], 2_000);
  const unknown = nextFlyPast(first, { before, landings, lanes: [landedLane("A-1")], ready: null });
  assert.equal(unknown.since, null, "Ready unread: no fly-past");
  assert.deepEqual(unknown, first, "and nothing learned from the update");
});

test("while another lane still flies, a landing isn't the last one; the last of two lanes plays it", () => {
  const two = boardOf([lane(), lane({ specId: "B-1" })]);
  const one = boardOf([landedLane("A-1"), lane({ specId: "B-1" })]);
  const none = boardOf([landedLane("A-1"), landedLane("B-1")]);
  const run = passes([[two, 1_000], [one, 20_000], [one, 40_000], [none, 60_000], [none, 60_000 + LANDING_MS + 100]]);
  assert.deepEqual(run.starts, [60_000 + LANDING_MS]);
});

test("two lanes landing in one update make one pass", () => {
  const run = passes([[boardOf([lane(), lane({ specId: "B-1" })]), 1_000], [boardOf([landedLane("A-1"), landedLane("B-1")]), 2_000],
    [boardOf([landedLane("A-1"), landedLane("B-1")]), 2_000 + LANDING_MS + 10]]);
  assert.deepEqual(run.starts, [2_000 + LANDING_MS]);
});

test("a queue that fills and clears again earns a new fly-past", () => {
  const first = passes([[boardOf([lane()]), 1_000], [boardOf([landedLane("A-1")]), 2_000], [boardOf([landedLane("A-1")]), 9_000]]);
  assert.deepEqual(first.starts, [2_000 + LANDING_MS]);
  const again = passes([[withReady(boardOf([landedLane("A-1")]), "B-1"), 20_000], [boardOf([landedLane("A-1"), lane({ specId: "B-1" })]), 30_000],
    [boardOf([landedLane("A-1"), landedLane("B-1")]), 40_000], [boardOf([landedLane("A-1"), landedLane("B-1")]), 41_000]], first.last);
  assert.deepEqual(again.starts, [40_000 + LANDING_MS]);
});

// ---------- the fly-past, painted ----------

test("the formation flies in a long V inside the sky: the lead at the right, each rank back and out past a plane's height", () => {
  for (const narrow of [false, true]) {
    for (const width of [560, 900, 1200, 1600]) {
      for (const slots of [1, 2, 3, 4, 5, 6]) {
        const g = runwayLayout(width, narrow, slots, "");
        const f = runwayFormation(g);
        const where = `${narrow ? "narrow" : "wide"} ${width}px, ${slots} stands`;
        assert.equal(f.planes.length, slots, `${where}: the whole formation`);
        assert.ok(f.cell >= 1 && f.cell <= g.cell);
        const [lead, ...rest] = f.planes;
        for (const box of f.planes) {
          assert.equal(box.w, RUNWAY_PLANE[0]!.length * f.cell);
          assert.ok(box.y >= 0 && box.y + box.h <= g.tarmac.y - 2, `${where}: in the sky, clear of the tarmac's text`);
        }
        rest.forEach((box, i) => {
          const rank = Math.ceil((i + 1) / 2);
          assert.ok(box.x < lead!.x, `${where}: plane ${i + 1} flies behind the lead`);
          assert.ok(Math.abs(box.y - lead!.y) > rank * box.h, `${where}: rank ${rank} steps out by more than a plane's height`);
          assert.equal(Math.sign(box.y - lead!.y), i % 2 === 0 ? -1 : 1, `${where}: the ranks alternate above and below`);
        });
        // No contrail runs through a plane behind it.
        for (const front of f.planes) {
          for (const { row } of RUNWAY_ENGINES) {
            const y = front.y + (row + 0.5) * f.cell;
            for (const back of f.planes) {
              if (back.x < front.x) assert.ok(y < back.y || y > back.y + back.h, `${where}: a trail at ${y} misses the plane behind at ${back.y}`);
            }
          }
        }
        assert.ok(f.trail >= 2 * g.trail, `${where}: the contrails are long (${f.trail}px against ${g.trail}px)`);
      }
    }
  }
});

/** The banner just after the last landing: the pass is due at `since`, and the clock runs from the landing. */
const passing = (since: number, at = since): RunwayState => ({
  stands: [{ kind: "parked" }, { kind: "parked" }, { kind: "parked" }], working: 0, at, flyPast: { since },
});

test("the pass crosses once from off the left edge to off the right, lit, with long trails, and the stands empty meanwhile", () => {
  const g = runwayLayout(1200, false, 3, "");
  const f = runwayFormation(g);
  const state = passing(10_000);
  const whole = 3 * SOLID * f.cell * f.cell;
  const seconds = FLYPAST_MS / 1000;
  assert.equal(count(paint(state, 0), INKS.plane, all(paint(state, 0))), 0, "it starts off the left edge");
  let best = 0, bestFrame: Surface | null = null;
  const noses: number[] = [], noseRow = Math.floor(f.planes[0]!.y + f.planes[0]!.h / 2);
  for (let t = 0.05; t < seconds; t += 0.05) {
    const s = paint(state, t);
    const lit = count(s, INKS.plane, all(s));
    // The last frame with the whole formation in view: its trails have room behind it.
    if (lit >= best) { best = lit; bestFrame = s; }
    assert.equal(count(s, INKS.plane, { x: 0, y: g.tarmac.y - 2, w: s.w, h: s.h }), 0, `${t.toFixed(2)}s: the formation stays in the sky`);
    assert.equal(count(s, INKS.stand, all(s)), 0, `${t.toFixed(2)}s: the planes have left their stands`);
    // The lead's nose, on its centre row: no other plane shares that row.
    let nose = -1;
    for (let x = 0; x < s.w; x++) if (at(s, x, noseRow) === INKS.plane) nose = x;
    if (nose >= 0) noses.push(nose);
  }
  assert.equal(best, whole, "at its height every plane of the formation is in view, whole");
  assert.ok(noses.length > 10 && noses.every((x, i) => i === 0 || x >= noses[i - 1]!), "it flies left to right, never back");
  // The longest trail reaches far behind the rearmost plane.
  let trailLeft = bestFrame!.w, planeLeft = bestFrame!.w;
  for (let y = 0; y < bestFrame!.h; y++) for (let x = 0; x < bestFrame!.w; x++) {
    if (at(bestFrame!, x, y) === INKS.trail) trailLeft = Math.min(trailLeft, x);
    if (at(bestFrame!, x, y) === INKS.plane) planeLeft = Math.min(planeLeft, x);
  }
  assert.ok(planeLeft - trailLeft > g.trail * 1.5, `the V's contrails run long behind it (${planeLeft - trailLeft}px)`);
  const after = paint(state, seconds + 0.01);
  assert.equal(count(after, INKS.plane, all(after)), 0, "then it's gone");
  for (const { park } of g.stands) assert.equal(count(after, INKS.stand, park), SOLID * g.cell * g.cell, "and the formation is parked");
});

test("before the pass starts, the last landing glides as usual; the pass keeps its own start on a later clock", () => {
  const g = runwayLayout(1200, false, 3, "");
  const landing: RunwayState = { stands: [{ kind: "landing", laneId: "A-1", since: 10_000, workKind: "spec" }, { kind: "empty" }, { kind: "empty" }],
    working: 0, at: 10_000, flyPast: { since: 10_000 + LANDING_MS } };
  const gliding = paint(landing, 0.2);
  assert.ok(count(gliding, INKS.plane, all(gliding)) === SOLID * g.cell * g.cell, "one plane, gliding in");
  // Later, redrawn from the update when the pass began, the same moment of the pass looks the same.
  const t = LANDING_MS / 1000 + 1.2;
  assert.deepEqual(paint(landing, t).buf, paint(passing(10_000 + LANDING_MS), 1.2).buf);
});

test("the banner moves while a pass is due; under reduced motion its still frame is the parked formation", () => {
  const g = runwayLayout(1200, false, 3, "");
  const state = passing(10_000 + LANDING_MS, 10_000);
  const motion = runwayMotion(state);
  assert.equal(motion.animated, true, "a pass moves the banner even with nobody working");
  const still = paint(state, motion.stillAt);
  assert.equal(count(still, INKS.plane, all(still)), 0, "no plane in the air");
  assert.equal(count(still, INKS.trail, all(still)), 0, "no trails");
  for (const { park } of g.stands) assert.equal(count(still, INKS.stand, park), SOLID * g.cell * g.cell, "every plane parked, still");
});

// ---------- the board view ----------

async function mount(actions: { dispatch?: (action: unknown) => void; onPlan?: (...args: unknown[]) => void } = {}) {
  await import("./fixtures/app-runtime.js");
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const browser = dom.window;
  browser.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof browser.matchMedia;
  browser.HTMLCanvasElement.prototype.getContext = (() => null) as typeof browser.HTMLCanvasElement.prototype.getContext;
  browser.HTMLElement.prototype.getBoundingClientRect = function () {
    return { top: 0, bottom: 164, left: 0, right: 1200, width: 1200, height: 164, x: 0, y: 0, toJSON() {} };
  };
  browser.Element.prototype.scrollIntoView = function () {};
  const globals = { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element,
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { BoardView } = await import("../board/Board.js");
  const root = createRoot(browser.document.getElementById("root")!);
  const show = async (board: Board) => act(async () => root.render(createElement(BoardView, {
    board, demo: false, modeSwitch: null, dispatch: actions.dispatch ?? (() => undefined), onPlan: actions.onPlan ?? (() => undefined), placement: "page" })));
  const banner = () => browser.document.querySelector<HTMLElement>(".sq-runway")!;
  return {
    show, pass: () => banner().dataset.flyPast, doc: browser.document, act,
    async close() {
      await act(async () => root.unmount());
      browser.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("in the view, the last Ready spec's landing sets the fly-past for its landing's end, once; a reload doesn't", async () => {
  const flying = withReady(boardOf([lane()]), "B-1");
  const empty = boardOf([landedLane("A-1"), landedLane("B-1")]);
  const view = await mount();
  try {
    await view.show(flying);
    await view.show(withReady(boardOf([landedLane("A-1")]), "B-1"));
    assert.equal(view.pass(), undefined, "a landing with work still Ready plays no fly-past");
    await view.show(boardOf([landedLane("A-1"), lane({ specId: "B-1" })]));
    assert.equal(view.pass(), undefined);
    const before = Date.now();
    await view.show(empty);
    const since = Number(view.pass());
    assert.ok(since >= before + LANDING_MS && since <= Date.now() + LANDING_MS, "the pass starts as the last landing ends");
    await view.show({ ...empty, tick: 1 });
    assert.equal(Number(view.pass()), since, "the same empty queue doesn't start another");
  } finally { await view.close(); }

  // A reload: a fresh view opened on the cleared queue.
  const reload = await mount();
  try {
    await reload.show(empty);
    await reload.show({ ...empty, tick: 1 });
    assert.equal(reload.pass(), undefined, "no fly-past on page load");
  } finally { await reload.close(); }
});

test("with Ready work that can start, the empty Flying section still points to New spec, and Start stays beside it", async () => {
  const dispatched: unknown[] = [];
  const planned: unknown[][] = [];
  const view = await mount({ dispatch: (action) => dispatched.push(action), onPlan: (...args) => planned.push(args) });
  try {
    await view.show(withReady(boardOf([landedLane("A-1")]), "B-1"));
    const head = view.doc.getElementById("sq-flying-h")!;
    const section = head.closest("section")!;
    const lines = [...section.querySelectorAll(".sq-clear")].map((p) => p.textContent);
    assert.deepEqual(lines, ["Nothing is flying. Plan the next spec with New spec."], "one plain line, pointing to New spec");
    const buttons = [...section.querySelectorAll<HTMLButtonElement>(".sq-empty button")];
    assert.equal(buttons.length, 2);
    assert.match(buttons[0]!.textContent!, /^New spec/, "New spec first, as the line says");
    assert.equal(buttons[1]!.textContent, "Start B-1", "with Start for the spec that can go");
    await view.act(async () => buttons[1]!.click());
    assert.deepEqual(dispatched, [{ type: "start", specId: "B-1" }], "Start starts that spec");
    await view.act(async () => buttons[0]!.click());
    assert.deepEqual(planned, [[]], "New spec plans a new spec from nothing");
  } finally { await view.close(); }
});

test("new work cancels an old fly-past in the same update and keeps its real beacon visible", () => {
  const start = update(null, boardOf([lane()]), 1000);
  const empty = boardOf([landedLane("A-1")]);
  const landing = update(start, empty, 2000);
  const now = 2000 + LANDING_MS + 500;
  assert.ok(update(landing, empty, now).state.flyPast, "the old pass is playing");
  const question = boardOf([landedLane("A-1"), lane({ specId: "B-1", tickets: [{ ...lane().tickets[0]!, id: "B-2", state: "question", question: "Which?" }] })]);
  for (const work of [question, withReady(empty, "B-1")]) {
    const arrived = update(landing, work, now);
    assert.equal(arrived.fly.since, null, "new Flying or Ready work cancels the pass");
    assert.equal(arrived.fly.armed, true, "new work still arms the next earned pass");
    assert.equal(arrived.state.flyPast, undefined);
  }
  const arrived = update(landing, question, now);
  const beacon = arrived.state.stands.find((stand) => "laneId" in stand && stand.laneId === "B-1");
  assert.ok(beacon && "beacon" in beacon && beacon.beacon === "question:B-2");
  for (const seconds of [0, runwayMotion(arrived.state).stillAt]) {
    const s = paint(arrived.state, seconds);
    assert.ok(count(s, INKS.beacon, all(s)) > 100, "real plane and beacon are visible, including the reduced-motion still");
  }
  // Even a stale pass supplied by a caller cannot hide live work in the painter.
  const stale = { ...arrived.state, at: now, flyPast: { since: now - 500 } };
  assert.ok(count(paint(stale, 0), INKS.beacon, all(paint(stale, 0))) > 100);
  const landed = update(arrived, boardOf([landedLane("A-1"), landedLane("B-1")]), now + 10_000);
  assert.equal(landed.fly.since, now + 10_000 + LANDING_MS, "the next genuine queue clear earns one new pass");
  assert.equal(update(landed, boardOf([landedLane("A-1"), landedLane("B-1")]), now + 11_000).fly.since, landed.fly.since, "no repeat");
});
