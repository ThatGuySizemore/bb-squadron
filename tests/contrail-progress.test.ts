// SQD-224: each Flying lane's progress is a dithered contrail with a small
// plane at its head, filling as tickets reach the branch. The lane's wind
// moves right to left, like the header, at the same working-agent pace the
// banner clouds use.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Lane, Route, Ticket } from "../lib/board-model.js";
import { airstream, contrail, createSurface, type Surface } from "../lib/dither.js";
import { windSpeed, workingAgents } from "../lib/working-agents.js";

const route: Route = { family: "claude", model: "claude-opus-5-5", effort: "high" };
const ticket = (id: string, state: Ticket["state"]): Ticket => ({ id, title: `Ticket ${id}`, blockedBy: [], route, state, minutes: 0 });
const lane = (specId: string, extra: Partial<Lane> = {}): Lane => ({
  specId, title: `Spec ${specId}`, lead: route, leadThreadId: `thr_lead_${specId}`, branch: `bb/lead-${specId.toLowerCase()}-thr_x`,
  state: "flying", minutes: 12, acceptOwner: false, workingThreads: 2,
  tickets: [ticket(`${specId}-A`, "done"), ticket(`${specId}-B`, "working"), ticket(`${specId}-C`, "blocked")],
  ...extra,
});

test("the working-agent count adds every flying lane's running threads, leaving out stopped and landed lanes", () => {
  assert.equal(workingAgents([]), 0);
  assert.equal(workingAgents([
    lane("A", { workingThreads: 3 }),
    lane("B", { workingThreads: undefined }),
    lane("C", { state: "pr-open", workingThreads: 1 }),
    lane("D", { state: "stopped", stopped: true, workingThreads: 2 }),
    lane("E", { state: "merge-waits", stopped: true, workingThreads: 1 }),
    lane("F", { state: "landed", workingThreads: 4 }),
  ]), 4);
});

test("wind speed is still with nobody working, quickens per agent and tops out at six", () => {
  assert.equal(windSpeed(0), 0);
  const speeds = [1, 2, 3, 4, 5, 6].map(windSpeed);
  assert.ok(speeds.every((speed, i) => speed > 0 && (i === 0 || speed > speeds[i - 1]!)), `rises per agent: ${speeds}`);
  assert.equal(windSpeed(9), windSpeed(6), "six and over share the top pace");
});

// ---------- the contrail painter, at the pixel level ----------
const TRAIL = 0xffd6a73f, PLANE = 0xff3f3fd6, GUIDE = 0xff888888;
const WIDTH = 320, HEIGHT = 16;

/** The device-pixel coordinates holding `ink`. */
function inked(s: Surface, ink: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (s.buf[y * s.w + x] === ink) out.push([x, y]);
  return out;
}
function paint(done: number, total: number, { dpr = 1, speed = 0, at = 1.2 } = {}): Surface {
  const s = createSurface(WIDTH, HEIGHT, dpr);
  contrail({ done, total, speed, trail: TRAIL, plane: PLANE, guide: GUIDE })(s, at);
  return s;
}

test("the contrail's filled length is tickets in branch over total, and the plane sits at its head", () => {
  // The plane is 8 x 5 cells on a 2px cell, so its tail can travel 320 - 16 = 304px.
  for (const [done, total, filled] of [[0, 5, 0], [3, 7, 130], [7, 7, 304], [0, 0, 0]] as const) {
    for (const dpr of [1, 2]) {
      const s = paint(done, total, { dpr });
      const plane = inked(s, PLANE);
      assert.equal(plane.length, 18 * 4 * dpr * dpr, `${done}/${total} @${dpr}x: one plane of 18 cells`);
      const left = Math.min(...plane.map(([x]) => x)), right = Math.max(...plane.map(([x]) => x));
      assert.equal(left, filled * dpr, `${done}/${total} @${dpr}x: the plane's tail is at the head of the fill`);
      assert.equal(right - left + 1, 16 * dpr, "the plane is 16px long, nose right");
      const trail = inked(s, TRAIL);
      assert.ok(trail.every(([x]) => x < left), "no contrail ahead of the plane");
      // The solid core: one unbroken run of trail ink from the left edge to the plane.
      const coreRow = Math.max(0, ...[...new Set(trail.map(([, y]) => y))].map((y) => trail.filter(([, ty]) => ty === y).length));
      assert.equal(coreRow, filled * dpr, `${done}/${total} @${dpr}x: the core runs the filled length`);
      const guide = inked(s, GUIDE);
      assert.ok(guide.every(([x]) => x > right), "the dotted guide only marks the way still to go");
      assert.equal(guide.length > 0, done < total, "a guide while tickets remain, none when all are in the branch");
    }
  }
});

test("the contrail streams from the plane's middle, the plane's nose on its centre line", () => {
  const s = paint(4, 7);
  const plane = inked(s, PLANE);
  const right = Math.max(...plane.map(([x]) => x));
  const nose = plane.filter(([x]) => x === right).map(([, y]) => y).sort((a, b) => a - b);
  assert.deepEqual(nose, [7, 8], "the nose is one 2px cell on the row's centre line");
  const trail = inked(s, TRAIL);
  const ys = trail.map(([, y]) => y);
  assert.ok(Math.min(...ys) >= 0 && Math.max(...ys) < HEIGHT);
  const centre = trail.filter(([, y]) => y === 7 || y === 8).length;
  const edge = trail.filter(([, y]) => y === 0 || y === HEIGHT - 1).length;
  assert.ok(centre > edge * 3, `the trail is densest along the centre line (${centre} vs ${edge} on the edges)`);
});

test("the wind moves only the grain: the fill and the plane hold their place, so any still frame shows the progress", () => {
  const speed = windSpeed(6);
  for (const at of [0, 2.4, 9]) {
    const s = paint(3, 7, { speed, at });
    const plane = inked(s, PLANE);
    assert.equal(Math.min(...plane.map(([x]) => x)), 130, `the plane holds its head at ${at}s`);
    assert.equal(inked(s, TRAIL).filter(([, y]) => y === 7).length >= 130, true, `the core still runs the filled length at ${at}s`);
  }
});

test("with nobody working the contrail is still: the same frame at any time", () => {
  assert.deepEqual([...paint(3, 7, { at: 0 }).buf], [...paint(3, 7, { at: 5 }).buf]);
  assert.notDeepEqual([...paint(3, 7, { speed: windSpeed(2), at: 0 }).buf], [...paint(3, 7, { speed: windSpeed(2), at: 0.5 }).buf],
    "working agents move the trail");
});

/**
 * How many trail pixels each column holds, summed over the 8 columns from it:
 * one period of the fixed Bayer threshold, so only the moving grain shows.
 */
function columns(s: Surface, ink: number): number[] {
  const counts = new Array<number>(s.w).fill(0);
  for (const [x] of inked(s, ink)) counts[x]!++;
  return counts.map((_, x) => counts.slice(x, x + 8).reduce((a, b) => a + b, 0));
}
/** How closely `later` matches `earlier` moved `shift` pixels (positive is rightward), over the middle of the strip. */
function match(earlier: number[], later: number[], shift: number): number {
  let same = 0;
  for (let x = 120; x < 480; x++) same -= Math.abs(later[x + shift]! - earlier[x]!);
  return same;
}

test("lane wind moves right to left: the contrail's grain drifts left over time", () => {
  const speed = windSpeed(3);
  const frame = (at: number) => {
    const s = createSurface(640, HEIGHT, 1);
    contrail({ done: 1, total: 1, speed, trail: TRAIL, plane: PLANE, guide: GUIDE })(s, at);
    return columns(s, TRAIL);
  };
  const shift = Math.round(speed * 0.5);
  const a = frame(2), b = frame(2.5);
  assert.ok(match(a, b, -shift) > match(a, b, shift), "the pattern matches itself moved left, not right");
});

test("the rail's airstream also blows right to left, at the shared wind speed", () => {
  const speed = windSpeed(3);
  const frame = (at: number) => {
    const s = createSurface(640, 48, 1);
    airstream({ speed, ink: TRAIL })(s, at);
    return columns(s, TRAIL);
  };
  const shift = Math.round(speed * 0.5);
  const a = frame(2), b = frame(2.5);
  assert.ok(match(a, b, -shift) > match(a, b, shift), "the airstream matches itself moved left, not right");
});
