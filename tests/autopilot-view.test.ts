import { test } from "node:test";
import assert from "node:assert/strict";
import type { Board } from "../lib/board-model.js";

test("the live board shows Autopilot state, bounded lane limit, and this Mac's runtime note", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 0, autoStart: false, lanes: [], ready: [], shaping: [], openIssues: [],
    autopilot: { status: "off", laneLimit: 3, consecutiveStops: 0, pauseReason: null } };
  const render = (status: "on" | "off", saving = false) => renderToStaticMarkup(createElement(BoardView, {
    board: { ...board, autopilot: { ...board.autopilot!, status } }, demo: false, modeSwitch: null,
    dispatch: () => undefined, onPlan: () => undefined, ...{ autopilotSaving: saving },
  }));
  const off = render("off");
  assert.match(off, /role="switch"[^>]*aria-checked="false"/);
  assert.match(off, /Autopilot/);
  assert.match(off, />Off</);
  assert.match(off, /Lane limit/);
  assert.match(off, /<option value="3" selected="">3<\/option>/);
  assert.match(off, /BB runs on this Mac/);
  const on = render("on", true);
  assert.match(on, /aria-checked="true"/);
  assert.match(on, />On</);
  assert.match(on, /<select[^>]*disabled=""/);
  assert.match(on, /role="status">Saving/);
});
