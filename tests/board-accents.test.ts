import { test } from "node:test";
import assert from "node:assert/strict";
import { createSurface, needsYou, plate, sectionRule } from "../lib/dither.js";
import { JSDOM } from "jsdom";
import type { Board, Lane } from "../lib/board-model.js";

test("Needs you has a heavy amber edge and a clear text inset at both widths and pixel densities", () => {
  const amber = 0xff00a9f2;
  for (const width of [350, 1100]) for (const dpr of [1, 2]) {
    for (const seconds of [0, 0.9, 2.7]) {
      const s = createSurface(width, 80, dpr);
      needsYou({ ink: amber })(s, seconds);
      for (let y = 16 * dpr; y < s.h - 16 * dpr; y++) {
        for (let x = 18 * dpr; x < s.w - 18 * dpr; x++) {
          assert.equal(s.buf[y * s.w + x], 0, "the full text rectangle stays clear throughout the breath");
        }
      }
      if (seconds === 0.9) {
        // Measure a whole row: Bayer thresholds can reject individual faint pixels.
        const innerEdge = s.buf.slice(8 * dpr * s.w + 18 * dpr, 8 * dpr * s.w + s.w - 18 * dpr);
        assert.ok(innerEdge.filter((p) => p === amber).length > innerEdge.length * 0.2,
          "the heavier edge retains substantial grain 8px into the row");
        const top = s.buf.slice(0, s.w);
        assert.ok(top.filter((p) => p === amber).length > s.w * 0.6, "the crest carries the comp's heavier amber grain");
      }
    }
  }
});

test("both board layouts place decorative rules before headings and keep the accents separate from text", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const lane: Lane = { specId: "FIX-1", title: "A completed spec", state: "landed", minutes: 12,
    lead: { family: "gpt", model: "gpt-6.1-sol", effort: "medium" }, leadThreadId: "thr_lead",
    branch: "bb/fixture", acceptOwner: false, tickets: [] };
  const board: Board = { tick: 0, laneCapacity: 2, workersPerLane: 2, autoStart: false,
    lanes: [lane, { ...lane, specId: "FIX-2", state: "stopped", title: "A stopped spec" }],
    ready: [], shaping: [], openIssues: [] };
  for (const placement of ["page", "panel"] as const) {
    const html = renderToStaticMarkup(createElement(BoardView, { board, placement, demo: false,
      modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined }));
    const dom = new JSDOM(html);
    try {
      const doc = dom.window.document;
      const sections = [...doc.querySelectorAll(".sq-section")];
      assert.equal(sections.length, 6);
      for (const section of sections) {
        const rule = section.querySelector(".sq-section-rule");
        assert.ok(rule, "every section has a pixel-dotted rule");
        assert.equal(rule.tagName, "CANVAS", "rules use the shared painter");
        assert.equal(rule.getAttribute("aria-hidden"), "true");
        assert.equal(rule.parentElement, section, "the rule sits outside the label's text box");
        assert.equal(rule.nextElementSibling?.className, "sq-label");
      }
      for (const selector of [".sq-need", '.sq-plate[data-landed="true"]']) {
        const accent = doc.querySelector(selector)!;
        assert.ok(accent);
        assert.equal(accent.querySelector(":scope > canvas")?.getAttribute("aria-hidden"), "true");
        assert.ok(accent.textContent!.includes(selector === ".sq-need" ? "Stopped" : "FIX-1"));
      }
      assert.equal(doc.querySelector(".sq-need button")?.textContent, "Resume");
    } finally { dom.window.close(); }
  }
});

test("the Landed stamp keeps its green grain outside the spec number", () => {
  const green = 0xff6ba32f;
  for (const dpr of [1, 2]) {
    const s = createSurface(108, 36, dpr);
    plate({ ink: green })(s, 0);
    assert.ok(s.buf.slice(0, s.w).filter((p) => p === green).length > s.w * 0.8,
      "the stamp has the comp's dense green edge");
    for (let y = 7 * dpr; y < s.h - 7 * dpr; y++) {
      for (let x = 7 * dpr; x < s.w - 7 * dpr; x++) {
        assert.equal(s.buf[y * s.w + x], 0, "no green texture behind the number");
      }
    }
    const later = createSurface(108, 36, dpr);
    plate({ ink: green })(later, 10);
    assert.deepEqual(later.buf, s.buf, "a stamp stays still");
  }
});

test("section rules draw 2px squares on an 8px pitch at both pixel densities", () => {
  const ink = 0x4de3e7e9;
  for (const dpr of [1, 2]) for (const width of [19, 350, 1100]) {
    const s = createSurface(width, 2, dpr);
    sectionRule({ ink })(s, 0);
    const dot = Array(2 * dpr).fill(ink);
    const gap = Array(6 * dpr).fill(0);
    const period = [...dot, ...gap];
    const row = Array.from({ length: s.w }, (_, x) => period[x % period.length]);
    for (let y = 0; y < s.h; y++) assert.deepEqual([...s.buf.slice(y * s.w, (y + 1) * s.w)], row);
  }
});
