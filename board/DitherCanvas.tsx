// A canvas that the board's dither renderer paints. Each canvas sizes itself
// to its box at device-pixel density, joins the one shared frame loop, and
// leaves it when it unmounts or scrolls off screen.
import { useEffect, useRef } from "react";
import { createDitherRenderer, type DitherRenderer, type DitherTarget } from "../lib/dither-renderer.js";
import { airstream, burst, BURST_SECONDS, createSurface, formation, needsYou, packInk, pegFill, plate, type Painter, type Surface } from "../lib/dither.js";

/** What a canvas draws. Inks are read from the board's CSS, so they follow the theme. */
export type Fx =
  | { kind: "airstream"; pace: number }
  | { kind: "peg"; state: "working" | "question" | "review" | "branch" | "done" | "failed" }
  | { kind: "needs-you" }
  | { kind: "plate" }
  | { kind: "formation"; flying: number }
  | { kind: "burst" };

type Inks = (name: string) => number;

function painterFor(fx: Fx, ink: Inks): Painter {
  switch (fx.kind) {
    case "airstream": return airstream({ pace: fx.pace, ink: ink("--sq-sky") });
    case "needs-you": return needsYou({ ink: ink("--sq-amber") });
    case "plate": return plate({ ink: ink("--sq-green"), level: 0.2 });
    case "formation": return formation({ flying: fx.flying, on: ink("--sq-sky"), off: ink("--border") });
    case "burst": return burst({ ink: ink("--sq-green") });
    case "peg":
      switch (fx.state) {
        case "working": return pegFill({ ink: ink("--sq-sky"), base: 0.07, amp: 0.3, speed: 9, edge: ink("--sq-sky") });
        case "question": return pegFill({ ink: ink("--sq-amber"), base: 0.16 });
        case "review": return pegFill({ ink: ink("--sq-sky"), base: 0.14 });
        case "branch": return pegFill({ ink: ink("--sq-green"), base: 0.17 });
        case "done": return pegFill({ ink: ink("--sq-green"), base: 0.24 });
        case "failed": return pegFill({ ink: ink("--sq-red"), base: 0.22 });
      }
  }
}

/** Whether the art moves, and the moment its still frame shows. */
function motionFor(fx: Fx): Pick<DitherTarget, "animated" | "stillAt" | "until"> {
  switch (fx.kind) {
    case "airstream": return { animated: fx.pace > 0, stillAt: 2.4 };
    case "needs-you": return { animated: true, stillAt: 0.9 };
    case "formation": return { animated: fx.flying > 0, stillAt: 0.8 };
    case "burst": return { animated: true, stillAt: BURST_SECONDS, until: BURST_SECONDS };
    case "peg": return { animated: fx.state === "working", stillAt: 1.2 };
    case "plate": return { animated: false, stillAt: 0 };
  }
}

let shared: DitherRenderer | null = null;
function renderer(): DitherRenderer {
  if (shared) return shared;
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  shared = createDitherRenderer({
    now: () => performance.now(),
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    isHidden: () => document.hidden,
    onVisibilityChange: (callback) => document.addEventListener("visibilitychange", callback),
    prefersReducedMotion: () => media.matches,
    onReducedMotionChange: (callback) => media.addEventListener("change", callback),
  });
  return shared;
}

/** Resolves a CSS colour, such as a custom property's value, to a packed pixel. */
function inksOf(el: Element): Inks {
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const ctx = probe.getContext("2d", { willReadFrequently: true })!;
  const style = getComputedStyle(el);
  const cache = new Map<string, number>();
  return (name) => {
    const css = style.getPropertyValue(name).trim() || "#888";
    const known = cache.get(css);
    if (known !== undefined) return known;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const packed = packInk(r!, g!, b!, a!);
    cache.set(css, packed);
    return packed;
  };
}

export function DitherCanvas({ fx, className, onDone, label }: {
  fx: Fx;
  className?: string;
  /** A one-time animation's end. */
  onDone?: () => void;
  /** An accessible name when the art carries meaning; otherwise it's hidden from assistive tech. */
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const key = JSON.stringify(fx);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const parsed = JSON.parse(key) as Fx;
    const loop = renderer();
    let painter = painterFor(parsed, inksOf(canvas));
    let surface: Surface | null = null;
    let image: ImageData | null = null;
    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const next = createSurface(rect.width, rect.height, dpr);
      if (surface && surface.w === next.w && surface.h === next.h && surface.dpr === dpr) return false;
      canvas.width = next.w;
      canvas.height = next.h;
      image = ctx.createImageData(next.w, next.h);
      surface = { ...next, buf: new Uint32Array(image.data.buffer) };
      return true;
    };
    fit();
    const target: DitherTarget = {
      ...motionFor(parsed),
      visible: true,
      draw(seconds) {
        if (!surface || !image) return;
        surface.buf.fill(0);
        painter(surface, seconds);
        ctx.putImageData(image, 0, 0);
      },
      onDone: () => done.current?.(),
    };
    loop.add(target);
    const resize = new ResizeObserver(() => { if (fit()) loop.redraw(target); });
    resize.observe(canvas);
    const onScreen = new IntersectionObserver((entries) => {
      for (const entry of entries) target.visible = entry.isIntersecting;
      loop.wake();
    }, { rootMargin: "64px" });
    onScreen.observe(canvas);
    // A theme change re-reads the inks.
    const theme = new MutationObserver(() => { painter = painterFor(parsed, inksOf(canvas)); loop.redraw(target); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    return () => {
      loop.remove(target);
      resize.disconnect();
      onScreen.disconnect();
      theme.disconnect();
    };
  }, [key]);
  return label
    ? <canvas ref={ref} className={className} role="img" aria-label={label} />
    : <canvas ref={ref} className={className} aria-hidden="true" />;
}
