import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBoard } from "../lib/board-derive.js";
import { needsYou } from "../lib/board-model.js";
import { parseSquadronSettings, SCOPE_MISSING } from "../lib/squadron-settings.js";
import { readFileSync } from "node:fs";
import { blocks, input, issue, snapshot } from "./fixtures/board-snapshots.js";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";

test("an idle Lead waiting on outside blockers names them in its lane without Needs you", () => {
  const snap = snapshot([
    issue("FIX-1", { labels: ["ready-for-agent", "accept:owner"] }),
    issue("FIX-2", { parent: "FIX-1", done: true }),
    issue("FIX-3", { parent: "FIX-1" }),
    issue("OUT-9", { outside: true }),
  ], [blocks("OUT-9", "FIX-3")]);
  const { board } = deriveBoard(input(snap, { now: 400_000, leads: [{
    specId: "fix-1", idleSince: 100_000, branch: "spec/fix-1",
    route: { family: "gpt", model: "gpt-6.1-sol", effort: "medium" },
    thread: makeThreadResponse({ id: "lead", projectId: "proj-one", status: "idle", runtime: { displayStatus: "idle" } }),
  }] }));
  assert.deepEqual(needsYou(board), []);
  assert.equal(board.lanes[0].state, "flying");
  assert.deepEqual(board.lanes[0].waitingOn, ["OUT-9"]);
});

test("a live Lead makes its spec Flying and links the Lead instead of offering Start", () => {
  const snap = snapshot([
    issue("FIX-1", { labels: ["ready-for-agent", "ui"] }),
    issue("FIX-2", { parent: "FIX-1" }),
  ]);
  const { board } = deriveBoard(input(snap, { leads: [{ specId: "fix-1", thread: makeThreadResponse({
    id: "thr_lead", projectId: "proj-one", providerId: "claude-code", status: "active",
    createdAt: Date.parse("2026-11-13T20:00:00Z"),
  }), route: { family: "claude", model: "claude-opus-5-5", effort: "high" }, branch: "spec/fix-1" }] }));
  assert.deepEqual(board.ready, []);
  assert.equal(board.lanes.length, 1);
  assert.equal(board.lanes[0].state, "flying");
  assert.equal(board.lanes[0].specId, "FIX-1");
  assert.equal(board.lanes[0].leadThreadId, "thr_lead");
  assert.deepEqual(board.lanes[0].lead, { family: "claude", model: "claude-opus-5-5", effort: "high" });
  assert.equal(board.lanes[0].minutes, 0);
});

test("ready-for-agent specs show under Ready with their tickets, and parentless issues under Open issues", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { title: "Board reads Linear", labels: ["ready-for-agent"] }),
    issue("FIX-2", { title: "Mirror issues", parent: "FIX-1", labels: ["ready-for-agent"] }),
    issue("FIX-3", { title: "Board page", parent: "FIX-1", labels: ["ui", "ready-for-agent"] }),
    issue("FIX-4", { title: "Webhooks", labels: ["v2"] }),
  ])));
  assert.deepEqual(board.ready.map(({ id, title, ticketCount, routes }) => ({ id, title, ticketCount, routes })), [{
    id: "FIX-1", title: "Board reads Linear", ticketCount: 2, routes: [
      { family: "gpt", model: "gpt-6.1-sol", effort: "high" },
      { family: "claude", model: "claude-opus-5-5", effort: "high" },
    ],
  }]);
  assert.deepEqual(board.openIssues.map(({ id, title, labels }) => ({ id, title, labels })), [
    { id: "FIX-4", title: "Webhooks", labels: ["v2"] },
  ]);
  assert.deepEqual(board.lanes, []);
  assert.equal(board.laneCapacity, 0);
  assert.equal(board.workersPerLane, 0);
});

test("open blockers across specs, inside or outside the project, hold Start with the reason", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1" }),
    issue("FIX-10", { labels: ["ready-for-agent"] }),
    issue("FIX-11", { parent: "FIX-10" }),
    issue("FIX-20", { labels: ["ready-for-agent"] }),
    issue("FIX-21", { parent: "FIX-20" }),
    issue("OUT-9", { title: "Outside work", outside: true }),
    issue("FIX-30", { labels: ["ready-for-agent"] }),
    issue("FIX-31", { parent: "FIX-30" }),
    issue("FIX-8", { done: true }),
    issue("OUT-7", { outside: true, done: true }),
  ], [blocks("FIX-1", "FIX-10"), blocks("OUT-9", "FIX-20"), blocks("FIX-1", "FIX-20"),
    blocks("FIX-8", "FIX-30"), blocks("OUT-7", "FIX-30")])));
  const rows = Object.fromEntries(board.ready.map((spec) => [spec.id, spec]));
  assert.deepEqual(rows["FIX-10"].blockedBy, ["FIX-1"]);
  assert.equal(rows["FIX-10"].startReason, "Waits on FIX-1");
  assert.deepEqual(rows["FIX-20"].blockedBy, ["FIX-1", "OUT-9"]);
  assert.deepEqual(rows["FIX-20"].blockers, [
    { id: "FIX-1", title: "Issue FIX-1", url: "https://linear.app/fixture/issue/FIX-1", outside: false },
    { id: "OUT-9", title: "Outside work", url: "https://linear.app/fixture/issue/OUT-9", outside: true },
  ]);
  assert.equal(rows["FIX-20"].startReason, "Waits on FIX-1 and OUT-9 (outside this project)");
  assert.deepEqual(rows["FIX-30"].blockedBy, []);
  assert.deepEqual(board.openIssues.map((row) => row.id), [], "outside and closed blockers never become rows");
});

test("a spec waits for Doctor, open tickets and an available frontier", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1" }),
    issue("FIX-5", { labels: ["ready-for-agent"] }),
    issue("FIX-51", { parent: "FIX-5", done: true }),
    issue("FIX-6", { labels: ["ready-for-agent"] }),
    issue("FIX-7", { parent: "FIX-6" }),
  ], [blocks("FIX-2", "FIX-7")])));
  assert.deepEqual(board.ready.map((spec) => [spec.id, spec.startReason]), [
    ["FIX-1", "Check Doctor before starting a lane."],
  ]);
  assert.deepEqual(board.shaping.map((spec) => [spec.id, spec.missing, spec.action]), [
    ["FIX-5", "Has the ready-for-agent label but no open tickets.", "tickets"],
    ["FIX-6", "Every ticket waits on a blocker: FIX-2", "tickets"],
  ], "a ready label without an available frontier is still Shaping");
});

test("a spec whose every ticket waits is Shaping with its blockers; a partial frontier stays Ready", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1" }), issue("FIX-3", { parent: "FIX-1" }),
    issue("FIX-10", { labels: ["ready-for-agent"] }), issue("FIX-11", { parent: "FIX-10" }),
    issue("OUT-9", { outside: true }), issue("FIX-8", { done: true }),
  ], [blocks("FIX-11", "FIX-2"), blocks("OUT-9", "FIX-2"), blocks("FIX-8", "FIX-3"),
    blocks("FIX-11", "FIX-3")])));
  assert.deepEqual(board.ready.map((spec) => spec.id), ["FIX-10"], "FIX-1 has no open, unblocked ticket, so it isn't Ready");
  assert.deepEqual(board.shaping.map(({ id, ticketCount, missing, action }) => ({ id, ticketCount, missing, action })), [
    { id: "FIX-1", ticketCount: 2, missing: "Every ticket waits on a blocker: FIX-11, OUT-9", action: "tickets" },
  ]);

  const partial = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1" }), issue("FIX-3", { parent: "FIX-1" }),
    issue("OUT-9", { outside: true }), issue("FIX-8", { done: true }),
  ], [blocks("OUT-9", "FIX-2"), blocks("FIX-8", "FIX-3")]))).board.ready[0];
  assert.deepEqual(partial.blockedBy, ["OUT-9"]);
  assert.equal(partial.startReason, "Check Doctor before starting a lane.");
});

test("Start waits on a valid docs/agents/squadron.md before anything else after blockers", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1" }),
  ]), { settings: { ok: false, issues: [{ section: "Routes", message: "Add routes." }] } }));
  assert.equal(board.ready[0].startReason, "Fix docs/agents/squadron.md first: Routes. Open Doctor for details.");
  assert.deepEqual(board.ready[0].routes, []);
});

test("every open issue stays visible: a child without a spec parent is an Open issue with its parent named", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-49", { done: true }),
    issue("FIX-50", { parent: "FIX-49" }),
    issue("FIX-60", { parent: "GONE-1" }),
    issue("FIX-69", { title: "Draft spec" }),
    issue("FIX-70", { parent: "FIX-69" }),
    issue("FIX-71", { parent: "FIX-70" }),
    issue("OUT-3", { outside: true }),
    issue("FIX-80", { parent: "OUT-3" }),
  ])));
  assert.deepEqual(board.openIssues.map(({ id, under }) => ({ id, under })), [
    { id: "FIX-50", under: "Under FIX-49, which is closed" },
    { id: "FIX-60", under: "Under an issue this board can't see" },
    { id: "FIX-71", under: "Under FIX-70" },
    { id: "FIX-80", under: "Under OUT-3, outside this project" },
  ]);
  assert.deepEqual(board.shaping.map((spec) => [spec.id, spec.ticketCount]), [["FIX-69", 1]],
    "a parentless issue with tickets is a spec being shaped, and its child is a ticket");
});

test("Open issues lists every open issue that isn't a spec or a ticket, each ready for Plan", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1" }),
    issue("FIX-3", { title: "Idea", labels: ["bug"] }),
    issue("FIX-4", { title: "Done idea", done: true }),
    issue("FIX-5", { title: "Only closed children" }),
    issue("FIX-6", { parent: "FIX-5", done: true }),
    { ...issue("FIX-7", { title: "Duplicate idea" }), state: { id: "state-duplicate", name: "Duplicate", type: "duplicate" } },
    issue("OUT-1", { outside: true }),
  ])));
  assert.deepEqual(board.openIssues.map(({ id, title, labels }) => ({ id, title, labels })), [
    { id: "FIX-3", title: "Idea", labels: ["bug"] },
  ], "a Duplicate issue is closed, like a Done one");
  assert.deepEqual(board.ready.map((spec) => spec.id), ["FIX-1"]);
  assert.deepEqual(board.shaping.map(({ id, ticketCount, totalTicketCount }) => ({ id, ticketCount, totalTicketCount })), [
    { id: "FIX-5", ticketCount: 0, totalTicketCount: 1 },
  ], "a spec with only completed tickets stays a spec");
});

test("a spec is Shaping while its planning thread is open, it has tickets but no ready label, or the label but no tickets", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-10", { title: "Being planned" }),
    issue("FIX-11", { parent: "FIX-10", done: true }),
    issue("FIX-20", { title: "Tickets, no label" }),
    issue("FIX-21", { parent: "FIX-20" }), issue("FIX-22", { parent: "FIX-20" }),
    issue("FIX-30", { title: "Label, no tickets", labels: ["ready-for-agent"] }),
    issue("FIX-31", { parent: "FIX-30", done: true }),
    issue("FIX-40", { title: "Still planning tickets" }),
    issue("FIX-41", { parent: "FIX-40" }),
  ]), { planning: [{ issueId: "fix-10", threadId: "thr_plan_10" }, { issueId: "fix-40", threadId: "thr_plan_40" }] }));
  assert.deepEqual(board.shaping, [
    { id: "FIX-10", title: "Being planned", url: "https://linear.app/fixture/issue/FIX-10", ticketCount: 0, totalTicketCount: 1,
      missing: "Planning is still open in its thread.", action: "resume", threadId: "thr_plan_10" },
    { id: "FIX-20", title: "Tickets, no label", url: "https://linear.app/fixture/issue/FIX-20", ticketCount: 2, totalTicketCount: 2,
      missing: "Has 2 tickets but no ready-for-agent label.", action: "tickets" },
    { id: "FIX-30", title: "Label, no tickets", url: "https://linear.app/fixture/issue/FIX-30", ticketCount: 0, totalTicketCount: 1,
      missing: "Has the ready-for-agent label but no open tickets.", action: "tickets" },
    { id: "FIX-40", title: "Still planning tickets", url: "https://linear.app/fixture/issue/FIX-40", ticketCount: 1, totalTicketCount: 1,
      missing: "Planning is still open in its thread.", action: "resume", threadId: "thr_plan_40" },
  ]);
  assert.deepEqual(board.openIssues, [], "a spec being shaped and its tickets leave Open issues");
  assert.deepEqual(board.ready, []);
});

test("Ready needs the ready label or Status: ready-for-agent and an open, unblocked ticket", () => {
  const issues = [
    issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" }),
    issue("FIX-5", { status: "ready-for-agent" }), issue("FIX-6", { parent: "FIX-5" }),
    issue("FIX-8", { status: "Ready-For-Agent" }), issue("FIX-9", { parent: "FIX-8" }),
  ];
  for (const kind of ["linear", "local-markdown", "github"] as const) {
    const { board } = deriveBoard(input(snapshot(issues), { kind }));
    assert.deepEqual(board.ready.map((spec) => spec.id), ["FIX-1", "FIX-5", "FIX-8"], kind);
    assert.deepEqual([board.shaping, board.openIssues], [[], []], kind);
  }
});

test("an open planning thread keeps a spec Shaping even when it would otherwise be Ready", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" }),
    issue("FIX-5", { labels: ["ready-for-agent"] }), issue("FIX-6", { parent: "FIX-5" }),
  ]), { planning: [{ issueId: "fix-1", threadId: "thr_plan" }] }));
  assert.deepEqual(board.ready.map((spec) => spec.id), ["FIX-5"]);
  assert.deepEqual(board.shaping.map(({ id, action, threadId, missing }) => ({ id, action, threadId, missing })), [
    { id: "FIX-1", action: "resume", threadId: "thr_plan", missing: "Planning is still open in its thread." },
  ]);
});

test("a Ready row lists which tickets wait on which blockers when only part of its frontier is available", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1", title: "Waits twice" }), issue("FIX-3", { parent: "FIX-1" }),
    issue("FIX-4", { parent: "FIX-1", title: "Waits on a sibling" }),
    issue("OUT-9", { outside: true }), issue("FIX-11"), issue("FIX-8", { done: true }),
  ], [blocks("FIX-11", "FIX-2"), blocks("OUT-9", "FIX-2"), blocks("FIX-8", "FIX-3"), blocks("FIX-3", "FIX-4")])));
  assert.deepEqual(board.ready[0].waiting, [
    { id: "FIX-2", title: "Waits twice", blockedBy: ["FIX-11", "OUT-9"] },
    { id: "FIX-4", title: "Waits on a sibling", blockedBy: ["FIX-3"] },
  ]);
  assert.equal(board.ready[0].startReason, "Check Doctor before starting a lane.", "FIX-3 is available, so Start isn't held");
});

test("disconnected, unscoped and failed reads say what happened without asking for a sync", () => {
  const disconnected = deriveBoard(input(snapshot([issue("FIX-4")], [], { syncedAt: null }), {
    connection: { status: "disconnected", message: "Connect Linear in Squadron settings." },
  }));
  assert.deepEqual([disconnected.board.tracker?.state, disconnected.board.tracker?.message],
    ["disconnected", "Connect Linear in Squadron settings."]);

  const unscoped = deriveBoard(input(snapshot([], [], { scope: null, syncedAt: null, error: SCOPE_MISSING })));
  assert.deepEqual([unscoped.board.tracker?.state, unscoped.board.tracker?.project, unscoped.board.tracker?.message],
    ["unscoped", null, SCOPE_MISSING]);

  const unread = deriveBoard(input(snapshot([], [], { scope: null, syncedAt: null })));
  assert.equal(unread.board.tracker?.state, "catching-up", "a Scope not yet read is not a setup problem");

  const failed = deriveBoard(input(snapshot([issue("FIX-4")], [], { error: "Linear is unavailable. Try again shortly." })));
  assert.deepEqual([failed.board.tracker?.state, failed.board.tracker?.message],
    ["failed", "Linear is unavailable. Try again shortly."]);
  assert.deepEqual(failed.board.openIssues.map((row) => row.id), ["FIX-4"], "the last good copy stays on the board");
});

test("a missing or unmatched Scope waits on the owner before anything else, once", () => {
  const unmatched = "Scope Project \"Nope\" matches no Linear project. Fix it in docs/agents/squadron.md.";
  const { board } = deriveBoard(input(snapshot([], [], { scope: null, syncedAt: null, error: unmatched })));
  assert.deepEqual(needsYou(board).map(({ kind, text }) => ({ kind, text })), [{ kind: "setup", text: unmatched }]);
  // Doctor names the same problem; the owner sees one row, not two.
  const doctor = { ready: false, configurationFiles: [], checks: [
    { id: "settings" as const, name: "Project settings", status: "fix" as const, message: unmatched },
  ] };
  const both = deriveBoard(input(snapshot([], [], { scope: null, syncedAt: null, error: unmatched }), { doctor })).board;
  assert.deepEqual(needsYou(both).map(({ key, text }) => ({ key, text })), [{ key: "setup:settings", text: unmatched }]);
});

test("Start uses the Doctor's first failing fix and owner-file warnings don't block it", () => {
  const snap = snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" })]);
  const doctor = {
    ready: false, configurationFiles: [], checks: [
      { id: "skills" as const, name: "Matt's plugin", status: "fix" as const, message: "Install Matt's plugin in Codex." },
      { id: "github" as const, name: "GitHub login", status: "fix" as const, message: "Run gh auth login." },
    ],
  };
  assert.equal(deriveBoard(input(snap, { doctor })).board.ready[0].startReason, "Install Matt's plugin in Codex.");
  const warnings = { ready: true, configurationFiles: [], checks: [
    { id: "playbook" as const, name: "Playbook", status: "warning" as const, message: "Optional playbook is missing." },
    { id: "machine-profile" as const, name: "Machine profile", status: "warning" as const, message: "Optional machine profile is missing." },
  ] };
  const board = deriveBoard(input(snap, { doctor: warnings })).board;
  assert.equal(board.ready[0].startReason, null);
  assert.deepEqual(board.doctor, warnings);
});

test("Start waits for a recent scoped Linear reading and a ready Doctor", () => {
  const snap = snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" })]);
  const doctor = { ready: true, checks: [], configurationFiles: [] };
  assert.equal(deriveBoard(input(snap, { doctor })).board.ready[0].startReason, null);
  assert.equal(deriveBoard(input(snap, { doctor, snapshot: { ...snap, error: "Linear is unavailable." } })).board.ready[0].startReason, null);
  for (const overrides of [
    { snapshot: { ...snap, syncedAt: input(snap).now - 900_001, error: "Linear is unavailable." } },
    { snapshot: { ...snap, syncedAt: null } },
    { snapshot: { ...snap, scope: null, error: SCOPE_MISSING } },
    { snapshot: { ...snap, scope: null } },
    { connection: { status: "disconnected", message: "Connect Linear." } },
    { doctor: { ready: false, checks: [], configurationFiles: [] } },
  ]) {
    assert.notEqual(deriveBoard(input(snap, { doctor, ...overrides })).board.ready[0].startReason, null);
  }
});

/** A Flying lane for FIX-1 whose Lead and workers are in the given BB states. */
function laneWith(lead: Partial<ReturnType<typeof makeThreadResponse>> & { hasPendingInteraction?: boolean; queuedWork?: "none" | "waiting" | "failed" },
  workers: (Partial<ReturnType<typeof makeThreadResponse>> & { hasPendingInteraction?: boolean; queuedWork?: "none" | "waiting" | "failed" })[] = []) {
  const snap = snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" })]);
  return deriveBoard(input(snap, { leads: [{
    specId: "fix-1", route: { family: "gpt", model: "gpt-6.1-sol", effort: "high" }, branch: "spec/fix-1",
    thread: { ...makeThreadResponse({ id: "thr_lead", projectId: "proj-one", status: "active", runtime: { displayStatus: "active" } }), ...lead },
    workers: workers.map((worker, i) => ({ ...makeThreadResponse({ id: `thr_w${i + 1}`, projectId: "proj-one", parentThreadId: "thr_lead",
      title: `Worker FIX-${i + 2}`, status: "active", runtime: { displayStatus: "active" } }), ...worker })),
  }] })).board;
}
const kinds = (board: ReturnType<typeof laneWith>) => needsYou(board).map(({ kind, specId, threadId }) => ({ kind, specId, threadId }));

test("a lane thread waiting on the owner is in Needs you until it moves on", () => {
  assert.deepEqual(kinds(laneWith({}, [{ status: "idle", runtime: { displayStatus: "idle" }, hasPendingInteraction: true }, {}])),
    [{ kind: "waiting", specId: "FIX-1", threadId: "thr_w1" }]);
  assert.deepEqual(kinds(laneWith({ hasPendingInteraction: true })), [{ kind: "waiting", specId: "FIX-1", threadId: "thr_lead" }]);
  const answered = laneWith({}, [{ hasPendingInteraction: false }]);
  assert.deepEqual(kinds(answered), []);
  assert.equal(answered.lanes[0].state, "flying");
});

test("a failed or blocked lane thread is in Needs you until it runs again", () => {
  assert.deepEqual(kinds(laneWith({}, [{ status: "error", runtime: { displayStatus: "error" } }])),
    [{ kind: "failed", specId: "FIX-1", threadId: "thr_w1" }]);
  assert.deepEqual(kinds(laneWith({ queuedWork: "failed" })), [{ kind: "blocked", specId: "FIX-1", threadId: "thr_lead" }]);
  assert.deepEqual(kinds(laneWith({ runtime: { displayStatus: "waiting-for-host" } })),
    [{ kind: "blocked", specId: "FIX-1", threadId: "thr_lead" }]);
  assert.deepEqual(kinds(laneWith({}, [{ status: "active", runtime: { displayStatus: "active" } }])), []);
  const text = needsYou(laneWith({}, [{ status: "error", runtime: { displayStatus: "error" } }]))[0].text;
  assert.match(text, /Worker FIX-2/, "the item names the thread");
});

test("a lane whose Lead and workers have all stopped is Stopped and in Needs you, and clears when it runs again", () => {
  const idle = { status: "idle" as const, runtime: { displayStatus: "idle" as const } };
  const stopped = laneWith(idle, [idle]);
  assert.equal(stopped.lanes[0].state, "stopped");
  assert.deepEqual(kinds(stopped), [{ kind: "stopped", specId: "FIX-1", threadId: "thr_lead" }]);
  // A Lead between turns while its worker builds is still flying.
  const working = laneWith(idle, [{}]);
  assert.equal(working.lanes[0].state, "flying");
  assert.deepEqual(kinds(working), []);
  const resumed = laneWith({}, [idle]);
  assert.equal(resumed.lanes[0].state, "flying");
  assert.deepEqual(kinds(resumed), []);
  // A stopped lane with a failed Lead lists the failure once, not also as a bare stop.
  const failed = laneWith({ status: "error", runtime: { displayStatus: "error" } }, [idle]);
  assert.equal(failed.lanes[0].state, "stopped");
  assert.deepEqual(kinds(failed), [{ kind: "failed", specId: "FIX-1", threadId: "thr_lead" }]);
});

test("Doctor problems are setup items in Needs you, and warnings aren't", () => {
  const snap = snapshot([issue("FIX-1", { labels: ["ready-for-agent"] })]);
  const doctor = { ready: false, configurationFiles: [], checks: [
    { id: "skills" as const, name: "Matt's plugin", status: "fix" as const, message: "Install Matt's plugin in Codex." },
    { id: "playbook" as const, name: "Playbook", status: "warning" as const, message: "No playbook yet." },
    { id: "github" as const, name: "GitHub", status: "pass" as const, message: "Signed in." },
  ] };
  assert.deepEqual(needsYou(deriveBoard(input(snap, { doctor })).board).map(({ kind, text }) => ({ kind, text })), [
    { kind: "setup", text: "Install Matt's plugin in Codex." },
  ]);
  assert.deepEqual(needsYou(deriveBoard(input(snap, { doctor: { ...doctor, ready: true, checks: doctor.checks.slice(1) } })).board), []);
});

const flyingLead = { specId: "fix-1", route: { family: "gpt" as const, model: "gpt-6.1-sol", effort: "high" as const }, branch: "spec/fix-1",
  thread: makeThreadResponse({ id: "thr_lead", projectId: "proj-one", status: "active", runtime: { displayStatus: "active" } }) };

test("a held ticket in a lane shows Held, not Waiting or Working, until it is done", () => {
  const snap = snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1", labels: ["Needs-Info"] }),
    issue("FIX-3", { parent: "FIX-1", labels: ["hold"], status: "In Progress" }),
    issue("FIX-4", { parent: "FIX-1" }),
    issue("FIX-5", { parent: "FIX-1", labels: ["hold"], done: true }),
  ]);
  const { board } = deriveBoard(input(snap, { leads: [flyingLead] }));
  assert.deepEqual(board.lanes[0].tickets.map(({ id, state }) => [id, state]).sort(),
    [["FIX-2", "held"], ["FIX-3", "held"], ["FIX-4", "blocked"], ["FIX-5", "done"]]);
});

test("a Status: hold line holds a ticket in trackers without labels", () => {
  const snap = snapshot([
    issue("FIX-1", { status: "ready-for-agent" }),
    issue("FIX-2", { parent: "FIX-1", status: "hold" }), issue("FIX-3", { parent: "FIX-1" }),
  ]);
  const { board } = deriveBoard(input(snap, { kind: "local-markdown", leads: [flyingLead] }));
  assert.deepEqual(board.lanes[0].tickets.map(({ id, state }) => [id, state]), [["FIX-2", "held"], ["FIX-3", "blocked"]]);
});

test("a spec whose open tickets are all held stays Shaping and says so", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1", labels: ["hold"] }), issue("FIX-3", { parent: "FIX-1", labels: ["ready-for-human"] }),
    issue("FIX-4", { parent: "FIX-1", done: true }),
  ])));
  assert.deepEqual(board.ready, []);
  assert.deepEqual(board.shaping.map(({ id, ticketCount, missing, action }) => ({ id, ticketCount, missing, action })), [
    { id: "FIX-1", ticketCount: 2, missing: "Every open ticket is held: FIX-2 and FIX-3.", action: "tickets" },
  ]);
});

test("a spec with some held tickets is Ready, lists them, and routes only the tickets that will run", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1", labels: ["ui", "hold"], title: "Held UI" }),
    issue("FIX-3", { parent: "FIX-1" }),
    issue("FIX-4", { parent: "FIX-1" }),
    issue("FIX-6", { labels: ["ready-for-agent"] }),
    issue("FIX-7", { parent: "FIX-6", labels: ["needs-info"] }), issue("FIX-8", { parent: "FIX-6" }),
    issue("OUT-9", { outside: true }),
  ], [blocks("OUT-9", "FIX-8"), blocks("FIX-3", "FIX-4")])));
  const [row] = board.ready;
  assert.deepEqual([row.id, row.ticketCount, row.held, row.routes], ["FIX-1", 3, [{ id: "FIX-2", title: "Held UI" }],
    [{ family: "gpt", model: "gpt-6.1-sol", effort: "high" }]]);
  assert.deepEqual(board.ready.map((spec) => spec.id), ["FIX-1"]);
  assert.deepEqual(board.shaping.map(({ id, missing }) => [id, missing]), [
    ["FIX-6", "Every ticket that isn't held waits on a blocker: OUT-9"],
  ]);
});

test("a repo's own hold labels hold tickets on the board too", () => {
  const markdown = readFileSync("tests/fixtures/squadron.md", "utf8") + "\n## Hold labels\n\n- wayfinder:*\n";
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1", labels: ["Wayfinder:Later"] }),
  ]), { settings: parseSquadronSettings(markdown) }));
  assert.deepEqual(board.shaping.map(({ id, missing }) => [id, missing]), [["FIX-1", "Every open ticket is held: FIX-2."]]);
});

for (const kind of ["github", "local-markdown"] as const) {
  test(`${kind} Ready queue preserves tracker order rather than identifier or Linear priority`, () => {
    const snap = snapshot([
      issue("FIX-20", { labels: ["ready-for-agent"] }), issue("FIX-21", { parent: "FIX-20" }),
      issue("FIX-10", { labels: ["ready-for-agent"] }), issue("FIX-11", { parent: "FIX-10" }),
    ]);
    snap.issues[0].priority = 0;
    snap.issues[2].priority = 1;
    const { board } = deriveBoard(input(snap, { kind }));
    assert.deepEqual(board.ready.map((row) => row.id), ["FIX-20", "FIX-10"]);
  });
}

for (const kind of ["github", "local-markdown"] as const) {
  test(`${kind} Ready queue uses oldest creation time for equal tracker ordinals`, () => {
    const source = input(snapshot([
      issue("FIX-20", { labels: ["ready-for-agent"] }), issue("FIX-21", { parent: "FIX-20" }),
      issue("FIX-10", { labels: ["ready-for-agent"] }), issue("FIX-11", { parent: "FIX-10" }),
    ]), { kind });
    Object.assign(source.snapshot.issues[0], { trackerOrder: 1, createdAt: "2026-01-01T00:00:00.100Z" });
    Object.assign(source.snapshot.issues[2], { trackerOrder: 1, createdAt: "2026-01-01T00:00:00Z" });
    assert.deepEqual(deriveBoard(source).board.ready.map((row) => row.id), ["FIX-10", "FIX-20"]);
  });
}

test("a returning completed spec keeps its queue order beside Ready specs and its Landed history", () => {
  const returning = { ...issue("FIX-20", { labels: ["ready-for-agent"], done: true }), sortOrder: -1 };
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" }),
    returning, issue("FIX-21", { parent: "FIX-20" }),
  ]), {
    leads: [{ specId: "fix-20", branch: "landed/old", route: { family: "gpt", model: "gpt-6.1-sol", effort: "high" },
      thread: makeThreadResponse({ id: "old-lead", projectId: "proj-one", environmentId: "old-env", status: "idle" }) }],
    pullRequests: { "old-env": { outcome: "available", pullRequest: { number: 1, state: "merged", url: "https://example.invalid/pr/1",
      updatedAt: "2026-11-13T20:00:00Z", checks: { state: "passing" } } } },
  }));
  assert.deepEqual(board.ready.map((row) => row.id), ["FIX-20", "FIX-1"]);
  assert.deepEqual(board.lanes.map((row) => [row.specId, row.state, row.leadThreadId]), [["FIX-20", "landed", "old-lead"]]);
});

const landedLead = (id = "old-lead") => ({ specId: "fix-20", branch: "landed/old", route: { family: "gpt" as const, model: "gpt-6.1-sol", effort: "high" as const },
  thread: makeThreadResponse({ id, projectId: "proj-one", environmentId: "old-env", status: "idle" }) });
const mergedPr = { "old-env": { outcome: "available" as const, pullRequest: { number: 1, state: "merged" as const, url: "https://example.invalid/pr/1",
  updatedAt: "2026-11-13T20:00:00Z", checks: { state: "passing" as const } } } };

test("a lane that just landed offers its spec only to the owner while every ticket is in branch or done", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-20", { labels: ["ready-for-agent"] }),
    issue("FIX-21", { parent: "FIX-20", status: "In Review" }),
    issue("FIX-22", { parent: "FIX-20", done: true }),
  ]), { leads: [landedLead()], pullRequests: mergedPr }));
  assert.deepEqual(board.lanes.map((row) => [row.specId, row.state]), [["FIX-20", "landed"]]);
  assert.deepEqual(board.ready.map((row) => [row.id, row.justLanded]), [["FIX-20", true]]);
});

test("a landed spec that gains a new open ticket still returns", () => {
  const { board } = deriveBoard(input(snapshot([
    issue("FIX-20", { labels: ["ready-for-agent"] }),
    issue("FIX-21", { parent: "FIX-20", status: "In Review" }),
    issue("FIX-23", { parent: "FIX-20" }),
  ]), { leads: [landedLead()], pullRequests: mergedPr }));
  assert.deepEqual(board.ready.map((row) => [row.id, row.justLanded]), [["FIX-20", undefined]]);
});
