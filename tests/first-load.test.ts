// SQD-247: until the board's first read returns, the board shows a loading
// state in its own world, never an empty state or a zero count. View tests
// through the board's renders, then the live board's first read, arrival,
// refresh and failure. Layout itself is measured in a real browser by
// tests/first-load-geometry.test.ts's page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDitherRenderer, type RendererEnv } from "../lib/dither-renderer.js";
import { createSurface, pixelsOf, type Painter, type Surface } from "../lib/dither.js";
import { runway, runwayLayout, runwayLoading, runwayMotion, RUNWAY_HEIGHT, RUNWAY_PLANE, type Box, type RunwayInks } from "../lib/runway.js";
import { readingRow, readingMotion } from "../lib/reading.js";
import type { Board, Lane } from "../lib/board-model.js";

// ---------- the banner: planes taxiing on their stands ----------

const INKS: RunwayInks = {
  cloud: 0xff111111, tarmac: 0xff222222, line: 0xff333333, rule: 0xff444444, stand: 0xff555555, plane: 0xff0000ff,
  trail: 0xff0000fe, beacon: 0xff00ffff, holding: 0xffff0000,
};
const at = (s: Surface, x: number, y: number) => s.buf[y * s.w + x]!;
function count(s: Surface, ink: number, box: Box): number {
  let n = 0;
  for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(s.h, Math.ceil(box.y + box.h)); y++) {
    for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(s.w, Math.ceil(box.x + box.w)); x++) if (at(s, x, y) === ink) n++;
  }
  return n;
}
function paintRunway(seconds: number, narrow = false, width = 1200): Surface {
  const s = createSurface(width, narrow ? RUNWAY_HEIGHT.narrow : RUNWAY_HEIGHT.wide, 1);
  runway({ state: runwayLoading(), narrow, label: "", inks: INKS })(s, seconds);
  return s;
}
/** Every reduced-motion test: the renderer draws once, at the still moment, and never asks for a frame. */
function stillFrames(motion: { animated: boolean; stillAt: number }, painter: Painter, width: number, height: number): { frames: number; drawn: Surface[] } {
  let now = 0, frames = 0;
  const env: RendererEnv = {
    now: () => now, requestFrame: () => ++frames, cancelFrame: () => undefined,
    isHidden: () => false, onVisibilityChange: () => undefined, prefersReducedMotion: () => true, onReducedMotionChange: () => undefined,
  };
  const drawn: Surface[] = [];
  createDitherRenderer(env).add({ ...motion, visible: true, draw: (t) => { const s = createSurface(width, height, 1); painter(s, t); drawn.push(s); } });
  now = 5000;
  return { frames, drawn };
}

test("before the first read, every stand holds a taxiing plane: solid in the stand's neutral ink, rolling along the tarmac", () => {
  const state = runwayLoading();
  assert.deepEqual(state.stands, [{ kind: "taxiing" }, { kind: "taxiing" }, { kind: "taxiing" }], "three stands, the default lane limit");
  assert.equal(state.working, 0, "nobody is counted as working before the read");
  const solid = RUNWAY_PLANE.join("").split("").filter((c) => c === "#").length;
  for (const narrow of [false, true]) {
    const width = narrow ? 560 : 1200;
    const g = runwayLayout(width, narrow, 3, "");
    const frames = [0.4, 1.3, 2.9].map((t) => paintRunway(t, narrow, width));
    for (const s of frames) {
      assert.equal(pixelsOf(s, INKS.plane), 0, "no plane is lit: the board doesn't know yet what flies");
      g.stands.forEach((stand, i) => {
        // The plane rolls a little either way along its stand, never up into the sky.
        const apron = { x: stand.park.x - 3 * g.cell, y: stand.park.y, w: stand.park.w + 6 * g.cell, h: stand.park.h };
        const inked = count(s, INKS.stand, apron);
        assert.ok(inked > solid * g.cell * g.cell * 0.9, `${narrow ? "panel" : "page"} stand ${i}: a solid plane, not dots (${inked} px)`);
      });
      assert.equal(count(s, INKS.stand, { x: 0, y: 0, w: s.w, h: g.tarmac.y }), 0, "taxiing planes stay on the tarmac");
    }
    assert.notDeepEqual(frames[0]!.buf, frames[1]!.buf, "the planes roll between frames");
  }
  assert.equal(runwayMotion(state).animated, true);
});

test("under reduced motion the taxiing banner draws one still frame that still shows the planes", () => {
  const state = runwayLoading();
  const { frames, drawn } = stillFrames(runwayMotion(state), runway({ state, narrow: false, label: "", inks: INKS }), 1200, RUNWAY_HEIGHT.wide);
  assert.equal(frames, 0, "no frame loop");
  assert.equal(drawn.length, 1, "one still frame");
  assert.ok(pixelsOf(drawn[0]!, INKS.stand) > 300, "the still frame shows the parked planes");
});

// ---------- placeholder rows: dither shimmering right to left ----------

const INK = 0xff777777;
function paintRow(seconds: number, width = 600, height = 40): Surface {
  const s = createSurface(width, height, 1);
  readingRow({ ink: INK })(s, seconds);
  return s;
}
const columns = (s: Surface) => Array.from({ length: s.w }, (_, x) => { let n = 0; for (let y = 0; y < s.h; y++) if (at(s, x, y) === INK) n++; return n; });
/** Where the shimmer is: the window of columns with the most ink above their quietest moment in one full cycle. */
function crest(s: Surface): number {
  const quiet = columns(paintRow(0));
  for (let t = 0.1; t < 2.5; t += 0.1) columns(paintRow(t)).forEach((n, x) => { quiet[x] = Math.min(quiet[x]!, n); });
  const lift = columns(s).map((n, x) => n - quiet[x]!);
  const window = 24;
  let best = -1, bestAt = 0;
  for (let x = 0; x + window <= s.w; x++) {
    const sum = lift.slice(x, x + window).reduce((a, b) => a + b, 0);
    if (sum > best) { best = sum; bestAt = x + window / 2; }
  }
  return bestAt;
}

test("a placeholder row is a row's shape in dither, and its shimmer runs right to left like the wind", () => {
  const a = paintRow(0.6), b = paintRow(0.9);
  assert.ok(pixelsOf(a, INK) > 200, "the row has a body of dither");
  assert.ok(pixelsOf(a, INK) < a.w * a.h * 0.6, "but it's grain, never a solid block");
  assert.ok(crest(b) < crest(a) - 20, `the shimmer moved left (${crest(a)} → ${crest(b)})`);
  for (let y = 0; y < a.h; y++) assert.equal(at(a, a.w - 1, y) === INK && at(a, a.w - 2, y) === INK && at(a, a.w - 3, y) === INK, false, "the right edge stays open, like a row's actions");
});

test("under reduced motion a placeholder row draws one still frame that still reads as a row", () => {
  const { frames, drawn } = stillFrames(readingMotion, readingRow({ ink: INK }), 600, 40);
  assert.equal(readingMotion.animated, true);
  assert.equal(frames, 0);
  assert.equal(drawn.length, 1);
  assert.ok(pixelsOf(drawn[0]!, INK) > 200);
});

// ---------- the board view while the first read is in flight ----------

const empty: Board = { tick: 0, laneCapacity: 0, workersPerLane: 0, autoStart: false, lanes: [], ready: [], shaping: [], openIssues: [] };
const lane = (specId: string, state: Lane["state"] = "flying"): Lane => ({
  specId, title: `Spec ${specId}`, state, lead: { family: "claude", model: "claude-opus-5-5", effort: "high" },
  leadThreadId: `thr_${specId}`, branch: `spec/${specId}`, minutes: 12, acceptOwner: false, tickets: [], workingThreads: 1,
});
const autopilot = (status: "on" | "off" | "paused"): NonNullable<Board["autopilot"]> => ({ status, laneLimit: 3, consecutiveStops: 0, pauseReason: null });
const SECTIONS = ["Needs you", "Flying", "Ready", "Shaping", "Open issues", "Landed"];

async function view(options: { placement?: "page" | "panel"; board?: Board; loading?: boolean; lanesKnown?: boolean; notice?: string; tracker?: { kind: "linear" | "github" | "local-markdown" | null } }) {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  return new JSDOM(renderToStaticMarkup(createElement(BoardView, {
    board: options.board ?? empty, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined,
    placement: options.placement ?? "page", loading: options.loading, lanesKnown: options.lanesKnown ?? !options.loading, notice: options.notice,
    tracker: options.tracker, projectId: "proj-one",
  }))).window.document;
}
const section = (doc: Document, title: string) => [...doc.querySelectorAll("section.sq-section")]
  .find((s) => s.querySelector(".sq-label h2 .sq-sr")?.textContent === title)!;

test("while the first read is in flight, no section shows an empty state and no count shows zero", async () => {
  for (const placement of ["page", "panel"] as const) {
    const doc = await view({ placement, loading: true });
    assert.equal(doc.querySelectorAll(".sq-empty, .sq-clear").length, 0, `${placement}: no empty-state line or button`);
    assert.doesNotMatch(doc.body.textContent ?? "", /Nothing (is|needs|has)|No (spec|open issues)|Reading the board\./, `${placement}: no empty-state words`);
    assert.equal(doc.querySelectorAll(".sq-label .sq-count, .sq-label .sq-count-amber").length, 0, `${placement}: section labels carry no count`);
    const counts = [...doc.querySelectorAll(".sq-station-count")];
    assert.equal(counts.length, 5);
    for (const n of counts) {
      assert.doesNotMatch(n.textContent ?? "", /\d/, `${placement}: never a number it hasn't read`);
      const svg = n.querySelector("svg.sq-pixeltext");
      assert.ok(svg, `${placement}: the count is drawn in the pixel font`);
      assert.equal(svg.querySelectorAll("rect").length, 3, "the pixel font's three-cell dash");
      assert.equal(n.querySelector(".sq-sr")?.textContent, "Not read yet", "read out as unknown, not as a dash");
      assert.equal(n.closest(".sq-station")?.getAttribute("data-zero"), "true", "muted, like an unknown count");
    }
    assert.equal(doc.querySelector(".sq")?.getAttribute("aria-busy"), "true", "assistive tech hears the board is busy");
  }
});

test("each section shows one or two dithered placeholder rows, under one plain reading line where the tracker line goes", async () => {
  for (const placement of ["page", "panel"] as const) {
    const doc = await view({ placement, loading: true });
    for (const title of SECTIONS) {
      const rows = [...section(doc, title).querySelectorAll(".sq-reading-row")];
      assert.ok(rows.length >= 1 && rows.length <= 2, `${placement} ${title}: one or two placeholder rows (${rows.length})`);
      for (const row of rows) {
        assert.ok(row.closest("[aria-hidden='true']"), `${placement} ${title}: placeholders are hidden from assistive tech`);
        assert.ok(row.querySelector("canvas.sq-reading-art"), `${placement} ${title}: drawn in dither`);
        assert.equal(row.textContent?.trim(), "", "no text sits on the moving dither");
      }
    }
    const lines = [...doc.querySelectorAll(".sq-reading-line")];
    assert.equal(lines.length, 1, `${placement}: one plain line`);
    assert.equal(lines[0]!.getAttribute("role"), "status");
    assert.ok(lines[0]!.classList.contains("sq-trackerline"), "it takes the tracker line's place, so the tracker line lands where it was");
    assert.equal(lines[0]!.textContent, "Reading the board…", "the tracker isn't known yet");
  }
  const linear = await view({ loading: true, tracker: { kind: "linear" } });
  assert.equal(linear.querySelector(".sq-reading-line")?.textContent, "Reading Linear…", "named for the project's tracker when known");
  const github = await view({ loading: true, tracker: { kind: "github" } });
  assert.equal(github.querySelector(".sq-reading-line")?.textContent, "Reading GitHub…");
  const arrived = await view({ board: { ...empty, laneCapacity: 3 } });
  assert.equal(arrived.querySelectorAll(".sq-reading-row, .sq-reading-line").length, 0, "the arrived board has no placeholders");
});

test("while the first read is in flight, the banner's planes taxi on their stands and no lane count is shown", async () => {
  for (const placement of ["page", "panel"] as const) {
    const doc = await view({ placement, loading: true });
    const banner = doc.querySelector(".sq-runway")!;
    assert.equal(banner.getAttribute("data-stands"), "3", `${placement}: three taxiing stands`);
    assert.equal(banner.getAttribute("data-loading"), "true");
    assert.equal(doc.querySelectorAll(".sq-runway-plane").length, 0, "a taxiing plane isn't a lane to click");
    assert.doesNotMatch(doc.body.textContent ?? "", /lanes? flying/, `${placement}: no lane count shown or read out`);
  }
  const arrived = await view({ board: { ...empty, laneCapacity: 3, lanes: [lane("FIX-1")] } });
  assert.equal(arrived.querySelector(".sq-runway")?.getAttribute("data-loading"), null);
  assert.match(arrived.body.textContent ?? "", /1 of 3 lanes flying/);
});

// ---------- the live board: first read, data arrival, refresh and failure ----------

async function liveHarness(answer: (call: number) => Promise<Board>) {
  await import("./fixtures/app-runtime.js");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const browser = dom.window;
  Object.defineProperty(browser.document, "visibilityState", { get: () => "visible" });
  browser.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof browser.matchMedia;
  browser.HTMLCanvasElement.prototype.getContext = (() => null) as typeof browser.HTMLCanvasElement.prototype.getContext;
  const intervals = new Map<number, () => void>();
  let timer = 0;
  browser.setInterval = ((callback: () => void) => { intervals.set(++timer, callback); return timer; }) as typeof browser.setInterval;
  browser.clearInterval = (id) => { if (id !== undefined) intervals.delete(id); };
  const globals = { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element,
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const runtime = (globalThis as any).__bbPluginRuntime.pluginSdkApp;
  const oldRpc = runtime.useRpc, oldRealtime = runtime.useRealtime;
  let reads = 0;
  const rpc = { call: async (method: string) => {
    if (method === "helper.read") return null;
    if (method === "board.projects") return { projects: [{ id: "proj-one", name: "Fixture" }], lastPick: null };
    assert.equal(method, "board");
    return answer(++reads);
  } };
  runtime.useRpc = () => rpc;
  runtime.useRealtime = () => undefined;
  const { LiveBoard } = await import("../board/Board.js");
  const root = createRoot(browser.document.getElementById("root")!);
  await act(async () => root.render(createElement(LiveBoard, { modeSwitch: null, context: "proj-one" })));
  const doc = browser.document;
  return {
    doc, act,
    poll: () => act(async () => { for (const callback of intervals.values()) callback(); }),
    loading: () => doc.querySelectorAll(".sq-reading-row").length > 0,
    async close() {
      await act(async () => root.unmount());
      runtime.useRpc = oldRpc; runtime.useRealtime = oldRealtime;
      browser.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("the live board shows the loading state only until its first read, then keeps the last board through refreshes", async () => {
  const board: Board = { ...empty, laneCapacity: 2, autopilot: autopilot("off"),
    ready: [{ id: "FIX-9", title: "A ready spec", ticketCount: 1, routes: [], blockedBy: [], acceptOwner: false }] };
  const pending: Array<(board: Board) => void> = [];
  const live = await liveHarness(() => new Promise<Board>((resolve) => pending.push(resolve)));
  try {
    assert.ok(live.loading(), "the first read is in flight: placeholders show");
    assert.equal(live.doc.querySelector(".sq-reading-line")?.textContent, "Reading the board…");
    assert.equal(live.doc.querySelectorAll(".sq-empty, .sq-clear").length, 0, "and no empty state");
    assert.equal(live.doc.querySelector(".sq-runway")?.getAttribute("data-loading"), "true");
    await live.act(async () => { pending.shift()!(board); });
    assert.equal(live.loading(), false, "the board replaced the placeholders");
    assert.equal(live.doc.querySelectorAll(".sq-reading-line").length, 0);
    assert.equal(live.doc.querySelector(".sq")?.getAttribute("aria-busy"), null);
    assert.match(live.doc.body.textContent ?? "", /A ready spec/);
    await live.poll();
    assert.ok(pending.length > 0, "a refresh is in flight");
    assert.equal(live.loading(), false, "a refresh never shows the loading state");
    assert.match(live.doc.body.textContent ?? "", /A ready spec/, "the last board stays while it reads");
  } finally { await live.close(); }
});

test("a failed first read leaves the loading state for the existing error", async () => {
  const live = await liveHarness(() => Promise.reject(new Error("offline")));
  try {
    assert.equal(live.loading(), false);
    assert.equal(live.doc.querySelectorAll(".sq-reading-line").length, 0);
    assert.equal(live.doc.querySelector(".sq-runway")?.getAttribute("data-loading"), null);
    assert.match(live.doc.body.textContent ?? "", /Couldn't load the board\. Make sure BB is running, then try again\./);
  } finally { await live.close(); }
});

// ---------- the controls row holds its shape when the board arrives ----------
// The real browser measurement is tests/first-load-geometry.test.ts's page; these pin the held places it relies on.

/** An element's layout skeleton: tags and classes all the way down, ignoring text, state attributes, the held-place class and its out-of-flow placeholder bar. */
function skeleton(el: Element): string {
  const classes = [...el.classList].filter((c) => c !== "sq-reserve").sort().join(".");
  const children = [...el.children].filter((child) => !child.classList.contains("sq-autopilot-reading"));
  return `${el.tagName.toLowerCase()}${classes ? `.${classes}` : ""}(${children.map(skeleton).join(",")})`;
}

test("while loading, Autopilot and its note hold their places, unseen and inert, as the real controls that replace them", async () => {
  for (const placement of ["page", "panel"] as const) {
    const loading = await view({ placement, loading: true });
    const held = loading.querySelector(".sq-controls .sq-autopilot")!;
    assert.ok(held.classList.contains("sq-reserve"), `${placement}: Autopilot's place is held, drawn invisible`);
    assert.equal(held.getAttribute("aria-hidden"), "true", "hidden from assistive tech: its state isn't known yet");
    assert.ok(held.hasAttribute("inert"), "and nothing in it can be focused or pressed");
    assert.equal(held.getAttribute("aria-label"), null);
    assert.ok(held.querySelector(":scope > canvas.sq-reading-bar.sq-autopilot-reading"), "the held place shows the sections' dither shimmer, laid over it");
    assert.match(readFileSync(join(process.cwd(), "board/board.css"), "utf8"), /\.sq-reserve > \.sq-autopilot-reading \{[^}]*position: absolute;[^}]*visibility: visible;/,
      "the bar takes no room of its own and shows through the hidden place");
    const note = loading.querySelector(".sq-controls .sq-autopilot-runtime")!;
    assert.ok(note.classList.contains("sq-reserve") && note.getAttribute("aria-hidden") === "true", `${placement}: its note's line is held too`);
    for (const status of ["off", "on", "paused"] as const) {
      const ready = await view({ placement, board: { ...empty, laneCapacity: 3, lanes: [lane("FIX-1")], autopilot: autopilot(status) } });
      const real = ready.querySelector(".sq-controls .sq-autopilot")!;
      assert.equal(skeleton(real), skeleton(held), `${placement}, Autopilot ${status}: the same controls fill the held place`);
      assert.equal(ready.querySelectorAll(".sq-controls .sq-reserve, .sq-controls [inert]").length, 0, "the real controls are live");
      assert.equal(real.getAttribute("aria-label"), "Autopilot controls");
    }
  }
});

test("Autopilot's state never changes its width: what it is doing now is said on its note's one line", async () => {
  const checking = await view({ board: { ...empty, laneCapacity: 3, autopilot: { ...autopilot("on"), checkingMain: true } } });
  assert.equal(checking.querySelectorAll(".sq-autopilot .sq-autopilot-note").length, 0, "no note inside the controls");
  const note = checking.querySelector(".sq-autopilot-runtime")!;
  assert.match(note.textContent ?? "", /^Checking main… Autopilot runs only while BB runs on this Mac\.$/);
  assert.equal(note.getAttribute("title"), "Checking main… Autopilot runs only while BB runs on this Mac.", "the whole note on hover when the line is cut");
  const waiting = await view({ board: { ...empty, laneCapacity: 3, autopilot: { ...autopilot("paused"), waitingForLinear: true, pauseReason: "Waiting for Linear." } } });
  assert.match(waiting.querySelector(".sq-autopilot-runtime")?.textContent ?? "", /^Waiting for Linear\. Autopilot runs/);
  assert.ok(waiting.querySelector(".sq-autopilot-status"), "On, Off and Paused sit in one fixed-width word");
});

test("the live board holds the tracker line's place before the read and whatever the read brings", async () => {
  const disconnected = { kind: "linear" as const, state: "disconnected" as const, message: "Connect Linear.", syncedAt: null, project: null };
  for (const options of [{ loading: true }, { board: { ...empty, tracker: disconnected } }, { board: { ...empty, tracker: { ...disconnected, state: "current" as const, syncedAt: 0 } } }]) {
    const doc = await view(options);
    const slots = doc.querySelectorAll(".sq-page > .sq-trackerslot");
    assert.equal(slots.length, 1, "one tracker line slot, before the path strip");
    assert.equal(slots[0]!.nextElementSibling?.classList.contains("sq-path"), true);
  }
});

test("in the narrow layout the lane label always sits in the controls row, so the lane limit never moves the page", async () => {
  for (const laneCapacity of [1, 2, 3, 10]) {
    const doc = await view({ placement: "panel", board: { ...empty, laneCapacity, lanes: [lane("FIX-1")] } });
    assert.equal(doc.querySelector(".sq-runway .sq-runway-label"), null, `${laneCapacity} stands: nothing on the tarmac`);
    assert.match(doc.querySelector(".sq-controls-lead .sq-runway-label")?.textContent ?? "", /^1 of \d+ lanes? flying/, `${laneCapacity} stands: on the lead line`);
  }
  const loading = await view({ placement: "panel", loading: true });
  assert.equal(loading.querySelectorAll(".sq-runway-label").length, 0, "before the read there is no count to show");
});

test("while loading, Doctor's verdict place shows a dither bar, read out as nothing until the verdict lands", async () => {
  for (const placement of ["page", "panel"] as const) {
    const doc = await view({ placement, loading: true });
    const word = doc.querySelector(".sq-doctor .sq-doctor-word")!;
    assert.equal(word.getAttribute("aria-hidden"), "true");
    assert.ok(word.querySelector("canvas.sq-reading-bar"));
    assert.equal(doc.querySelector(".sq-doctor")?.textContent, "Doctor");
  }
});

test("before the read the Landed count's dash sits in the flip window its number lands in", async () => {
  const doc = await view({ loading: true });
  const landed = [...doc.querySelectorAll(".sq-station-count")].at(-1)!;
  assert.ok(landed.querySelector(".sq-flip .sq-flip-digit svg.sq-pixeltext"), "the dash in a flip window");
  assert.equal(landed.querySelector(".sq-sr")?.textContent, "Not read yet");
});
