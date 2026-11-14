// SQD-204: the "How Squadron works" view, opened from the board header,
// rendered outside BB through the app-runtime stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Board } from "../lib/board-model.js";

const board: Board = { tick: 0, laneCapacity: 0, workersPerLane: 0, autoStart: false, lanes: [], ready: [], shaping: [], openIssues: [] };

async function render(node: unknown): Promise<string> {
  await import("./fixtures/app-runtime.js");
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
}

async function boardHtml(placement: "page" | "panel" = "page") {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { BoardView } = await import("../board/Board.js");
  return render(createElement(BoardView, { board, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined, placement }));
}

test("the board header opens How Squadron works, which starts closed", async () => {
  for (const placement of ["page", "panel"] as const) {
    const html = await boardHtml(placement);
    const header = /<header class="sq-head">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
    const button = /<button[^>]*class="sq-btn sq-how-open"[^>]*>([^<]*)<\/button>/.exec(header);
    assert.ok(button, `the ${placement} header has the How it works button`);
    assert.equal(button[1], "How it works");
    assert.match(button[0], /aria-expanded="false"/);
    assert.ok(!html.includes('aria-label="How Squadron works"'), "the view is not shown until it is opened");
  }
});

async function viewHtml() {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { HowItWorks } = await import("../board/HowItWorks.js");
  return render(createElement(HowItWorks, { id: "how", onClose: () => undefined }));
}

/** Visible text: tags and hover definitions (role="tooltip") stripped. */
const text = (html: string) => html.replace(/<span[^>]*role="tooltip"[^>]*>[^<]*<\/span>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function stops(html: string) {
  return [...html.matchAll(/<li class="sq-how-stop" data-stop="([^"]+)">([\s\S]*?)<\/li>/g)].map(([, stop, body]) => ({
    stop,
    name: text(/<h3[^>]*>([\s\S]*?)<\/h3>/.exec(body!)?.[1] ?? ""),
    who: text(/<p class="sq-how-who">([\s\S]*?)<\/p>/.exec(body!)?.[1] ?? ""),
    you: text(/<p class="sq-how-you">([\s\S]*?)<\/p>/.exec(body!)?.[1] ?? ""),
  }));
}

test("the view shows the path from an idea to a merged pull request, who does each part, and where you step in", async () => {
  const html = await viewHtml();
  assert.match(html, /<section[^>]*id="how"[^>]*aria-label="How Squadron works"/);
  assert.match(html, /<button[^>]*>Close<\/button>/, "the view closes from inside itself");
  assert.deepEqual(stops(html).map(({ stop, name }) => [stop, name]), [
    ["plan", "Plan"], ["spec", "Spec"], ["ready", "Ready"], ["lane", "Lane"], ["landed", "Landed"],
  ]);
  assert.deepEqual(stops(html).map(({ who }) => who), [
    "You and the Helper",
    "The agent splits it into tickets",
    "Squadron shows it once a ticket can start",
    "A Lead and its workers build it",
    "The Lead opens one pull request",
  ]);
  assert.deepEqual(stops(html).filter(({ you }) => you).map(({ stop, you }) => [stop, you]), [
    ["plan", "You plan it"],
    ["lane", "You answer questions"],
    ["landed", "You merge accept:owner work"],
  ], "exactly three step-in points");
});

test("owner words in the view carry their hover definitions, under at most five short lines and no retired term", async () => {
  const { OWNER_WORDS } = await import("../lib/owner-words.js");
  const html = await viewHtml();
  const words = [...html.matchAll(/<span class="sq-term"([^>]*)>([^<]+)<span id="([^"]+)" role="tooltip"[^>]*>([^<]+)<\/span><\/span>/g)]
    .map(([, attrs, shown, tipId, tip]) => ({ attrs: attrs!, shown: shown!, tipId: tipId!, tip }));
  assert.ok(words.length > 0);
  for (const { attrs, shown, tipId } of words) {
    assert.ok(attrs.includes(`aria-describedby="${tipId}"`), `${shown} is described by its own hover text`);
    assert.ok(attrs.includes('tabindex="0"'), `${shown} can be reached by keyboard`);
  }
  const defined = new Map(words.map(({ shown, tip }) => [shown.toLowerCase(), tip]));
  for (const word of ["Spec", "Ready", "Lane", "Landed", "Ticket", "Needs you", "Helper", "Board"] as const) {
    assert.equal(defined.get(word.toLowerCase()), OWNER_WORDS[word], `${word} shows its glossary definition on hover`);
  }
  const owner = new Set(Object.keys(OWNER_WORDS).map((word) => word.toLowerCase()));
  for (const { shown } of words) assert.ok(owner.has(shown.toLowerCase()), `${shown} is an owner word`);

  const lines = [...(/<ul class="sq-how-lines">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "").matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, line]) => text(line!));
  assert.ok(lines.length >= 1 && lines.length <= 5, `one to five lines of text, got ${lines.length}`);
  for (const line of lines) assert.ok(line.length <= 90, `"${line}" is a short line`);
  assert.ok(lines.some((line) => /Needs you/.test(line)), "says where questions and approvals wait");
  assert.ok(lines.some((line) => /without you/.test(line)), "says what runs without the owner");

  for (const retired of [/\bChief\b/i, /\bPlaybook\b/i, /\bFrontier\b/i, /Machine profile/i, /\bepic\b/i, /\bPRD\b/]) {
    assert.doesNotMatch(text(html), retired);
  }
});
