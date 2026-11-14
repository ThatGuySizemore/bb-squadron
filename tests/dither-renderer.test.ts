// SIZE-956: the board's dither renderer. One frame loop paints every animated
// surface; it stops drawing while the document is hidden and paints one still
// frame under prefers-reduced-motion. Driven through a fake frame clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDitherRenderer, type RendererEnv } from "../lib/dither-renderer.js";
import { airstream, createSurface, formation, FORMATION_SIZE, pixelsOf } from "../lib/dither.js";

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
  formation({ flying: 2, on: 0xff0000ff, off: 0xff888888 })(one, 0.8);
  formation({ flying: 2, on: 0xff0000ff, off: 0xff888888 })(two, 0.8);
  assert.equal(two.buf.length, one.buf.length * 4);
  assert.ok(pixelsOf(two, 0xff0000ff) > 0, "flying chevrons are inked");
});

test("an airstream with no working threads is still; with work it flows", () => {
  const ink = 0xffd6a73f;
  const still = createSurface(200, 48, 1);
  const paintStill = airstream({ pace: 0, ink });
  paintStill(still, 0);
  const a = [...still.buf];
  paintStill(still, 3);
  assert.deepEqual([...still.buf], a, "pace 0 draws the same frame at any time");

  const moving = createSurface(200, 48, 1);
  const paintMoving = airstream({ pace: 2, ink });
  paintMoving(moving, 0);
  const b = [...moving.buf];
  paintMoving(moving, 0.5);
  assert.notDeepEqual([...moving.buf], b, "working threads move the streaks");
});

test("no steps() animation remains on the board", async () => {
  const dir = join(process.cwd(), "board");
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".css")) continue;
    const css = await readFile(join(dir, name), "utf8");
    assert.doesNotMatch(css, /steps\(/, `${name} still uses steps()`);
  }
});
