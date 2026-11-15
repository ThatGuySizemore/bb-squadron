import type { Surface } from "../../lib/dither.js";

/** Read one backing-buffer pixel. */
export const pixelAt = (s: Surface, x: number, y: number): number => s.buf[y * s.w + x]!;

/** Count one exact ink inside a clipped pixel rectangle; expectations stay in each test. */
export function countInk(s: Surface, ink: number, box: { x: number; y: number; w: number; h: number }): number {
  let n = 0;
  for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(s.h, Math.ceil(box.y + box.h)); y++) {
    for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(s.w, Math.ceil(box.x + box.w)); x++) if (pixelAt(s, x, y) === ink) n++;
  }
  return n;
}
