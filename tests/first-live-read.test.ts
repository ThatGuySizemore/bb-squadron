// SQD-226: lifecycle history begins with the first real LiveBoard RPC read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { Board, Lane } from "../lib/board-model.js";

test("deferred first LiveBoard read and reload seed existing lanes; later starts take off", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LiveBoard } = await import("../board/Board.js");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const browser = dom.window;
  browser.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof browser.matchMedia;
  browser.HTMLCanvasElement.prototype.getContext = (() => null) as typeof browser.HTMLCanvasElement.prototype.getContext;
  browser.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 164, left: 0, right: 1200, width: 1200, height: 164, x: 0, y: 0, toJSON() {} });
  const globals = { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element,
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const route = { family: "gpt", model: "gpt-6.1-sol", effort: "medium" } as const;
  const lane: Lane = { specId: "A-1", title: "Already flying", lead: route, leadThreadId: "thr_a", branch: "spec/a",
    state: "flying", minutes: 90, acceptOwner: false, workingThreads: 1, tickets: [] };
  let board: Board = { tick: 0, laneCapacity: 2, workersPerLane: 2, autoStart: false, lanes: [lane], ready: [], shaping: [], openIssues: [] };
  const runtime = (globalThis as unknown as { __bbPluginRuntime: { pluginSdkApp: { useRpc: () => unknown; useRealtime: (...args: unknown[]) => unknown } } }).__bbPluginRuntime.pluginSdkApp;
  const originalRpc = runtime.useRpc, originalRealtime = runtime.useRealtime;
  let changed: (() => void) | undefined;
  browser.setInterval = ((callback: () => void) => { changed = callback; return 1; }) as typeof browser.setInterval;
  browser.clearInterval = () => undefined;
  let fulfill!: (value: Board) => void;
  let firstRead = new Promise<Board>((resolve) => { fulfill = resolve; });
  let delivered = false;
  const rpc = { call: async (method: string) => {
    if (method === "board.projects") return { projects: [{ id: "proj-one", name: "Project" }], lastPick: "proj-one" };
    if (method === "board") return delivered ? board : firstRead;
    throw new Error(`Unused RPC ${method}`);
  } };
  runtime.useRpc = () => rpc;
  let root = createRoot(browser.document.getElementById("root")!);
  const plane = (id: string) => browser.document.querySelector<HTMLElement>(`.sq-runway-plane[aria-label^='${id},']`);
  try {
    for (const reload of [false, true]) {
      if (reload) {
        await act(async () => root.unmount());
        root = createRoot(browser.document.getElementById("root")!);
        delivered = false;
        firstRead = new Promise<Board>((resolve) => { fulfill = resolve; });
      }
      await act(async () => root.render(createElement(LiveBoard, { modeSwitch: null, context: "proj-one" })));
      assert.equal(plane("A-1"), null, "RPC is still deferred");
      await act(async () => { delivered = true; fulfill(board); await firstRead; });
      assert.equal(plane("A-1")?.dataset.plane, "flying", "an existing 90-minute lane never replays takeoff on first read or reload");
      assert.doesNotMatch(plane("A-1")?.getAttribute("aria-label") ?? "", /taking off/);
    }
    board = { ...board, lanes: [lane, { ...lane, specId: "B-1", title: "New lane", minutes: 0 }] };
    assert.ok(changed, "LiveBoard polls for board changes");
    await act(async () => { changed!(); });
    assert.equal(plane("A-1")?.dataset.plane, "flying");
    assert.equal(plane("B-1")?.dataset.plane, "takeoff", "a real start after known data still takes off");
    // Picking another project is a fresh read too, not a start of every lane there.
    board = { ...board, lanes: [{ ...lane, specId: "C-1" }] };
    delivered = false;
    firstRead = new Promise<Board>((resolve) => { fulfill = resolve; });
    await act(async () => root.render(createElement(LiveBoard, { modeSwitch: null, context: "proj-two" })));
    assert.equal(plane("C-1"), null);
    await act(async () => { delivered = true; fulfill(board); await firstRead; });
    assert.equal(plane("C-1")?.dataset.plane, "flying", "another project's first read also seeds history");
  } finally {
    await act(async () => root.unmount());
    runtime.useRpc = originalRpc;
    runtime.useRealtime = originalRealtime;
    browser.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
