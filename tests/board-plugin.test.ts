import { fixtureProviders } from "./fixtures/provider-catalog.js";
// Spec A's end-to-end test: the real server.ts on the SDK's fake plugin host,
// a recorded Linear workspace behind fetch, and the board read through RPC.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { elements, parse, visibleText } from "./fixtures/owner-text.js";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { Board } from "../lib/board-model.js";
import { registerLinearAuth } from "../lib/linear-auth.js";
import { registerLinearReader } from "../lib/linear-reader.js";
import { registerBoard } from "../lib/board-service.js";
import { registerTracker } from "../lib/tracker-service.js";
import { workspace, workspaceIssues } from "./fixtures/board-workspace.js";

const settingsFile = readFileSync("tests/fixtures/squadron.md", "utf8");

/** Render the public board with inert controls; each test owns its literal expectations. */
async function boardDocument(board: Board, placement: "page" | "panel" = "page") {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const { JSDOM } = await import("jsdom");
  return new JSDOM(renderToStaticMarkup(createElement(BoardView, {
    board, placement, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined,
  }))).window.document;
}

function host(settings: Record<string, string> = { linearApiKey: "fake-board-e2e-key" }) {
  return createFakePluginHost({
    pluginId: "squadron",
    experimental_hostEntry: true,
    settings,
    sdk: {
      providers: fixtureProviders,
      threads: { list: async () => [] },
      projects: { get: async () => ({
        id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId: "proj-one", hostId: "repo-machine", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }],
      }) },
      files: { read: async ({ path }) => {
        if (path === "/repo/docs/agents/issue-tracker.md") {
          const content = readFileSync("tests/fixtures/trackers/bb-squadron.md", "utf8");
          return { content, contentEncoding: "utf8", path, sha256: "tracker", sizeBytes: content.length };
        }
        assert.equal(path, "/repo/docs/agents/squadron.md");
        return { content: settingsFile, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: settingsFile.length };
      } },
      skills: { list: async () => ({ skills: ["claude-code", "codex"].flatMap((provider) =>
        ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"].map((name) => ({
          id: `${provider}-${name}`, name: `mattpocock-skills:${name}`, description: null,
          filePath: `/plugins/${provider}/${name}/SKILL.md`, manageable: false,
          pluginId: "mattpocock-skills", provider, registrySkillId: null, scope: "plugin" as const,
        }))) }) },
    },
    experimental_callHostRpc: async ({ method, input }) => method === "githubLogin" ? { authenticated: true } : {
      homePath: "/owner", repoRulesExists: true, playbookExists: true, machineProfileExists: true,
      setupFiles: ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"],
      regularSkillFiles: (input as { skillPaths: string[] }).skillPaths,
    },
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), `timed out waiting for ${what}`);
}

test("Ready includes standalone ready work items beside specs, without promoting their tickets", async (t) => {
  const standalone = workspaceIssues.data.issues.nodes[5];
  const linear = workspace({ issues: () => Response.json({ data: { issues: {
    ...workspaceIssues.data.issues, nodes: [...workspaceIssues.data.issues.nodes,
      { ...standalone, id: "fix-10", identifier: "FIX-10", title: "Standalone fix", labels: {
        nodes: [{ id: "ready", name: "ready-for-agent", color: "#00aa00" }, { id: "ui", name: "ui", color: "#0000aa" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } },
    ],
  } } }) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.ready.map((row) => [row.id, (row as { kind?: string }).kind, row.ticketCount]), [
    ["FIX-1", "spec", 2], ["FIX-5", "spec", 1], ["FIX-10", "work-item", 0],
  ]);
  const work = board.ready.find((row) => row.id === "FIX-10")!;
  assert.deepEqual(work.routes, [{ family: "claude", model: "claude-opus-5-5", effort: "high" }]);
  assert.equal(work.startReason, null);
  assert.deepEqual(board.openIssues.map((row) => row.id), ["FIX-9"]);
  assert.deepEqual(board.shaping, []);
});

test("Ready rows label specs with their ticket count and work items without a ticket list at both placements", async () => {
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, lanes: [], shaping: [], openIssues: [], ready: [
    { id: "FIX-1", title: "A spec", kind: "spec", ticketCount: 5, routes: [], blockedBy: [], acceptOwner: false },
    { id: "FIX-2", title: "A work item", kind: "work-item", ticketCount: 0, routes: [], blockedBy: [], acceptOwner: false },
  ] };
  for (const placement of ["page", "panel"] as const) {
    const document = await boardDocument(board, placement);
    const rows = document.querySelectorAll(".sq-ready");
    const tag = rows[0].querySelector(".sq-work-kind")!;
    assert.equal(tag?.textContent?.replace(/A plan whose tickets are its sub-issues\./g, "").replace(/One piece of a spec\./g, ""), "Spec · 5 tickets");
    assert.equal(rows[0].querySelector('[data-term="Spec"] [role="tooltip"]')?.textContent, "A plan whose tickets are its sub-issues.");
    assert.equal(rows[0].querySelector('[data-term="Ticket"] [role="tooltip"]')?.textContent, "One piece of a spec.");
    assert.equal(rows[1].querySelector('[data-term="Work item"] [role="tooltip"]')?.textContent, "An issue that stands alone: no parent spec, no tickets of its own.");
    assert.equal(rows[1].querySelector('[data-term="Ticket"]'), null);
  }
});

test("spec tags show exactly 25 tickets or 25+ for overflow at both placements", async () => {
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, lanes: [], shaping: [], openIssues: [], ready: [
    { id: "FIX-25", title: "Exactly 25", kind: "spec", ticketCount: 1, totalTicketCount: 25, routes: [], blockedBy: [], acceptOwner: false },
    { id: "FIX-26", title: "More than 25", kind: "spec", ticketCount: 1, totalTicketCount: 26, routes: [], blockedBy: [], acceptOwner: false },
  ] };
  for (const placement of ["page", "panel"] as const) {
    const document = await boardDocument(board, placement);
    const tags = [...document.querySelectorAll(".sq-ready .sq-work-kind")];
    for (const tag of tags) tag.querySelectorAll('[role="tooltip"]').forEach((tip) => tip.remove());
    assert.deepEqual(tags.map((tag) => tag.textContent), ["Spec · 25 tickets", "Spec · 25+ tickets"]);
  }
});

test("a Ready spec counts completed tickets in its tag while keeping the open count for its frontier", async (t) => {
  const linear = workspace({ issues: () => Response.json({ data: { issues: {
    ...workspaceIssues.data.issues,
    nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-5"
      ? { ...node, childSummary: { nodes: [{ id: "open-child" }, { id: "closed-child" }], pageInfo: { hasNextPage: false } } } : node),
  } } }) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  const spec = board.ready.find((row) => row.id === "FIX-5")!;
  assert.equal(spec.ticketCount, 1);
  assert.equal((spec as { totalTicketCount?: number }).totalTicketCount, 2);
  const document = await boardDocument(board);
  const tag = document.querySelectorAll(".sq-ready .sq-work-kind")[1].cloneNode(true) as Element;
  tag.querySelectorAll('[role="tooltip"]').forEach((tip) => tip.remove());
  assert.equal(tag.textContent, "Spec · 2 tickets");
});

test("held, unfinished and actively planned work items stay in Open issues with Plan", async (t) => {
  const loose = workspaceIssues.data.issues.nodes[5];
  const readyLabel = { id: "ready", name: "ready-for-agent", color: "#00aa00" };
  const holds = ["HOLD", "needs-triage", "Needs-Info", "ready-for-human", "wontfix", "Later:Owner"];
  const additions = holds.map((name, i) => ({ ...loose, id: `fix-${10 + i}`, identifier: `FIX-${10 + i}`,
    labels: { ...loose.labels, nodes: [readyLabel, { id: `hold-${i}`, name, color: "#aaaaaa" }] } }));
  const linear = workspace({ issues: () => Response.json({ data: { issues: { ...workspaceIssues.data.issues, nodes: [
    ...workspaceIssues.data.issues.nodes, ...additions,
    { ...loose, id: "fix-16", identifier: "FIX-16", labels: { ...loose.labels, nodes: [readyLabel] }, state: { ...loose.state, name: "needs-info" } },
    { ...loose, id: "fix-17", identifier: "FIX-17", labels: { ...loose.labels, nodes: [readyLabel] } },
    { ...loose, id: "fix-18", identifier: "FIX-18", labels: { ...loose.labels, nodes: [readyLabel] }, childSummary: { nodes: [{ id: "closed-child" }], pageInfo: { hasNextPage: false } } },
  ] } } }) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  harness.sdk.stub("files.read", async ({ path }: { path: string }) => {
    const content = path.endsWith("issue-tracker.md") ? readFileSync("tests/fixtures/trackers/bb-squadron.md", "utf8")
      : settingsFile + "\n## Hold labels\n\n- later:*\n";
    return { content, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: content.length };
  });
  harness.sdk.stub("threads.list", async () => [makeThreadResponse({ id: "thr_plan", projectId: "proj-one" })]);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "planning", issueId: "fix-17" }));
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.ready.map((row) => row.id), ["FIX-1", "FIX-5"]);
  assert.deepEqual(board.openIssues.map((row) => [row.id, row.kind]), [
    ["FIX-9", "work-item"], ["FIX-10", "work-item"], ["FIX-11", "work-item"], ["FIX-12", "work-item"],
    ["FIX-13", "work-item"], ["FIX-14", "work-item"], ["FIX-15", "work-item"], ["FIX-16", "work-item"], ["FIX-17", "work-item"],
  ]);
  assert.deepEqual(board.shaping.map((row) => [row.id, row.totalTicketCount]), [["FIX-18", 1]], "a spec with completed tickets remains a spec");
  const document = await boardDocument(board);
  assert.equal(document.querySelectorAll(".sq-open-issue").length, 9);
  for (const row of document.querySelectorAll(".sq-open-issue")) {
    assert.equal(row.querySelector(".sq-row-actions button")?.textContent, "Plan");
    assert.ok(row.querySelector('[data-term="Work item"]'));
  }
});

test("install, read the repo's Scope, sync a recorded workspace and read the real board through RPC", async (t) => {
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.lifecycle.install();

  // No binding step: the first board read resolves tests/fixtures/squadron.md's Scope.
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.tracker?.state, "current");
  assert.equal(board.tracker?.project, "Fixture team · Fixture project");
  assert.deepEqual(board.ready.map(({ id, ticketCount, blockedBy, startReason, routes }) => ({ id, ticketCount, blockedBy, startReason, models: routes.map((route) => route.model) })), [
    { id: "FIX-1", ticketCount: 2, blockedBy: ["OUT-10"], startReason: "Waits on OUT-10 (outside this project)", models: ["gpt-6.1-sol", "claude-opus-5-5"] },
    { id: "FIX-5", ticketCount: 1, blockedBy: [], startReason: null, models: ["gpt-6.1-sol"] },
  ]);
  assert.deepEqual(board.openIssues.map((row) => [row.id, row.title]), [["FIX-9", "Linear webhooks"]]);
  assert.deepEqual(board.lanes, []);
  assert.ok(!linear.operations.some((name) => !name.startsWith("Squadron")));
});

const withNewIssue = () => Response.json({ data: { issues: { ...workspaceIssues.data.issues, nodes: [
  ...workspaceIssues.data.issues.nodes,
  { ...workspaceIssues.data.issues.nodes[5], id: "fix-12", identifier: "FIX-12", title: "Added in Linear", url: "https://linear.app/fixture/issue/FIX-12" },
] } } });

test("a change in Linear reaches open boards as board-changed on the mirror's next poll", async (t) => {
  let changed = false;
  const linear = workspace({ issues: () => changed ? withNewIssue() : Response.json(workspaceIssues) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  const before = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length;
  changed = true;
  const poll = harness.behavior.runService("linear-reader");
  t.after(() => poll.controller.abort());
  await until(() => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length > before, "board-changed after the poll");
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.openIssues.map((row) => row.id), ["FIX-9", "FIX-12"]);
});

test("a reload restores the complete reading for the repo's Scope, then reads Linear afresh", async (t) => {
  let changed = false;
  const linear = workspace({ issues: () => changed ? withNewIssue() : Response.json(workspaceIssues) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const first = host();
  await plugin(first.bb);
  await first.harness.behavior.callRpc("board", { projectId: "proj-one" });
  const previous = await first.harness.behavior.callRpc("linear.snapshot", { bbProjectId: "proj-one" }) as {
    scope: { name: string } | null; issues: unknown[]; syncedAt: number | null;
  };
  changed = true;
  const { harness } = await first.harness.lifecycle.reload((api) => plugin(api));
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });

  const snapshot = await harness.behavior.callRpc("linear.snapshot", { bbProjectId: "proj-one" }) as {
    scope: { name: string } | null; issues: unknown[]; syncedAt: number | null;
  };
  assert.deepEqual(snapshot.scope, previous.scope, "saved readings match the Scope the repo still names");
  assert.deepEqual(snapshot.issues, previous.issues, "the complete reading survives reload");
  assert.equal(snapshot.syncedAt, previous.syncedAt, "restoring never makes an old reading younger");
  // The poller reads only projects a board page shows (SIZE-953); this page shows proj-one.
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  const poll = harness.behavior.runService("linear-reader");
  t.after(() => poll.controller.abort());
  await until(() => linear.operations.filter((name) => name === "SquadronVocabulary").length >= 2, "full read after reload");
  await until(() => harness.inspection.realtimeSignals.some((signal) => signal.channel === "linear-mirror-changed"), "fresh snapshot");
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.tracker?.state, "current");
  assert.deepEqual(board.openIssues.map((row) => row.id), ["FIX-9", "FIX-12"]);
});

test("without a Linear credential the board asks the owner to connect and reads nothing", async (t) => {
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host({});
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.tracker, { kind: "linear", state: "disconnected", message: "Connect Linear in Squadron settings.", syncedAt: null,
    project: "FIX · Fixture project" }, "the Scope shows as written until Linear resolves it");
  assert.deepEqual(linear.operations, []);
});

test("board RPC refreshes reuse identity for a minute and invalidate it when credentials change", async (t) => {
  const linear = workspace();
  const { bb, harness } = host();
  t.after(() => harness.lifecycle.dispose());
  let now = Date.now();
  const auth = registerLinearAuth(bb, { fetch: linear.fetch, now: () => now });
  const mirror = registerLinearReader(bb, auth);
  registerBoard(bb, { connection: () => auth.getConnection(), tracker: registerTracker(bb, mirror) }, { now: () => now });
  const identities = () => linear.operations.filter((name) => name === "SquadronIdentity").length;
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  assert.equal(identities(), 1);
  await Promise.all(Array.from({ length: 5 }, () => harness.behavior.callRpc("board", { projectId: "proj-one" })));
  assert.equal(identities(), 1, "five page refreshes share the recent public identity");
  now += 60_001;
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  assert.equal(identities(), 2, "the next read after a minute verifies identity again");
  await harness.behavior.setSettings({ linearApiKey: "fake-replacement-key" });
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  assert.equal(identities(), 3, "a credential replacement discards the cached connection immediately");
});

test("a failed read keeps the last good copy and shows Linear's safe reason", async (t) => {
  let failing = false;
  const linear = workspace({ issues: () => failing
    ? Response.json({ errors: [{ message: "fake-private-provider-detail" }] }, { status: 503 })
    : Response.json(workspaceIssues) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  const signalsBeforeFailure = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length;
  failing = true;
  const poll = harness.behavior.runService("linear-reader");
  t.after(() => poll.controller.abort());
  await until(() => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length > signalsBeforeFailure, "board-changed after the failure");
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual([board.tracker?.state, board.tracker?.message], ["failed", "Linear could not complete the request."]);
  assert.deepEqual(board.openIssues.map((row) => row.id), ["FIX-9"]);
  assert.ok(!JSON.stringify(board).includes("fake-private-provider-detail"));
});

test("the board page renders the RPC board model: Ready, Open issues, reasons and the Linear line", async (t) => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardPage, BoardView } = await import("../board/Board.js");
  const { DoctorChecks } = await import("../board/Doctor.js");
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;

  const html = renderToStaticMarkup(createElement(BoardView, {
    board, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined,
  }));
  assert.equal(visibleText(elements(parse(html)).find((element) => element.tag === "h2" && element.attrs.id === "sq-open-issues-h")!),
    "Open issues", "the section uses the glossary's Open issue term");
  for (const text of ["Fixture team · Fixture project", "The board reads Linear", "Waits on OUT-10 (outside this project)",
    "Doctor checks", "Linear webhooks", "Nothing is flying. Plan the next spec with New spec.", "Start FIX-5"]) {
    assert.ok(html.includes(text), `the board shows ${text}`);
  }
  assert.equal((html.match(/<button[^>]*disabled=""[^>]*>Start<\/button>/g) ?? []).length, 1, "the blocked spec's Start button is disabled");
  assert.ok(!html.includes("Synthetic data"), "the real board carries no synthetic label");

  assert.ok(board.doctor);
  const doctorHtml = renderToStaticMarkup(createElement(DoctorChecks, { report: board.doctor }));
  for (const text of ["Repo rules", "Project settings", "House rules", "This machine", "Present", "/owner/.bb-squadron/playbook.md"]) {
    assert.ok(doctorHtml.includes(text), `Doctor shows ${text}`);
  }

  const page = renderToStaticMarkup(createElement(BoardPage));
  assert.ok(page.includes('aria-checked="false"') && page.includes("Synthetic demo"), "the demo is a switch, off by default");
  assert.ok(!page.includes("Synthetic data") && !page.includes("SQD-"), "no synthetic data before the owner turns the demo on");
  const demo = renderToStaticMarkup(createElement(BoardView, {
    board: { ...board, ready: [{ id: "SQD-40", title: "Invented spec", ticketCount: 1, routes: [], blockedBy: [], acceptOwner: false }] },
    demo: true, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined,
  }));
  assert.ok(demo.includes("Synthetic data"), "demo data is labelled in the header");
});

test("empty, disconnected, unscoped and failed boards each say what to do", async () => {
  await import("./fixtures/app-runtime.js");
  const { liveNotice } = await import("../board/Board.js");
  const base = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, lanes: [], ready: [], shaping: [], openIssues: [] };
  const status = (state: NonNullable<Board["tracker"]>["state"], syncedAt: number | null = null): Board =>
    ({ ...base, tracker: { state, message: "", syncedAt, project: null } });
  assert.equal(liveNotice({ projectId: null, board: null, failed: false }), "Choose a BB project to see its board.");
  assert.equal(liveNotice({ projectId: "p", board: null, failed: false }), "Reading the board.");
  assert.equal(liveNotice({ projectId: "p", board: null, failed: true }), "Couldn't load the board. Make sure BB is running, then try again.");
  assert.equal(liveNotice({ projectId: "p", board: status("disconnected"), failed: false }), "Connect Linear to see this project's issues.");
  assert.equal(liveNotice({ projectId: "p", board: status("unscoped"), failed: false }), "Set this project's Linear Scope in docs/agents/squadron.md to see its issues.");
  assert.equal(liveNotice({ projectId: "p", board: status("catching-up"), failed: false }), "Reading this project's issues from Linear.");
  assert.equal(liveNotice({ projectId: "p", board: status("failed", 1), failed: false }), null, "a failed read keeps the last copy");
});


test("repeated signals with no change in the board model publish nothing", async (t) => {
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  const auth = registerLinearAuth(bb);
  const mirror = registerLinearReader(bb, auth);
  const board = registerBoard(bb, { connection: () => auth.getConnection(), tracker: registerTracker(bb, mirror) });
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  const before = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length;
  await Promise.all([board.refresh("proj-one"), board.refresh("proj-one"), board.refresh("proj-one")]);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  assert.equal(harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length, before);
});

test("the plugin exposes no Linear write tools or OAuth controls", async (t) => {
  const { bb, harness } = host({});
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  assert.deepEqual(harness.registrations.agentTools, []);
  for (const rpc of ["linear.connect", "linear.disconnect", "linear.setup", "linear.outboxResume"]) {
    await assert.rejects(harness.behavior.callRpc(rpc, null), /has no rpc method/);
  }
  assert.deepEqual(Object.keys(harness.registrations.settingsDescriptors), ["linearApiKey", "dailySummaryTime"]);
});


test("an outside ready work item keeps its kind and read-only controls through the board reader", async (t) => {
  const linear = workspace({ issues: () => Response.json({ data: { issues: {
    ...workspaceIssues.data.issues, nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-9"
      ? { ...node, labels: { ...node.labels, nodes: [{ id: "ready", name: "ready-for-agent", color: "#000000" }] } } : node),
  } } }) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  harness.sdk.stub("threads.list", async ({ originPluginId, parentThreadId }) => originPluginId || parentThreadId ? [] : [
    makeThreadResponse({ id: "outside", originPluginId: null, projectId: "proj-one", title: "Fix FIX-9", status: "active" }),
  ]);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  harness.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: "fixture", reasoningLevel: "medium" }));
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes[0].kind, "work-item");
  assert.equal(board.lanes[0].outside, true);
  assert.deepEqual(board.lanes[0].tickets, []);
  assert.ok(!board.ready.some((row) => row.id === "FIX-9"));
  const document = await boardDocument(board);
  const lane = document.querySelector(".sq-lane-row")!;
  assert.ok(lane.querySelector('[data-term="Work item"]'));
  assert.equal(lane.querySelector('[data-term="Spec"]'), null);
  assert.match(lane.textContent ?? "", /Read-only: Squadron didn't start this lane/);
  assert.ok(![...lane.querySelectorAll("button")].some((button) => ["Start", "Stop", "Resume", "Merge"].includes(button.textContent ?? "")));
  for (const action of ["start", "stop", "resume", "merge"]) {
    await assert.rejects(harness.behavior.callRpc(`lane.${action}`, { projectId: "proj-one", specId: "FIX-9" }), /started outside Squadron/);
  }
  assert.equal(harness.inspection.sdk.callsTo("threads.send").length, 0);
});

test("Landed rows retain each work kind and the spec's total ticket count at both placements", async () => {
  const lane = { specId: "FIX-1", title: "Delivered", lead: { family: "gpt" as const, model: "fixture", effort: "medium" as const },
    leadThreadId: "delivered", acceptOwner: false, branch: "delivered", state: "landed" as const, minutes: 12, tickets: [], totalTicketCount: 5 };
  const board: Board = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, ready: [], shaping: [], openIssues: [],
    lanes: [{ ...lane, kind: "spec" }, { ...lane, specId: "FIX-2", kind: "work-item", totalTicketCount: 0 }] };
  for (const placement of ["page", "panel"] as const) {
    const document = await boardDocument(board, placement);
    const rows = [...document.querySelectorAll(".sq-landed-row")];
    assert.equal(rows.length, 2);
    for (const row of rows) row.querySelectorAll('[role="tooltip"]').forEach((tip) => tip.remove());
    assert.equal(rows[0].querySelector(".sq-work-kind")?.textContent, "Spec · 5 tickets");
    assert.equal(rows[1].querySelector(".sq-work-kind")?.textContent, "Work item");
  }
});
