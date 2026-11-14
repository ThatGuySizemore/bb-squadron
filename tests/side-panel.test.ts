// SIZE-959: Squadron in a thread's side panel. The tab's registration, its
// narrow layout, the thread's project and where its thread links open, checked
// outside BB through the app-runtime stand-in. The real side panel is an
// experimental BB API and is checked by hand (see the PR's Not proven).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Board, Lane, Route, Ticket } from "../lib/board-model.js";
import { elements, parse, visibleText } from "./fixtures/owner-text.js";

const route: Route = { family: "claude", model: "claude-opus-5-5", effort: "high" };
const ticket = (id: string, state: Ticket["state"], extra: Partial<Ticket> = {}): Ticket =>
  ({ id, title: `Ticket ${id}`, blockedBy: [], route, state, minutes: 0, ...extra });
const lane: Lane = {
  specId: "FIX-1", title: "A flying spec", lead: route, leadThreadId: "thr_lead", branch: "fix-1", state: "flying",
  minutes: 12, acceptOwner: false,
  tickets: [
    ticket("FIX-2", "done"), ticket("FIX-3", "working", { threadId: "thr_worker3", minutes: 4 }),
    ticket("FIX-4", "question", { threadId: "thr_worker4" }), ticket("FIX-5", "blocked", { blockedBy: ["FIX-3"] }),
  ],
};
const board: Board = { tick: 0, laneCapacity: 1, workersPerLane: 2, autoStart: false, lanes: [lane], ready: [], shaping: [], openIssues: [] };

async function render(node: unknown): Promise<string> {
  await import("./fixtures/app-runtime.js");
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
}

type Registration = { id: string; [key: string]: unknown };

async function registrations() {
  await import("./fixtures/app-runtime.js");
  const app = (await import("../app.js")).default as unknown as { setup: (app: unknown) => void };
  const slots: Record<string, Registration[]> = {};
  const collect = (name: string) => (registration: Registration) => { (slots[name] ??= []).push(registration); };
  app.setup({ slots: new Proxy({}, { get: (_, name: string) => collect(name) }) });
  return slots;
}

test("Squadron registers a thread side-panel tab alongside its full-page nav panel", async () => {
  const slots = await registrations();
  assert.deepEqual(slots.navPanel?.map(({ id, path, title }) => ({ id, path, title })), [{ id: "board", path: "board", title: "Squadron" }],
    "the full-page board keeps its route");
  assert.equal(slots.experimental_tab?.length, 1);
  const tab = slots.experimental_tab![0]!;
  assert.deepEqual({ id: tab.id, title: tab.title, icon: tab.icon, context: tab.context, availability: tab.availability, layout: tab.layout },
    { id: "board", title: "Squadron", icon: "Plane", context: { kind: "thread" }, availability: "action", layout: "flush" });
  assert.equal(typeof tab.component, "function");
  assert.notEqual(tab.component, slots.navPanel![0]!.component, "the tab renders the side-panel board, not the full page");
});

test("in the side panel a flying lane shows its active pegs and an All N tickets disclosure with its in-branch count", async () => {
  const { createElement } = await import("react");
  const { BoardView } = await import("../board/Board.js");
  const props = { board, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined };
  const panel = await render(createElement(BoardView, { ...props, placement: "panel" }));
  assert.match(panel, /class="sq"[^>]*data-layout="narrow"/);
  const active = /<div class="sq-active">([\s\S]*?)<\/div><details/.exec(panel)?.[1] ?? "";
  assert.deepEqual([...active.matchAll(/class="sq-peg-id">([^<]+)</g)].map((m) => m[1]), ["FIX-3", "FIX-4"],
    "only tickets an agent is on, or that need the owner, are pegs");
  const all = /<details class="sq-all"><summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/.exec(panel);
  assert.equal(all && visibleText(parse(all[1])), "All 4 tickets · 1 in branch", "the in-branch count moves from the progress strip into the summary");
  assert.deepEqual([...(all?.[2] ?? "").matchAll(/<li data-state="([^"]+)"><span class="sq-id">([^<]+)<\/span><span>([^<]+)<\/span><span data-st="[^"]+">(?:<span[^>]*data-term="[^"]+"[^>]*>)?([^<]+)</g)]
    .map((m) => m.slice(1)), [
    ["done", "FIX-2", "Ticket FIX-2", "Done"], ["working", "FIX-3", "Ticket FIX-3", "Working"],
    ["question", "FIX-4", "Ticket FIX-4", "Needs you"], ["blocked", "FIX-5", "Ticket FIX-5", "Waiting"],
  ]);
  assert.ok(!panel.includes("sq-rail"), "no dependency rail at side-panel width");
  assert.ok(!panel.includes("sq-progress"), "the compact lane row replaces the progress strip");
  const single = await render(createElement(BoardView, { ...props, placement: "panel",
    board: { ...board, lanes: [{ ...lane, tickets: [ticket("FIX-2", "working")] }] } }));
  assert.ok(elements(parse(single)).some((element) => element.tag === "summary" && visibleText(element) === "1 ticket · 0 in branch"));

  const page = await render(createElement(BoardView, props));
  assert.match(page, /class="sq"[^>]*data-layout="wide"/);
  assert.ok(page.includes("sq-rail") && !page.includes("sq-all"), "the full page keeps the dependency rail");
});

test("a thread link opens beside the board on the full page, and in the main view from the side panel", async () => {
  await import("./fixtures/app-runtime.js");
  const { openThread } = await import("../board/Board.js");
  const calls: unknown[] = [];
  const navigate = { toThread: (threadId: string, options?: { split?: boolean }) => { calls.push([threadId, options]); } };
  openThread(navigate, "page", "thr_a");
  openThread(navigate, "panel", "thr_b");
  assert.deepEqual(calls, [["thr_a", { split: true }], ["thr_b", undefined]]);
});

test("the side panel opens on the thread's project, read through BB's thread API", async () => {
  await import("./fixtures/app-runtime.js");
  const { threadProject } = await import("../board/SidePanel.js");
  const asked: string[] = [];
  const sdk = (projectId: string | null) => ({ threads: { get: async ({ threadId }: { threadId: string }) => { asked.push(threadId); return { id: threadId, projectId }; } } });
  assert.equal(await threadProject(sdk("proj-thread"), "thr_here"), "proj-thread");
  assert.deepEqual(asked, ["thr_here"]);
  assert.equal(await threadProject(sdk(null), "thr_loose"), null, "a projectless thread falls back to the picker's order");
  assert.equal(await threadProject({ threads: { get: async () => { throw new Error("gone"); } } }, "thr_gone"), null,
    "an unreadable thread falls back too");
});

test("both layouts show a muted current step on active pegs, an empty fallback and the Lead's activity", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { BoardView } = await import("../board/Board.js");
  const live: Board = { ...board, lanes: [{ ...lane,
    liveStep: { status: "active", step: "Waiting on worker", since: 123 },
    tickets: lane.tickets.map((item) => item.id === "FIX-3" ? { ...item,
      liveStep: { status: "error", step: "Running npm test", since: 456 } } : item),
  }] };
  for (const placement of ["page", "panel"] as const) {
    const html = await render(createElement(BoardView, { board: live, demo: false, modeSwitch: null,
      dispatch: () => undefined, onPlan: () => undefined, placement }));
    const all = elements(parse(html));
    const steps = all.filter((element) => element.attrs.class?.split(" ").includes("sq-live-step"));
    assert.equal(steps.length, 3);
    assert.ok(steps.some((element) => visibleText(element).includes("Waiting on worker")));
    assert.ok(steps.some((element) => visibleText(element).includes("Error") && visibleText(element).includes("Running npm test")));
    assert.ok(steps.some((element) => visibleText(element) === "No recent activity"));
  }
});
