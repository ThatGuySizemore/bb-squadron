import { test } from "node:test";
import assert from "node:assert/strict";
import type { Board } from "../lib/board-model.js";

test("the live board exposes the persisted auto-start switch and disables it while saving", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: true, lanes: [], ready: [], unplanned: [] };
  const render = (saving: boolean) => renderToStaticMarkup(createElement(BoardView, {
    board, demo: false, modeSwitch: null, autoStartSaving: saving, dispatch: () => undefined, onPlan: () => undefined,
  }));
  assert.match(render(false), /<button[^>]*role="switch"[^>]*aria-checked="true"[^>]*>[\s\S]*?Auto-start ready specs/);
  assert.match(render(true), /<button[^>]*role="switch"[^>]*aria-checked="true"[^>]*disabled=""/);
  assert.ok(render(true).includes("Saving auto-start"));
});

test("the switch saves the selected project and refreshes after both success and refusal", async () => {
  await import("./fixtures/app-runtime.js");
  const { setAutoStartFromBoard } = await import("../board/Board.js");
  const calls: unknown[] = [];
  await setAutoStartFromBoard({ set: async (input) => { calls.push(input); return { enabled: true }; },
    refresh: async () => { calls.push("refresh"); }, notify: (message) => { calls.push(message); } }, "proj-one", true);
  assert.deepEqual(calls, [{ projectId: "proj-one", enabled: true }, "refresh"]);
  calls.length = 0;
  await setAutoStartFromBoard({ set: async () => { throw new Error("Change auto-start from the Squadron board."); },
    refresh: async () => { calls.push("refresh"); }, notify: (message) => { calls.push(message); } }, "proj-two", false);
  assert.deepEqual(calls, ["Change auto-start from the Squadron board.", "refresh"]);
});
