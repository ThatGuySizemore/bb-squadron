// The board's placeholder rows while its first read is in flight (SQD-247): a
// row's shape in neutral dither (a plate, a title line and a meta line, with
// the actions' end left open) and a shimmer that runs through the dither ramp
// right to left, the way the banner's wind blows. No text ever sits on it.
import { field, type Painter } from "./dither.js";

/** Seconds for one shimmer to cross the row. */
const PERIOD = 2.4;
/** The shimmer's half-width in CSS pixels. */
const BAND = 90;

/** Whether placeholder rows move, and the still frame under reduced motion: the shimmer over the title line. */
export const readingMotion = { animated: true, stillAt: 0.9 } as const;

/** The parts of a placeholder row, in CSS pixels, for a row `w` wide and `h` tall. */
function shapes(w: number, h: number): Array<[x: number, y: number, w: number, h: number]> {
  const plate = Math.min(56, Math.round(w * 0.14));
  const text = plate + 16;
  const top = Math.max(0, Math.round((h - 30) / 2));
  return [
    [0, top + 2, plate, 26],
    [text, top + 4, Math.round(w * 0.42), 9],
    [text, top + 20, Math.round(w * 0.24), 7],
  ];
}

/**
 * One placeholder row. The parts rest low on the ramp; a broad shimmer lifts
 * them as it passes right to left, every PERIOD seconds. `delay` staggers the
 * rows of a section so the shimmer runs down them in turn.
 */
export function readingRow({ ink, delay = 0 }: { ink: number; delay?: number }): Painter {
  return (s, seconds) => {
    const parts = shapes(s.cssW, s.cssH);
    const right = Math.max(...parts.map(([x, , w]) => x + w));
    const span = right + BAND * 2;
    const crest = right + BAND - ((((seconds - delay) / PERIOD) % 1 + 1) % 1) * span;
    field(s, ink, (x, y) => {
      if (!parts.some(([px, py, pw, ph]) => x >= px && x < px + pw && y >= py && y < py + ph)) return 0;
      const d = (x - crest) / BAND;
      return 0.16 + 0.42 * Math.exp(-d * d * 2);
    });
  };
}
