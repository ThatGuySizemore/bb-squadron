// SQD-222: the runway banner. One geometry places the stands, the planes over
// them, the SQUADRON stencil and the "M of N lanes flying" label; the painter
// draws clouds, tarmac and stands from it. Pixel tests, as for the formation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countInk as count, pixelAt as at } from "./fixtures/pixel-count.js";
import { createDitherRenderer, type RendererEnv } from "../lib/dither-renderer.js";
import { createSurface, pixelsOf, type Surface } from "../lib/dither.js";
import { windSpeed } from "../lib/working-agents.js";
import { runway, runwayMotion, runwayState, RUNWAY_HEIGHT, runwayLayout, RUNWAY_PLANE, type Box, type RunwayInks, type RunwayState } from "../lib/runway.js";

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Box, width: number, height: number) => a.x >= 0 && a.y >= 0 && a.x + a.w <= width && a.y + a.h <= height;

test("the banner is 164px tall on the page and 140px in the side panel, with the tarmac along its foot", () => {
  assert.equal(RUNWAY_HEIGHT.wide, 164);
  assert.equal(RUNWAY_HEIGHT.narrow, 140);
  for (const narrow of [false, true]) {
    const g = runwayLayout(1200, narrow, 4, "2 of 4 lanes flying");
    assert.equal(g.height, narrow ? 140 : 164);
    assert.ok(g.tarmac.y + g.tarmac.h <= g.height && g.tarmac.y > g.height / 2, "the tarmac is a strip at the foot");
    assert.ok(g.title, "SQUADRON is stencilled on the tarmac");
    assert.ok(g.title.y >= g.tarmac.y && g.title.y + g.title.h <= g.tarmac.y + g.tarmac.h, "the stencil sits inside the tarmac");
  }
});

test("on a full page, planes are about three times today's 24px plane and every stand fits at the right", () => {
  const g = runwayLayout(1200, false, 4, "2 of 4 lanes flying");
  assert.equal(g.stands.length, 4);
  assert.equal(g.plane.w, 64, "16 cells of 4px, nose to tail");
  assert.ok(g.stands.every((s) => s.park.x > g.title!.x + g.title!.w), "stands sit to the right of the stencil");
  assert.ok(g.label, "a wide banner has room for the label on the tarmac");
});

test("nothing in the banner overlaps the stencil, the label, a stand or a plane, at any width", () => {
  const label = (slots: number) => `${slots} of ${slots} lanes flying`;
  // The page takes the wide layout only above 900px; the narrow one (and the side panel) runs from 320px up.
  for (const narrow of [false, true]) {
    for (let width = narrow ? 320 : 901; width <= 1800; width += 13) {
      for (let slots = 1; slots <= 10; slots++) {
        const g = runwayLayout(width, narrow, slots, label(slots));
        const where = `${narrow ? "panel" : "page"} ${width}px, ${slots} stands`;
        assert.equal(g.stands.length, slots, `${where}: one stand per slot`);
        assert.ok(g.title, `${where}: SQUADRON fits`);
        const boxes: Array<[string, Box]> = [["title", g.title], ...(g.label ? [["label", g.label] as [string, Box]] : []),
          ...g.stands.flatMap((s, i): Array<[string, Box]> => [[`stand ${i}`, s.park], [`plane ${i}`, s.air]])];
        for (const [name, box] of boxes) assert.ok(inside(box, width, g.height), `${where}: ${name} stays inside the banner`);
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          assert.ok(!overlaps(boxes[i]![1], boxes[j]![1]), `${where}: ${boxes[i]![0]} overlaps ${boxes[j]![0]}`);
        }
        if (g.label) {
          assert.ok(g.label.y >= g.tarmac.y && g.label.y + g.label.h <= g.tarmac.y + g.tarmac.h, `${where}: the label sits on the flat tarmac`);
        }
      }
    }
  }
});

test("a label that can't fit between the stencil and the stands leaves the banner rather than crowd it", () => {
  const g = runwayLayout(560, true, 4, "4 of 4 lanes flying");
  assert.equal(g.label, null);
  const roomy = runwayLayout(560, true, 1, "1 of 1 lane flying");
  assert.ok(roomy.label, "one stand leaves room for it");
});

test("more stands than the widest planes allow shrink the planes before they ever crowd", () => {
  const few = runwayLayout(560, true, 3, "");
  const many = runwayLayout(560, true, 10, "");
  assert.ok(many.plane.w < few.plane.w, "ten stands in the side panel draw smaller planes");
  const crowded = runwayLayout(320, true, 12, "");
  assert.equal(crowded.stands.length, 12);
  for (let i = 1; i < 12; i++) assert.ok(!overlaps(crowded.stands[i - 1]!.park, crowded.stands[i]!.park), "stands never overlap each other");
});

// ---------- the painter ----------

const INKS: RunwayInks = {
  cloud: 0xff111111, tarmac: 0xff222222, line: 0xff333333, rule: 0xff444444, stand: 0xff555555, plane: 0xff0000ff,
  trail: 0xff00ff00, beacon: 0xff00aaff, holding: 0xffff0000,
};
const empty = (n: number): RunwayState["stands"] => Array.from({ length: n }, () => ({ kind: "empty" as const }));

function paint(state: RunwayState, seconds: number, { width = 1200, narrow = false, label = "" } = {}): Surface {
  const s = createSurface(width, narrow ? RUNWAY_HEIGHT.narrow : RUNWAY_HEIGHT.wide, 1);
  runway({ state, narrow, label, inks: INKS })(s, seconds);
  return s;
}

test("clouds drift right to left on the lanes' wind, and stay put when nobody works", () => {
  const state = { stands: empty(3), working: 4 };
  const g = runwayLayout(1200, false, 3, "");
  const before = paint(state, 0), after = paint(state, 0.5);
  assert.ok(pixelsOf(before, INKS.cloud) > 500, "there are clouds to watch");
  // Four agents blow the lanes' wind at 32px/s, so in half a second every cloud pixel moves exactly 16px to the left.
  const shift = 16;
  assert.equal(windSpeed(4) * 0.5, shift);
  let compared = 0;
  for (let y = 0; y < g.tarmac.y; y++) for (let x = 0; x + shift < before.w; x++) {
    const was = at(before, x + shift, y) === INKS.cloud, is = at(after, x, y) === INKS.cloud;
    assert.equal(is, was, `the cloud at ${x + shift},${y} has moved to ${x},${y}`);
    compared++;
  }
  assert.ok(compared > 100_000);
  const still = { stands: empty(3), working: 0 };
  assert.deepEqual(paint(still, 0).buf, paint(still, 7).buf, "no agents working, no drift");
});

test("clouds stay in the sky: the tarmac under the stencil and the label is flat, with no moving dither", () => {
  const label = "1 of 3 lanes flying";
  const state = { stands: [{ kind: "flying" as const, laneId: "SQD-1", beacon: null, workKind: "spec" as const }, ...empty(2)], working: 4 };
  const g = runwayLayout(1200, false, 3, label);
  assert.ok(g.label && g.title);
  const texts: Array<[string, Box]> = [["stencil", g.title], ["label", g.label]];
  for (const t of [0, 0.5, 3.2]) {
    const s = paint(state, t, { label });
    assert.equal(count(s, INKS.cloud, { x: 0, y: g.tarmac.y, w: s.w, h: s.h - g.tarmac.y }), 0, "no cloud on or below the tarmac");
    for (const [name, box] of texts) {
      assert.equal(count(s, INKS.tarmac, box), box.w * box.h, `the ${name} sits on plain tarmac`);
    }
  }
});

test("empty stands are dotted outlines; a flying lane lights its plane over its stand", () => {
  const state: RunwayState = { stands: [{ kind: "flying", laneId: "SQD-1", beacon: null, workKind: "spec" }, { kind: "empty" }, { kind: "flying", laneId: "SQD-2", beacon: null, workKind: "spec" }, { kind: "empty" }], working: 0 };
  const g = runwayLayout(1200, false, 4, "");
  const s = paint(state, 0.8);
  const solid = 4 * 4 * RUNWAY_PLANE.join("").split("").filter((c) => c === "#").length;
  g.stands.forEach((stand, i) => {
    const lit = state.stands[i]!.kind === "flying";
    const dots = count(s, INKS.stand, stand.park), plane = count(s, INKS.plane, stand.air);
    if (lit) {
      assert.equal(dots, 0, `stand ${i}: its plane is up, so the stand is clear`);
      assert.ok(plane > solid * 0.8, `stand ${i}: the lit plane is drawn solid over the stand (${plane} px)`);
    } else {
      assert.ok(dots > 0, `stand ${i}: an empty stand is drawn`);
      assert.ok(dots < solid / 2, `stand ${i}: dotted, never solid (${dots} px of ${solid})`);
      assert.equal(plane, 0, `stand ${i}: no plane flies over an empty stand`);
    }
  });
});

test("the banner's state comes from the lanes: one stand per slot in the lane limit, lit in board order", () => {
  const lane = (specId: string, state: "flying" | "stopped" | "pr-open" | "landed") => ({ specId, state });
  const lanes = [lane("A-1", "flying"), lane("A-2", "landed"), lane("A-3", "stopped"), lane("A-4", "pr-open")];
  assert.deepEqual(runwayState(lanes, 5, 3), {
    stands: [{ kind: "flying", laneId: "A-1", beacon: null, workKind: "spec" }, { kind: "holding", laneId: "A-3", beacon: null, workKind: "spec" }, { kind: "flying", laneId: "A-4", beacon: null, workKind: "spec" }, { kind: "empty" }, { kind: "empty" }],
    working: 3,
  }, "a Landed lane takes no stand, a stopped one holds; the board's working-agent count paces the clouds");
  assert.equal(runwayState([], 0, 0).stands.length, 1, "with no lane limit and nothing flying, one empty stand");
  assert.equal(runwayState(lanes, 2, 0).stands.length, 3, "lanes started over the limit add stands");
});

test("the banner moves only while something flies or works, and draws one still frame under reduced motion", () => {
  assert.equal(runwayMotion({ stands: empty(3), working: 0 }).animated, false);
  assert.equal(runwayMotion({ stands: empty(3), working: 2 }).animated, true);
  assert.equal(runwayMotion({ stands: [{ kind: "flying", laneId: "A-1", beacon: null, workKind: "spec" }], working: 0 }).animated, true);

  let now = 0;
  const frames: Array<(t: number) => void> = [];
  const env: RendererEnv = {
    now: () => now, requestFrame: (cb) => frames.push(cb), cancelFrame: () => undefined,
    isHidden: () => false, onVisibilityChange: () => undefined, prefersReducedMotion: () => true, onReducedMotionChange: () => undefined,
  };
  const state = { stands: [{ kind: "flying" as const, laneId: "A-1", beacon: null, workKind: "spec" as const }, ...empty(2)], working: 3 };
  const drawn: Surface[] = [];
  const painter = runway({ state, narrow: false, label: "", inks: INKS });
  createDitherRenderer(env).add({ ...runwayMotion(state), visible: true, draw: (t) => { const s = createSurface(1200, 164, 1); painter(s, t); drawn.push(s); } });
  now = 5000;
  assert.equal(frames.length, 0, "no frame loop under reduced motion");
  assert.equal(drawn.length, 1, "one still frame");
  assert.ok(pixelsOf(drawn[0]!, INKS.plane) > 0 && pixelsOf(drawn[0]!, INKS.cloud) > 0, "the still frame still shows planes and clouds");
});
