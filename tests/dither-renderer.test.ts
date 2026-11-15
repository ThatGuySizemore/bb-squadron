// SIZE-956: the board's dither renderer. One frame loop paints every animated
// surface; it stops drawing while the document is hidden and paints one still
// frame under prefers-reduced-motion. Driven through a fake frame clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDitherRenderer, type RendererEnv } from "../lib/dither-renderer.js";
import { airstream, createSurface, formation, formationSize, FORMATION_SIZE, pixelsOf } from "../lib/dither.js";
import { windSpeed } from "../lib/working-agents.js";

/** A browser stand-in: frames run only when the test says so. */
function fakeEnv(options: { reduced?: boolean } = {}) {
  let now = 0;
  let nextId = 1;
  const frames = new Map<number, (time: number) => void>();
  const visibility: Array<() => void> = [];
  const motion: Array<() => void> = [];
  const state = { hidden: false, reduced: options.reduced ?? false };
  const env: RendererEnv = {
    now: () => now,
    requestFrame: (callback) => { const id = nextId++; frames.set(id, callback); return id; },
    cancelFrame: (id) => { frames.delete(id); },
    isHidden: () => state.hidden,
    onVisibilityChange: (callback) => { visibility.push(callback); },
    prefersReducedMotion: () => state.reduced,
    onReducedMotionChange: (callback) => { motion.push(callback); },
  };
  return {
    env,
    /** Advances the clock by one 60 Hz frame and runs whatever frames were requested. */
    tick(count = 1) {
      for (let i = 0; i < count; i++) {
        now += 1000 / 60;
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(now);
      }
    },
    pendingFrames: () => frames.size,
    setHidden(hidden: boolean) { state.hidden = hidden; for (const callback of visibility) callback(); },
    setReduced(reduced: boolean) { state.reduced = reduced; for (const callback of motion) callback(); },
  };
}

function recorder(options: { animated: boolean; stillAt?: number; until?: number }) {
  const drawn: number[] = [];
  return { drawn, target: { ...options, stillAt: options.stillAt ?? 1.5, visible: true, draw: (seconds: number) => { drawn.push(seconds); } } };
}

test("an animated surface draws continuously, then stops drawing while the document is hidden", () => {
  const browser = fakeEnv();
  const renderer = createDitherRenderer(browser.env);
  const lane = recorder({ animated: true });
  renderer.add(lane.target);
  browser.tick(10);
  const whileShown = lane.drawn.length;
  assert.ok(whileShown >= 10, `draws every frame while shown (drew ${whileShown})`);
  assert.ok(lane.drawn.every((t, i) => i === 0 || t > lane.drawn[i - 1]!), "time moves forward every frame, never cycling");

  browser.setHidden(true);
  browser.tick(30);
  assert.equal(lane.drawn.length, whileShown, "nothing is drawn while the document is hidden");
  assert.equal(browser.pendingFrames(), 0, "no frame is requested while hidden");

  browser.setHidden(false);
  browser.tick(3);
  assert.ok(lane.drawn.length > whileShown, "drawing resumes when the document is shown again");
});

test("under prefers-reduced-motion each surface draws one still frame and the loop never runs", () => {
  const browser = fakeEnv({ reduced: true });
  const renderer = createDitherRenderer(browser.env);
  const lane = recorder({ animated: true, stillAt: 2.4 });
  renderer.add(lane.target);
  browser.tick(30);
  assert.deepEqual(lane.drawn, [2.4], "one still frame, at the surface's still moment");
  assert.equal(browser.pendingFrames(), 0, "no animation frame is requested");
});

test("turning reduced motion on mid-flight replaces the motion with a still frame", () => {
  const browser = fakeEnv();
  const renderer = createDitherRenderer(browser.env);
  const lane = recorder({ animated: true, stillAt: 0.9 });
  renderer.add(lane.target);
  browser.tick(5);
  browser.setReduced(true);
  const after = lane.drawn.length;
  assert.equal(lane.drawn[after - 1], 0.9, "the last thing drawn is the still frame");
  browser.tick(20);
  assert.equal(lane.drawn.length, after, "no more frames once motion is reduced");
});

test("still surfaces draw once; a one-time burst stops at its end; a surface off screen is skipped", () => {
  const browser = fakeEnv();
  const renderer = createDitherRenderer(browser.env);
  const plate = recorder({ animated: false });
  const burst = recorder({ animated: true, until: 0.5 });
  const offscreen = recorder({ animated: true });
  let finished = 0;
  renderer.add(plate.target);
  renderer.add({ ...burst.target, onDone: () => { finished++; } });
  renderer.add({ ...offscreen.target, visible: false });
  browser.tick(60);
  assert.deepEqual(plate.drawn, [1.5], "a still surface draws once");
  assert.equal(finished, 1, "the burst reports its end once");
  assert.equal(burst.drawn[burst.drawn.length - 1], 0.5, "the burst ends on its final frame");
  assert.ok(burst.drawn.length < 40, "the burst stops drawing after it ends");
  assert.equal(offscreen.drawn.length, 1, "an off-screen surface is not redrawn every frame");
});

test("the loop stops when no animated surface is left", () => {
  const browser = fakeEnv();
  const renderer = createDitherRenderer(browser.env);
  const lane = recorder({ animated: true });
  renderer.add(lane.target);
  browser.tick(2);
  renderer.remove(lane.target);
  browser.tick(2);
  assert.equal(browser.pendingFrames(), 0);
});

test("dither is drawn per device pixel: a 2x surface holds four times the pixels of a 1x one", () => {
  const one = createSurface(FORMATION_SIZE.width, FORMATION_SIZE.height, 1);
  const two = createSurface(FORMATION_SIZE.width, FORMATION_SIZE.height, 2);
  formation({ slots: 3, lit: 2, on: 0xff0000ff, off: 0xff888888 })(one, 0.8);
  formation({ slots: 3, lit: 2, on: 0xff0000ff, off: 0xff888888 })(two, 0.8);
  assert.equal(two.buf.length, one.buf.length * 4);
  assert.ok(pixelsOf(two, 0xff0000ff) > 0, "flying planes are inked");
});

// SQD-214: the formation mark shows this project's lanes. Each plane is 18
// cells on the 3px cell (9 device pixels each at 1x): a fuselage of 8, swept
// wings of 4 and 4, and tail fins of 1 and 1.
const SKY = 0xffd6a73f, HAIRLINE = 0xff888888, TRAIL = 0xff00ff00;
const PLANE_PIXELS = 18 * 9;

/** The device-pixel coordinates holding `ink`. */
function inked(s: ReturnType<typeof createSurface>, ink: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (s.buf[y * s.w + x] === ink) out.push([x, y]);
  return out;
}

test("SQD-214: a still frame draws one plane per slot, lit planes in sky and empty ones in hairline", () => {
  const frame = (slots: number, lit: number) => {
    const s = createSurface(FORMATION_SIZE.width, FORMATION_SIZE.height, 1);
    formation({ slots, lit, on: SKY, off: HAIRLINE, trail: TRAIL })(s, 0.8);
    return s;
  };
  assert.deepEqual(FORMATION_SIZE, { width: 184, height: 80 }, "about twice the old 92x40 mark");
  for (const [slots, lit] of [[1, 0], [1, 1], [3, 0], [3, 2], [3, 3], [5, 4], [10, 7], [11, 0], [12, 0], [12, 7], [12, 12], [18, 17]] as const) {
    const s = frame(slots, lit);
    assert.equal(pixelsOf(s, SKY), lit * PLANE_PIXELS, `${lit} of ${slots}: ${lit} lit planes`);
    assert.equal(pixelsOf(s, HAIRLINE), (slots - lit) * PLANE_PIXELS, `${lit} of ${slots}: ${slots - lit} empty slots`);
  }
  assert.equal(pixelsOf(frame(3, 0), TRAIL), 0, "no lane flying, no contrail");
  assert.ok(pixelsOf(frame(3, 1), TRAIL) > 0, "a lit plane trails a contrail");
});

test("SQD-214: planes face right with the contrail trailing behind them, to the left", () => {
  const s = createSurface(FORMATION_SIZE.width, FORMATION_SIZE.height, 1);
  formation({ slots: 1, lit: 1, on: SKY, off: HAIRLINE, trail: TRAIL })(s, 0.8);
  const plane = inked(s, SKY);
  const xs = plane.map(([x]) => x), ys = plane.map(([, y]) => y);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  assert.equal(right - left + 1, 8 * 3, "eight cells long");
  assert.equal(bottom - top + 1, 5 * 3, "five cells across the wings");
  const rows = (x: number) => [...new Set(plane.filter(([px]) => px === x).map(([, y]) => y))].sort((a, b) => a - b);
  const middle = top + 6;
  assert.deepEqual(rows(right), [middle, middle + 1, middle + 2], "the nose is one cell, at the right, on the fuselage");
  assert.deepEqual(rows(left), [top + 3, top + 4, top + 5, middle, middle + 1, middle + 2, top + 9, top + 10, top + 11], "the tail at the left carries two fins");
  const trail = inked(s, TRAIL);
  assert.ok(trail.length > 20, "the contrail is drawn");
  assert.ok(trail.every(([x]) => x < left), "every contrail pixel sits behind the tail");
  assert.ok(trail.every(([, y]) => y > top && y < bottom), "the contrail streams from the fuselage");
});

test("an airstream with no wind is still; with working agents it flows", () => {
  const ink = 0xffd6a73f;
  const still = createSurface(200, 48, 1);
  const paintStill = airstream({ speed: windSpeed(0), ink });
  paintStill(still, 0);
  const a = [...still.buf];
  paintStill(still, 3);
  assert.deepEqual([...still.buf], a, "no wind draws the same frame at any time");

  const moving = createSurface(200, 48, 1);
  const paintMoving = airstream({ speed: windSpeed(2), ink });
  paintMoving(moving, 0);
  const b = [...moving.buf];
  paintMoving(moving, 0.5);
  assert.notDeepEqual([...moving.buf], b, "working agents move the streaks");
});


test("large formations grow their canvas and retain every lit and empty sprite at both densities", () => {
  assert.deepEqual(formationSize(12, 0), { width: 184, height: 80 });
  assert.deepEqual(formationSize(24, 13), { width: 184, height: 88 });
  assert.deepEqual(formationSize(1, 48), { width: 184, height: 172 }, "over-limit starts also reserve drawn space");
  for (const dpr of [1, 2]) {
    for (const [slots, lit, skyPixels, emptyPixels] of [[24, 13, 2106, 1782], [48, 30, 4860, 2916], [1, 48, 7776, 0]] as const) {
      const size = formationSize(slots, lit);
      const s = createSurface(size.width, size.height, dpr);
      formation({ slots, lit, on: SKY, off: HAIRLINE, trail: TRAIL })(s, 0.8);
      assert.equal(pixelsOf(s, SKY), skyPixels * dpr * dpr);
      assert.equal(pixelsOf(s, HAIRLINE), emptyPixels * dpr * dpr);
    }
  }
});
