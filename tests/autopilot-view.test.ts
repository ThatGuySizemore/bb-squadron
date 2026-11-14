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

test("Paused shows its reason and one Autopilot-paused Needs you row with Resume", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const { needsYou } = await import("../lib/board-model.js");
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 0, autoStart: false, lanes: [], ready: [], shaping: [], openIssues: [],
    autopilot: { status: "paused", laneLimit: 3, consecutiveStops: 2, pauseReason: "Two lanes in a row stopped" } };
  assert.deepEqual(needsYou(board), [{ key: "autopilot-paused", kind: "autopilot-paused", specId: "", threadId: null,
    text: "Two lanes in a row stopped" }]);
  const html = renderToStaticMarkup(createElement(BoardView, { board, demo: false, modeSwitch: null,
    dispatch: () => undefined, onPlan: () => undefined }));
  assert.match(html, />Paused</);
  assert.match(html, /data-kind="autopilot-paused"/);
  assert.match(html, /Two lanes in a row stopped/);
  assert.match(html, />Resume<\/button>/);
});

test("the live paused row resumes Autopilot through RPC, waits while saving, and refreshes", async () => {
  await import("./fixtures/app-runtime.js");
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const browser = dom.window;
  browser.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof browser.matchMedia;
  browser.HTMLCanvasElement.prototype.getContext = (() => null) as typeof browser.HTMLCanvasElement.prototype.getContext;
  const globals = { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element,
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const runtime = (globalThis as any).__bbPluginRuntime.pluginSdkApp;
  const oldRpc = runtime.useRpc;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let boardReads = 0;
  const calls: unknown[] = [];
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 0, autoStart: false, lanes: [], ready: [], shaping: [], openIssues: [],
    autopilot: { status: "paused", laneLimit: 3, consecutiveStops: 2, pauseReason: "Two lanes in a row stopped" } };
  const rpc = { call: async (method: string, input: unknown) => {
    if (method === "board.projects") return { projects: [{ id: "proj-one", name: "Fixture" }], lastPick: null };
    if (method === "board") { boardReads++; return board; }
    assert.equal(method, "autopilot.resume"); calls.push([method, input]);
    await gate;
    board.autopilot = { status: "on", laneLimit: 3, consecutiveStops: 0, pauseReason: null };
    return board.autopilot;
  } };
  runtime.useRpc = () => rpc;
  const { LiveBoard } = await import("../board/Board.js");
  const root = createRoot(browser.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(LiveBoard, { modeSwitch: null, context: "proj-one" })));
    const button = browser.document.querySelector<HTMLButtonElement>('[data-kind="autopilot-paused"] button')!;
    assert.equal(button.textContent, "Resume");
    const before = boardReads;
    await act(async () => button.click());
    assert.deepEqual(calls, [["autopilot.resume", { projectId: "proj-one" }]]);
    assert.equal(button.disabled, true);
    await act(async () => { release(); await gate; });
    assert.ok(boardReads > before);
    assert.equal(browser.document.querySelector('[data-kind="autopilot-paused"]'), null);
  } finally {
    release();
    await act(async () => root.unmount());
    runtime.useRpc = oldRpc;
    browser.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
