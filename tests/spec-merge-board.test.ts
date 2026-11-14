import { test } from "node:test";
import assert from "node:assert/strict";
import type { Board, Lane } from "../lib/board-model.js";

const route = { family: "gpt" as const, model: "gpt-6.1-sol", effort: "high" as const };
const head = "c".repeat(40);
const waiting: Lane = { specId: "FIX-1", title: "Merging spec", lead: route, leadThreadId: "thr_lead", branch: "bb/lead", state: "merge-waits",
  minutes: 3, acceptOwner: true, tickets: [], pr: { number: 12, checks: "passing", url: "https://github.com/fixture/repo/pull/12" }, mergeCommit: head };
const board = (lanes: Lane[]): Board => ({ tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, unplanned: [], ready: [], lanes });

test("the owner's Merge sends the exact PR and head the board shows, then reads the board back even after a refusal", async () => {
  await import("./fixtures/app-runtime.js");
  const { mergeFromBoard } = await import("../board/Board.js");
  const calls: unknown[] = [];
  const deps = { call: async (input: unknown) => { calls.push(input); return { state: "flying" as const }; },
    refresh: async () => { calls.push("refresh"); }, notify: (text: string) => { calls.push(text); } };
  await mergeFromBoard(deps, "proj-one", waiting);
  assert.deepEqual(calls, [{ projectId: "proj-one", specId: "FIX-1", number: 12, commit: head },
    "Merge approved for PR #12 at cccccccc. The Lead squash-merges that exact commit.", "refresh"]);
  calls.length = 0;
  await mergeFromBoard({ ...deps, call: async () => { throw new Error("The PR changed since the board showed it. Nothing was approved; refresh the board."); } }, "proj-one", waiting);
  assert.deepEqual(calls, ["The PR changed since the board showed it. Nothing was approved; refresh the board.", "refresh"]);
  calls.length = 0;
  // Without an exact context there is nothing to approve, and nothing is sent.
  await mergeFromBoard(deps, "proj-one", { ...waiting, state: "pr-open", mergeCommit: undefined });
  assert.deepEqual(calls, ["This merge isn't waiting on you. Refresh the board.", "refresh"]);
});

test("the live board shows the Merge action, PR note and every checks state in words", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const render = (lanes: Lane[], controlling: { specId: string; action: "merge" } | null = null) => renderToStaticMarkup(createElement(BoardView, {
    board: board(lanes), demo: false, modeSwitch: null, onPlan: () => undefined, dispatch: () => undefined, controlling }));
  const html = render([waiting]);
  assert.match(html, /<button[^>]*data-tone="amber"[^>]*>Merge<\/button>/);
  assert.match(html, /checks pass/);
  const pending = render([waiting], { specId: "FIX-1", action: "merge" });
  assert.match(pending, /<button[^>]*disabled=""[^>]*>Approving…<\/button>/);
  assert.match(pending, /Approving the merge for FIX-1/);
  const noted = render([{ ...waiting, state: "pr-open", mergeCommit: undefined, pr: { ...waiting.pr!, checks: "none" },
    prNote: "PR #12 reports no checks. Squadron merges only after checks pass." }]);
  assert.match(noted, /no checks/);
  assert.match(noted, /PR #12 reports no checks\. Squadron merges only after checks pass\./);
  assert.doesNotMatch(noted, />Merge<\/button>/);
  assert.match(render([{ ...waiting, state: "pr-open", mergeCommit: undefined, pr: { ...waiting.pr!, checks: "unknown" } }]), /checks unknown/);
});

test("each landing plays once: recent and unseen only, with a still pixel fallback under reduced motion", async () => {
  await import("./fixtures/app-runtime.js");
  const { freshLandings, BoardView } = await import("../board/Board.js");
  const now = 1_000_000;
  const landed = (specId: string, landedAt?: number): Lane => ({ ...waiting, specId, state: "landed", mergeCommit: undefined, ...(landedAt !== undefined ? { landedAt } : {}) });
  assert.deepEqual(freshLandings([landed("FIX-1", now - 2_000), landed("FIX-2", now - 3_600_000), landed("FIX-3"), waiting], new Set(), now), ["FIX-1:998000"]);
  assert.deepEqual(freshLandings([landed("FIX-1", now - 2_000)], new Set(["FIX-1:998000"]), now), []);
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const view = () => renderToStaticMarkup(createElement(BoardView, { board: board([landed("FIX-1", Date.now() - 500)]), demo: false, modeSwitch: null,
    onPlan: () => undefined, dispatch: () => undefined }));
  const moving = view();
  assert.match(moving, /class="sq-burst"/);
  assert.doesNotMatch(moving, /data-still/);
  assert.match(moving, /FIX-1 landed/);
  const win = (globalThis as unknown as { window: { matchMedia: () => unknown } }).window;
  const original = win.matchMedia;
  win.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  try {
    const still = view();
    assert.match(still, /class="sq-burst" data-still="true"/);
    assert.match(still, /FIX-1 landed/);
  } finally { win.matchMedia = original; }
});
