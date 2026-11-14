import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { Board, Lane, Ticket } from "../lib/board-model.js";
import { elements, parse, visibleText } from "./fixtures/owner-text.js";

const route = { family: "gpt", model: "gpt-6.1-sol", effort: "medium" } as const;
const ticket = (id: string, state: Ticket["state"], extra: Partial<Ticket> = {}): Ticket => ({
  id, title: `Ticket ${id}`, state, route, blockedBy: [], minutes: 4, ...extra,
});

test("slim rows follow the measured narrow layout and open their own threads in the right view", async () => {
  await import("./fixtures/app-runtime.js");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const browser = dom.window;
  let width = 360;
  browser.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof browser.matchMedia;
  browser.HTMLCanvasElement.prototype.getContext = (() => null) as typeof browser.HTMLCanvasElement.prototype.getContext;
  browser.HTMLElement.prototype.getBoundingClientRect = () => ({ width, height: 600, top: 0, bottom: 600, left: 0, right: width, x: 0, y: 0, toJSON() {} });
  const globals = { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element,
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { BoardView } = await import("../board/Board.js");
  const runtime = (globalThis as any).__bbPluginRuntime.pluginSdkApp;
  const oldNavigate = runtime.useBbNavigate;
  const calls: unknown[] = [];
  runtime.useBbNavigate = () => ({ toThread: (id: string, options?: unknown) => { calls.push([id, options]); } });
  const root = createRoot(browser.document.getElementById("root")!);
  try {
    for (const [index, [placement, measuredWidth]] of ([
      ["panel", 360], ["page", 900], ["page", 901], ["panel", 1400],
    ] as const).entries()) {
      width = measuredWidth;
      await act(async () => root.render(createElement(BoardView, { key: index, board, placement, demo: false,
        modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined })));
      const rows = [...browser.document.querySelectorAll<HTMLButtonElement>(".sq-ticket-row")];
      if (placement === "page" && width === 901) {
        assert.equal(rows.length, 0, "wide boards retain their sortie pegs");
        assert.ok(browser.document.querySelector(".sq-peg"));
        continue;
      }
      assert.equal(rows.length, 4);
      calls.length = 0;
      for (const row of rows) await act(async () => row.click());
      assert.deepEqual(calls, ["thr_work", "thr_review", "thr_question", "thr_failed"].map((id) =>
        [id, placement === "page" ? { split: true } : undefined]));
    }
    const missing: Board = { ...board, lanes: [{ ...lane, tickets: [ticket("FIX-11", "working")] }] };
    await act(async () => root.render(createElement(BoardView, { board: missing, placement: "panel", demo: false,
      modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined })));
    const row = browser.document.querySelector(".sq-ticket-row")!;
    assert.equal(row.tagName, "DIV", "a missing thread never offers a broken button");
    assert.match(row.textContent!, /No recent activity/);
    assert.match(row.textContent!, /4m/);
  } finally {
    await act(async () => root.unmount());
    runtime.useBbNavigate = oldNavigate;
    browser.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
const lane: Lane = {
  specId: "FIX-1", title: "A flying spec", state: "flying", lead: route, leadThreadId: "thr_lead", branch: "bb/fixture",
  minutes: 12, acceptOwner: false,
  tickets: [
    ticket("FIX-2", "working", { threadId: "thr_work", liveStep: { status: "active", step: "Running npm test", since: null } }),
    ticket("FIX-3", "review", { threadId: "thr_review", liveStep: { status: "active", step: "Reading the changes", since: null } }),
    ticket("FIX-4", "question", { threadId: "thr_question", liveStep: { status: "idle", step: "Choose a name", since: null } }),
    ticket("FIX-5", "failed", { threadId: "thr_failed", liveStep: { status: "error", step: "Build failed", since: null } }),
    ticket("FIX-6", "done"), ticket("FIX-7", "branch"), ticket("FIX-8", "blocked"),
    ticket("FIX-9", "ready"), ticket("FIX-10", "held"),
  ],
};
const board: Board = { tick: 0, laneCapacity: 1, workersPerLane: 2, autoStart: false,
  lanes: [lane], ready: [], shaping: [], openIssues: [] };

test("narrow lanes show slim active ticket rows with titles, state words, live steps and time above every ticket", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const html = renderToStaticMarkup(createElement(BoardView, { board, placement: "panel", demo: false,
    modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined }));
  const all = elements(parse(html));
  const active = all.find((element) => element.attrs.class === "sq-active")!;
  assert.ok(active);
  const rows = elements(active).filter((element) => element.attrs.class === "sq-ticket-row");
  assert.deepEqual(rows.map((row) => row.attrs["data-state"]), ["working", "review", "question", "failed"]);
  assert.deepEqual(rows.map((row) => visibleText(row)), [
    "FIX-2Ticket FIX-2WorkingRunning npm test4m", "FIX-3Ticket FIX-3In reviewReading the changes4m",
    "FIX-4Ticket FIX-4Needs youChoose a name4m", "FIX-5Ticket FIX-5StoppedError · Build failed4m",
  ]);
  assert.ok(rows.every((row) => row.tag === "button" && row.attrs["aria-label"]?.includes("Open thread")));
  assert.match(rows[3]!.attrs["aria-label"], /error\. Build failed\. 4m\./,
    "the thread control's accessible name includes its error, live step and time");
  assert.equal(elements(active).some((element) => element.attrs.class === "sq-peg"), false,
    "active tickets use rows instead of tall pegs");
  const disclosure = all.find((element) => element.tag === "details" && element.attrs.class === "sq-all")!;
  assert.equal(visibleText(elements(disclosure).find((element) => element.tag === "summary")!), "All 9 tickets · 2 in branch");
  assert.deepEqual(elements(disclosure).filter((element) => element.tag === "li").map((element) => element.attrs["data-state"]),
    ["working", "review", "question", "failed", "done", "branch", "blocked", "ready", "held"]);
  assert.ok(html.indexOf('class="sq-active"') < html.indexOf('class="sq-all"'));
});
