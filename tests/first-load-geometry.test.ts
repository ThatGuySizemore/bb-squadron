// SQD-247: the loading state and the board that replaces it, laid out by a real
// browser. jsdom has no layout, so this file builds one page holding the loading
// board and several arrived boards at page and side-panel widths, with the
// board's own CSS. The page measures itself in any browser and prints whether
// the banner, the controls row, the path strip and each section heading kept
// their place. `SQUADRON_GEOMETRY_PAGE=<path> npm test -- tests/first-load-geometry.test.ts`
// writes the page; open it in a browser to read the result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import type { Board, Lane } from "../lib/board-model.js";
import { createSurface, sectionRule, type Painter } from "../lib/dither.js";
import { runway, runwayLoading, RUNWAY_HEIGHT } from "../lib/runway.js";
import { readingRow } from "../lib/reading.js";

const pass = { ready: true, checks: [], configurationFiles: [] } satisfies NonNullable<Board["doctor"]>;
const fixes = { ready: false, checks: [
  { id: "linear" as const, name: "Linear", status: "fix" as const, message: "Connect Linear." },
  { id: "skills" as const, name: "Skills", status: "fix" as const, message: "Install Matt's skills." },
], configurationFiles: [] } satisfies NonNullable<Board["doctor"]>;
const tracker = { kind: "linear" as const, state: "current" as const, message: "", syncedAt: Date.now() - 60_000, project: "BB Squadron" };
const autopilot = (status: "on" | "off" | "paused", laneLimit = 3): NonNullable<Board["autopilot"]> =>
  ({ status, laneLimit, consecutiveStops: 0, pauseReason: status === "paused" ? "Two lanes stopped in a row." : null });
const lane = (specId: string, state: Lane["state"] = "flying"): Lane => ({
  specId, title: `Spec ${specId} with a realistic title`, state, lead: { family: "claude", model: "claude-opus-5-5", effort: "high" },
  leadThreadId: `thr_${specId}`, branch: `spec/${specId}`, minutes: 12, acceptOwner: false, tickets: [], workingThreads: 1,
  ...(state === "landed" ? { landedAt: Date.now() - 3_600_000 } : {}),
});
const ready = (id: string): Board["ready"][number] => ({ id, title: `Ready spec ${id}`, ticketCount: 2, routes: [], blockedBy: [], acceptOwner: false });
const shaping = (id: string): Board["shaping"][number] => ({ id, title: `Shaping spec ${id}`, ticketCount: 0, missing: "No tickets yet.", action: "tickets" });
const issue = (id: string): Board["openIssues"][number] => ({ id, title: `Open issue ${id}`, labels: [] });
const base: Board = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, lanes: [], ready: [], shaping: [], openIssues: [], tracker, doctor: pass, autopilot: autopilot("off") };

/** Boards that can arrive after the first read, from an empty project to a busy one over its lane limit. */
export const ARRIVALS: Record<string, Board> = {
  typical: { ...base, lanes: [lane("FIX-1"), lane("FIX-0", "landed")], ready: [ready("FIX-2"), ready("FIX-3")], shaping: [shaping("FIX-4")], openIssues: [issue("FIX-5"), issue("FIX-6")] },
  quiet: { ...base },
  busy: { ...base, laneCapacity: 6, autoStart: true, autopilot: autopilot("on", 6), doctor: fixes,
    lanes: ["A", "B", "C", "D"].map((id) => lane(`FIX-1${id}`)), ready: [ready("FIX-2")], openIssues: [issue("FIX-5")] },
  over: { ...base, laneCapacity: 2, autopilot: autopilot("paused", 2), lanes: [lane("FIX-1"), lane("FIX-2"), lane("FIX-3")] },
  limitTen: { ...base, laneCapacity: 10, autopilot: autopilot("off", 10), lanes: [lane("FIX-1")] },
  checkingMain: { ...base, autoStart: true, autopilot: { ...autopilot("on"), checkingMain: true }, lanes: [lane("FIX-1")] },
  waitingForLinear: { ...base, autopilot: { ...autopilot("paused"), waitingForLinear: true, pauseReason: "Waiting for Linear to answer." } },
  noDoctorYet: { ...base, doctor: undefined, lanes: [lane("FIX-1")] },
  github: { ...base, tracker: { ...tracker, kind: "github" }, ready: [ready("FIX-2")] },
  disconnected: { ...base, tracker: { ...tracker, state: "disconnected", message: "Connect Linear.", syncedAt: null } },
  localMarkdown: { ...base, tracker: { ...tracker, kind: "local-markdown" } },
  longProject: { ...base, tracker: { ...tracker, project: "A very long Linear project name that would wrap in a side panel" } },
  elevenLanes: { ...base, lanes: Array.from({ length: 11 }, (_, i) => lane(`FIX-${i + 1}`)) },
  twentyLanes: { ...base, lanes: Array.from({ length: 20 }, (_, i) => lane(`FIX-${i + 1}`)) },
};

/** Page width, side-panel widths: the board's two layouts. */
export const WIDTHS = [{ placement: "page" as const, width: 1200 }, { placement: "page" as const, width: 960 }, { placement: "panel" as const, width: 560 }, { placement: "panel" as const, width: 420 }];

async function markup(placement: "page" | "panel", board: Board | null): Promise<string> {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView, liveNotice } = await import("../board/Board.js");
  const { ProjectButton, pickerMeta } = await import("../board/ProjectPicker.js");
  // As the live board passes them: an empty board in its loading state until the first read.
  const notice = board ? liveNotice({ projectId: "proj-one", board, failed: false }) : null;
  const shown = board ? { ready: board.ready.length, flying: board.lanes.filter((l) => l.state !== "landed").length } : null;
  return renderToStaticMarkup(createElement(BoardView, {
    board: board ?? { ...base, laneCapacity: 0, workersPerLane: 0, tracker: undefined, doctor: undefined, autopilot: undefined },
    demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined, placement, projectId: "proj-one",
    lanesKnown: board !== null, loading: board === null, notice: notice ?? undefined,
    tracker: board?.tracker ? { kind: board.tracker.kind ?? null, note: board.tracker.message } : undefined,
    projectButton: createElement(ProjectButton, { name: "BB Squadron", meta: pickerMeta(board?.tracker?.kind, shown), open: false, controls: "picker", onToggle: () => undefined }),
  }));
}

/** What the page measures, relative to the board's own top: everything above the sections, then each section heading. */
const MEASURE = `
const frames = [...document.querySelectorAll(".frame[data-board]")];
const box = (frame, el) => { if (!el) return null; const a = frame.getBoundingClientRect(), b = el.getBoundingClientRect(); return { top: Math.round(b.top - a.top), height: Math.round(b.height), left: Math.round(b.left - a.left), width: Math.round(b.width) }; };
const measure = (frame) => ({
  runway: box(frame, frame.querySelector(".sq-runway")),
  controls: box(frame, frame.querySelector(".sq-controls")),
  controlItems: [...frame.querySelectorAll(".sq-controls > *, .sq-head-actions > *")].map((el) => ({ cls: el.className, ...box(frame, el) })),
  path: box(frame, frame.querySelector(".sq-path")),
  sections: [...frame.querySelectorAll("section.sq-section")].map((s) => ({ title: s.getAttribute("aria-labelledby"), ...box(frame, s.querySelector(".sq-label")) })),
});
const results = {};
for (const frame of frames) { (results[frame.dataset.width] ??= {})[frame.dataset.board] = measure(frame); }
const report = [];
for (const [width, boards] of Object.entries(results)) {
  const before = boards.loading;
  for (const [name, after] of Object.entries(boards)) {
    if (name === "loading") continue;
    const moved = [];
    for (const key of ["runway", "controls", "path"]) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) moved.push(key + " " + JSON.stringify(before[key]) + " -> " + JSON.stringify(after[key]));
    const first = (m) => m.sections[0];
    if (JSON.stringify(first(before)) !== JSON.stringify(first(after))) moved.push("first section " + JSON.stringify(first(before)) + " -> " + JSON.stringify(first(after)));
    report.push({ width, board: name, moved });
  }
}
document.getElementById("result").textContent = JSON.stringify({ ok: report.every((r) => r.moved.length === 0), report, results }, null, 1);
`;

/**
 * The loading frames' art, painted by the board's own painters at one moment
 * and coloured in the page from the theme's inks, so the page shows what the
 * loading state looks like in light and dark. Ink n is painted as the value n.
 */
const INK_NAMES = ["--sq-cloud", "--sq-tarmac", "--sq-tarmac-line", "--sq-tarmac-rule", "--sq-stand", "--sq-sky", "--sq-rule-ink"];
const ink = (name: string) => INK_NAMES.indexOf(name) + 1;
function paint(painter: Painter, w: number, h: number, seconds: number): { w: number; h: number; px: string } {
  const surface = createSurface(w, h, 1);
  painter(surface, seconds);
  return { w: surface.w, h: surface.h, px: Buffer.from(Uint8Array.from(surface.buf, (v) => v & 0xff)).toString("base64") };
}
function loadingArt(width: number, narrow: boolean) {
  const content = width - (width <= 560 ? 28 : 56);
  const inks = { cloud: ink("--sq-cloud"), tarmac: ink("--sq-tarmac"), line: ink("--sq-tarmac-line"), rule: ink("--sq-tarmac-rule"),
    stand: ink("--sq-stand"), plane: ink("--sq-sky"), trail: ink("--sq-sky"), beacon: ink("--sq-sky"), holding: ink("--sq-sky") };
  return {
    "sq-runway-art": paint(runway({ state: runwayLoading(), narrow, label: "", inks }), width, narrow ? RUNWAY_HEIGHT.narrow : RUNWAY_HEIGHT.wide, 1.3),
    "sq-reading-art": paint(readingRow({ ink: ink("--sq-cloud") }), content, 42, 0.9),
    "sq-section-rule": paint(sectionRule({ ink: ink("--sq-rule-ink") }), content, 2, 0),
    "sq-reading-bar": paint(readingRow({ ink: ink("--sq-cloud"), shape: "bar" }), 240, 12, 0.9),
  };
}
const PAINT = `
const inks = ${JSON.stringify(INK_NAMES)};
for (const frame of document.querySelectorAll(".frame[data-art]")) {
  const art = window.ART[frame.dataset.art];
  for (const canvas of frame.querySelectorAll("canvas")) {
    const cls = [...canvas.classList].find((c) => art[c]);
    if (!cls) continue;
    const { w, h, px } = art[cls];
    const probe = document.createElement("span");
    canvas.parentElement.appendChild(probe);
    // Any CSS colour the style engine resolves (oklab from color-mix included), read back as RGBA through a canvas pixel.
    const dot = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const rgb = inks.map((name) => { probe.style.color = "var(" + name + ")"; dot.clearRect(0, 0, 1, 1); dot.fillStyle = getComputedStyle(probe).color; dot.fillRect(0, 0, 1, 1); return [...dot.getImageData(0, 0, 1, 1).data]; });
    probe.remove();
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d"), img = ctx.createImageData(w, h), bytes = atob(px);
    for (let i = 0; i < w * h; i++) {
      const n = bytes.charCodeAt(i); if (!n) continue;
      img.data.set(rgb[n - 1], i * 4);
    }
    ctx.putImageData(img, 0, 0);
  }
}
`;

export async function geometryPage(): Promise<string> {
  const css = readdirSync(join(process.cwd(), "board")).filter((f) => f.endsWith(".css")).sort()
    .map((f) => readFileSync(join(process.cwd(), "board", f), "utf8")).join("\n");
  const frames: string[] = [];
  for (const { placement, width } of WIDTHS) {
    for (const [name, board] of [["loading", null] as const, ...Object.entries(ARRIVALS)]) {
      frames.push(`<div class="frame" data-width="${placement}-${width}" data-board="${name}" style="width:${width}px">${await markup(placement, board)}</div>`);
    }
  }
  // The loading state to look at, in light and dark: measured by nothing, painted with the board's inks.
  const art: Record<string, ReturnType<typeof loadingArt>> = {};
  const looks: string[] = [];
  for (const { placement, width } of WIDTHS) {
    art[`${width}`] = loadingArt(width, placement === "panel");
    for (const theme of ["light", "dark"]) {
      looks.push(`<div class="frame look ${theme}" data-art="${width}" data-look="${placement}-${width}-${theme}" style="width:${width}px">${await markup(placement, null)}</div>`);
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --foreground: #1b1b1b; --background: #ffffff; --border: #dddddd; --muted-foreground: #6b6b6b; font-family: -apple-system, system-ui, sans-serif; }
.dark { --foreground: #ececec; --background: #161616; --border: #333333; --muted-foreground: #9a9a9a; background: #161616; }
body { margin: 0; } .frame { position: relative; border-bottom: 4px solid red; } .look .sq { height: auto; overflow: visible; }
${css}</style></head><body><pre id="result">measuring</pre>${frames.join("\n")}${looks.join("\n")}<script>window.ART = ${JSON.stringify(art)};${PAINT}${MEASURE}</script></body></html>`;
}

test("the geometry page holds the loading board and every arrival at each width", async () => {
  const page = await geometryPage();
  const doc = new JSDOM(page).window.document;
  assert.equal(doc.querySelectorAll(".frame[data-board]").length, WIDTHS.length * (1 + Object.keys(ARRIVALS).length));
  assert.equal(doc.querySelectorAll(".frame.look").length, WIDTHS.length * 2, "the loading state in light and dark at each width");
  const out = process.env.SQUADRON_GEOMETRY_PAGE;
  if (out) writeFileSync(out, page);
});
