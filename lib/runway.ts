// The board's runway banner (SQD-221, comp variant B): light clouds drifting
// right to left over a tarmac strip, SQUADRON stencilled on the tarmac and one
// stand per lane in the lane limit. One geometry, runwayLayout(), places
// everything; the painter here and the DOM (the stencil and the label) both read
// it, so the label never lands on a plane or a stand.
import { fbm, fieldIn, rect, type Painter, type Surface } from "./dither.js";
import { layoutPixels } from "./pixels.js";
import { windSpeed } from "./working-agents.js";

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
    return { width: W, height, tarmac, cell, plane, keys, title, label, stands };
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
 * What one stand shows. This ticket draws empty stands and lanes flying over
 * their stands; the lane moments (takeoff, beacon, holding, landing) add kinds here.
 */
export type RunwayStand = { kind: "empty" } | { kind: "flying"; laneId: string };

/** The banner's whole state, derived from the board in the same update as the lane rows. */
export interface RunwayState {
  stands: RunwayStand[];
  /** The board's working-agent count (workingAgents()): the same count that paces each lane's wind. */
  working: number;
}

/**
 * One stand per lane in the lane limit, lit in board order by the lanes on the
 * Flying line (anything not Landed). With no lane limit the stands are the lanes
 * flying, with one shown when none are; lanes started over the limit add stands.
 * `working` is the board's one working-agent count, the same one each lane's wind reads.
 */
export function runwayState(lanes: ReadonlyArray<{ specId: string; state: string }>, limit: number, working: number): RunwayState {
  const flying = lanes.filter((lane) => lane.state !== "landed");
  const slots = Math.max(1, limit, flying.length);
  return {
    stands: Array.from({ length: slots }, (_, i): RunwayStand => i < flying.length ? { kind: "flying", laneId: flying[i]!.specId } : { kind: "empty" }),
    working: Math.max(0, working),
  };
}

/** Whether the banner moves, and the still frame drawn under reduced motion. */
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
 * text sits on moving dither. Empty stands are dotted; a flying lane's plane is
 * lit over its stand, bobbing under a pixel.
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

    // Stands and planes.
    g.stands.forEach(({ park, air }, i) => {
      const stand = state.stands[i];
      if (!stand || stand.kind === "empty") { dotted(s, inks.stand, park.x, park.y, g.cell); return; }
      const phase = i * 1.7;
      const dx = Math.sin(seconds * 0.7 + phase) * 0.8, dy = Math.sin(seconds * 1.3 + phase) * 1.2;
      sprite(s, inks.plane, air.x + dx, air.y + dy, g.cell);
    });
  };
}
