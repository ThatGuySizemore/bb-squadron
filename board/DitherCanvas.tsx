// A canvas that the board's dither renderer paints. Each canvas sizes itself
// to its box at device-pixel density, joins the one shared frame loop, and
// leaves it when it unmounts or scrolls off screen.
import { useEffect, useRef, type CSSProperties } from "react";
import { windSpeed } from "../lib/working-agents.js";
import { createDitherRenderer, type DitherRenderer, type DitherTarget } from "../lib/dither-renderer.js";
import { airstream, burst, BURST_SECONDS, contrail, createSurface, needsYou, packInk, pegFill, plate, sectionRule, type Painter, type Surface } from "../lib/dither.js";
import { runway, runwayMotion, type RunwayState } from "../lib/runway.js";

/** What a canvas draws. Inks are read from the board's CSS, so they follow the theme. */
export type Fx =
  /** `wind` is the board's working-agent count (lib/working-agents.ts); 0 is still. */
  | { kind: "airstream"; wind: number }
  | { kind: "contrail"; done: number; total: number; wind: number; tone: "sky" | "red" }
  | { kind: "peg"; state: "working" | "question" | "review" | "branch" | "done" | "failed" }
  | { kind: "needs-you" }
  | { kind: "plate" }
  | { kind: "section-rule" }
  | { kind: "runway"; narrow: boolean; label: string; state: RunwayState }
  /** `since`: when the landing started, in Date.now() milliseconds, shared with the banner's glide. */
  | { kind: "burst"; since?: number };

type Inks = (name: string) => number;

function painterFor(fx: Fx, ink: Inks): Painter {
  switch (fx.kind) {
    case "airstream": return airstream({ speed: windSpeed(fx.wind), ink: ink("--sq-sky") });
    case "contrail": {
      const tone = ink(fx.tone === "red" ? "--sq-red" : "--sq-sky");
      return contrail({ done: fx.done, total: fx.total, speed: windSpeed(fx.wind), trail: tone, plane: tone, guide: ink("--sq-rule-ink") });
    }
    case "needs-you": return needsYou({ ink: ink("--sq-amber") });
    case "plate": return plate({ ink: ink("--sq-green") });
    case "section-rule": return sectionRule({ ink: ink("--sq-rule-ink") });
    case "runway": return runway({ state: fx.state, narrow: fx.narrow, label: fx.label, inks: {
      cloud: ink("--sq-cloud"), tarmac: ink("--sq-tarmac"), line: ink("--sq-tarmac-line"), rule: ink("--sq-tarmac-rule"),
      stand: ink("--sq-stand"), plane: ink("--sq-sky"), trail: ink("--sq-sky"), beacon: ink("--sq-amber"), holding: ink("--sq-red"),
    } });
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
    case "airstream": return { animated: fx.wind > 0, stillAt: 2.4 };
    case "contrail": return { animated: fx.wind > 0, stillAt: 2.4 };
    case "needs-you": return { animated: true, stillAt: 0.9 };
    case "runway": return runwayMotion(fx.state);
    case "burst": return { animated: true, stillAt: BURST_SECONDS, until: BURST_SECONDS };
    case "peg": return { animated: fx.state === "working", stillAt: 1.2 };
    case "plate":
    case "section-rule": return { animated: false, stillAt: 0 };
  }
}

/** When an art's second 0 was, in Date.now() milliseconds: a landing's burst and the banner's moments. */
function bornOf(fx: Fx): number | undefined {
  return fx.kind === "burst" ? fx.since : fx.kind === "runway" ? fx.state.at : undefined;
}

/** The frame clock's reading at Date.now() zero, read once so every canvas converts a start the same way. */
let epochOnFrames: number | null = null;
function onFrames(epochMs: number): number {
  epochOnFrames ??= performance.now() - Date.now();
  return epochMs + epochOnFrames;
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
  // A mixed ink, such as the runway's color-mix() neutrals, resolves through the
  // style engine first, so the canvas gets a plain colour it can always parse.
  const plain = (css: string) => {
    if (!/color-mix\(|var\(/.test(css)) return css;
    const span = document.createElement("span");
    span.style.display = "none";
    span.style.color = css;
    (el.parentElement ?? document.body).appendChild(span);
    const resolved = getComputedStyle(span).color;
    span.remove();
    return resolved || css;
  };
  return (name) => {
    const css = plain(style.getPropertyValue(name).trim() || "#888");
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

export function DitherCanvas({ fx, className, onDone, label, title, style }: {
  fx: Fx;
  className?: string;
  style?: CSSProperties;
  /** A one-time animation's end. */
  onDone?: () => void;
  /** An accessible name when the art carries meaning; otherwise it's hidden from assistive tech. */
  label?: string;
  /** A hover text; the formation mark's says what its label says. */
  title?: string;
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
    const born = bornOf(parsed);
    const target: DitherTarget = {
      ...motionFor(parsed),
      ...(born !== undefined ? { born: onFrames(born) } : {}),
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
  const data = { "data-fx": fx.kind, "data-born": bornOf(fx) };
  return label
    ? <canvas ref={ref} className={className} style={style} role="img" aria-label={label} title={title} {...data} />
    : <canvas ref={ref} className={className} style={style} aria-hidden="true" {...data} />;
}
