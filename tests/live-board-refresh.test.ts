import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { Board } from "../lib/board-model.js";

test("the live page reads only visible lanes, skips every refresh while hidden and resumes at 15 seconds", async () => {
  await import("./fixtures/app-runtime.js");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const browser = dom.window;
  let hidden = true;
  Object.defineProperty(browser.document, "visibilityState", { get: () => hidden ? "hidden" : "visible" });
  browser.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof browser.matchMedia;
  browser.HTMLCanvasElement.prototype.getContext = (() => null) as typeof browser.HTMLCanvasElement.prototype.getContext;
  browser.HTMLElement.prototype.getBoundingClientRect = function () {
    const offscreen = this.getAttribute("data-live-lane") === "FIX-2";
    return { top: offscreen ? 1200 : 0, bottom: offscreen ? 1500 : 600, left: 0, right: 400, width: 400, height: 600, x: 0, y: 0, toJSON() {} };
  };
  const intervals = new Map<number, { callback: () => void; ms: number }>();
  let timer = 0;
  browser.setInterval = ((callback: () => void, ms: number) => { intervals.set(++timer, { callback, ms }); return timer; }) as typeof browser.setInterval;
  browser.clearInterval = (id) => { if (id !== undefined) intervals.delete(id); };
  const globals = { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element,
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const runtime = (globalThis as any).__bbPluginRuntime.pluginSdkApp;
  const oldRpc = runtime.useRpc, oldRealtime = runtime.useRealtime;
  const signals = new Map<string, (payload: unknown) => void>();
  const calls: Array<{ visibleLaneIds?: string[]; refreshLive?: boolean }> = [];
  const route = { family: "gpt", model: "gpt-6.1-sol", effort: "medium" } as const;
  const board: Board = { tick: 0, laneCapacity: 2, workersPerLane: 2, autoStart: false, ready: [], shaping: [], openIssues: [],
    lanes: ["FIX-1", "FIX-2"].map((specId) => ({ specId, title: specId, lead: route, leadThreadId: specId,
      branch: "spec", state: "flying", minutes: 1, acceptOwner: false, tickets: [] })) };
  const rpc = { call: async (method: string, value: any) => {
    if (method === "board.projects") return { projects: [{ id: "proj-one", name: "Fixture" }], lastPick: null };
    assert.equal(method, "board"); calls.push(value); return board;
  } };
  runtime.useRpc = () => rpc;
  runtime.useRealtime = (name: string, callback: (payload: unknown) => void) => { signals.set(name, callback); };
  const { LiveBoard } = await import("../board/Board.js");
  const root = createRoot(browser.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(LiveBoard, { modeSwitch: null, context: "proj-one" })));
    assert.equal(calls.length, 0, "even the initial board read waits while hidden");
    hidden = false;
    await act(async () => { browser.document.dispatchEvent(new browser.Event("visibilitychange")); });
    assert.ok(calls.length >= 2, "first reads the board, then the on-screen lanes");
    assert.deepEqual(calls.at(-1)?.visibleLaneIds, ["FIX-1"]);
    const poll = [...intervals.values()].find((entry) => entry.ms === 15_000);
    assert.ok(poll, "one 15-second poll");
    const before = calls.length;
    hidden = true;
    await act(async () => { poll.callback(); signals.get("board-changed")!({ projectId: "proj-one" }); });
    assert.equal(calls.length, before, "neither timer nor signal reads hidden pages");
    hidden = false;
    await act(async () => { signals.get("board-changed")!({ projectId: "proj-one" }); });
    assert.equal(calls.at(-1)?.refreshLive, true);
    await act(async () => { poll.callback(); });
    assert.equal(calls.at(-1)?.refreshLive, false);
  } finally {
    await act(async () => root.unmount());
    runtime.useRpc = oldRpc; runtime.useRealtime = oldRealtime;
    browser.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
