import { test } from "node:test";
import assert from "node:assert/strict";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { deriveBoard } from "../lib/board-derive.js";
import type { LeadThread } from "../lib/lead-threads.js";
import { readFileSync } from "node:fs";
import { parseSquadronSettings } from "../lib/squadron-settings.js";
import { blocks, input, issue, snapshot, SYNCED_AT } from "./fixtures/board-snapshots.js";

const LEAD_ROUTE = { family: "claude" as const, model: "claude-opus-5-5", effort: "high" as const };

function lead(children: { id: string; title: string; createdAt?: number }[] = []): LeadThread {
  return {
    specId: "fix-1", route: LEAD_ROUTE, branch: "spec/fix-1",
    thread: makeThreadResponse({ id: "thr_lead", projectId: "proj-one", providerId: "claude-code",
      environmentId: "env_lead", status: "active", createdAt: SYNCED_AT - 30 * 60_000 }),
    workers: children.map(({ id, title, createdAt }) => makeThreadResponse({ id, title, projectId: "proj-one",
      parentThreadId: "thr_lead", status: "idle", createdAt: createdAt ?? SYNCED_AT - 10 * 60_000 })),
  };
}

const laneIssues = () => [
  issue("FIX-1", { title: "Lane spec", labels: ["ready-for-agent"] }),
  issue("FIX-2", { title: "First slice", parent: "FIX-1" }),
  issue("FIX-3", { title: "Second slice", parent: "FIX-1", labels: ["ui"] }),
  issue("FIX-12", { title: "Third slice", parent: "FIX-1" }),
];

test("a worker child whose title holds a ticket identifier links its card, and an unmatched child still shows", () => {
  const { board } = deriveBoard(input(snapshot(laneIssues()), { leads: [lead([
    { id: "thr_w2", title: "Worker FIX-2" },
    { id: "thr_w12", title: "Worker FIX-12: third slice" },
    { id: "thr_rev", title: "Reviewer for FIX-1 branch" },
    { id: "thr_misc", title: "Scratch notes" },
  ])] }));
  const lane = board.lanes[0];
  assert.deepEqual(lane.tickets.map((t) => [t.id, t.threadId]), [
    ["FIX-2", "thr_w2"], ["FIX-3", undefined], ["FIX-12", "thr_w12"],
  ], "FIX-1 never matches FIX-12, and the spec identifier is not a ticket");
  assert.deepEqual(lane.unmatchedThreads, [
    { threadId: "thr_rev", title: "Reviewer for FIX-1 branch" },
    { threadId: "thr_misc", title: "Scratch notes" },
  ]);
  assert.equal(lane.tickets[0].minutes, 10, "a linked card shows its worker's time");
  assert.deepEqual(lane.tickets[1].route, LEAD_ROUTE, "a ui ticket takes the ui route from settings");
});

function withStatus(base: ReturnType<typeof issue>, name: string, type = "started") {
  return { ...base, state: { id: `state-${name}`, name, type }, inProject: type !== "completed" && type !== "canceled" };
}

const ticketStates = (board: ReturnType<typeof deriveBoard>["board"]) =>
  board.lanes[0].tickets.map((t) => [t.id, t.state]);

test("ticket states read Linear through the default status mapping", () => {
  const [spec, two, three, twelve] = laneIssues();
  const { board } = deriveBoard(input(snapshot([
    spec, withStatus(two, "In Progress"), withStatus(three, "In Review"), withStatus(twelve, "Done", "completed"),
    withStatus(issue("FIX-13", { parent: "FIX-1" }), "Backlog", "backlog"),
    withStatus(issue("FIX-14", { parent: "FIX-1" }), "Canceled", "canceled"),
  ]), { leads: [lead()] }));
  assert.deepEqual(ticketStates(board), [
    ["FIX-2", "working"], ["FIX-3", "branch"], ["FIX-12", "done"], ["FIX-13", "blocked"],
  ], "Todo-like statuses wait, and cancelled tickets leave the lane");
});

test("ticket states follow a custom status mapping", () => {
  const custom = parseSquadronSettings(readFileSync("tests/fixtures/squadron.md", "utf8").replace(/## Status mapping[\s\S]*$/, [
    "## Status mapping", "", "| State | Linear status |", "|---|---|",
    "| Ready | Todo |", "| Flying | Building |", "| In review | Waiting to Merge |", "| Landed | Shipped |",
    "| Waiting | Todo |", "| Working | Building |", "| In branch | Waiting to Merge |", "| Done | Shipped |", "",
  ].join("\n")));
  assert.ok(custom.ok);
  const [spec, two, three, twelve] = laneIssues();
  const { board } = deriveBoard(input(snapshot([
    spec, withStatus(two, "Building"), withStatus(three, "Waiting to Merge"), withStatus(twelve, "In Review"),
    withStatus(issue("FIX-13", { parent: "FIX-1" }), "Shipped", "completed"),
  ]), { leads: [lead()], settings: custom }));
  assert.deepEqual(ticketStates(board), [
    ["FIX-2", "working"], ["FIX-3", "branch"], ["FIX-12", "blocked"], ["FIX-13", "done"],
  ], "an unmapped status such as In Review waits");
});

function pr(state: "draft" | "open" | "merged" | "closed", checks: "passing" | "failing" | "pending" | "no_checks" | "unknown" = "passing") {
  return { outcome: "available" as const, pullRequest: {
    number: 42, title: "Lane spec", state, url: "https://github.com/fixture/repo/pull/42",
    baseRefName: "main", headRefName: "spec/fix-1", updatedAt: "2026-11-13T19:50:00Z", autoMerge: false, inMergeQueue: null,
    checks: { state: checks, totalCount: 3, passedCount: 2, failedCount: checks === "failing" ? 1 : 0, pendingCount: 0 },
    review: { state: "none", reviewRequestCount: 0 },
    mergeability: { state: "mergeable", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" }, attention: "none",
  } };
}

test("a lane is Flying with no PR, In review while its PR is open, and Landed when the PR merges", () => {
  const lanes = (pullRequests?: Record<string, unknown>) =>
    deriveBoard(input(snapshot(laneIssues()), { leads: [lead()], pullRequests })).board.lanes[0];
  const none = lanes();
  assert.equal(none.state, "flying");
  assert.equal(none.pr, undefined);
  assert.equal(lanes({ env_lead: { outcome: "absent" } }).state, "flying");
  assert.equal(lanes({ env_lead: { outcome: "unavailable", message: "Machine offline" } }).state, "flying");

  const draft = lanes({ env_lead: pr("draft", "pending") });
  assert.equal(draft.state, "flying", "a draft PR is not yet in review");
  assert.deepEqual(draft.pr, { number: 42, state: "draft", checks: "pending", url: "https://github.com/fixture/repo/pull/42" });

  const open = lanes({ env_lead: pr("open", "failing") });
  assert.equal(open.state, "pr-open");
  assert.deepEqual(open.pr, { number: 42, state: "open", checks: "failing", url: "https://github.com/fixture/repo/pull/42" });
  assert.equal(lanes({ env_lead: pr("open", "no_checks") }).pr?.checks, "none");

  const merged = lanes({ env_lead: pr("merged") });
  assert.equal(merged.state, "landed");
  assert.equal(merged.landedAt, Date.parse("2026-11-13T19:50:00Z"));
  assert.equal(merged.minutes, 20, "a landed lane's time stops at the merge");
  assert.equal(merged.url, "https://linear.app/fixture/issue/FIX-1");

  assert.equal(lanes({ other_env: pr("merged") }).state, "flying", "PRs are keyed by the Lead's environment");
});

test("a lane's tickets come in dependency order", () => {
  const { board } = deriveBoard(input(snapshot(laneIssues(), [blocks("FIX-12", "FIX-2"), blocks("FIX-3", "FIX-12")]),
    { leads: [lead()] }));
  assert.deepEqual(board.lanes[0].tickets.map((t) => [t.id, t.blockedBy]), [
    ["FIX-3", []], ["FIX-12", ["FIX-3"]], ["FIX-2", ["FIX-12"]],
  ]);
});

test("the same Linear snapshot, threads and PRs give the same board after a restart", () => {
  const make = () => input(snapshot(laneIssues(), [blocks("FIX-2", "FIX-3")]), {
    leads: [lead([{ id: "thr_w2", title: "Worker FIX-2" }, { id: "thr_misc", title: "Notes" }])],
    pullRequests: { env_lead: pr("open", "pending") },
  });
  assert.deepEqual(deriveBoard(make()).board, deriveBoard(structuredClone(make())).board);
});

test("the lane's reviewer comes from the final-review family in project settings", () => {
  const other = deriveBoard(input(snapshot(laneIssues()), { leads: [lead()] })).board.lanes[0];
  assert.deepEqual(other.reviewer, { family: "gpt", model: "gpt-6.1-sol", effort: "high" }, "the default row, not the data row");
  const same = parseSquadronSettings(readFileSync("tests/fixtures/squadron.md", "utf8").replace(/## Final review\s+other/, "## Final review\n\nsame"));
  assert.ok(same.ok);
  assert.deepEqual(deriveBoard(input(snapshot(laneIssues()), { leads: [lead()], settings: same })).board.lanes[0].reviewer, LEAD_ROUTE);
});

test("the lane row links the Lead, the spec and the PR, labels In review, and lists unmatched threads", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const derived = deriveBoard(input(snapshot(laneIssues(), [blocks("FIX-2", "FIX-3")]), {
    leads: [lead([{ id: "thr_w2", title: "Worker FIX-2" }, { id: "thr_misc", title: "Scratch notes" }])],
    pullRequests: { env_lead: pr("open", "no_checks") },
  })).board;
  const html = renderToStaticMarkup(createElement(BoardView, {
    board: derived, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined,
  }));
  assert.match(html, /class="sq-lane-state" data-lane="pr-open">In review</);
  assert.match(html, /<button[^>]*title="Open the spec in Linear"[^>]*>Lane spec<\/button>/);
  assert.match(html, /aria-label="PR #42, no checks. Open on GitHub."/);
  assert.match(html, /<span class="sq-threads-label">Other threads<\/span>.*Scratch notes<\/button>/s);
  assert.match(html, /aria-label="FIX-2, First slice: Waiting\. Open thread\."/);
  assert.match(html, /after FIX-2/, "a waiting ticket names its open blocker");
  assert.doesNotMatch(html, /after blockers/, "a waiting ticket with no blocker gets no empty after-line");
});

test("an open or merged PR outranks a quiet Lead, which otherwise reads as stopped", () => {
  const quiet = { ...lead(), thread: { ...lead().thread, status: "idle" as const } };
  const state = (pullRequests?: Record<string, unknown>) =>
    deriveBoard(input(snapshot(laneIssues()), { leads: [quiet], pullRequests })).board.lanes[0].state;
  assert.equal(state(), "stopped");
  assert.equal(state({ env_lead: pr("open") }), "pr-open");
  assert.equal(state({ env_lead: pr("merged") }), "landed");
});

test("Merge shows only for an open PR with passing checks, and an accept:owner PR ready to merge is in Needs you", async () => {
  const { canMerge, needsYou } = await import("../lib/board-model.js");
  const board = (pullRequests: Record<string, unknown>, specLabels = ["ready-for-agent"]) => {
    const [spec, ...tickets] = laneIssues();
    return deriveBoard(input(snapshot([{ ...spec, labels: specLabels.map((name) => ({ id: `label-${name}`, name, color: "#888888" })) }, ...tickets]),
      { leads: [lead()], pullRequests })).board;
  };
  const mergeable = (pullRequests: Record<string, unknown>) => canMerge(board(pullRequests).lanes[0]);
  assert.equal(mergeable({}), false, "no PR, no Merge");
  assert.equal(mergeable({ env_lead: pr("draft", "passing") }), false);
  for (const checks of ["failing", "pending", "no_checks", "unknown"] as const) {
    assert.equal(mergeable({ env_lead: pr("open", checks) }), false, `open with ${checks} checks`);
  }
  assert.equal(mergeable({ env_lead: pr("merged") }), false);
  assert.equal(mergeable({ env_lead: pr("closed") }), false);
  assert.equal(mergeable({ env_lead: pr("open", "passing") }), true);

  const owner = board({ env_lead: pr("open", "passing") }, ["ready-for-agent", "accept:owner"]);
  assert.equal(owner.lanes[0].state, "merge-waits");
  assert.deepEqual(needsYou(owner).map(({ kind, specId, threadId }) => [kind, specId, threadId]), [["merge", "FIX-1", "thr_lead"]]);
  assert.doesNotMatch(needsYou(owner)[0].text, /both reviews/, "the slim lane has one final review");

  const pending = board({ env_lead: pr("open", "pending") }, ["ready-for-agent", "accept:owner"]);
  assert.equal(pending.lanes[0].state, "pr-open", "accept:owner waits for checks before it needs you");
  assert.deepEqual(needsYou(pending), []);
  assert.deepEqual(needsYou(board({ env_lead: pr("open", "passing") })), [], "the Lead merges its own lane without accept:owner");
});

test("the lane row shows Merge for an open PR with passing checks and not otherwise", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const html = (checks: "passing" | "pending") => renderToStaticMarkup(createElement(BoardView, {
    board: deriveBoard(input(snapshot(laneIssues()), { leads: [lead()], pullRequests: { env_lead: pr("open", checks) } })).board,
    demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined,
  }));
  assert.match(html("passing"), /<article class="sq-line"[\s\S]*>Merge<\/button>/);
  assert.doesNotMatch(html("pending"), />Merge<\/button>/);
  const merging = renderToStaticMarkup(createElement(BoardView, {
    board: deriveBoard(input(snapshot(laneIssues()), { leads: [lead()], pullRequests: { env_lead: pr("open", "passing") } })).board,
    demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined, acting: { specId: "FIX-1", type: "merge" },
  }));
  assert.match(merging, /role="status">Squash-merging the PR/);
  assert.match(merging, /<button[^>]*disabled=""[^>]*>Merging…<\/button>/);
});

test("the landing animation plays once, when the board sees a lane turn Landed", async () => {
  const { LANDING_MS, nextLandings } = await import("../lib/board-model.js");
  const landedBoard = deriveBoard(input(snapshot(laneIssues()), { leads: [lead()], pullRequests: { env_lead: pr("merged") } })).board;
  const flyingBoard = deriveBoard(input(snapshot(laneIssues()), { leads: [lead()], pullRequests: { env_lead: pr("open") } })).board;
  const at = SYNCED_AT + 5 * 60_000;

  const reopened = nextLandings(null, landedBoard.lanes, at);
  assert.deepEqual(reopened.until, {}, "a lane already Landed when the board opens doesn't replay its landing");

  const watching = nextLandings(null, flyingBoard.lanes, at);
  const landing = nextLandings(watching, landedBoard.lanes, at + 1_000);
  assert.deepEqual(landing.until, { "FIX-1": at + 1_000 + LANDING_MS }, "the landing plays when the PR's merge is seen");
  const later = nextLandings(landing, structuredClone(landedBoard.lanes), at + 1_000 + LANDING_MS + 1);
  assert.deepEqual(later.until, {}, "the next board read after the window plays nothing more");
  assert.deepEqual(nextLandings(later, landedBoard.lanes, at + 60_000).until, {}, "it never plays again");
});

test("a landing is a still state under reduced motion", async () => {
  const css = readFileSync("board/board.css", "utf8");
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.match(reduced, /\.sq \*,[\s\S]*?animation: none !important;/, "the stamp and every other animation stop");
  assert.match(reduced, /\.sq-burst \{\s*display: none;/, "the burst's pixels never show");
});

test("a spec the Lead closed after its merge stays a Landed lane with its done tickets", () => {
  const [spec, two, three, twelve] = laneIssues();
  const { board } = deriveBoard(input(snapshot([
    withStatus(spec, "Done", "completed"), withStatus(two, "Done", "completed"), withStatus(three, "Done", "completed"),
    withStatus(twelve, "Canceled", "canceled"),
  ]), { leads: [lead()], pullRequests: { env_lead: pr("merged") } }));
  assert.deepEqual(board.lanes.map((lane) => [lane.specId, lane.state]), [["FIX-1", "landed"]]);
  assert.deepEqual(ticketStates(board), [["FIX-2", "done"], ["FIX-3", "done"]]);
  assert.deepEqual(board.ready, []);
  assert.deepEqual(board.openIssues, [], "closed issues stay off Unplanned");

  const elsewhere = deriveBoard(input(snapshot([{ ...withStatus(spec, "Done", "completed"), projectId: "project-other" }]),
    { leads: [lead()], pullRequests: { env_lead: pr("merged") } })).board;
  assert.deepEqual(elsewhere.lanes, [], "a spec moved out of the bound project leaves the board");
});

test("Cancel is a demo-only control and never appears on a live lane", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const board = deriveBoard(input(snapshot(laneIssues()), { leads: [lead()] })).board;
  const html = (demo: boolean) => renderToStaticMarkup(createElement(BoardView, {
    board, demo, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined,
  }));
  assert.doesNotMatch(html(false), />Cancel<\/button>/);
  assert.match(html(true), />Cancel<\/button>/, "the synthetic simulation keeps Cancel");
});

test("the live header counts lanes on the board without a capacity or empty formation mark", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const board = deriveBoard(input(snapshot(laneIssues()), { leads: [lead()] })).board;
  const header = (lanes: typeof board.lanes, demo = false) => {
    const html = renderToStaticMarkup(createElement(BoardView, {
      board: { ...board, lanes, laneCapacity: demo ? 3 : 0 }, demo, modeSwitch: null,
      dispatch: () => undefined, onPlan: () => undefined,
    }));
    return /<header[\s\S]*?<\/header>/.exec(html)![0];
  };
  assert.match(header([]), /0 lanes on the board/);
  assert.match(header(board.lanes), /1 lane on the board/);
  const mixed = [board.lanes[0],
    { ...board.lanes[0], specId: "FIX-10", state: "pr-open" as const },
    { ...board.lanes[0], specId: "FIX-20", state: "stopped" as const },
    { ...board.lanes[0], specId: "FIX-30", state: "landed" as const }];
  assert.match(header(mixed), /3 lanes on the board/);
  assert.doesNotMatch(header(mixed), /of 0|lanes flying|sq-formation/);
  assert.match(header(board.lanes, true), /1 of 3 lanes flying/);
  assert.match(header(board.lanes, true), /aria-label="1 of 3 lanes flying"/);
});

test("a stopped Lead with an open PR stays In review and in Needs you until it runs again", async () => {
  const { needsYou } = await import("../lib/board-model.js");
  const quiet = { ...lead(), thread: { ...lead().thread, status: "idle" as const } };
  const board = (currentLead: LeadThread, checks: "pending" | "failing" | "passing" = "pending",
    state: "open" | "merged" = "open", owner = false) => {
    const [spec, ...tickets] = laneIssues();
    if (owner) spec.labels.push({ id: "owner", name: "accept:owner", color: "#888888" });
    return deriveBoard(input(snapshot([spec, ...tickets]), {
      leads: [currentLead], pullRequests: { env_lead: pr(state, checks) },
    })).board;
  };
  for (const checks of ["pending", "failing", "passing"] as const) {
    const stopped = board(quiet, checks);
    assert.equal(stopped.lanes[0].state, "pr-open");
    assert.deepEqual(needsYou(stopped).map(({ kind, specId, threadId }) => [kind, specId, threadId]),
      [["stopped", "FIX-1", "thr_lead"]]);
  }
  assert.deepEqual(needsYou(board(lead())), [], "Resume clears the stopped need while the PR remains open");
  const failed = { ...quiet, thread: { ...quiet.thread, status: "error" as const } };
  assert.deepEqual(needsYou(board(failed)).map(({ kind }) => kind), ["failed"], "a failure explains the stop once");
  assert.deepEqual(needsYou(board(quiet, "passing", "open", true)).map(({ kind }) => kind), ["merge"],
    "an accept:owner PR ready to merge needs only its merge");
  assert.deepEqual(needsYou(board(quiet, "passing", "merged")), [], "a landed lane needs no Resume");
});

test("an In review lane row offers Stop while running and Resume while stopped", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const row = (status: "active" | "idle", checks: "pending" | "failing" | "passing", owner = false) => {
    const currentLead = { ...lead(), thread: { ...lead().thread, status } };
    const [spec, ...tickets] = laneIssues();
    if (owner) spec.labels.push({ id: "owner", name: "accept:owner", color: "#888888" });
    const board = deriveBoard(input(snapshot([spec, ...tickets]), {
      leads: [currentLead], pullRequests: { env_lead: pr("open", checks) },
    })).board;
    const html = renderToStaticMarkup(createElement(BoardView, {
      board, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined,
    }));
    return /<article class="sq-line"[\s\S]*?<\/article>/.exec(html)![0];
  };
  for (const checks of ["pending", "failing"] as const) {
    const running = row("active", checks);
    assert.match(running, /data-lane="pr-open">In review</);
    assert.match(running, />Stop<\/button>/);
    assert.doesNotMatch(running, />Resume<\/button>/);
    const stopped = row("idle", checks);
    assert.match(stopped, /data-lane="pr-open">In review</);
    assert.match(stopped, />Resume<\/button>/);
    assert.doesNotMatch(stopped, />Stop<\/button>/);
  }
  const ownerMerge = row("idle", "passing", true);
  assert.match(ownerMerge, />Merge<\/button>/);
  assert.match(ownerMerge, />Resume<\/button>/, "a merge-ready PR doesn't hide the stopped Lead's Resume");
  assert.doesNotMatch(ownerMerge, />Stop<\/button>/);
});
