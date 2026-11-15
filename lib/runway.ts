// The board's runway banner (SQD-221, comp variant B): light clouds drifting
// right to left over a tarmac strip, SQUADRON stencilled on the tarmac and one
// stand per lane in the lane limit. One geometry, runwayLayout(), places
// everything; the painter here and the DOM (the stencil and the label) both read
// it, so the label never lands on a plane or a stand.
import { fbm, fieldIn, rect, type Painter, type Surface } from "./dither.js";
import { layoutPixels } from "./pixels.js";
import { windSpeed } from "./working-agents.js";
import { LANDING_MS, TAKEOFF_MS, type Landings } from "./board-model.js";

/** The banner's height in CSS pixels: a full page, and the narrow layout (the side panel). */
export const RUNWAY_HEIGHT = { wide: 164, narrow: 140 } as const;

export interface Box { x: number; y: number; w: number; h: number }

export interface RunwayLayout {
  width: number;
  height: number;
  /** The flat strip at the foot that carries the stencil, the label and the stands. */
  tarmac: { y: number; h: number };
  /** The plane sprite's cell and size in CSS pixels. */
  cell: number;
  plane: { w: number; h: number };
  /** The threshold bars at the runway's left end, or null when the stands need the room. */
  keys: { x: number; bars: number; bar: number; step: number } | null;
  /** SQUADRON in the pixel font, on the tarmac; null only when no stencil fits. */
  title: (Box & { cell: number; gap: number }) | null;
  /** "M of N lanes flying" on the tarmac, or null when it would crowd: then it sits in the controls row. */
  label: Box | null;
  /** One per slot, right to left from the banner's right edge: where the plane parks, and where it flies. */
  stands: Array<{ park: Box; air: Box }>;
  /** How far a contrail reaches behind its engine, short of the next plane's stand. */
  trail: number;
}

/** The plane seen from above, nose right, 16x9 cells: wings swept back from the middle, a T tail. */
export const RUNWAY_PLANE = [
  "     ###        ",
  "      ###       ",
  "#      ###      ",
  "##    #######   ",
  "################",
  "##    #######   ",
  "#      ###      ",
  "      ###       ",
  "     ###        ",
];
const PLANE_COLS = RUNWAY_PLANE[0]!.length, PLANE_ROWS = RUNWAY_PLANE.length;

/**
 * The engines, in sprite cells: one under each main wing, at its trailing edge.
 * Real contrails form in engine exhaust, so each lit plane's two trails start
 * here and run back clear of the tail.
 */
export const RUNWAY_ENGINES = [{ col: 6, row: 1 }, { col: 6, row: 7 }] as const;

/** A layout candidate: plane cell, stencil cell and gap, and whether the threshold bars stay. */
interface Fit { cell: number; titleCell: number; titleGap: number; keys: boolean }
const WIDE_FITS: Fit[] = [
  { cell: 4, titleCell: 4, titleGap: 1, keys: true },
  { cell: 3, titleCell: 4, titleGap: 1, keys: true },
  { cell: 3, titleCell: 3, titleGap: 0, keys: true },
  { cell: 2, titleCell: 3, titleGap: 0, keys: true },
];
const NARROW_FITS: Fit[] = [
  { cell: 3, titleCell: 3, titleGap: 0, keys: true },
  { cell: 2, titleCell: 3, titleGap: 0, keys: true },
];
/** Shared last resorts: smaller stencils, no threshold bars, then the smallest planes. */
const LAST_FITS: Fit[] = [
  { cell: 2, titleCell: 2, titleGap: 0, keys: true },
  { cell: 2, titleCell: 2, titleGap: 0, keys: false },
  { cell: 1, titleCell: 2, titleGap: 0, keys: false },
  { cell: 1, titleCell: 1, titleGap: 0, keys: false },
];

/** Space between neighbouring stands, and from the last stand to the right edge (room for a holding ring). */
const STAND_GAP: Record<number, number> = { 4: 26, 3: 14, 2: 10, 1: 6 };
const RIGHT_MARGIN: Record<number, number> = { 4: 50, 3: 34, 2: 24, 1: 14 };
/** Clear space kept between the stencil or label and anything else on the tarmac. */
const CLEAR = 16;

/** A generous width for the label's 12px semibold text, so the measured text always fits its box. */
export function runwayLabelWidth(text: string): number {
  return Math.ceil(text.length * 7.2) + 4;
}

export function runwayLayout(width: number, narrow: boolean, slots: number, labelText: string): RunwayLayout {
  const W = Math.max(1, Math.round(width));
  const height = narrow ? RUNWAY_HEIGHT.narrow : RUNWAY_HEIGHT.wide;
  const tarmacH = narrow ? 42 : 52;
  const tarmac = { y: height - tarmacH - 2, h: tarmacH };
  const pad = narrow ? 14 : 30;
  const count = Math.max(1, slots);
  const stencil = layoutPixels("SQUADRON");

  const place = (fit: Fit, withTitle: boolean, force = false): RunwayLayout | null => {
    const { cell } = fit;
    const plane = { w: PLANE_COLS * cell, h: PLANE_ROWS * cell };
    const gap = STAND_GAP[cell]!, right = RIGHT_MARGIN[cell]!;
    const keys = fit.keys ? (narrow ? { x: pad, bars: 4, bar: 3, step: 6 } : { x: pad, bars: 4, bar: 4, step: 9 }) : null;
    const keysEnd = keys ? keys.x + (keys.bars - 1) * keys.step + keys.bar + (narrow ? 10 : 16) : pad;
    let title: RunwayLayout["title"] = null;
    if (withTitle) {
      const pitch = fit.titleCell + fit.titleGap;
      const w = stencil.width * pitch - fit.titleGap, h = stencil.height * pitch - fit.titleGap;
      title = { x: keysEnd, y: tarmac.y + Math.round((tarmac.h - h) / 2), w, h, cell: fit.titleCell, gap: fit.titleGap };
    }
    const leftEdge = (title ? title.x + title.w : keysEnd) + CLEAR;
    const firstX = W - right - plane.w - (count - 1) * (plane.w + gap);
    if (firstX < leftEdge && !force) return null;
    const lift = Math.round(cell * 4.5), stagger = Math.round(cell * 5.5), shift = Math.round(cell * 3.5);
    const parkY = tarmac.y + Math.round((tarmac.h - plane.h) / 2);
    const stands = Array.from({ length: count }, (_, i) => {
      // Stand 0 is the rightmost, so the first lane to fly leads at the right.
      const x = W - right - plane.w - i * (plane.w + gap);
      return {
        park: { x, y: parkY, w: plane.w, h: plane.h },
        air: { x: x + shift, y: tarmac.y - plane.h - lift - (i % 2) * stagger, w: plane.w, h: plane.h },
      };
    });
    const leftmost = stands[count - 1]!.park.x;
    const labelW = labelText ? runwayLabelWidth(labelText) : 0;
    const labelX = (title ? title.x + title.w : keysEnd) + 18;
    const label = labelW && labelX + labelW + CLEAR <= leftmost
      ? { x: labelX, y: tarmac.y + Math.round(tarmac.h / 2) - 9, w: labelW, h: 18 } : null;
    return { width: W, height, tarmac, cell, plane, keys, title, label, stands, trail: plane.w + gap - 10 };
  };

  const fits = [...(narrow ? NARROW_FITS : WIDE_FITS), ...LAST_FITS];
  for (const fit of fits) {
    const layout = place(fit, true);
    if (layout) return layout;
  }
  // Too many stands for a stencil: the stands keep the tarmac, and the page's own heading still names the board.
  const smallest = fits[fits.length - 1]!;
  return place(smallest, false) ?? place(smallest, false, true)!;
}

// ---------- state ----------

/**
 * What one stand shows. A lit stand's kind is its lane's moment: taking off when
 * the lane starts, flying, holding while it's stopped, landing while its burst
 * plays. `beacon` is the key of the lane's first Needs you row, or null: the
 * plane blinks amber exactly while that row exists, and clicking it goes there.
 * `since` is when a takeoff or landing started, in Date.now() milliseconds.
 */
export type RunwayStand =
  | { kind: "empty" }
  | { kind: "flying"; laneId: string; beacon: string | null }
  | { kind: "takeoff"; laneId: string; since: number; beacon: string | null }
  | { kind: "holding"; laneId: string; beacon: string | null }
  | { kind: "landing"; laneId: string; since: number };

/** The banner's whole state, derived from the board in the same update as the lane rows. */
export interface RunwayState {
  stands: RunwayStand[];
  /** The board's working-agent count (workingAgents()): the same count that paces each lane's wind. */
  working: number;
  /**
   * When the banner's clock starts, in Date.now() milliseconds: the newest
   * takeoff or landing on it, so that moment and its lane's burst share a start.
   * Absent while no moment plays.
   */
  at?: number;
}

/** What the board view knows beyond the lanes, read in the same update: its Needs you rows and the moments it has seen. */
export interface RunwayMoments {
  /** needsYou(board), in the strip's order. */
  needs: ReadonlyArray<{ key: string; specId: string }>;
  /** nextLandings() for this update. */
  landings: Landings | null;
  now: number;
}

type RunwayLane = { specId: string; state: string; stopped?: boolean };

/** One lane's stand, from its own state. Null for a lane that has landed and finished its landing. */
function standFor(lane: RunwayLane, moments: RunwayMoments | undefined): RunwayStand | null {
  const laneId = lane.specId;
  const until = moments?.landings?.until[laneId];
  if (lane.state === "landed") {
    return until !== undefined && moments && until > moments.now ? { kind: "landing", laneId, since: until - LANDING_MS } : null;
  }
  const beacon = moments?.needs.find((item) => item.specId === laneId)?.key ?? null;
  // Stopped exactly when the lane shows Resume.
  if (lane.stopped ?? lane.state === "stopped") return { kind: "holding", laneId, beacon };
  const took = moments?.landings?.takeoffs?.[laneId];
  if (took !== undefined && moments && took + TAKEOFF_MS > moments.now) return { kind: "takeoff", laneId, since: took, beacon };
  return { kind: "flying", laneId, beacon };
}

/**
 * One stand per lane in the lane limit, lit in board order by the lanes on the
 * Flying line (anything not Landed, and a lane still landing). With no lane
 * limit the stands are the lanes flying, with one shown when none are; lanes
 * started over the limit add stands. `working` is the board's one working-agent
 * count, the same one each lane's wind reads. `moments` carries what the view
 * read in this update, so each plane's state matches its lane row.
 */
export function runwayState(lanes: ReadonlyArray<RunwayLane>, limit: number, working: number, moments?: RunwayMoments): RunwayState {
  const lit = lanes.map((lane) => standFor(lane, moments)).filter((stand): stand is RunwayStand => stand !== null);
  const slots = Math.max(1, limit, lit.length);
  const starts = lit.flatMap((stand) => "since" in stand ? [stand.since] : []);
  return {
    stands: Array.from({ length: slots }, (_, i): RunwayStand => lit[i] ?? { kind: "empty" }),
    working: Math.max(0, working),
    ...(starts.length ? { at: Math.max(...starts) } : {}),
  };
}

/** Whether the banner moves, and the still frame drawn under reduced motion: late enough that every moment shows its end. */
export function runwayMotion(state: RunwayState): { animated: boolean; stillAt: number } {
  return { animated: windSpeed(state.working) > 0 || state.stands.some((stand) => stand.kind !== "empty"), stillAt: 2.4 };
}

// ---------- the painter ----------

/** Packed inks, read from the board's CSS so they follow the theme. */
export interface RunwayInks {
  /** Light clouds in the sky. */
  cloud: number;
  /** The flat tarmac strip. */
  tarmac: number;
  /** Threshold bars and centre-line dashes. */
  line: number;
  /** The tarmac's top and bottom edges. */
  rule: number;
  /** An empty stand's dotted plane. */
  stand: number;
  /** A lit plane. */
  plane: number;
  /** Its two contrails. */
  trail: number;
  /** A plane whose lane needs the owner, and its brackets. */
  beacon: number;
  /** A stopped lane's plane, and its holding ring. */
  holding: number;
}

const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp01 = (p: number) => Math.min(1, Math.max(0, p));

/** A takeoff rolls along the tarmac for this share of its time, then lifts. */
const ROLL = 0.35;
/** A landing glides down for this share of its time, then rolls back onto its stand. */
const GLIDE = 0.7;
/** One holding circuit, and one beacon blink, in seconds. */
const HOLD_LAP = 4.5, BLINK = 2.4;

/** Where a lit plane is drawn at a moment, how much contrail it leaves, and what marks it. */
interface Pose { x: number; y: number; ink: number; trail: number; ring?: { cx: number; cy: number; r: number }; brackets?: boolean }

/**
 * A lit stand's plane at `age` seconds into its moment. Takeoff rolls off the
 * stand then lifts into the air; landing glides down then rolls back onto the
 * stand; holding circles inside a ring; flying bobs over its stand. A beacon
 * turns the plane amber with blinking brackets. At the reduced-motion still
 * frame each moment is at its end and each mark is lit.
 */
function pose(stand: Exclude<RunwayStand, { kind: "empty" }>, g: RunwayLayout, i: number, seconds: number, age: number, inks: RunwayInks): Pose | null {
  const { park, air } = g.stands[i]!;
  const phase = i * 1.7;
  const bob = { x: Math.sin(seconds * 0.7 + phase) * 0.8, y: Math.sin(seconds * 1.3 + phase) * 1.2 };
  switch (stand.kind) {
    case "landing": {
      const p = clamp01(age / (LANDING_MS / 1000));
      const glide = easeInOut(clamp01(p / GLIDE)), roll = easeOut(clamp01((p - GLIDE) / (1 - GLIDE)));
      return { x: air.x + (park.x - air.x) * roll, y: air.y + (park.y - air.y) * glide, ink: inks.plane, trail: 1 - clamp01(p / 0.5) };
    }
    case "holding": {
      const a = -Math.PI / 4 + seconds * (Math.PI * 2 / HOLD_LAP), r = g.cell * 2;
      return { x: air.x + Math.cos(a) * r, y: air.y + Math.sin(a) * r, ink: inks.holding, trail: 0,
        ring: { cx: air.x + g.plane.w / 2, cy: air.y + g.plane.h / 2, r: g.plane.w * 0.62 + r } };
    }
    case "takeoff":
    case "flying": {
      const p = stand.kind === "takeoff" ? clamp01(age / (TAKEOFF_MS / 1000)) : 1;
      const roll = easeOut(clamp01(p / ROLL)), lift = clamp01((p - ROLL) / (1 - ROLL));
      const x = p < 1 ? park.x + (air.x - park.x) * roll : air.x + bob.x;
      const y = p < 1 ? park.y + (air.y - park.y) * easeOut(lift) : air.y + bob.y;
      const beacon = stand.beacon !== null;
      return { x, y, ink: beacon ? inks.beacon : inks.plane, trail: p < 1 ? lift * 0.5 : 1, brackets: beacon };
    }
  }
}

/** The brackets blink on and off; the still frame and the start of every blink are lit. */
function blinkOn(seconds: number): boolean {
  return Math.sin(seconds * Math.PI * 2 / BLINK) > -0.35;
}

/**
 * Two contrails behind a plane at (x, y), one from each engine, thinning as
 * they reach back and blowing right to left on the board's wind. They stay in
 * the sky, so no trail ever crosses the tarmac's text.
 */
export function runwayTrails(s: Surface, ink: number, x: number, y: number, g: RunwayLayout, reach: number, T: number, speed: number, seed: number): void {
  if (reach < 2) return;
  const c = g.cell, sky = g.tarmac.y - 2;
  for (const engine of RUNWAY_ENGINES) {
    const ex = Math.round(x + engine.col * c), ey = y + (engine.row + 0.5) * c;
    fieldIn(s, ink, (px, py) => {
      const behind = ex - px;
      if (behind <= 0 || behind > reach || py >= sky) return 0;
      const spread = (py - ey) / (c * 0.5 + behind * 0.025);
      const flow = fbm((px + T * speed) / 11, seed + engine.row * 2.3 + py / 4);
      return Math.exp(-spread * spread) * Math.pow(1 - behind / reach, 1.2) * (0.45 + 0.55 * flow);
    }, [ex - reach, ey - c * 2.5, ex, Math.min(sky, ey + c * 2.5)]);
  }
}

/** The holding ring: a dotted ellipse around the plane's air box. */
function ring(s: Surface, ink: number, { cx, cy, r }: { cx: number; cy: number; r: number }): void {
  for (let a = 0; a < 360; a += 9) {
    const rad = a * Math.PI / 180;
    rect(s, ink, cx + Math.cos(rad) * r - 1, cy + Math.sin(rad) * r * 0.7 - 1, 2, 2);
  }
}

/** Beacon brackets: four amber corners just outside the plane. */
function brackets(s: Surface, ink: number, x: number, y: number, w: number, h: number): void {
  const m = 7, a = 9, x0 = x - m, y0 = y - m, x1 = x + w + m, y1 = y + h + m;
  for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]] as const) {
    rect(s, ink, sx > 0 ? cx : cx - a, sy > 0 ? cy : cy - 2, a, 2);
    rect(s, ink, sx > 0 ? cx : cx - 2, sy > 0 ? cy : cy - a, 2, a);
  }
}

/** A plane from RUNWAY_PLANE, one solid square per cell. */
function sprite(s: Surface, ink: number, x: number, y: number, cell: number): void {
  RUNWAY_PLANE.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) if (row[rx] === "#") rect(s, ink, x + rx * cell, y + ry * cell, cell, cell);
  });
}

/** An empty stand: the same plane as a dotted outline, one small dot per cell, so it never reads as a lit plane or a cloud. */
function dotted(s: Surface, ink: number, x: number, y: number, cell: number): void {
  const d = cell >= 3 ? 2 : 1, o = Math.floor((cell - d) / 2);
  RUNWAY_PLANE.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      if (row[rx] !== "#" || (cell === 1 && (rx + ry) % 2)) continue;
      rect(s, ink, x + rx * cell + o, y + ry * cell + o, d, d);
    }
  });
}

/**
 * The runway banner. Clouds drift right to left over the sky only, at the
 * working-agent pace; the tarmac is flat under the stencil and the label so no
 * text sits on moving dither. Empty stands are dotted; each lit stand draws its
 * lane's moment, with two contrails from the engines blowing on the same wind.
 * Moments keep their own clock: `seconds` counts from state.at.
 */
export function runway({ state, narrow, label, inks }: { state: RunwayState; narrow: boolean; label: string; inks: RunwayInks }): Painter {
  // The clouds ride the same wind as the lanes: equal working counts, equal speed.
  const speed = windSpeed(state.working);
  return (s, seconds) => {
    const g = runwayLayout(s.cssW, narrow, state.stands.length, label);
    const W = s.cssW, sky = g.tarmac.y - 4;
    const T = speed === 0 ? 0 : seconds;

    // Weather: light clouds, thinning to nothing just above the tarmac.
    fieldIn(s, inks.cloud, (x, y) => {
      const u = (x + T * speed) / 120, v = y / 34;
      const n = fbm(u, v) * 0.7 + fbm(u * 2.6 + 9, v * 2.2) * 0.3;
      const c = Math.min(1, Math.max(0, (n - 0.54) / 0.2));
      return c * 0.42 * Math.min(1, (sky - y) / 18);
    }, [0, 0, W, sky], 2);

    // The runway: a flat strip between two rules, threshold bars at its left end, a dashed centre line between the label and the stands.
    rect(s, inks.tarmac, 0, g.tarmac.y, W, g.tarmac.h);
    rect(s, inks.rule, 0, g.tarmac.y, W, 2);
    rect(s, inks.rule, 0, g.tarmac.y + g.tarmac.h - 2, W, 2);
    if (g.keys) {
      for (let k = 0; k < g.keys.bars; k++) rect(s, inks.line, g.keys.x + k * g.keys.step, g.tarmac.y + 9, g.keys.bar, g.tarmac.h - 18);
    }
    const from = (g.label ? g.label.x + g.label.w : g.title ? g.title.x + g.title.w : 0) + 16;
    const to = g.stands[g.stands.length - 1]!.park.x - 14;
    const centre = g.tarmac.y + Math.round(g.tarmac.h / 2) - 1;
    for (let x = from; x + 12 <= to; x += 22) rect(s, inks.line, x, centre, 12, 3);

    // Stands and planes: empty stands dotted, then every lit plane's trails, then its marks and the plane on top.
    const poses: Pose[] = [];
    g.stands.forEach(({ park }, i) => {
      const stand = state.stands[i];
      if (!stand || stand.kind === "empty") { dotted(s, inks.stand, park.x, park.y, g.cell); return; }
      const age = seconds + ("since" in stand && state.at !== undefined ? (state.at - stand.since) / 1000 : 0);
      const p = pose(stand, g, i, seconds, age, inks);
      if (p) poses.push(p);
    });
    poses.forEach((p, i) => runwayTrails(s, inks.trail, p.x, p.y, g, g.trail * p.trail, T, speed, i * 5.3));
    for (const p of poses) {
      if (p.ring) ring(s, inks.holding, p.ring);
      if (p.brackets && blinkOn(seconds)) brackets(s, inks.beacon, p.x, p.y, g.plane.w, g.plane.h);
      sprite(s, p.ink, p.x, p.y, g.cell);
    }
  };
}
