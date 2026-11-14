import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { Board } from "../lib/board-model.js";
import { binding, workspace, workspaceIssues } from "./fixtures/board-workspace.js";

const settingsFile = readFileSync("tests/fixtures/squadron.md", "utf8");
const skillNames = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];
function nativeThreads() {
  return { count: 0, threads: new Map<string, ReturnType<typeof makeThreadResponse>>(),
    metadata: new Map<string, Record<string, unknown>>(), routes: new Map<string, { model: string; reasoningLevel: string }>() };
}
function host(native = nativeThreads()) {
  const { threads, metadata, routes } = native;
  return { native, ...createFakePluginHost({
    pluginId: "squadron", experimental_hostEntry: true,
    settings: { linearApiKey: "fake-start-key" },
    sdk: {
      projects: { get: async ({ projectId }) => ({
        id: projectId, name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId, hostId: "repo-machine", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }],
      }) },
      files: { read: async ({ path }) => {
        assert.equal(path, "/repo/docs/agents/squadron.md");
        return { content: settingsFile, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: settingsFile.length };
      } },
      skills: { list: async () => ({ skills: ["claude-code", "codex"].flatMap((provider) => skillNames.map((name) => ({
        id: `${provider}-${name}`, name: `mattpocock-skills:${name}`, description: null,
        filePath: `/plugins/${provider}/${name}/SKILL.md`, manageable: false, pluginId: "mattpocock-skills", provider,
        registrySkillId: null, scope: "plugin" as const,
      }))) }) },
      threads: {
        list: async () => [...threads.values()].map((thread) => ({ ...thread, environmentBranchName: "spec/fix-5" })),
        getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
        defaultExecutionOptions: async ({ threadId }) => ({ ...routes.get(threadId)!, permissionMode: "auto", serviceTier: "default", source: "client/turn/start" }),
        spawn: async (args) => {
          const thread = makeThreadResponse({ id: `thr_lead_${++native.count}`, projectId: args.projectId,
            providerId: args.providerId, environmentId: `env_lead_${native.count}`, status: "active", createdAt: Date.now() });
          threads.set(thread.id, thread); metadata.set(thread.id, args.pluginMetadata ?? {});
          routes.set(thread.id, { model: args.model!, reasoningLevel: args.reasoningLevel! });
          return thread;
        },
      },
    },
    experimental_callHostRpc: async ({ method, input }) => method === "githubLogin" ? { authenticated: true } : {
      homePath: "/owner", repoRulesExists: true, playbookExists: false, machineProfileExists: false,
      setupFiles: ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"],
      regularSkillFiles: (input as { skillPaths: string[] }).skillPaths,
    },
  }) };
}
async function setup(t: import("node:test").TestContext, issues?: () => Response) {
  const linear = workspace({ issues });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness, native } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("linear.bind", binding);
  return { harness, native };
}

test("Start spawns one visible Lead on the spec's default route with metadata, a new worktree and only context pointers", async (t) => {
  const { harness } = await setup(t);
  const started = await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  assert.deepEqual(started, { threadId: "thr_lead_1" });
  const spawns = harness.inspection.sdk.callsTo("threads.spawn");
  assert.equal(spawns.length, 1);
  const args = spawns[0][0] as Record<string, unknown>;
  assert.equal(args.providerId, "codex");
  assert.equal(args.model, "gpt-6.1-sol");
  assert.equal(args.reasoningLevel, "high");
  assert.equal(args.serviceTier, "default");
  assert.equal(args.visibility, "visible");
  assert.equal(args.title, "Lead FIX-5");
  assert.deepEqual(args.pluginMetadata, { role: "lead", specId: "fix-5" });
  assert.deepEqual(args.environment, { type: "host", hostId: "repo-machine", workspace: {
    type: "managed-worktree", baseBranch: { kind: "default" },
  } });
  assert.equal(args.prompt, [
    "Use the squadron-lead skill for this spec.", "", "Spec: https://linear.app/fixture/issue/FIX-5",
    "Repo rules: AGENTS.md and docs/agents/", "Project settings: docs/agents/squadron.md",
    "Playbook: /owner/.bb-squadron/playbook.md", "Machine profile: /owner/.bb-squadron/machine.md",
  ].join("\n"));
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.lanes.map(({ specId, state, leadThreadId }) => [specId, state, leadThreadId]), [["FIX-5", "flying", "thr_lead_1"]]);
  assert.deepEqual(board.ready.map((row) => row.id), ["FIX-1"]);
});

test("Start uses the first matching spec label rather than a ticket's route", async (t) => {
  const { harness } = await setup(t, () => Response.json({ data: { issues: {
    ...workspaceIssues.data.issues, nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-5" ? {
      ...node, labels: { ...node.labels, nodes: [...node.labels.nodes, { id: "label-ui", name: "ui", color: "#0000aa" }] },
    } : node),
  } } }));
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  const args = harness.inspection.sdk.callsTo("threads.spawn")[0][0] as Record<string, unknown>;
  assert.deepEqual([args.providerId, args.model, args.reasoningLevel], ["claude-code", "claude-opus-5-5", "high"]);
});

test("blocked specs and failing fresh Doctor checks refuse Start without spawning", async (t) => {
  const { harness } = await setup(t);
  await assert.rejects(harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-1" }), /Waits on OUT-10/);
  await assert.rejects(harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-9" }), /isn't a ready spec/);
  await assert.rejects(harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" },
    { experimental_caller: { kind: "plugin", pluginId: "other" } }), /from the Squadron board/);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  harness.sdk.stub("skills.list", async () => ({ skills: [] }));
  await assert.rejects(harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" }), /Install Matt Pocock's skills plugin/);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("double clicks share one Lead and later Start calls find it in BB metadata", async (t) => {
  const { harness } = await setup(t);
  const start = () => harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  assert.deepEqual(await Promise.all([start(), start(), start()]), Array(3).fill({ threadId: "thr_lead_1" }));
  assert.deepEqual(await start(), { threadId: "thr_lead_1" });
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
});

test("reload and fresh plugin storage reconstruct Flying from BB metadata, without a second Lead", async (t) => {
  const { harness: first, native } = await setup(t);
  await first.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  native.threads.set("thr_lead_1", { ...native.threads.get("thr_lead_1")!, title: "Renamed Lead" });
  const { harness: reloaded } = await first.lifecycle.reload(plugin);
  t.after(() => reloaded.lifecycle.dispose());
  await reloaded.behavior.callRpc("linear.bind", binding);
  const board = await reloaded.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes[0].leadThreadId, "thr_lead_1");
  assert.deepEqual(await reloaded.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" }), { threadId: "thr_lead_1" });
  assert.equal(reloaded.inspection.sdk.callsTo("threads.spawn").length, 0);

  // An entirely new host has empty plugin storage, while BB's own threads survive.
  const fresh = host(native);
  t.after(() => fresh.harness.lifecycle.dispose());
  await plugin(fresh.bb);
  const unbound = await fresh.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(unbound.linear?.state, "unbound", "wiping plugin storage loses the binding");
  await fresh.harness.behavior.callRpc("linear.bind", binding);
  const restored = await fresh.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(restored.lanes, board.lanes);
  assert.deepEqual(await fresh.harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" }), { threadId: "thr_lead_1" });
  assert.equal(fresh.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("the bundled Lead skill points to installed Matt skills and adds BB lane rules without Squadron tools", () => {
  const skill = readFileSync("skills/squadron-lead/SKILL.md", "utf8");
  assert.match(skill, /^---\nname: squadron-lead\ndescription: .+\n---\n/);
  for (const pointer of ["`implement-spec`", "`tdd`", "`code-review`", "AGENTS.md", "docs/agents/squadron.md",
    "playbook", "machine profile", "parent-self", "accept:owner", "two strikes", "Stop", "Resume", "status mapping"]) {
    assert.ok(skill.includes(pointer), `the Lead skill names ${pointer}`);
  }
  assert.ok(!/squadron_\w+/.test(skill), "the Lead names no Squadron agent tools");
  assert.ok(skill.split(/\s+/).length < 700, "the wrapper stays about one page");
});

test("Start on the board opens the Lead beside it, refreshes the board, and reports refusals", async () => {
  await import("./fixtures/app-runtime.js");
  const { startFromBoard } = await import("../board/Board.js");
  const opened: string[] = [];
  const notes: string[] = [];
  const inputs: unknown[] = [];
  let refreshed = 0;
  const run = (result: () => Promise<{ threadId: string }>) => startFromBoard({
    start: async (input) => { inputs.push(input); return result(); },
    openThread: (threadId) => opened.push(threadId), notify: (text) => notes.push(text),
    refresh: async () => { refreshed++; },
  }, "proj-one", "FIX-5");
  await run(async () => ({ threadId: "thr_lead" }));
  await run(async () => { throw new Error("Install Matt's plugin in Codex."); });
  assert.deepEqual(inputs, [{ projectId: "proj-one", specId: "FIX-5" }, { projectId: "proj-one", specId: "FIX-5" }]);
  assert.deepEqual(opened, ["thr_lead"]);
  assert.deepEqual(notes, ["Install Matt's plugin in Codex."]);
  assert.equal(refreshed, 2, "a refusal refreshes the Start reason too");
});

test("the Start button announces opening and waits while its Lead is created", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const board: Board = { tick: 0, laneCapacity: 0, workersPerLane: 0, autoStart: false, lanes: [], unplanned: [], ready: [{
    id: "FIX-5", title: "Doctor checks", ticketCount: 1, routes: [], blockedBy: [], acceptOwner: false, startReason: null,
  }, {
    id: "FIX-8", title: "Another spec", ticketCount: 1, routes: [], blockedBy: [], acceptOwner: false, startReason: null,
  }] };
  const html = renderToStaticMarkup(createElement(BoardView, {
    board, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined, starting: "FIX-5",
  }));
  assert.match(html, /<button[^>]*disabled=""[^>]*>Opening…<\/button>/);
  assert.match(html, /role="status">Opening its Lead thread/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Start<\/button>/, "other Starts wait instead of silently ignoring a click");
});
