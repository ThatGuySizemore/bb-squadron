import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runway, runwayLayout, type RunwayState, type Box } from "../lib/runway.js";
import type { Board, Lane } from "../lib/board-model.js";
import { createSurface, pixelsOf } from "../lib/dither.js";

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Box, width: number, height: number) => a.x >= 0 && a.y >= 0 && a.x + a.w <= width && a.y + a.h <= height;

test("uncapped over-limit lanes retain every stand, plane and padded control on reachable runway ground", () => {
  for (const narrow of [true, false]) for (const width of [320, 360, 560, 900, 1200, 1600]) for (const count of [11, 24, 64, 128]) {
    const g = runwayLayout(width, narrow, count, `${count} of ${count} lanes flying (limit 3)`);
    const where = `${width}px, ${count} lanes, narrow=${narrow}`;
    assert.deepEqual(runwayLayout(g.width, narrow, count, `${count} of ${count} lanes flying (limit 3)`), g, `${where}: canvas and DOM use identical geometry at the expanded width`);
    assert.equal(g.stands.length, count, `${where}: no lane is capped or dropped`);
    assert.ok(g.width >= width, `${where}: content can extend to an accessible overflow area`);
    assert.ok(g.title && inside(g.title, g.width, g.height), `${where}: title stays unobstructed`);
    const targets = g.stands.map(({ air }): Box => ({ x: air.x - 10, y: air.y - 10, w: air.w + 20, h: air.h + 20 }));
    for (const [i, stand] of g.stands.entries()) {
      for (const box of [stand.park, stand.air, targets[i]!]) {
        assert.ok(inside(box, g.width, g.height), `${where}: stand/plane/control ${i} remains inside scrollable content`);
        assert.ok(!overlaps(box, g.title!), `${where}: ${i} clears the title`);
        if (g.label) assert.ok(!overlaps(box, g.label), `${where}: ${i} clears the label`);
      }
      if (i > 0) {
        assert.ok(!overlaps(stand.park, g.stands[i - 1]!.park), `${where}: adjacent stands stay separate`);
        assert.ok(!overlaps(targets[i]!, targets[i - 1]!), `${where}: adjacent padded buttons stay separate`);
      }
    }
  }
});

test("over-limit runway exposes a named keyboard scroll region and every lane button", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { JSDOM } = await import("jsdom");
  const { BoardView } = await import("../board/Board.js");
  const route = { family: "gpt", model: "gpt-6.1-sol", effort: "medium" } as const;
  const lanes: Lane[] = Array.from({ length: 24 }, (_, i) => ({ specId: `A-${i}`, title: `Lane ${i}`, lead: route, leadThreadId: `thr_${i}`, branch: `spec/${i}`,
    state: "flying", minutes: 90, acceptOwner: false, workingThreads: 0, tickets: [] }));
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, lanes, ready: [], shaping: [], openIssues: [] };
  const html = renderToStaticMarkup(createElement(BoardView, { board, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined, placement: "panel" }));
  const dom = new JSDOM(html);
  try {
    const region = dom.window.document.querySelector<HTMLElement>('.sq-runway[role="region"]');
    assert.ok(region, "overflow has an accessible region");
    assert.equal(region.tabIndex, 0, "keyboard users can scroll before choosing a plane");
    assert.equal(region.getAttribute("aria-label"), "Runway, 24 stands. Scroll horizontally to see every plane.");
    assert.equal(region.querySelectorAll("button.sq-runway-plane").length, 24);
    const scene = region.querySelector<HTMLElement>(".sq-runway-scene")!;
    assert.ok(parseFloat(scene.style.width) > 560, "the canvas and DOM share the full content width");
    assert.match(dom.window.document.querySelector(".sq-runway-scroll-hint")?.textContent ?? "", /Scroll the runway to see all 24 stands/);
    const css = readFileSync("board/board.css", "utf8");
    assert.match(css, /\.sq-runway\[data-overflow="true"\]\s*\{[^}]*overflow-x:\s*auto/s, "horizontal overflow is reachable");
  } finally { dom.window.close(); }
});

test("every plane control uses two-pixel corners and an outward sky focus outline", () => {
  const css = readFileSync("board/board.css", "utf8");
  const base = css.match(/\.sq-runway-plane\s*\{([^}]+)\}/)?.[1] ?? "";
  const focus = css.match(/\.sq-runway-plane:focus-visible\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(base, /border-radius:\s*2px/);
  assert.match(focus, /outline:\s*2px solid var\(--sq-sky-ink\)/);
  assert.match(focus, /outline-offset:\s*2px/);
  assert.doesNotMatch(css, /\.sq-runway-plane\[data-beacon\]:focus-visible/, "a beacon never replaces the sky focus ring");
});


test("expanded runway paints every real plane and beacon, with no clipped pixels", () => {
  const inks = { cloud: 1, tarmac: 2, line: 3, rule: 4, stand: 5, plane: 6, trail: 7, beacon: 8, holding: 9 };
  for (const count of [24, 128]) {
    const g = runwayLayout(320, true, count, "");
    const state: RunwayState = { working: 0, stands: Array.from({ length: count }, (_, i) => ({ kind: "flying", laneId: `A-${i}`, beacon: i === count - 1 ? "question:last" : null, workKind: "spec" })) };
    const s = createSurface(g.width, g.height, 1);
    runway({ state, narrow: true, label: "", inks })(s, 0);
    assert.equal(pixelsOf(s, inks.plane), 216 * (count - 1), "each sky plane has all 216 pixels at two-pixel cells");
    assert.equal(pixelsOf(s, inks.beacon), 344, "the last plane has all 216 pixels and 128 bracket pixels");
  }
});
