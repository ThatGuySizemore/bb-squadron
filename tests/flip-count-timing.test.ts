import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

test("the animated digit faces receive the 90ms place delays and 460ms duration", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { FlipCount } = await import("../board/FlipCount.js");
  const css = readFileSync("board/board.css", "utf8");
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id='root'></div></body></html>");
  const browser = dom.window;
  const globals = { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  // Parse the real face rule rather than treating a delay on a parent as proof.
  const faceRule = css.match(/\.sq-flip-digit\[data-flip="true"\] > \*\s*\{([^}]+)\}/)?.[1];
  assert.ok(faceRule, "the stylesheet declares the animation on each changed face");
  const style = browser.document.createElement("style");
  style.textContent = `.sq-flip-digit[data-flip="true"] > * {${faceRule}}`;
  browser.document.head.append(style);
  const root = createRoot(browser.document.getElementById("root")!);
  const show = (value: number) => act(async () => root.render(createElement(FlipCount, { value, digit: (d: string) => createElement("span", { className: "face" }, d) })));
  try {
    await show(99);
    await show(100);
    const rule = style.sheet!.cssRules[0] as CSSStyleRule;
    const faces = [...browser.document.querySelectorAll<HTMLElement>(rule.selectorText)];
    assert.equal(faces.length, 3, "the animation selector targets all three changed faces");
    assert.equal(rule.style.getPropertyValue("animation-duration"), "460ms", "460ms belongs to the face animation");
    const delays = faces.map((face) => {
      const declared = rule.style.getPropertyValue("animation-delay").trim();
      return declared === "inherit" ? face.parentElement!.style.animationDelay : browser.getComputedStyle(face).animationDelay;
    });
    assert.deepEqual(delays, ["180ms", "90ms", "0ms"], "the animated faces stagger from units upward, not just their outer windows");
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, "reduced-motion override remains");
  } finally {
    await act(async () => root.unmount());
    browser.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
