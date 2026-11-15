import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { Board } from "../lib/board-model.js";

const empty: Board = { tick: 0, laneCapacity: 0, workersPerLane: 0, autoStart: false, lanes: [], ready: [], shaping: [], openIssues: [] };

async function view(placement: "page" | "panel", board = empty, notice?: string) {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  return new JSDOM(renderToStaticMarkup(createElement(BoardView, {
    board, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined, placement, notice,
  }))).window.document;
}

test("all six section labels use accessible pixel text and keep their glossary definitions in both layouts", async () => {
  for (const placement of ["page", "panel"] as const) {
    const doc = await view(placement);
    const headings = [...doc.querySelectorAll(".sq-label h2")];
    assert.deepEqual(headings.map((h) => h.querySelector(".sq-sr")?.textContent),
      ["Needs you", "Flying", "Ready", "Shaping", "Open issues", "Landed"]);
    for (const h of headings) {
      const svg = h.querySelector("svg.sq-pixeltext");
      assert.equal(svg?.getAttribute("aria-hidden"), "true");
      assert.equal(svg.getAttribute("height"), "14", "the comp uses two-pixel cells for labels");
      assert.ok(svg.querySelector("rect"));
      assert.equal(h.querySelector("canvas"), null, "pixel labels have no dither behind them");
    }
    for (const name of ["Needs you", "Flying", "Ready", "Shaping", "Landed"]) {
      const term = doc.querySelector(`.sq-label [data-term="${name}"]`);
      assert.equal(term?.getAttribute("tabindex"), "0");
      assert.ok(doc.getElementById(term!.getAttribute("aria-describedby")!)?.textContent);
    }
  }
});

test("only path counts join the section labels and existing spec numbers in pixel type", async () => {
  const { initialBoard } = await import("../lib/fake-board.js");
  for (const placement of ["page", "panel"] as const) {
    const sample = initialBoard();
    const doc = await view(placement, { ...sample, lanes: sample.lanes.map((lane) => ({ ...lane, tickets: lane.tickets.slice(0, 1) })) });
    const counts = [...doc.querySelectorAll(".sq-station-count")];
    assert.equal(counts.length, 5);
    assert.deepEqual(counts.map((n) => n.querySelector(".sq-sr")?.textContent), ["6", "2", "3", "2", "1"]);
    for (const n of counts) {
      const svg = n.querySelector("svg.sq-pixeltext");
      assert.equal(svg?.getAttribute("aria-hidden"), "true");
      assert.equal(svg.getAttribute("height"), placement === "panel" ? "14" : "21");
      assert.ok(svg.querySelector("rect"));
    }
    for (const el of doc.querySelectorAll(".sq-label .sq-num, .sq-time, .sq-progress-n, .sq-peg-id, .sq-btn, .sq-station-label, .sq-term-tip")) {
      assert.equal(el.querySelector("svg.sq-pixeltext"), null, `${el.className} stays in normal type`);
    }
    for (const svg of doc.querySelectorAll("svg.sq-pixeltext")) {
      // SQD-222: the banner's SQUADRON stencil is the one other approved role.
      assert.ok(svg.closest(".sq-label h2, .sq-station-count, .sq-tail-number, .sq-need-id, .sq-plate-id, .sq-runway-title"),
        "pixel text is limited to the approved roles");
    }
  }
});

test("path counts preserve zero, multiple digits and unknown values without changing their labels", async () => {
  const twelveIssues: Board["openIssues"] = Array.from({ length: 12 }, (_, i) => ({ id: `FIX-${i + 1}`, title: "An open issue", priority: 0, labels: [] }));
  const doc = await view("panel", { ...empty, openIssues: twelveIssues });
  assert.deepEqual([...doc.querySelectorAll(".sq-station-count .sq-sr")].map((n) => n.textContent), ["12", "0", "0", "0", "0"]);
  assert.equal(doc.querySelector(".sq-station-count svg")?.getAttribute("width"), "18", "the comp's narrow 1 and 2 glyphs share a two-pixel gap");
  const unknown = await view("panel", empty, "Still reading the tracker");
  const stations = [...unknown.querySelectorAll(".sq-station")];
  assert.deepEqual(stations.slice(0, 3).map((n) => n.querySelector(".sq-station-count")?.textContent), ["–", "–", "–"]);
  assert.ok(stations.slice(0, 3).every((n) => !n.querySelector(".sq-station-count svg")), "unknown is a text dash, never a blank unsupported pixel glyph");
  assert.equal(stations[0]?.querySelector(".sq-station-long")?.textContent, "Open issues");
  assert.equal(stations[0]?.querySelector(".sq-station-short")?.getAttribute("aria-hidden"), "true");
});
