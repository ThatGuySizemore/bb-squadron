import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

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
  const rpc = { call: async (method: string, input: any) => {
    calls.push([method, input]);
    if (method === "helper.read") return helper;
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
    assert.ok(button("Start Helper"));
    await act(async () => button("Start Helper").click());
    assert.deepEqual(opened, ["thr_first"]);
    assert.ok(button("Helper"));
    const menu = () => container.querySelector<HTMLButtonElement>('[aria-label="Helper options"]')!;
    await act(async () => menu().click());
    assert.ok(button("Start new"));
    assert.ok(button("Use another thread…"));
    await act(async () => button("Start new").click());
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
  } finally {
    await act(async () => root.unmount());
    runtime.useRpc = oldRpc;
    browser.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
