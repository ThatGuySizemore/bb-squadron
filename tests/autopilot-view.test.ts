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
  const render = (status: "on" | "off", saving = false, checkingMain = false) => renderToStaticMarkup(createElement(BoardView, {
    board: { ...board, autopilot: { ...board.autopilot!, status, checkingMain } }, demo: false, modeSwitch: null,
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
  const checking = render("on", false, true);
  assert.match(checking, /role="status">Checking main…/);
  assert.doesNotMatch(checking.match(/<section class="sq-autopilot"[\s\S]*?<\/section>/)![0], /disabled=""/);
  assert.doesNotMatch(checking, /Saving/);
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

test("a main-check pause exposes its retained host log beside Resume", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 0, autoStart: false, lanes: [], ready: [], shaping: [], openIssues: [],
    autopilot: { status: "paused", laneLimit: 3, consecutiveStops: 0, pauseReason: "Main fails its quick check",
      pauseLog: { hostId: "repo-machine", path: "/scratch/main.log" } } };
  const html = renderToStaticMarkup(createElement(BoardView, { board, demo: false, modeSwitch: null,
    dispatch: () => undefined, onPlan: () => undefined }));
  assert.match(html, /href="\/scratch\/main.log"[^>]*>Check log<\/a>/);
  assert.match(html, /Main fails its quick check/);
  assert.match(html, />Resume<\/button>/);
});

test("saved switch and lane limit update before a slow board reload completes", async () => {
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
  let releaseReload!: () => void;
  const reloadGate = new Promise<void>(resolve => { releaseReload = resolve; });
  const calls: unknown[] = [];
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 0, autoStart: false, lanes: [], ready: [], shaping: [], openIssues: [],
    autopilot: { status: "off", laneLimit: 3, consecutiveStops: 0, pauseReason: null } };
  const rpc = { call: async (method: string, input: unknown) => {
    if (method === "board.projects") return { projects: [{ id: "proj-one", name: "Fixture" }], lastPick: null };
    if (method === "board") { boardReads++; if (boardReads > 1) await reloadGate; return board; }
    assert.equal(method, "autopilot.set"); calls.push([method, input]);
    await gate;
    board.autopilot = { ...board.autopilot!, ...(input as object) };
    return board.autopilot;
  } };
  runtime.useRpc = () => rpc;
  const { LiveBoard } = await import("../board/Board.js");
  const root = createRoot(browser.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(LiveBoard, { modeSwitch: null, context: "proj-one" })));
    const button = browser.document.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => button.click());
    assert.equal(button.disabled, true);
    await act(async () => { release(); await gate; });
    assert.ok(boardReads > 1, 'the background reload has begun');
    assert.equal(button.disabled, false, 'Saving ends when the save returns');
    assert.equal(button.getAttribute('aria-checked'), 'true');
    assert.match(button.textContent!, /On/);
    const select = browser.document.querySelector<HTMLSelectElement>('.sq-autopilot-limit select')!;
    await act(async () => { select.value = '5'; select.dispatchEvent(new browser.Event('change', { bubbles: true })); });
    assert.equal(select.disabled, false);
    assert.equal(select.value, '5', 'the saved lane limit is visible before reload returns');
    assert.deepEqual(calls, [ ['autopilot.set', { projectId: 'proj-one', status: 'on' }],
      ['autopilot.set', { projectId: 'proj-one', laneLimit: 5 }] ]);

  } finally {
    release(); releaseReload();
    await act(async () => root.unmount());
    runtime.useRpc = oldRpc;
    browser.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});


test('a background reload can restore the board shown before the save', async () => {
  await import('./fixtures/app-runtime.js');
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const browser = dom.window;
  browser.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof browser.matchMedia;
  browser.HTMLCanvasElement.prototype.getContext = (() => null) as typeof browser.HTMLCanvasElement.prototype.getContext;
  const globals = { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element,
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const runtime = (globalThis as any).__bbPluginRuntime.pluginSdkApp;
  const oldRpc = runtime.useRpc;
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 0, autoStart: false, lanes: [], ready: [], shaping: [], openIssues: [],
    autopilot: { status: 'off', laneLimit: 3, consecutiveStops: 0, pauseReason: null } };
  const rpc = { call: async (method: string) => {
    if (method === 'board.projects') return { projects: [{ id: 'proj-one', name: 'Fixture' }], lastPick: null };
    if (method === 'board') return board; // Another owner control restored Off before this reload.
    assert.equal(method, 'autopilot.set');
    return { ...board.autopilot, status: 'on' };
  } };
  runtime.useRpc = () => rpc;
  const { LiveBoard } = await import('../board/Board.js');
  const root = createRoot(browser.document.getElementById('root')!);
  try {
    await act(async () => root.render(createElement(LiveBoard, { modeSwitch: null, context: 'proj-one' })));
    const button = browser.document.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => button.click());
    assert.equal(button.getAttribute('aria-checked'), 'false', 'the returned board replaces the saved On state even when it matches the pre-save board');
  } finally {
    await act(async () => root.unmount()); runtime.useRpc = oldRpc; browser.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
