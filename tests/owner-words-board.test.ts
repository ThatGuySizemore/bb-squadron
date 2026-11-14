// SQD-202: the board teaches its own words. Every owner word it shows as a
// label carries its one-line definition for hover and keyboard focus, and
// nothing the owner reads on the board or in Doctor uses a retired word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Board, Lane, Route, Ticket } from "../lib/board-model.js";
import { doctor, type ConfigurationFile } from "../lib/doctor.js";
import { OWNER_WORDS } from "../lib/owner-words.js";
import { elements, parse, readable, retiredTerms, texts, textOf, type Element } from "./fixtures/owner-text.js";

const route: Route = { family: "claude", model: "claude-opus-5-5", effort: "high" };
const ticket = (id: string, state: Ticket["state"], extra: Partial<Ticket> = {}): Ticket =>
  ({ id, title: `Piece ${id}`, blockedBy: [], route, state, minutes: 3, ...extra });
const lane = (specId: string, state: Lane["state"], tickets: Ticket[], extra: Partial<Lane> = {}): Lane => ({
  specId, title: `Feature ${specId}`, lead: route, leadThreadId: `thr_${specId}`, branch: specId.toLowerCase(), state,
  minutes: 30, acceptOwner: false, tickets, ...extra,
});
const files: ConfigurationFile[] = [
  { id: "repo-rules", name: "Repo rules", path: "/repo/AGENTS.md", hostId: "host", exists: true },
  { id: "project-settings", name: "Project settings", path: "/repo/docs/agents/squadron.md", hostId: "host", exists: true },
  { id: "playbook", name: "House rules", path: "/owner/.bb-squadron/house-rules.md", hostId: "host", exists: true },
  { id: "machine-profile", name: "This machine", path: "/owner/.bb-squadron/machine.md", hostId: "host", exists: false },
];
const report = doctor({
  skills: {}, setupFiles: [], settingsMarkdown: readFileSync("tests/fixtures/squadron.md", "utf8"), issueTrackerMarkdown: null,
  linearConnected: false, ghAuthenticated: false, configurationFiles: files,
});
// Every section, lane state and ticket state the board can show at once.
const board: Board = {
  doctor: report, tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false,
  lanes: [
    lane("FIX-1", "flying", [
      ticket("FIX-2", "done"), ticket("FIX-3", "branch"), ticket("FIX-4", "working", { threadId: "thr_4" }),
      ticket("FIX-5", "question", { threadId: "thr_5", question: "Which colour?" }), ticket("FIX-6", "review", { threadId: "thr_6" }),
      ticket("FIX-7", "ready"), ticket("FIX-8", "held"), ticket("FIX-9", "blocked", { blockedBy: ["FIX-4"] }),
      ticket("FIX-10", "failed", { threadId: "thr_10" }), ticket("FIX-11", "question"),
    ], { pr: { number: 7, checks: "pending", url: "https://example.test/pr/7" } }),
    lane("FIX-20", "stopped", [ticket("FIX-21", "ready")], { stopReason: "The Lead stopped." }),
    lane("FIX-30", "merge-waits", [ticket("FIX-31", "done")], { acceptOwner: true, pr: { number: 8, checks: "passing", url: "https://example.test/pr/8" } }),
    lane("FIX-40", "landed", [ticket("FIX-41", "done")], { landedAt: 1 }),
  ],
  ready: [{ id: "FIX-50", title: "Feature FIX-50", ticketCount: 3, routes: [route], blockedBy: [], acceptOwner: true,
    waiting: [{ id: "FIX-51", title: "Piece FIX-51", blockedBy: ["FIX-52"] }], held: [{ id: "FIX-53", title: "Piece FIX-53" }] }],
  shaping: [{ id: "FIX-60", title: "Feature FIX-60", ticketCount: 0, missing: "No tickets yet", action: "tickets" }],
  openIssues: [{ id: "FIX-70", title: "Loose idea", labels: ["ui"] }],
  tracker: { kind: "linear", state: "current", message: "Up to date", syncedAt: 1, project: "Fixture project" },
};

async function render(placement: "page" | "panel"): Promise<string> {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const { DoctorChecks } = await import("../board/Doctor.js");
  const props = { board, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined, placement };
  return renderToStaticMarkup(createElement("div", null, createElement(BoardView, props), createElement(DoctorChecks, { report })));
}

const INTERACTIVE = new Set(["button", "a", "summary"]);
function closest(node: Element | null, match: (element: Element) => boolean): Element | null {
  for (; node; node = node.parent) if (match(node)) return node;
  return null;
}

function ownerWordsInLabel(text: string) {
  return (Object.keys(OWNER_WORDS) as (keyof typeof OWNER_WORDS)[])
    .filter((word) => new RegExp(`\\b${word}s?\\b`, "i").test(text));
}

function assertDefinitions(root: Element, placement: string) {
  const shown = new Set<string>();
  for (const text of texts(root)) {
    if (closest(text.parent, (element) => element.attrs.role === "tooltip")) continue;
    const label = text.text.trim();
    const words = Object.hasOwn(OWNER_WORDS, label) || closest(text.parent, (element) => INTERACTIVE.has(element.tag))
      ? ownerWordsInLabel(label) : [];
    for (const word of words) {
      shown.add(word);
      const term = closest(text.parent, (element) => "data-term" in element.attrs);
      assert.ok(term, `${placement}: "${word}" is shown with no definition`);
      assert.equal(term.attrs["data-term"], word, `${placement}: "${word}" sits in its own term`);
      const tip = elements(term).find((element) => element.attrs.role === "tooltip");
      assert.equal(tip && textOf(tip), OWNER_WORDS[word as keyof typeof OWNER_WORDS], `${placement}: "${word}" shows the glossary's definition`);
      // Focus reaches the definition: the term is focusable and described by it, or it sits inside a control that is.
      const control = closest(term.parent, (element) => INTERACTIVE.has(element.tag));
      if (control) assert.ok(!("tabindex" in term.attrs), `${placement}: "${word}" inside a control adds no second tab stop`);
      else {
        assert.equal(term.attrs.tabindex, "0", `${placement}: "${word}" takes keyboard focus`);
        assert.equal(term.attrs["aria-describedby"], tip!.attrs.id, `${placement}: "${word}" is described by its definition`);
      }
    }
  }
  return shown;
}

test("every owner word the board shows as a label carries its definition for hover and focus", async () => {
  for (const placement of ["page", "panel"] as const) {
    const root = parse(await render(placement));
    const shown = assertDefinitions(root, placement);
    // The fixture shows these words as labels, so the check above really ran on them.
    for (const word of ["Needs you", "Flying", "Ready", "Shaping", "Landed", "Held", "House rules"]) {
      assert.ok(shown.has(word), `${placement}: the fixture shows ${word}`);
    }
  }
});

test("owner-word label coverage rejects longer, lowercase and plural labels without definitions", () => {
  for (const [label, expected] of [["New spec", "Spec"], ["Plan tickets", "Ticket"], ["2 held", "Held"], ["ready", "Ready"]]) {
    assert.deepEqual(ownerWordsInLabel(label), [expected], label);
    assert.throws(() => assertDefinitions(parse(`<button>${label}</button>`), "fixture"), /shown with no definition/, label);
  }
  assert.deepEqual(ownerWordsInLabel("Already ticketed"), [], "only whole words are terms");
});

test("nothing the owner reads on the board or in Doctor uses a retired word", async () => {
  for (const placement of ["page", "panel"] as const) {
    const found = readable(await render(placement)).flatMap((text) => retiredTerms(text).map((term) => `${term} in "${text.trim()}"`));
    assert.deepEqual(found, [], `${placement}: retired words on the board`);
  }
});

test("the retired-word check catches every retired word and spares file names", () => {
  for (const text of ["The frontier moved", "Each lane state", "Add the Status mapping section", "Machine profile", "Playbook is present.", "Ask the Chief"]) {
    assert.equal(retiredTerms(text).length, 1, text);
  }
  assert.deepEqual(retiredTerms("Rename playbook.md to house-rules.md"), []);
});
