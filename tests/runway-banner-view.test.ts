// SQD-222: the board header is the runway banner, with one controls row under
// it. Rendered through the app-runtime stand-in, as the other view tests are.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Board, Lane } from "../lib/board-model.js";

const lane = (specId: string, state: Lane["state"] = "flying"): Lane => ({
  specId, title: `Spec ${specId}`, state, lead: { family: "claude", model: "claude-opus-5-5", effort: "high" },
  leadThreadId: `thr_${specId}`, branch: `spec/${specId}`, minutes: 12, acceptOwner: false, tickets: [], workingThreads: 1,
});
const base: Board = { tick: 0, laneCapacity: 4, workersPerLane: 0, autoStart: false, lanes: [lane("FIX-1")], ready: [], shaping: [], openIssues: [],
  autopilot: { status: "off", laneLimit: 4, consecutiveStops: 0, pauseReason: null } };

async function render(board: Board, options: { placement?: "page" | "panel"; lanesKnown?: boolean; demo?: boolean } = {}) {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  return renderToStaticMarkup(createElement(BoardView, {
    board, demo: options.demo ?? false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined,
    placement: options.placement ?? "page", lanesKnown: options.lanesKnown, projectId: "proj-one",
    projectButton: createElement("button", { type: "button", className: "sq-picker-button" }, "Fixture project"),
  }));
}

const header = (html: string) => /<header class="sq-head">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
const banner = (html: string) => /<div class="sq-runway"[\s\S]*?<\/div>(?=<div class="sq-controls")/.exec(header(html))?.[0] ?? "";
const controls = (html: string) => /<div class="sq-controls"[\s\S]*$/.exec(header(html))?.[0] ?? "";
const text = (html: string) => html.replace(/<span[^>]*role="tooltip"[^>]*>[^<]*<\/span>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const label = (html: string) => {
  const found = /<p class="sq-runway-label"[^>]*>([\s\S]*?)<\/p>/.exec(header(html));
  return found ? text(found[1]!) : undefined;
};

test("the banner leads the header: 164px on the page and 140px in the side panel, art hidden from assistive tech", async () => {
  for (const [placement, height] of [["page", 164], ["panel", 140]] as const) {
    const html = await render(base, { placement });
    const top = banner(html);
    assert.ok(top, `the ${placement} header opens with the runway banner`);
    assert.match(top, new RegExp(`style="height:${height}px"`));
    assert.match(top, /<canvas class="sq-runway-art" aria-hidden="true"/, "the art is decoration; the label and stencil carry the words");
    assert.match(top, /<h1 class="sq-runway-title"[^>]*>[\s\S]*<svg[^>]*class="sq-pixeltext"[\s\S]*<span class="sq-sr">Squadron<\/span>[\s\S]*<\/h1>/,
      "SQUADRON in the pixel font is the page heading");
  }
});

test("the lane label says how many lanes fly against the stands, on the tarmac when it fits and in the controls row when it doesn't", async () => {
  const page = await render({ ...base, lanes: [lane("FIX-1"), lane("FIX-2", "stopped"), lane("FIX-3", "landed")] });
  assert.equal(label(page), "2 of 4 lanes flying");
  assert.match(banner(page), /class="sq-runway-label"/, "a full page has room on the tarmac");
  assert.match(banner(page), /data-stands="4"/);

  const panel = await render({ ...base, lanes: [lane("FIX-1"), lane("FIX-2"), lane("FIX-3"), lane("FIX-4")] }, { placement: "panel" });
  assert.equal(label(panel), "4 of 4 lanes flying");
  assert.doesNotMatch(banner(panel), /sq-runway-label/, "four stands leave no room beside the stencil in the side panel");
  assert.match(controls(panel), /class="sq-runway-label"/, "so the label moves to the controls row");

  const unread = await render(base, { lanesKnown: false });
  assert.equal(label(unread), undefined, "no count until the live board's first read");
  assert.match(banner(unread), /data-stands="0"/, "and no stands drawn yet");
});

test("one row under the banner holds the picker, How it works, Doctor, Helper, New spec and Autopilot, in that order", async () => {
  for (const placement of ["page", "panel"] as const) {
    const row = controls(await render(base, { placement }));
    const order = [
      ["picker", /class="sq-picker-button"/],
      ["How it works", /class="sq-btn sq-how-open"/],
      ["Doctor", /class="sq-doctor"/],
      ["Helper", /class="sq-helper"/],
      ["New spec", />New <span[^>]*data-term="Spec"/],
      ["Autopilot", /<section class="sq-autopilot"[^>]*>[\s\S]*role="switch"/],
    ] as const;
    let from = -1;
    for (const [name, pattern] of order) {
      const at = row.search(pattern);
      assert.ok(at >= 0, `the ${placement} controls row holds ${name}`);
      assert.ok(at > from, `${name} follows the control before it`);
      from = at;
    }
    assert.match(row, /Autopilot runs only while BB runs on this Mac\./, "Autopilot's note stays with it");
  }
});
