// The inks a dither canvas paints with, read from the board's CSS. A mixed ink
// (color-mix, var) resolves through the style engine, and each such read forces
// a restyle of the page, so one reading is shared by every canvas until the
// theme changes.
import { packInk } from "../lib/dither.js";

export type Inks = (name: string) => number;

/** Resolved colours by the CSS they came from, and packed pixels by resolved colour. */
const resolved = new Map<string, string>();
const packed = new Map<string, number>();
const listeners = new Set<() => void>();
let watching: MutationObserver | null = null;

/** Drops the shared reading and tells every canvas to read again. */
export function themeChanged(): void {
  resolved.clear();
  packed.clear();
  for (const listener of [...listeners]) listener();
}

/** Calls back once per theme change, however many canvases listen; returns the stop. */
export function onThemeChange(listener: () => void): () => void {
  watching ??= new MutationObserver(themeChanged);
  if (listeners.size === 0) watching.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) watching?.disconnect();
  };
}

let probe: CanvasRenderingContext2D | null = null;
function probeContext(): CanvasRenderingContext2D {
  if (probe) return probe;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  probe = canvas.getContext("2d", { willReadFrequently: true })!;
  return probe;
}

/** Resolves a CSS colour, such as a custom property's value, to a packed pixel. */
export function inksOf(el: Element): Inks {
  const style = getComputedStyle(el);
  // A mixed ink, such as the runway's color-mix() neutrals, resolves through the
  // style engine first, so the canvas gets a plain colour it can always parse.
  const plain = (css: string) => {
    if (!/color-mix\(|var\(/.test(css)) return css;
    const known = resolved.get(css);
    if (known !== undefined) return known;
    const span = document.createElement("span");
    span.style.display = "none";
    span.style.color = css;
    (el.parentElement ?? document.body).appendChild(span);
    const color = getComputedStyle(span).color || css;
    span.remove();
    resolved.set(css, color);
    return color;
  };
  return (name) => {
    const css = plain(style.getPropertyValue(name).trim() || "#888");
    const known = packed.get(css);
    if (known !== undefined) return known;
    const ctx = probeContext();
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const pixel = packInk(r!, g!, b!, a!);
    packed.set(css, pixel);
    return pixel;
  };
}
