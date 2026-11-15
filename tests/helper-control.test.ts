import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

test("the header starts and opens the Helper, offers replacement and selection, and restores Start Helper when it disappears", async () => {
  await import("./fixtures/app-runtime.js");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const browser = dom.window;
  const globals = { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const runtime = (globalThis as any).__bbPluginRuntime.pluginSdkApp;
  const oldRpc = runtime.useRpc;
  let helper: { threadId: string; title: string } | null = null;
  const calls: unknown[] = [], opened: string[] = [];
  let finishRead!: () => void;
  const reading = new Promise<void>((resolve) => { finishRead = resolve; });
  let finishAction: (() => void) | undefined;
  let pendingAction: Promise<void> | undefined;
  const rpc = { call: async (method: string, input: any) => {
    calls.push([method, input]);
    if (method === "helper.read") { await reading; return helper; }
    if (pendingAction) await pendingAction;
    if (method === "helper.threads") return [{ threadId: "thr_other", title: "Other thread" }];
    if (method === "helper.start") return helper = { threadId: input.fresh ? "thr_new" : "thr_first", title: "Helper" };
    if (method === "helper.use") return helper = { threadId: input.threadId, title: "Other thread" };
    throw new Error(method);
  } };
  runtime.useRpc = () => rpc;
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { HelperControl } = await import("../board/HelperControl.js");
  const container = browser.document.getElementById("root")!;
  const root = createRoot(container);
  const button = (name: string) => [...container.querySelectorAll("button")].find((element) => element.textContent?.replace(/The optional agent.*$/, "").trim() === name)!;
  try {
    await act(async () => root.render(createElement(HelperControl, { projectId: "one", openThread: (id: string) => opened.push(id) })));
    const reason = () => container.querySelector('[role="status"]')?.textContent;
    assert.equal(button("Start Helper").disabled, true);
    assert.equal(reason(), "Reading the Helper…");
    await act(async () => finishRead());
    assert.ok(button("Start Helper"));
    await act(async () => button("Start Helper").click());
    assert.deepEqual(opened, ["thr_first"]);
    assert.ok(button("Helper"));
    const menu = () => container.querySelector<HTMLButtonElement>('[aria-label="Helper options"]')!;
    await act(async () => menu().click());
    assert.ok(button("Start new"));
    assert.ok(button("Use another thread…"));
    pendingAction = new Promise<void>((resolve) => { finishAction = resolve; });
    await act(async () => button("Start new").click());
    assert.equal(reason(), "Opening the Helper…");
    for (const control of container.querySelectorAll<HTMLButtonElement>("button")) {
      assert.equal(control.disabled, true);
      const id = control.getAttribute("aria-describedby");
      assert.ok(id && browser.document.getElementById(id)?.textContent === "Opening the Helper…");
    }
    await act(async () => finishAction!());
    pendingAction = undefined;
    assert.ok(calls.some((call) => JSON.stringify(call) === '["helper.start",{"projectId":"one","fresh":true}]'));
    assert.equal(opened.at(-1), "thr_new");
    await act(async () => menu().click());
    await act(async () => button("Use another thread…").click());
    await act(async () => button("Other thread").click());
    assert.equal(opened.at(-1), "thr_other");
    await act(async () => menu().click());
    await act(async () => menu().dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(menu().getAttribute("aria-expanded"), "false");
    assert.equal(browser.document.activeElement, menu());
    helper = null;
    await act(async () => browser.dispatchEvent(new browser.Event("focus")));
    assert.ok(button("Start Helper"), "archived, deleted or missing Helper state restores the start button");
    await act(async () => root.render(createElement(HelperControl, { projectId: null, openThread: (id: string) => opened.push(id) })));
    assert.equal(button("Start Helper").disabled, true);
    assert.equal(reason(), "Choose a project first.");
  } finally {
    await act(async () => root.unmount());
    runtime.useRpc = oldRpc;
    browser.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("switching boards reads and opens only that project's Helper, including a switch during a pending action", async () => {
  await import("./fixtures/app-runtime.js");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const browser = dom.window;
  const globals = { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const threads = new Map(["one", "two"].map((projectId) => [projectId, makeThreadResponse({ id: projectId, projectId, title: projectId })]));
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", sdk: { threads: {
    get: async ({ threadId }) => threads.get(threadId)!, send: async () => ({ ok: true, delivery: "sent" }),
  } } });
  await plugin(bb);
  for (const projectId of ["one", "two"]) await harness.behavior.callRpc("helper.use", { projectId, threadId: projectId });
  const runtime = (globalThis as any).__bbPluginRuntime.pluginSdkApp;
  const oldRpc = runtime.useRpc;
  let finishRead!: () => void;
  let delay: Promise<void> | undefined;
  const rpc = { call: async (method: string, input: any) => {
    if (delay) await delay;
    return harness.behavior.callRpc(method, input);
  } };
  runtime.useRpc = () => rpc;
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { HelperControl } = await import("../board/HelperControl.js");
  const container = browser.document.getElementById("root")!;
  const root = createRoot(container);
  const opened: string[] = [];
  const show = (projectId: string | null) => root.render(createElement(HelperControl, { projectId, openThread: (id: string) => opened.push(id) }));
  const main = () => container.querySelector<HTMLButtonElement>("button")!;
  try {
    await act(async () => show("one"));
    await act(async () => main().click());
    assert.deepEqual(opened, ["one"]);
    delay = new Promise<void>((resolve) => { finishRead = resolve; });
    await act(async () => show("two"));
    assert.equal(main().disabled, true, "the former project's Helper is unavailable while this project loads");
    assert.equal(container.querySelector('[aria-label="Helper options"]'), null);
    await act(async () => finishRead());
    delay = undefined;
    await act(async () => main().click());
    assert.deepEqual(opened, ["one", "two"]);
    delay = new Promise<void>((resolve) => { finishRead = resolve; });
    await act(async () => main().click());
    await act(async () => show("one"));
    await act(async () => finishRead());
    delay = undefined;
    assert.deepEqual(opened, ["one", "two"], "late actions in the previous project never open its Helper on this board");
    await act(async () => main().click());
    assert.equal(opened.at(-1), "one");
    await act(async () => show(null));
    assert.equal(main().disabled, true);
    assert.equal(container.querySelector('[aria-label="Helper options"]'), null);
  } finally {
    await act(async () => root.unmount());
    await harness.lifecycle.dispose();
    runtime.useRpc = oldRpc;
    browser.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
