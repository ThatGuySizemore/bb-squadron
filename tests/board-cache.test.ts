// SQD-271: switching chats remounts the side panel's board. A project the panel
// has already read shows its last board at once, then refreshes; only a project
// read for the first time shows the loading state. The inks every dither canvas
// reads come from one shared reading per theme, not a forced restyle per canvas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { Board } from "../lib/board-model.js";

const route = { family: "gpt", model: "gpt-6.1-sol", effort: "medium" } as const;
const boardOf = (title: string): Board => ({ tick: 0, laneCapacity: 2, workersPerLane: 2, autoStart: false, ready: [], shaping: [], openIssues: [],
  lanes: [{ specId: "FIX-1", title, lead: route, leadThreadId: "t", branch: "spec", state: "flying", minutes: 1, acceptOwner: false, tickets: [] }] });

test("a remount on a project already read shows its last board with no loading state; a new project still loads", async () => {
  await import("./fixtures/app-runtime.js");
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
  const oldRpc = runtime.useRpc, oldRealtime = runtime.useRealtime;
  let hold = false;
  const rpc = { call: async (method: string, value: any) => {
    if (method === "helper.read") return null;
    if (method === "board.projects") return { projects: [{ id: "proj-one", name: "One" }, { id: "proj-two", name: "Two" }], lastPick: null };
    if (hold) return new Promise(() => undefined);
    return boardOf(`Board of ${value.projectId}`);
  } };
  runtime.useRpc = () => rpc;
  runtime.useRealtime = () => undefined;
  const { LiveBoard } = await import("../board/Board.js");
  const host = browser.document.getElementById("root")!;
  const mount = async (context: string) => {
    const root = createRoot(host);
    await act(async () => root.render(createElement(LiveBoard, { modeSwitch: null, context })));
    return root;
  };
  const busy = () => host.querySelector(".sq")?.hasAttribute("aria-busy");
  try {
    let root = await mount("proj-one");
    assert.equal(busy(), false, "the first read arrived");
    assert.match(host.textContent ?? "", /Board of proj-one/);
    await act(async () => root.unmount());
    hold = true; // the refresh never returns, so only the remembered board can be on screen
    root = await mount("proj-one");
    assert.equal(busy(), false, "a project already read opens on its last board");
    assert.match(host.textContent ?? "", /Board of proj-one/);
    await act(async () => root.unmount());
    root = await mount("proj-two");
    assert.equal(busy(), true, "a project read for the first time shows the loading state");
    assert.doesNotMatch(host.textContent ?? "", /Board of proj-one/, "never another project's board");
    await act(async () => root.unmount());
  } finally {
    runtime.useRpc = oldRpc; runtime.useRealtime = oldRealtime;
    browser.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("canvases share one reading of the inks per theme instead of restyling per canvas", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='a'></div><div id='b'></div></body></html>", { pretendToBeVisual: true });
  const browser = dom.window;
  const real = browser.getComputedStyle.bind(browser);
  const spanReads: string[] = [];
  const probes: string[] = [];
  browser.getComputedStyle = ((el: Element) => {
    if (el.tagName === "SPAN") spanReads.push((el as HTMLElement).style.color);
    return real(el);
  }) as typeof browser.getComputedStyle;
  browser.HTMLCanvasElement.prototype.getContext = (() => { probes.push("ctx"); return {
    clearRect() {}, fillRect() {}, getImageData: () => ({ data: [1, 2, 3, 255] }), fillStyle: "",
  }; }) as unknown as typeof browser.HTMLCanvasElement.prototype.getContext;
  browser.document.documentElement.style.setProperty("--sq-sky", "color-mix(in oklab, red 50%, blue)");
  const globals = { window: browser, document: browser.document, getComputedStyle: browser.getComputedStyle };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  try {
    const { inksOf, themeChanged } = await import("../board/inks.js");
    const make = (id: string) => inksOf(browser.document.getElementById(id)!);
    for (let i = 0; i < 10; i++) make(i % 2 ? "a" : "b")("--sq-sky");
    assert.equal(spanReads.length, 1, "ten canvases resolve the same mixed ink once");
    themeChanged();
    make("a")("--sq-sky");
    assert.equal(spanReads.length, 2, "a theme change reads the inks again");
  } finally {
    browser.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
