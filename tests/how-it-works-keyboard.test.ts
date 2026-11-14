import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

test("Escape dismisses a focused or hovered definition before closing How Squadron works", async () => {
  await import("./fixtures/app-runtime.js");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const browser = dom.window;
  const globals = { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);

  // The DOM host has no top layer. Model only the browser's popover API;
  // React and native event capture/bubbling run normally.
  const open = new WeakSet<object>();
  const matches = browser.HTMLElement.prototype.matches;
  Object.assign(browser.HTMLElement.prototype, {
    showPopover(this: object) { open.add(this); },
    hidePopover(this: object) { open.delete(this); },
    matches(this: InstanceType<typeof browser.HTMLElement>, selector: string) {
      return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
    },
  });
  const { createElement, useState, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { HowItWorks } = await import("../board/HowItWorks.js");
  function View() {
    const [shown, setShown] = useState(true);
    return shown ? createElement(HowItWorks, { id: "how", onClose: () => setShown(false) }) : null;
  }
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  try {
    for (const method of ["focus", "hover"] as const) {
      await act(async () => root.render(createElement(View, { key: method })));
      const heading = container.querySelector("h2")!;
      const term = container.querySelector<InstanceType<typeof browser.HTMLElement>>('[data-term="Spec"]')!;
      const tip = term.querySelector('[role="tooltip"]')!;
      assert.equal(browser.document.activeElement, heading, "opening the view focuses its heading");
      await act(async () => {
        if (method === "focus") term.focus();
        else term.dispatchEvent(new browser.Event("pointerenter"));
      });
      assert.ok(open.has(tip), `${method} opens the definition`);
      const target = method === "focus" ? term : heading;
      const escape = () => new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      const first = escape();
      await act(async () => { target.dispatchEvent(first); });
      assert.ok(container.querySelector("#how"), "the first Escape keeps the view open");
      assert.equal(open.has(tip), false, "the first Escape hides the definition");
      assert.equal(first.defaultPrevented, true, "dismissing the definition consumes Escape");
      assert.equal(browser.document.activeElement, target, "dismissing the definition keeps focus in place");
      await act(async () => { target.dispatchEvent(escape()); });
      assert.equal(container.querySelector("#how"), null, "a second Escape closes the view");
    }
  } finally {
    await act(async () => root.unmount());
    browser.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
