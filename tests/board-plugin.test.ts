// Spec A's end-to-end test: the real server.ts on the SDK's fake plugin host,
// a recorded Linear workspace behind fetch, and the board read through RPC.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { Board } from "../lib/board-model.js";
import { registerLinearAuth } from "../lib/linear-auth.js";
import { registerLinearReader } from "../lib/linear-reader.js";
import { registerBoard } from "../lib/board-service.js";
import { registerTracker } from "../lib/tracker-service.js";
import { binding, workspace, workspaceIssues } from "./fixtures/board-workspace.js";

const settingsFile = readFileSync("tests/fixtures/squadron.md", "utf8");

function host(settings: Record<string, string> = { linearApiKey: "fake-board-e2e-key" }) {
  return createFakePluginHost({
    pluginId: "squadron",
    experimental_hostEntry: true,
    settings,
    sdk: {
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

test("install, bind a recorded workspace, sync it and read the real board through RPC", async (t) => {
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.lifecycle.install();

  const unbound = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(unbound.linear?.state, "unbound");
  assert.deepEqual([unbound.ready, unbound.openIssues], [[], []]);

  await harness.behavior.callRpc("linear.bind", binding);
  await until(() => harness.inspection.realtimeSignals.some((signal) => signal.channel === "board-changed"), "board-changed");
  assert.deepEqual(harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").at(-1)?.payload,
    { projectId: "proj-one" });

  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.linear?.state, "current");
  assert.equal(board.linear?.project, "Fixture team · Fixture project");
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
  await harness.behavior.callRpc("linear.bind", binding);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  const before = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length;
  changed = true;
  const poll = harness.behavior.runService("linear-reader");
  t.after(() => poll.controller.abort());
  await until(() => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length > before, "board-changed after the poll");
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.openIssues.map((row) => row.id), ["FIX-9", "FIX-12"]);
});

test("a reload keeps the binding and rebuilds the board from Linear without a stored snapshot", async (t) => {
  let changed = false;
  const linear = workspace({ issues: () => changed ? withNewIssue() : Response.json(workspaceIssues) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const first = host();
  await plugin(first.bb);
  await first.harness.behavior.callRpc("linear.bind", binding);
  changed = true;
  const { harness } = await first.harness.lifecycle.reload((api) => plugin(api));
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });

  const snapshot = await harness.behavior.callRpc("linear.snapshot", { bbProjectId: "proj-one" }) as {
    binding: { project: { id: string } }; issues: unknown[]; syncedAt: number | null;
  };
  assert.equal(snapshot.binding.project.id, "linear-one");
  assert.deepEqual(snapshot.issues, [], "issues are held only in memory");
  assert.equal(snapshot.syncedAt, null);
  // The poller reads only projects a board page shows (SIZE-953); this page shows proj-one.
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  const poll = harness.behavior.runService("linear-reader");
  t.after(() => poll.controller.abort());
  await until(() => linear.operations.filter((name) => name === "SquadronVocabulary").length >= 2, "full read after reload");
  await until(() => harness.inspection.realtimeSignals.some((signal) => signal.channel === "linear-mirror-changed"), "fresh snapshot");
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.linear?.state, "current");
  assert.deepEqual(board.openIssues.map((row) => row.id), ["FIX-9", "FIX-12"]);
});

test("without a Linear credential the board asks the owner to connect and reads nothing", async (t) => {
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host({});
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.linear, { state: "disconnected", message: "Connect Linear in Squadron settings.", syncedAt: null, project: null });
  assert.deepEqual(linear.operations, []);
});

test("board RPC refreshes reuse identity for a minute and invalidate it when credentials change", async (t) => {
  const linear = workspace();
  const { bb, harness } = host();
  t.after(() => harness.lifecycle.dispose());
  let now = Date.now();
  const auth = registerLinearAuth(bb, { fetch: linear.fetch, now: () => now });
  const mirror = registerLinearReader(bb, auth);
  registerBoard(bb, { connection: auth.getConnection, tracker: registerTracker(bb, mirror) }, { now: () => now });
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
  await harness.behavior.callRpc("linear.bind", binding);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  const signalsBeforeFailure = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length;
  failing = true;
  const poll = harness.behavior.runService("linear-reader");
  t.after(() => poll.controller.abort());
  await until(() => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "board-changed").length > signalsBeforeFailure, "board-changed after the failure");
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual([board.linear?.state, board.linear?.message], ["failed", "Linear could not complete the request."]);
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
  await harness.behavior.callRpc("linear.bind", binding);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;

  const html = renderToStaticMarkup(createElement(BoardView, {
    board, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined,
  }));
  assert.match(html, /<h2[^>]*>Open issues<\/h2>/, "the section uses the glossary's Open issue term");
  for (const text of ["Fixture team · Fixture project", "The board reads Linear", "Waits on OUT-10 (outside this project)",
    "Doctor checks", "Linear webhooks", "No lanes flying."]) {
    assert.ok(html.includes(text), `the board shows ${text}`);
  }
  assert.equal((html.match(/<button[^>]*disabled=""[^>]*>Start<\/button>/g) ?? []).length, 1, "the blocked spec's Start button is disabled");
  assert.ok(!html.includes("Synthetic data"), "the real board carries no synthetic label");

  assert.ok(board.doctor);
  const doctorHtml = renderToStaticMarkup(createElement(DoctorChecks, { report: board.doctor }));
  for (const text of ["Repo rules", "Project settings", "Playbook", "Machine profile", "Present", "/owner/.bb-squadron/playbook.md"]) {
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

test("empty, disconnected, unbound and failed boards each say what to do", async () => {
  await import("./fixtures/app-runtime.js");
  const { liveNotice } = await import("../board/Board.js");
  const base = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, lanes: [], ready: [], openIssues: [] };
  const status = (state: NonNullable<Board["linear"]>["state"], syncedAt: number | null = null): Board =>
    ({ ...base, linear: { state, message: "", syncedAt, project: null } });
  assert.equal(liveNotice({ projectId: null, board: null, failed: false }), "Choose a BB project to see its board.");
  assert.equal(liveNotice({ projectId: "p", board: null, failed: false }), "Reading the board.");
  assert.equal(liveNotice({ projectId: "p", board: null, failed: true }), "Couldn't load the board. Make sure BB is running, then try again.");
  assert.equal(liveNotice({ projectId: "p", board: status("disconnected"), failed: false }), "Connect Linear to see this project's issues.");
  assert.equal(liveNotice({ projectId: "p", board: status("unbound"), failed: false }), "Choose this project's Linear team and project above.");
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
  await harness.behavior.callRpc("linear.bind", binding);
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
  assert.deepEqual(Object.keys(harness.registrations.settingsDescriptors), ["linearApiKey"]);
});
