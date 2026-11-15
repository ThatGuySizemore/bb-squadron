// The board's dither material, ported from the approved SIZE-948 comp
// (comps/live-board/dither.js): ordered Bayer 8x8 dither, one threshold cell
// per device pixel, painted into a packed RGBA buffer. Nothing here touches
// the DOM; board/DitherCanvas.tsx puts the buffer on a canvas.

/** A canvas-sized pixel buffer. Sizes in CSS pixels; w and h in device pixels. */
export interface Surface {
  buf: Uint32Array;
  w: number;
  h: number;
  dpr: number;
  cssW: number;
  cssH: number;
}

/** Paints one frame at `seconds` into a cleared surface. */
export type Painter = (surface: Surface, seconds: number) => void;

export function createSurface(cssW: number, cssH: number, dpr: number): Surface {
  cssW = Math.max(1, Math.round(cssW));
  cssH = Math.max(1, Math.round(cssH));
  const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
  return { buf: new Uint32Array(w * h), w, h, dpr, cssW, cssH };
}

/** How many pixels of the surface carry `ink`. */
export function pixelsOf(surface: Surface, ink: number): number {
  let n = 0;
  for (const p of surface.buf) if (p === ink) n++;
  return n;
}

/** Packs an RGBA colour (0-255 channels) the way ImageData's little-endian buffer reads it. */
export function packInk(r: number, g: number, b: number, a = 255): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

// ---------- Bayer 8x8 thresholds in (0, 1) ----------
const BAYER = new Float32Array(64);
{
  const b2 = [[0, 2], [3, 1]];
  let m = b2;
  for (let n = 2; n < 8; n *= 2) {
    const next: number[][] = [];
    for (let y = 0; y < n * 2; y++) {
      const row: number[] = [];
      for (let x = 0; x < n * 2; x++) row.push(4 * m[y % n]![x % n]! + b2[Math.floor(y / n)]![Math.floor(x / n)]!);
      next.push(row);
    }
    m = next;
  }
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) BAYER[y * 8 + x] = (m[y]![x]! + 0.5) / 64;
}

// ---------- smooth value noise ----------
const PERM = new Uint8Array(512);
{
  const p = Array.from({ length: 256 }, (_, i) => i);
  let seed = 948;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const j = seed % (i + 1);
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]!;
}
const fade = (t: number) => t * t * (3 - 2 * t);
function noise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const X = xi & 255, Y = yi & 255;
  const a = PERM[PERM[X]! + Y]! / 255, b = PERM[PERM[X + 1]! + Y]! / 255;
  const c = PERM[PERM[X]! + Y + 1]! / 255, d = PERM[PERM[X + 1]! + Y + 1]! / 255;
  const u = fade(xf), v = fade(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Two octaves of value noise, in about [0, 1]. */
export const fbm = (x: number, y: number) => noise(x, y) * 0.65 + noise(x * 2.1 + 17.3, y * 2.1 + 5.1) * 0.35;

// ---------- painting helpers ----------

/**
 * Dithers a scalar field into the surface: the field is sampled once per CSS
 * pixel and thresholded per device pixel, so the grain is device-fine.
 */
export function field(s: Surface, ink: number, fn: (x: number, y: number) => number): void {
  const { w, h, dpr, cssW, cssH, buf } = s;
  const row = new Float32Array(cssW);
  let lastCy = -1;
  for (let y = 0; y < h; y++) {
    const cy = Math.min(cssH - 1, Math.floor(y / dpr));
    if (cy !== lastCy) {
      for (let cx = 0; cx < cssW; cx++) row[cx] = fn(cx, cy);
      lastCy = cy;
    }
    const by = (y & 7) * 8;
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const v = row[Math.min(cssW - 1, Math.floor(x / dpr))]!;
      if (v > BAYER[by + (x & 7)]!) buf[o + x] = ink;
    }
  }
}

/**
 * field(), limited to a box of CSS pixels [x0, y0, x1, y1] and sampled every
 * `step` CSS pixels on a grid fixed to the surface, for large low-frequency
 * art such as the banner's clouds. Thresholds stay per device pixel.
 */
export function fieldIn(s: Surface, ink: number, fn: (x: number, y: number) => number, box: [number, number, number, number], step = 1): void {
  const { w, h, dpr, cssW, cssH, buf } = s;
  const bx0 = Math.max(0, Math.floor(box[0])), by0 = Math.max(0, Math.floor(box[1]));
  const bx1 = Math.min(cssW, Math.ceil(box[2])), by1 = Math.min(cssH, Math.ceil(box[3]));
  if (bx1 <= bx0 || by1 <= by0) return;
  const row = new Float32Array(cssW);
  let lastSy = -1;
  const x0 = Math.round(bx0 * dpr), x1 = Math.min(w, Math.round(bx1 * dpr));
  for (let y = Math.round(by0 * dpr); y < Math.min(h, Math.round(by1 * dpr)); y++) {
    const cy = Math.min(cssH - 1, Math.floor(y / dpr));
    const sy = cy - (cy % step);
    if (sy !== lastSy) {
      for (let cx = bx0; cx < bx1; cx++) row[cx] = cx % step === 0 || cx === bx0 ? fn(cx - (cx % step), sy) : row[cx - 1]!;
      lastSy = sy;
    }
    const by = (y & 7) * 8;
    const o = y * w;
    for (let x = x0; x < x1; x++) {
      const v = row[Math.min(cssW - 1, Math.floor(x / dpr))]!;
      if (v > BAYER[by + (x & 7)]!) buf[o + x] = ink;
    }
  }
}

/** A solid rectangle in CSS pixels, snapped to device pixels. */
export function rect(s: Surface, ink: number, x: number, y: number, w: number, h: number): void {
  const d = s.dpr;
  const x0 = Math.max(0, Math.round(x * d)), y0 = Math.max(0, Math.round(y * d));
  const x1 = Math.min(s.w, Math.round((x + w) * d)), y1 = Math.min(s.h, Math.round((y + h) * d));
  for (let yy = y0; yy < y1; yy++) s.buf.fill(ink, yy * s.w + x0, yy * s.w + x1);
}

/** A border march: dashes running round the edge, offset continuously. */
export function march(s: Surface, ink: number, t: number, { thickness = 2, dash = 6, gap = 4, speed = 12 } = {}): void {
  const d = s.dpr;
  const th = Math.max(1, Math.round(thickness * d));
  const { w, h, buf } = s;
  const period = (dash + gap) * d;
  const on = dash * d;
  const shift = (t * speed * d) % period;
  const per = 2 * (w + h);
  const inked = (p: number) => ((((p - shift) % period) + period) % period) < on;
  for (let x = 0; x < w; x++) {
    if (inked(x)) for (let k = 0; k < th; k++) buf[k * w + x] = ink;
    if (inked(per / 2 + (w - 1 - x))) for (let k = 0; k < th; k++) buf[(h - 1 - k) * w + x] = ink;
  }
  for (let y = 0; y < h; y++) {
    if (inked(w + y)) for (let k = 0; k < th; k++) buf[y * w + (w - 1 - k)] = ink;
    if (inked(per - 1 - y)) for (let k = 0; k < th; k++) buf[y * w + k] = ink;
  }
}

// ---------- painters ----------

/** Working threads that pace an airstream; four and over fly at full pace. */
const MAX_PACE = 4;

/**
 * The sortie line's airstream: sky streaks flowing left to right along the
 * line, paced by the lane's working threads. A lane with none working is still.
 */
export function airstream({ pace, ink }: { pace: number; ink: number }): Painter {
  const p = Math.max(0, Math.min(pace, MAX_PACE));
  const speed = 12 + 12 * p;
  const strength = 0.16 + 0.06 * p;
  return (s, seconds) => {
    const t = p === 0 ? 0 : seconds;
    const mid = s.cssH / 2, spread = Math.min(20, s.cssH * 0.36);
    field(s, ink, (x, y) => {
      const dy = (y - mid) / spread;
      const env = Math.exp(-dy * dy * 1.6);
      if (env < 0.02) return 0;
      const n = fbm((x - t * speed) / 52, y / 3.2 + Math.sin(x / 160 + t * 0.25) * 0.5);
      const gust = 0.5 + 0.5 * Math.sin((x - t * speed * 1.7) / 140);
      return env * strength * (0.25 + 2.2 * Math.max(0, n - 0.42) * (0.5 + gust));
    });
  };
}

/** Inside a peg: a fine fill that drifts while an agent works on it, with an optional marching edge. */
export function pegFill({ ink, base, amp = 0, speed = 0, edge }: { ink: number; base: number; amp?: number; speed?: number; edge?: number }): Painter {
  return (s, t) => {
    field(s, ink, (x, y) => {
      if (!amp) return base;
      const n = fbm((x + y * 0.6 - t * speed) / 26, (y - t * speed * 0.15) / 18);
      return base + amp * (n - 0.45);
    });
    if (edge !== undefined) march(s, edge, t);
  };
}

/** Needs you: amber grain along the row's edges, breathing on a 3.6 s sine, so the text stays on a clean ground. */
export function needsYou({ ink }: { ink: number }): Painter {
  return (s, t) => {
    const breath = 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / 3.6);
    const depth = 10 + 4 * breath;
    field(s, ink, (x, y) => {
      const edge = Math.min(y, s.cssH - 1 - y, x * 1.15, (s.cssW - 1 - x) * 1.15);
      if (edge > depth + 2) return 0;
      const n = fbm((x - t * 14) / 40, y / 9 + t * 0.08);
      const falloff = Math.max(0, 1 - edge / depth);
      return falloff * falloff * (0.36 + 0.3 * breath + 0.4 * (n - 0.4));
    });
  };
}

/** A still Landed stamp: green edge grain with a clean centre for the number. */
export function plate({ ink }: { ink: number }): Painter {
  return (s) => field(s, ink, (x, y) => {
    const edge = Math.min(y, s.cssH - 1 - y, x, s.cssW - 1 - x);
    const falloff = Math.max(0, 1 - edge / 7);
    return falloff * falloff * 0.85;
  });
}

/** A section separator: 2px square dots on an 8px pitch, as in the Runway comp. */
export function sectionRule({ ink }: { ink: number }): Painter {
  return (s) => {
    for (let x = 0; x < s.cssW; x += 8) rect(s, ink, x, 0, 2, 2);
  };
}

/**
 * A plane seen from above, nose right, on the formation's 3px cell: a fuselage
 * of eight cells, wings swept back from its middle and two tail fins.
 */
const PLANE = ["  ##    ", "#  ##   ", "########", "#  ##   ", "  ##    "];
const CELL = 3;
const PLANE_W = PLANE[0]!.length * CELL, PLANE_H = PLANE.length * CELL;
/** The original V fits a lead and five pairs. Larger formations use rows. */
const V_SLOTS = 11;
const FORMATION_COLUMNS = 6;
const FORMATION_ROW_PITCH = PLANE_H + 6;
/** Cells from the lead's fuselage to the first pair's, above and below. */
const FIRST_SPREAD = 4;
/** Cells between ranks, nose to nose. */
const RANK_STEP = 10;
/** How far, in CSS pixels, a contrail streams behind its plane. */
const TRAIL = 42;
/** The formation mark's canvas size in CSS pixels. */
export const FORMATION_SIZE = { width: 184, height: 80 } as const;

/** Keep the ordinary mark's size, adding height when more sprite rows are needed. */
export function formationSize(slots: number, lit: number): { width: number; height: number } {
  const count = Math.max(1, slots, lit);
  return { width: FORMATION_SIZE.width, height: count <= V_SLOTS ? FORMATION_SIZE.height
    : Math.max(FORMATION_SIZE.height, Math.ceil(count / FORMATION_COLUMNS) * FORMATION_ROW_PITCH + 4) };
}

/**
 * Where each plane sits on a mark `width` x `height` CSS pixels, as its
 * top-left corner: a V flying right, the lead at its point and pairs stepping
 * back above and below it. The V flattens as ranks are added, so up to eleven
 * planes fit the 184x80 mark.
 */
function formationLayout(count: number, width: number, height: number): Array<{ x: number; y: number }> {
  if (count > V_SLOTS) {
    const rows = Math.ceil(count / FORMATION_COLUMNS);
    const top = (height - ((rows - 1) * FORMATION_ROW_PITCH + PLANE_H)) / 2;
    return Array.from({ length: count }, (_, i) => ({
      x: width - PLANE_W - 3 - (i % FORMATION_COLUMNS) * RANK_STEP * CELL,
      y: top + Math.floor(i / FORMATION_COLUMNS) * FORMATION_ROW_PITCH,
    }));
  }
  const ranks = Math.ceil((count - 1) / 2);
  const maxSpread = Math.floor((height / 2 - PLANE_H / 2 - 1) / CELL);
  const step = ranks <= 1 ? 0 : Math.min(3, Math.floor((maxSpread - FIRST_SPREAD) / (ranks - 1)));
  // The lead flies at the right, beside the title; the rest of the V and the contrails fill the mark behind it.
  const lead = width - PLANE_W - 3;
  const mid = height / 2 - PLANE_H / 2;
  return Array.from({ length: count }, (_, i) => {
    const rank = Math.ceil(i / 2);
    const side = i === 0 ? 0 : i % 2 === 1 ? -1 : 1;
    const spread = rank === 0 ? 0 : FIRST_SPREAD + (rank - 1) * step;
    return { x: lead - rank * RANK_STEP * CELL, y: mid + side * spread * CELL };
  });
}

/**
 * The formation mark: one plane slot per lane in the project's lane limit.
 * The first `lit` planes fly in sky, bobbing under a pixel with a dithered
 * contrail streaming behind them; empty slots stay still in hairline. Lanes
 * over the limit add slots; larger formations use rows. Still when nothing flies.
 */
export function formation({ slots, lit, on, off, trail = on }: { slots: number; lit: number; on: number; off: number; trail?: number }): Painter {
  const count = Math.max(1, slots, lit);
  const flying = Math.max(0, Math.min(lit, count));
  const motion = (i: number, t: number) => i < flying
    ? { dx: Math.sin(t * 0.7 + i) * 0.6, dy: Math.sin(t * 1.3 + i * 1.9) * 0.9 }
    : { dx: 0, dy: 0 };
  return (s, t) => {
    const planes = formationLayout(count, s.cssW, s.cssH);
    if (flying > 0) {
      field(s, trail, (x, y) => {
        let v = 0;
        for (let i = 0; i < flying; i++) {
          const { dx: driftX, dy: bob } = motion(i, t);
          const tail = planes[i]!.x + driftX;
          const behind = tail - x;
          if (behind < 1 || behind > TRAIL) continue;
          const spread = (y - (planes[i]!.y + PLANE_H / 2 + bob)) / (1.2 + behind * 0.05);
          const flow = fbm((x + t * 22) / 9, i * 7.1 + y / 4);
          v = Math.max(v, Math.exp(-spread * spread) * (1 - behind / TRAIL) * (0.25 + 0.55 * flow));
        }
        return v * 0.85;
      });
    }
    planes.forEach(({ x, y }, i) => {
      const { dx, dy } = motion(i, t);
      PLANE.forEach((row, ry) => [...row].forEach((c, rx) => {
        if (c === "#") rect(s, i < flying ? on : off, x + rx * CELL + dx, y + ry * CELL + dy, CELL, CELL);
      }));
    });
  };
}

/** How long the landing burst runs, in seconds. */
export const BURST_SECONDS = 1.6;

/** The landing burst: about 110 green pixels sweep the sortie line once, leaving a wake that thins out by 1.4 s. */
export function burst({ ink, seed = 939 }: { ink: number; seed?: number }): Painter {
  const bits = Array.from({ length: 110 }, (_, i) => {
    const r = (k: number) => ((Math.sin((i + 1) * 12.9898 * k + seed) * 43758.5453) % 1 + 1) % 1;
    return { lane: r(1) * 2 - 1, reach: 0.35 + r(2) * 0.65, size: r(3) < 0.25 ? 3 : r(3) < 0.6 ? 2 : 1, delay: r(4) * 0.28, wobble: r(5) * 6.28 };
  });
  const ease = (p: number) => 1 - Math.pow(1 - p, 4);
  return (s, t) => {
    const mid = s.cssH / 2;
    const head = ease(Math.min(1, t / 0.95));
    const fadeOut = Math.max(0, 1 - Math.max(0, t - 0.6) / 0.8);
    if (fadeOut > 0) {
      field(s, ink, (x, y) => {
        const p = x / s.cssW;
        if (p > head) return 0;
        const dy = (y - mid) / Math.min(18, s.cssH * 0.3);
        const behind = 1 - (head - p);
        return Math.exp(-dy * dy) * behind * 0.38 * fadeOut * (0.6 + 0.4 * noise(x / 7 - t * 30, y / 3));
      });
    }
    for (const b of bits) {
      const p = ease(Math.max(0, Math.min(1, (t - b.delay) / 0.9)));
      if (p <= 0 || t - b.delay > 1.3) continue;
      const x = p * b.reach * s.cssW;
      const y = mid + b.lane * Math.min(s.cssH * 0.45, 40) * (0.4 + 0.6 * p) + Math.sin(b.wobble + t * 9) * 1.5;
      rect(s, ink, x, y, b.size, b.size);
    }
  };
}
