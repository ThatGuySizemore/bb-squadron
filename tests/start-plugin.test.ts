import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createDoctorHost } from "../host.js";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { Board } from "../lib/board-model.js";
import { workspace, workspaceIssues } from "./fixtures/board-workspace.js";

const settingsFile = readFileSync("tests/fixtures/squadron.md", "utf8");
const skillNames = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];
function nativeThreads() {
  return { count: 0, threads: new Map<string, ReturnType<typeof makeThreadResponse>>(),
    metadata: new Map<string, Record<string, unknown>>(), routes: new Map<string, { model: string; reasoningLevel: string }>() };
}
function host(native = nativeThreads(), ownerHost?: ReturnType<typeof experimental_createHostEntryHarness>, settings = settingsFile) {
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
        if (path === "/repo/docs/agents/issue-tracker.md") {
          const content = readFileSync("tests/fixtures/trackers/bb-squadron.md", "utf8");
          return { content, contentEncoding: "utf8", path, sha256: "tracker", sizeBytes: content.length };
        }
        assert.equal(path, "/repo/docs/agents/squadron.md");
        return { content: settings, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: settings.length };
      } },
      skills: { list: async () => ({ skills: ["claude-code", "codex"].flatMap((provider) => skillNames.map((name) => ({
        id: `${provider}-${name}`, name: `mattpocock-skills:${name}`, description: null,
        filePath: `/plugins/${provider}/${name}/SKILL.md`, manageable: false, pluginId: "mattpocock-skills", provider,
        registrySkillId: null, scope: "plugin" as const,
      }))) }) },
      threads: {
        list: async (args) => [...threads.values()].filter((thread) => (!args?.projectId || thread.projectId === args.projectId) && (!args?.parentThreadId || thread.parentThreadId === args.parentThreadId))
          .map((thread) => ({ ...thread, environmentBranchName: "spec/fix-5" })),
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
      ...(ownerHost ? await ownerHost.experimental_call("inspectFiles", { checkoutPath: "/repo", skillPaths: [] }) as Record<string, unknown> : {}),
      setupFiles: ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"],
      regularSkillFiles: (input as { skillPaths: string[] }).skillPaths,
    },
  }) };
}
async function setup(t: import("node:test").TestContext, issues?: () => Response, ownerHost?: ReturnType<typeof experimental_createHostEntryHarness>, settings = settingsFile) {
  const linear = workspace({ issues });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness, native } = host(undefined, ownerHost, settings);
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
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
  assert.deepEqual(args.pluginMetadata, { role: "lead", specId: "fix-5", startedBy: "owner" });
  assert.deepEqual(args.environment, { type: "host", hostId: "repo-machine", workspace: {
    type: "managed-worktree", baseBranch: { kind: "default" },
  } });
  assert.equal(args.prompt, [
    "Use the squadron-lead skill for this spec.", "", "Spec: https://linear.app/fixture/issue/FIX-5",
    "Repo rules: AGENTS.md and docs/agents/", "Project settings: docs/agents/squadron.md",
    "House rules: /owner/.bb-squadron/house-rules.md", "This machine: /owner/.bb-squadron/machine.md",
    "Held tickets carry one of these labels or Status lines: hold, needs-triage, needs-info, ready-for-human, wontfix.",
  ].join("\n"));
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.lanes.map(({ specId, state, leadThreadId }) => [specId, state, leadThreadId]), [["FIX-5", "flying", "thr_lead_1"]]);
  assert.deepEqual(board.ready.map((row) => row.id), ["FIX-1"]);
});

test("Without a Lead row, Start uses the first matching spec label rather than a ticket's route", async (t) => {
  const { harness } = await setup(t, () => Response.json({ data: { issues: {
    ...workspaceIssues.data.issues, nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-5" ? {
      ...node, labels: { ...node.labels, nodes: [...node.labels.nodes, { id: "label-ui", name: "ui", color: "#0000aa" }] },
    } : node),
  } } }));
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  const args = harness.inspection.sdk.callsTo("threads.spawn")[0][0] as Record<string, unknown>;
  assert.deepEqual([args.providerId, args.model, args.reasoningLevel], ["claude-code", "claude-opus-5-5", "high"]);
});

test("Start uses the Lead row even on a ui spec and keeps ticket routes separate", async (t) => {
  const settings = settingsFile.replace("| `ui`", "| Lead | GPT | gpt-6.1-sol | medium |\n| `ui`");
  const { harness } = await setup(t, () => Response.json({ data: { issues: {
    ...workspaceIssues.data.issues, nodes: workspaceIssues.data.issues.nodes.map((node) => ({
      ...node, labels: { ...node.labels, nodes: [...node.labels.nodes, { id: "label-ui", name: "ui", color: "#0000aa" }] },
    })),
  } } }), undefined, settings);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  const args = harness.inspection.sdk.callsTo("threads.spawn")[0][0] as Record<string, unknown>;
  assert.deepEqual([args.providerId, args.model, args.reasoningLevel], ["codex", "gpt-6.1-sol", "medium"]);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.lanes[0].tickets[0].route, { family: "claude", model: "claude-opus-5-5", effort: "high" });
  assert.deepEqual(board.lanes[0].reviewer, { family: "claude", model: "claude-opus-5-5", effort: "high" });
});

test("a ready-marked spec with open planning is Shaping in the board and picker and cannot Start through RPC", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("projects.list", async () => [{ id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }]);
  await harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-5" });
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.shaping.map((row) => row.id), ["FIX-5"]);
  assert.deepEqual(board.ready.map((row) => row.id), ["FIX-1"]);
  const counts = await harness.behavior.callRpc("board.projectCounts", null) as { projects: { ready: number }[] };
  assert.equal(counts.projects[0].ready, 1);
  await assert.rejects(harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" }), /isn't a ready spec/);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1, "only the planning thread was spawned");
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
  await reloaded.behavior.callRpc("board", { projectId: "proj-one" });
  const board = await reloaded.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes[0].leadThreadId, "thr_lead_1");
  assert.deepEqual(await reloaded.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" }), { threadId: "thr_lead_1" });
  assert.equal(reloaded.inspection.sdk.callsTo("threads.spawn").length, 0);

  // An entirely new host has empty plugin storage, while BB's own threads survive.
  const fresh = host(native);
  t.after(() => fresh.harness.lifecycle.dispose());
  await plugin(fresh.bb);
  // The Scope lives in the repo, so empty plugin storage loses nothing.
  const restored = await fresh.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(restored.tracker?.state, "current");
  assert.deepEqual(restored.lanes, board.lanes);
  assert.deepEqual(await fresh.harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" }), { threadId: "thr_lead_1" });
  assert.equal(fresh.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("a Flying lane links its worker threads and reads its PR only from BB's pull-request plugin", async (t) => {
  const { harness, native } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  for (const [id, title] of [["thr_worker", "Worker FIX-6"], ["thr_other", "Reviewer"]]) {
    native.threads.set(id, makeThreadResponse({ id, title, projectId: "proj-one", parentThreadId: "thr_lead_1", createdAt: Date.now() }));
  }
  const reads: unknown[] = [];
  harness.sdk.stub("plugins.callRpc", async (args: { pluginId: string; method: string; input: unknown }) => {
    reads.push([args.pluginId, args.method, args.input]);
    return { env_lead_1: { outcome: "available", pullRequest: {
      number: 7, title: "FIX-5", state: "open", url: "https://github.com/fixture/repo/pull/7", baseRefName: "main",
      headRefName: "spec/fix-5", updatedAt: "2026-11-13T20:00:00Z", autoMerge: false, inMergeQueue: null,
      checks: { state: "pending", totalCount: 1, passedCount: 0, failedCount: 0, pendingCount: 1 },
      review: { state: "none", reviewRequestCount: 0 },
      mergeability: { state: "unknown", mergeStateStatus: null, mergeable: null }, attention: "checks_pending",
    } } };
  });
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  const lane = board.lanes[0];
  assert.deepEqual(reads, [["bb--github-pr-status", "pullRequests", { keys: ["env_lead_1"] }]]);
  assert.equal(lane.state, "pr-open");
  assert.deepEqual(lane.pr, { number: 7, state: "open", checks: "pending", url: "https://github.com/fixture/repo/pull/7" });
  assert.deepEqual(lane.tickets.map((ticket) => [ticket.id, ticket.threadId]), [["FIX-6", "thr_worker"]]);
  assert.deepEqual(lane.unmatchedThreads, [{ threadId: "thr_other", title: "Reviewer" }]);

  harness.sdk.stub("plugins.callRpc", async () => { throw new Error("plugin not installed"); });
  const without = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(without.lanes[0].state, "flying", "without the pull-request plugin the lane shows no PR");
  assert.equal(without.lanes[0].pr, undefined);
});

test("the bundled Lead skill points to installed Matt skills and adds BB lane rules without Squadron tools", () => {
  const skill = readFileSync("skills/squadron-lead/SKILL.md", "utf8");
  assert.match(skill, /^---\nname: squadron-lead\ndescription: .+\n---\n/);
  for (const pointer of ["`implement-spec`", "`tdd`", "`code-review`", "AGENTS.md", "docs/agents/squadron.md",
    "House rules", "This machine", "parent-self", "accept:owner", "two strikes", "Stop", "Resume", "status mapping"]) {
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
  const board: Board = { tick: 0, laneCapacity: 0, workersPerLane: 0, autoStart: false, lanes: [], shaping: [], openIssues: [], ready: [{
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

/** Everything the plugin stores: its database rows and kv keys. */
async function stored(bb: import("@get-bb/plugin-sdk").BbPluginApi) {
  const db = bb.storage.database();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]);
  return { tables, kv: await bb.storage.kv.list() };
}

test("Stop and Resume send their fixed message to the spec's own Lead and store nothing", async (t) => {
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness, native } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  // Another spec's Lead must not receive this lane's messages.
  native.threads.set("thr_other", makeThreadResponse({ id: "thr_other", projectId: "proj-one", providerId: "codex", status: "active" }));
  native.metadata.set("thr_other", { role: "lead", specId: "fix-1" });
  native.routes.set("thr_other", { model: "gpt-6.1-sol", reasoningLevel: "high" });
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  const sent: { threadId: string; text: string }[] = [];
  harness.sdk.stub("threads.send", async (raw: unknown) => {
    const args = raw as Parameters<typeof bb.sdk.threads.send>[0];
    const [part] = args.input;
    sent.push({ threadId: args.threadId, text: part.type === "text" ? part.text : "" });
    return { ok: true, delivery: "sent" } as Awaited<ReturnType<typeof bb.sdk.threads.send>>;
  });
  const before = await stored(bb);

  assert.deepEqual(await harness.behavior.callRpc("lane.stop", { projectId: "proj-one", specId: "FIX-5" }), { threadId: "thr_lead_1" });
  assert.deepEqual(await harness.behavior.callRpc("lane.resume", { projectId: "proj-one", specId: "FIX-5" }), { threadId: "thr_lead_1" });

  assert.deepEqual(sent.map(({ threadId }) => threadId), ["thr_lead_1", "thr_lead_1"]);
  const [stop, resume] = sent.map(({ text }) => text);
  assert.match(stop, /wind/i);
  assert.match(stop, /work in progress to (its|their) branch/i);
  assert.match(stop, /summary on the spec/i);
  assert.match(resume, /carry on from your last summary/i);
  for (const text of [stop, resume]) {
    assert.match(text, /progress only/i, "the message limits ticket comments to progress");
    assert.doesNotMatch(text, /paused|don't start|do not start/i, "a stop is never written as a standing order");
  }
  assert.deepEqual(await stored(bb), before, "Stop and Resume store nothing");
  await assert.rejects(harness.behavior.callRpc("lane.stop", { projectId: "proj-one", specId: "FIX-9" }), /no Lead/);
  await assert.rejects(harness.behavior.callRpc("lane.stop", { projectId: "proj-one", specId: "FIX-5" },
    { experimental_caller: { kind: "plugin", pluginId: "other" } }), /from the Squadron board/);
  assert.equal(sent.length, 2);
});

test("Stop and Resume on the board message the Lead, say what happened, and refresh the board", async () => {
  await import("./fixtures/app-runtime.js");
  const { messageLeadFromBoard } = await import("../board/Board.js");
  const sent: unknown[] = [];
  const notes: string[] = [];
  let refreshed = 0;
  const run = (type: "stop" | "resume", result: () => Promise<{ threadId: string }>) => messageLeadFromBoard({
    send: async (kind, input) => { sent.push([kind, input]); return result(); },
    notify: (text) => notes.push(text), refresh: async () => { refreshed++; },
  }, "proj-one", { type, specId: "FIX-5" });
  await run("stop", async () => ({ threadId: "thr_lead" }));
  await run("resume", async () => ({ threadId: "thr_lead" }));
  await run("stop", async () => { throw new Error("FIX-5 has no Lead thread in this project. Read the board again."); });
  assert.deepEqual(sent, [["stop", { projectId: "proj-one", specId: "FIX-5" }], ["resume", { projectId: "proj-one", specId: "FIX-5" }],
    ["stop", { projectId: "proj-one", specId: "FIX-5" }]]);
  assert.deepEqual(notes, [
    "Asked the Lead for FIX-5 to wind down. Its workers save their work first.",
    "Asked the Lead for FIX-5 to carry on from its last summary.",
    "FIX-5 has no Lead thread in this project. Read the board again.",
  ]);
  assert.equal(refreshed, 3);
});

test("Needs you names each kind in words and offers its one action; lane buttons wait while a message is sent", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const lane = (specId: string, state: "flying" | "stopped", needs?: NonNullable<Board["lanes"][number]["needs"]>) => ({
    specId, title: `Spec ${specId}`, lead: { family: "gpt" as const, model: "gpt-6.1-sol", effort: "high" as const },
    leadThreadId: `thr_${specId}`, branch: "", state, minutes: 3, acceptOwner: false, tickets: [], ...(needs ? { needs } : {}),
  });
  const board: Board = { tick: 0, laneCapacity: 0, workersPerLane: 0, autoStart: false, ready: [], shaping: [], openIssues: [], lanes: [
    lane("FIX-1", "flying", [{ threadId: "thr_w1", kind: "waiting", text: "Worker FIX-2 is waiting on you." }]),
    lane("FIX-3", "flying", [{ threadId: "thr_w3", kind: "failed", text: "Worker FIX-4 failed. Open it to see why." }]),
    lane("FIX-5", "stopped"),
  ] };
  const render = (acting: { specId: string; type: "stop" | "resume" } | null) => renderToStaticMarkup(createElement(BoardView, {
    board, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined, acting,
  }));
  const html = render(null);
  for (const [kind, action] of [["Question", "Answer in thread"], ["Failed", "Open thread"], ["Stopped", "Resume"]]) {
    assert.match(html, new RegExp(`sq-need-kind">${kind}<[\\s\\S]*?>${action}</button>`), `${kind} offers ${action}`);
  }
  assert.doesNotMatch(html, /Re-plan|Prototype/, "the live strip has no prototype actions");
  assert.match(html, />Stop<\/button>/);
  const stopping = render({ specId: "FIX-1", type: "stop" });
  assert.match(stopping, /role="status">Asking the Lead to wind down/);
  assert.match(stopping, /<button[^>]*disabled=""[^>]*>Stopping…<\/button>/);
  assert.doesNotMatch(stopping, /<button(?![^>]*disabled)[^>]*>(Stop|Resume)<\/button>/, "other lane messages wait");
});

test("Merge squash-merges the lane's PR through BB's pull-request plugin, and refuses unless its checks pass", async (t) => {
  const { harness } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  let checks = "failing";
  const calls: unknown[] = [];
  harness.sdk.stub("plugins.callRpc", async (args: { pluginId: string; method: string; input: unknown }) => {
    calls.push([args.pluginId, args.method, args.input]);
    if (args.method === "merge") return { message: "Merged pull request #7." };
    return { env_lead_1: { outcome: "available", pullRequest: {
      number: 7, title: "FIX-5", state: "open", url: "https://github.com/fixture/repo/pull/7", baseRefName: "main",
      headRefName: "spec/fix-5", updatedAt: "2026-11-13T20:00:00Z", autoMerge: false, inMergeQueue: null,
      checks: { state: checks, totalCount: 1, passedCount: 0, failedCount: 1, pendingCount: 0 },
      review: { state: "none", reviewRequestCount: 0 },
      mergeability: { state: "mergeable", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" }, attention: "none",
    } } };
  });
  const merge = () => harness.behavior.callRpc("lane.merge", { projectId: "proj-one", specId: "FIX-5" });

  await assert.rejects(merge(), /checks/i);
  assert.ok(!calls.some((call) => (call as unknown[])[1] === "merge"), "failing checks never reach the merge call");

  checks = "passing";
  assert.deepEqual(await merge(), { number: 7 });
  assert.deepEqual(calls.filter((call) => (call as unknown[])[1] === "merge"),
    [["bb--github-pr-status", "merge", { environmentId: "env_lead_1", method: "squash" }]]);

  await assert.rejects(harness.behavior.callRpc("lane.merge", { projectId: "proj-one", specId: "FIX-9" }), /no Lead/);
  await assert.rejects(harness.behavior.callRpc("lane.merge", { projectId: "proj-one", specId: "FIX-5" },
    { experimental_caller: { kind: "plugin", pluginId: "other" } }), /from the Squadron board/);
  assert.equal(calls.filter((call) => (call as unknown[])[1] === "merge").length, 1);
});

test("a lane whose Lead closed its spec and tickets after the merge stays on the board as Landed", async (t) => {
  let closed = false;
  const nodes = workspaceIssues.data.issues.nodes;
  const done = { id: "state-done", name: "Done", type: "completed" };
  const linear = workspace({
    issues: () => Response.json(closed ? { data: { issues: { ...workspaceIssues.data.issues,
      nodes: nodes.filter((node) => node.identifier !== "FIX-5" && node.identifier !== "FIX-6") } } } : workspaceIssues),
    laneSpec: (id) => {
      const spec = nodes.find((node) => node.id === id)!;
      const children = closed ? nodes.filter((node) => node.parent?.id === id).map((node) => ({ ...node, state: done })) : [];
      return Response.json({ data: { issue: { ...spec, ...(closed ? { state: done } : {}),
        children: { nodes: children, pageInfo: { hasNextPage: false, endCursor: null } } } } });
    },
  });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_1: { outcome: "available", pullRequest: {
    number: 7, title: "FIX-5", state: "merged", url: "https://github.com/fixture/repo/pull/7", baseRefName: "main",
    headRefName: "spec/fix-5", updatedAt: "2026-11-13T20:00:00Z", autoMerge: false, inMergeQueue: null,
    checks: { state: "passing", totalCount: 1, passedCount: 1, failedCount: 0, pendingCount: 0 },
    review: { state: "none", reviewRequestCount: 0 },
    mergeability: { state: "unknown", mergeStateStatus: null, mergeable: null }, attention: "none",
  } } }));

  closed = true;
  // The poller reads the shown project again on its next pass.
  const changes = () => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "linear-mirror-changed").length;
  const before = changes();
  const poll = harness.behavior.runService("linear-reader");
  t.after(() => poll.controller.abort());
  for (let i = 0; i < 200 && changes() === before; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.lanes.map((lane) => [lane.specId, lane.state, lane.tickets.map((ticket) => [ticket.id, ticket.state])]),
    [["FIX-5", "landed", [["FIX-6", "done"]]]]);
  assert.ok(linear.operations.includes("SquadronLaneSpec"), "the reader reads the Lead's spec by id");
  assert.ok(!linear.operations.some((name) => /mutation/i.test(name)));
});

test("Merge on the board says which PR merged or why it didn't, and refreshes the board", async () => {
  await import("./fixtures/app-runtime.js");
  const { mergeFromBoard } = await import("../board/Board.js");
  const notes: string[] = [];
  let refreshed = 0;
  const run = (result: () => Promise<{ number: number }>) => mergeFromBoard({
    merge: result, notify: (text) => notes.push(text), refresh: async () => { refreshed++; },
  }, "proj-one", "FIX-5");
  await run(async () => ({ number: 7 }));
  await run(async () => { throw new Error("PR #7 can merge once its checks pass."); });
  assert.deepEqual(notes, ["Squash-merged PR #7 for FIX-5. The lane lands when BB sees the merge.", "PR #7 can merge once its checks pass."]);
  assert.equal(refreshed, 2);
});

async function houseRulesCase(t: import("node:test").TestContext, files: string[], status: string, message: string, selected: string) {
  const owner = await mkdtemp(join(tmpdir(), "squadron-house-rules-"));
  const directory = join(owner, ".bb-squadron");
  await mkdir(directory);
  for (const file of files) await writeFile(join(directory, file), `Private fixture ${file}`);
  const ownerHost = experimental_createHostEntryHarness(createDoctorHost(undefined, () => owner));
  t.after(() => ownerHost.experimental_dispose());
  const { harness } = await setup(t, undefined, ownerHost);
  const report = await harness.behavior.callRpc("doctor", { projectId: "proj-one" }) as import("../lib/doctor.js").DoctorReport;
  assert.equal(report.ready, true, "House rules warnings never block Start");
  const check = report.checks.find((check) => check.name === "House rules");
  assert.equal(check?.status, status);
  assert.equal(check?.message, message.replace("{directory}", directory));
  const file = report.configurationFiles.find((file) => file.name === "House rules");
  assert.equal(file?.path, join(directory, selected));
  assert.equal(file?.exists, files.includes(selected));
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  const args = harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { prompt: string };
  assert.ok(args.prompt.includes(`House rules: ${join(directory, selected)}`));
  assert.ok(!JSON.stringify(report).includes("Private fixture"));
  assert.ok(!args.prompt.includes("Private fixture"));
  assert.deepEqual(await readdir(directory), [...files].sort(), "inspection never renames or creates owner files");
  for (const file of files) assert.equal(await readFile(join(directory, file), "utf8"), `Private fixture ${file}`);
}

test("Doctor and Start use House rules when only house-rules.md exists", async (t) => {
  await houseRulesCase(t, ["house-rules.md"], "pass", "House rules is present.", "house-rules.md");
});

test("Doctor warns to rename playbook.md and Start still points at the existing file", async (t) => {
  await houseRulesCase(t, ["playbook.md"], "warning", "Rename playbook.md to house-rules.md", "playbook.md");
});

test("Doctor warns when both rule files exist and Start prefers house-rules.md", async (t) => {
  await houseRulesCase(t, ["house-rules.md", "playbook.md"], "warning",
    "Both house-rules.md and playbook.md are present. Squadron reads house-rules.md.", "house-rules.md");
});


test("missing House rules warn without blocking Start or creating an owner file", async (t) => {
  await houseRulesCase(t, [], "warning",
    "Optional: create {directory}/house-rules.md from the bundled starter template. This file doesn't block Start.", "house-rules.md");
});


test("Autopilot defaults Off with three lanes, validates owner controls, and survives reload per project", async (t) => {
  const linear = workspace({ issues: () => Response.json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  t.after(() => fetch.mock.restore());
  const { bb, harness } = host();
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const read = (projectId = "proj-one") => harness.behavior.callRpc("autopilot.get", { projectId });
  assert.deepEqual(await read(), { status: "off", laneLimit: 3, consecutiveStops: 0, pauseReason: null });
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 2 });
  assert.deepEqual(await read(), { status: "on", laneLimit: 2, consecutiveStops: 0, pauseReason: null });
  assert.deepEqual(await read("proj-two"), { status: "off", laneLimit: 3, consecutiveStops: 0, pauseReason: null });
  for (const laneLimit of [0, 11, 1.5]) await assert.rejects(harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", laneLimit }));
  await assert.rejects(harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "off" },
    { experimental_caller: { kind: "plugin", pluginId: "other" } }), /board/);
  const reloaded = await harness.lifecycle.reload(plugin);
  t.after(() => reloaded.harness.lifecycle.dispose());
  assert.deepEqual(await reloaded.harness.behavior.callRpc("autopilot.get", { projectId: "proj-one" }),
    { status: "on", laneLimit: 2, consecutiveStops: 0, pauseReason: null });
});


test("Autopilot starts one Ready spec per watcher cycle through Start and stops at its lane limit", async (t) => {
  const { harness, native } = await setup(t, () => Response.json({ data: { issues: {
    ...workspaceIssues.data.issues, nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-1"
      ? { ...node, inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } : node),
  } } }));
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  const cycle = harness.behavior.runService("board-watcher");
  t.after(() => cycle.controller.abort());
  for (let i = 0; i < 200 && native.count === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  cycle.controller.abort(); await cycle.done;
  assert.equal(native.count, 1);
  assert.deepEqual(native.metadata.get("thr_lead_1"), { role: "lead", specId: "fix-1", startedBy: "autopilot" });
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.laneCapacity, 1);
  assert.equal(board.autoStart, true);
  // A manual start still uses precisely the same first message, and may exceed the limit.
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  assert.equal(native.count, 2);
  assert.deepEqual(native.metadata.get("thr_lead_2"), { role: "lead", specId: "fix-5", startedBy: "owner" });
  const spawns = harness.inspection.sdk.callsTo("threads.spawn").map(([args]) => args as { prompt: string });
  assert.equal(spawns[0].prompt.replace("FIX-1", "FIX-5"), spawns[1].prompt);
});

/** A fixture with two unblocked Ready specs, in the board's existing order. */
function twoReady() {
  return Response.json({ data: { issues: { ...workspaceIssues.data.issues,
    nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-1"
      ? { ...node, inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } : node),
  } } });
}
async function watcherCycle(harness: ReturnType<typeof host>["harness"]) {
  const cycle = harness.behavior.runService("board-watcher");
  try { await new Promise((resolve) => setTimeout(resolve, 40)); }
  finally { cycle.controller.abort(); await cycle.done; }
}

test("a board signal starts only one lane with room for more, and the next watcher cycle fills the next slot", async (t) => {
  const { harness, native } = await setup(t, () => Response.json({ data: { issues: { ...workspaceIssues.data.issues,
    nodes: [...workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-1"
      ? { ...node, inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } : node),
      { ...workspaceIssues.data.issues.nodes[3], id: "fix-7", identifier: "FIX-7" },
      { ...workspaceIssues.data.issues.nodes[4], id: "fix-8", identifier: "FIX-8", parent: { id: "fix-7" } }],
  } } }));
  await watcherCycle(harness);
  assert.equal(native.count, 0, "Off never starts a lane");
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 2 });
  for (let i = 0; i < 200 && native.count < 1; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(native.count, 1, "the start's own board signal cannot fill a second slot");
  await watcherCycle(harness);
  assert.equal(native.count, 2);
  assert.deepEqual([...native.metadata.values()].map((item) => item.specId), ["fix-1", "fix-5"]);
  await watcherCycle(harness);
  assert.equal(native.count, 2);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.ready.map((spec) => spec.id), ["FIX-7"], "the third Ready spec waits at the limit");
});

test("a hand-started lane waiting on an owner question retains its Autopilot slot", async (t) => {
  const { harness, native } = await setup(t, twoReady);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-1" });
  const waiting = { ...native.threads.get("thr_lead_1")!, status: "idle" as const, hasPendingInteraction: true };
  native.threads.set(waiting.id, waiting);
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  await watcherCycle(harness);
  assert.equal(native.count, 1);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes[0].needs?.[0].kind, "waiting", "the real pending interaction derives the question");
  assert.deepEqual(board.ready.map((spec) => spec.id), ["FIX-5"]);
});

test("Doctor refuses automatic starts", async (t) => {
  const { harness, native } = await setup(t, twoReady);
  harness.sdk.stub("skills.list", async () => ({ skills: [] }));
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on" });
  await watcherCycle(harness);
  assert.equal(native.count, 0);
  assert.deepEqual(await harness.behavior.callRpc("autopilot.get", { projectId: "proj-one" }),
    { status: "on", laneLimit: 3, consecutiveStops: 0, pauseReason: null });
});

test("an enabled project restarts its watcher without opening the board", async (t) => {
  const { harness, native } = await setup(t, twoReady);
  // Keep the first instance from starting; the replacement has working Doctor fixtures.
  harness.sdk.stub("skills.list", async () => ({ skills: [] }));
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  await watcherCycle(harness);
  assert.equal(native.count, 0);
  const reloaded = await harness.lifecycle.reload(plugin);
  t.after(() => reloaded.harness.lifecycle.dispose());
  await watcherCycle(reloaded.harness);
  assert.equal(native.count, 1);
  assert.deepEqual(native.metadata.get("thr_lead_1"), { role: "lead", specId: "fix-1", startedBy: "autopilot" });
});


test("outside lanes do not consume an Autopilot slot", async (t) => {
  const { harness, native } = await setup(t, twoReady);
  native.threads.set("outside", makeThreadResponse({ id: "outside", title: "Lead FIX-1", projectId: "proj-one", status: "active" }));
  const before = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(before.lanes[0].outside, true);
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  await watcherCycle(harness);
  assert.equal(native.count, 1);
  assert.equal(native.metadata.get("thr_lead_1")?.specId, "fix-5");
});

test("stopped hand-started lanes free their Autopilot slot", async (t) => {
  const { harness, native } = await setup(t, twoReady);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-1" });
  native.threads.set("thr_lead_1", { ...native.threads.get("thr_lead_1")!, status: "idle" });
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  await watcherCycle(harness);
  assert.equal(native.count, 2);
});

test("an Off action cancels an automatic start still checking Doctor", async (t) => {
  const { harness, native } = await setup(t, twoReady);
  let release!: () => void;
  let checking!: () => void;
  const entered = new Promise<void>((resolve) => { checking = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  harness.sdk.stub("skills.list", async () => {
    checking(); await gate;
    return { skills: ["claude-code", "codex"].flatMap((provider) => skillNames.map((name) => ({
      id: `${provider}-${name}`, name: `mattpocock-skills:${name}`, description: null,
      filePath: `/plugins/${provider}/${name}/SKILL.md`, manageable: false, pluginId: "mattpocock-skills", provider,
      registrySkillId: null, scope: "plugin" as const,
    }))) };
  });
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on" });
  await entered;
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "off" });
  release();
  await watcherCycle(harness);
  assert.equal(native.count, 0);
});

test("Autopilot skips a held parent spec even when it still has ready-for-agent and runnable tickets", async (t) => {
  const { harness, native } = await setup(t, () => Response.json({ data: { issues: { ...workspaceIssues.data.issues,
    nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-1" ? {
      ...node, inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      labels: { ...node.labels, nodes: [...node.labels.nodes, { id: "hold", name: "hold", color: "#aaaaaa" }] },
    } : node),
  } } }));
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  await watcherCycle(harness);
  assert.deepEqual([...native.metadata.values()].filter((item) => item.role === "lead").map((item) => item.specId), ["fix-5"]);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.ok(board.shaping.some((spec) => spec.id === "FIX-1"));
  assert.ok(!board.ready.some((spec) => spec.id === "FIX-1"));
  await assert.rejects(harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-1" }), /isn't a ready spec/);
});

test("Autopilot never starts a Shaping spec whose ready-for-agent label remains during planning", async (t) => {
  const { harness, native } = await setup(t);
  await harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-5" });
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on" });
  await watcherCycle(harness);
  assert.deepEqual([...native.metadata.values()].filter((item) => item.role === "lead"), []);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.ok(board.shaping.some((spec) => spec.id === "FIX-5"));
  assert.ok(!board.ready.some((spec) => spec.id === "FIX-5"));
});

test("Autopilot follows Linear manual order, priority with none last, and oldest creation time", async (t) => {
  const template = workspaceIssues.data.issues.nodes[3];
  const ticket = workspaceIssues.data.issues.nodes[4];
  const order = [
    { id: "fix-10", sortOrder: 2, priority: 1, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "fix-20", sortOrder: 1, priority: 0, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "fix-30", sortOrder: 1, priority: 2, createdAt: "2026-03-01T00:00:00.000Z" },
    { id: "fix-40", sortOrder: 1, priority: 1, createdAt: "2026-02-01T00:00:00.100Z" },
    { id: "fix-50", sortOrder: 1, priority: 1, createdAt: "2026-02-01T00:00:00Z" },
  ];
  const { harness, native } = await setup(t, () => Response.json({ data: { issues: { ...workspaceIssues.data.issues,
    nodes: order.flatMap((fields) => [
      { ...template, ...fields, identifier: fields.id.toUpperCase() },
      { ...ticket, id: `${fields.id}-ticket`, identifier: `${fields.id.toUpperCase()}-T`, parent: { id: fields.id } },
    ]),
  } } }));
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.ready.map((row) => row.id), ["FIX-50", "FIX-40", "FIX-30", "FIX-20", "FIX-10"]);
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 5 });
  for (let i = 0; i < 5; i++) await watcherCycle(harness);
  assert.deepEqual([...native.metadata.values()].map((row) => row.specId), ["fix-50", "fix-40", "fix-30", "fix-20", "fix-10"]);
});

test("a queued spec waits for its open blocker while Autopilot starts the next eligible spec", async (t) => {
  const { harness, native } = await setup(t);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const html = renderToStaticMarkup(createElement(BoardView, { board, demo: false, modeSwitch: null,
    dispatch: () => undefined, onPlan: () => undefined }));
  assert.match(html, /Waiting for .*OUT-10/);
  assert.match(html, /aria-label="FIX-5 is next in the queue"/);
  assert.doesNotMatch(html, /aria-label="FIX-1 is next in the queue"/);
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  await watcherCycle(harness);
  assert.deepEqual([...native.metadata.values()].map((row) => row.specId), ["fix-5"]);
});

for (const completed of [false, true]) {
  test(`a queued spec ${completed ? "can start after its blocker is completed" : "waits for an open blocking spec"}`, async (t) => {
    const nodes = workspaceIssues.data.issues.nodes;
    const blocker = { ...nodes[3], ...(completed ? { state: { id: "done", name: "Done", type: "completed" } } : {}) };
    const { harness, native } = await setup(t, () => Response.json({ data: { issues: { ...workspaceIssues.data.issues,
      nodes: nodes.map((node) => node.id === "fix-1" ? { ...node, sortOrder: -10,
        inverseRelations: { nodes: [{ id: "spec-block", type: "blocks", issue: blocker, relatedIssue: node }], pageInfo: { hasNextPage: false, endCursor: null } },
      } : node.id === "fix-5" ? blocker : node),
    } } }));
    const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
    assert.deepEqual(board.ready.find((row) => row.id === "FIX-1")?.waitingFor?.map((row) => row.id) ?? [], completed ? [] : ["FIX-5"]);
    await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
    await watcherCycle(harness);
    assert.deepEqual([...native.metadata.values()].map((row) => row.specId), completed ? ["fix-1"] : ["fix-5"]);
  });
}

/** PR evidence belongs to an environment, never just to a spec. */
function lanePr(state: "open" | "merged", number = 7) {
  return { outcome: "available", pullRequest: {
    number, title: "FIX-5", state, url: `https://github.com/fixture/repo/pull/${number}`, baseRefName: "main",
    headRefName: "spec/fix-5-old", updatedAt: "2026-11-14T20:00:00Z", autoMerge: false, inMergeQueue: null,
    checks: { state: "passing", totalCount: 1, passedCount: 1, failedCount: 0, pendingCount: 0 },
    review: { state: "none", reviewRequestCount: 0 },
    mergeability: { state: "mergeable", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" }, attention: "none",
  } };
}

test("accept:owner waiting on a merge stays in Needs you while the next Ready spec takes its slot", async (t) => {
  const { harness, native } = await setup(t, () => Response.json({ data: { issues: { ...workspaceIssues.data.issues,
    nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-5" ? {
      ...node, labels: { ...node.labels, nodes: [...node.labels.nodes, { id: "accept", name: "accept:owner", color: "#aaaaaa" }] },
    } : node.identifier === "FIX-1" ? { ...node, inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } : node),
  } } }));
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_1: lanePr("open") }));
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  await watcherCycle(harness);
  assert.equal(native.count, 2);
  assert.equal(native.metadata.get("thr_lead_2")?.specId, "fix-1");
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes.find((lane) => lane.specId === "FIX-5")?.state, "merge-waits");
  const { needsYou } = await import("../lib/board-model.js");
  assert.ok(needsYou(board).some((need) => need.kind === "merge" && need.threadId === "thr_lead_1"));
});

test("a landed spec with remaining un-held tickets returns Ready and starts a fresh Lead without reusing its landed branch", async (t) => {
  const { harness, native } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  native.threads.set("old-worker", makeThreadResponse({ id: "old-worker", title: "Worker FIX-6", projectId: "proj-one",
    parentThreadId: "thr_lead_1", status: "error" }));
  harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_1: lanePr("merged") }));
  const before = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(before.ready.map((spec) => spec.id), ["FIX-1", "FIX-5"]);
  assert.equal(before.lanes[0].state, "landed");
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  await watcherCycle(harness);
  assert.equal(native.count, 2);
  assert.equal(native.metadata.get("thr_lead_2")?.specId, "fix-5");
  const spawns = harness.inspection.sdk.callsTo("threads.spawn");
  const args = spawns[1][0] as { environment: unknown; prompt: string };
  assert.deepEqual(args.environment, { type: "host", hostId: "repo-machine", workspace: {
    type: "managed-worktree", baseBranch: { kind: "default" },
  } });
  assert.match(args.prompt, /fresh integration branch/);
  assert.match(args.prompt, /spec\/fix-5/);
  // BB assigns each newly managed worktree its own branch. Return newest first to
  // prove selection does not depend on SDK list ordering.
  harness.sdk.stub("threads.list", async () => [...native.threads.values()].reverse().map((thread) => ({
    ...thread, environmentBranchName: thread.id === "thr_lead_1" ? "spec/fix-5" : "spec/fix-5-returned",
  })));
  const after = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(after.lanes.map((lane) => [lane.leadThreadId, lane.branch, lane.state, lane.pr]),
    [["thr_lead_2", "spec/fix-5-returned", "flying", undefined]]);
  assert.equal(after.lanes[0].tickets[0].threadId, undefined, "old workers never become the returning lane's workers");
  assert.equal(after.lanes[0].needs, undefined, "old worker failures never become this lane's questions");
  assert.ok(native.threads.has("old-worker"));
  assert.ok(native.threads.has("thr_lead_1"), "the old Lead and its environment remain attributable in BB");
  assert.deepEqual(native.metadata.get("thr_lead_1"), { role: "lead", specId: "fix-5", startedBy: "owner" });
  assert.deepEqual(await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" }), { threadId: "thr_lead_2" });
});

test("a landed spec stays Landed while every remaining ticket is held, then returns when the hold clears", async (t) => {
  let held = true;
  const { harness, native } = await setup(t, () => Response.json({ data: { issues: { ...workspaceIssues.data.issues,
    nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-6" && held ? {
      ...node, labels: { ...node.labels, nodes: [{ id: "hold", name: "hold", color: "#aaaaaa" }] },
    } : node),
  } } }));
  native.threads.set("old", makeThreadResponse({ id: "old", projectId: "proj-one", providerId: "codex",
    environmentId: "env_lead_1", status: "idle", createdAt: 1 }));
  native.metadata.set("old", { role: "lead", specId: "fix-5", startedBy: "owner" });
  native.routes.set("old", { model: "gpt-6.1-sol", reasoningLevel: "high" });
  harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_1: lanePr("merged") }));
  const before = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(before.lanes[0].state, "landed");
  assert.equal(before.lanes[0].tickets[0].state, "held");
  assert.ok(!before.ready.some((spec) => spec.id === "FIX-5"));
  assert.ok(!before.shaping.some((spec) => spec.id === "FIX-5"));
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  await watcherCycle(harness);
  assert.equal(native.count, 0);
  held = false;
  const next = await harness.lifecycle.reload(plugin);
  t.after(() => next.harness.lifecycle.dispose());
  next.harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_1: lanePr("merged") }));
  const unheld = await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.ok(unheld.ready.some((spec) => spec.id === "FIX-5"));
  await watcherCycle(next.harness);
  assert.equal(native.count, 1);
  assert.equal(native.metadata.get("thr_lead_1")?.specId, "fix-5");
});

test("an un-held spec with an open PR keeps its existing Lead and never returns Ready", async (t) => {
  const { harness, native } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_1: lanePr("open") }));
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes[0].state, "pr-open");
  assert.ok(!board.ready.some((spec) => spec.id === "FIX-5"));
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 2 });
  await watcherCycle(harness);
  assert.deepEqual(await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" }), { threadId: "thr_lead_1" });
  assert.equal(native.count, 1);
});
