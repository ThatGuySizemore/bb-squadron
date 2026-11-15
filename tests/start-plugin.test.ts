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
import { needsYou, type Board } from "../lib/board-model.js";
import { STOP_MESSAGE, RESUME_MESSAGE } from "../lib/lane-contract.js";
import { workspace, workspaceIssues } from "./fixtures/board-workspace.js";

const settingsFile = readFileSync("tests/fixtures/squadron.md", "utf8");
const skillNames = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];
function nativeThreads() {
  return { count: 0, threads: new Map<string, ReturnType<typeof makeThreadResponse>>(),
    metadata: new Map<string, Record<string, unknown>>(), routes: new Map<string, { model: string; reasoningLevel: string }>() };
}
function host(native = nativeThreads(), ownerHost?: ReturnType<typeof experimental_createHostEntryHarness>, settings = settingsFile,
  mainCheck: (input: unknown) => unknown = () => ({ passed: true, logPath: "/scratch/check.log", mergedCommit: "a".repeat(40), baseCommit: "b".repeat(40) })) {
  const { threads, metadata, routes } = native;
  return { native, ...createFakePluginHost({
    pluginId: "squadron", experimental_hostEntry: true,
    settings: { linearApiKey: "fake-start-key" },
    sdk: {
      projects: {
        list: async () => [{ id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }],
        get: async ({ projectId }) => ({
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
    experimental_callHostRpc: async ({ method, input }) => method === "runMainQuickCheck" ? mainCheck(input) : method === "githubLogin" ? { authenticated: true } : {
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
  assert.match(skill, /Never install\/reinstall Squadron or redirect BB loading/);
  assert.match(skill, /the owner's checkout and Helper handle it/);
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

function readyWorkItem() {
  return Response.json({ data: { issues: { ...workspaceIssues.data.issues,
    nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-9"
      ? { ...node, labels: { ...node.labels, nodes: [{ id: "ready", name: "ready-for-agent", color: "#000000" }] } } : node),
  } } });
}

test("a manually started work item occupies capacity, keeps its question slot and frees it after Stop", async (t) => {
  const { harness, native } = await setup(t, readyWorkItem);
  harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-9" });
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  await watcherCycle(harness);
  assert.equal(native.count, 1, "the manual work item fills the shared limit");
  let board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.lanes.map((lane) => [lane.specId, lane.kind]), [["FIX-9", "work-item"]]);
  const running = native.threads.get("thr_lead_1")!;
  const waiting = { ...running, status: "idle" as const, runtime: { displayStatus: "idle" as const }, hasPendingInteraction: true };
  native.threads.set(running.id, waiting);
  await watcherCycle(harness);
  assert.equal(native.count, 1, "questions retain the shared slot");
  board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(needsYou(board).filter((need) => need.specId === "FIX-9").map((need) => need.kind), ["waiting"]);
  await harness.behavior.callRpc("lane.stop", { projectId: "proj-one", specId: "FIX-9" });
  native.threads.set(running.id, { ...running, status: "idle", runtime: { displayStatus: "idle" } });
  await watcherCycle(harness);
  assert.equal(native.count, 2, "a confirmed stopped work item frees capacity under existing policy");
  board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(needsYou(board).filter((need) => need.specId === "FIX-9").map((need) => need.kind), ["stopped"]);
  await harness.behavior.callRpc("lane.resume", { projectId: "proj-one", specId: "FIX-9" });
  const sends = harness.inspection.sdk.callsTo("threads.send").map(([args]) => args as { threadId: string; mode: string; input: { text: string }[] });
  assert.deepEqual(sends.map((send) => [send.threadId, send.mode, send.input[0].text]), [
    [running.id, "steer-if-active", STOP_MESSAGE], [running.id, "queue-if-active", RESUME_MESSAGE],
  ]);
  native.threads.set(running.id, running);
  board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes.find((lane) => lane.specId === "FIX-9")?.state, "flying");
  assert.deepEqual(needsYou(board).filter((need) => need.specId === "FIX-9"), []);
});

test("work-item PR review and landing use the shared policy without child tickets", async (t) => {
  const { harness, native } = await setup(t, readyWorkItem);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-9" });
  let merged = false;
  harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_1: { outcome: "available", pullRequest: {
    number: 99, state: merged ? "merged" : "open", url: "https://example.invalid/pull/99",
    updatedAt: new Date(Date.now()).toISOString(), checks: { state: "passing" },
  } } }));
  let board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes[0].state, "pr-open");
  assert.deepEqual(board.lanes[0].tickets, []);
  merged = true;
  native.threads.set("thr_lead_1", { ...native.threads.get("thr_lead_1")!, status: "idle" });
  board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes[0].state, "landed");
  assert.equal(board.lanes[0].kind, "work-item");
  assert.deepEqual(needsYou(board), []);
});
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

test("Autopilot skips Ready work items and starts the next eligible spec", async (t) => {
  const { harness, native } = await setup(t, () => Response.json({ data: { issues: {
    ...workspaceIssues.data.issues, nodes: [
      { ...workspaceIssues.data.issues.nodes[3], id: "fix-0", identifier: "FIX-0", title: "Standalone fix", sortOrder: -1 },
      ...workspaceIssues.data.issues.nodes,
    ],
  } } }));
  const before = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(before.ready[0].id, "FIX-0");
  assert.equal(before.ready[0].kind, "work-item");
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  await watcherCycle(harness);
  assert.equal(native.count, 1);
  assert.equal(native.metadata.get("thr_lead_1")?.specId, "fix-5");
  assert.equal(native.metadata.get("thr_lead_1")?.startedBy, "autopilot");
  const after = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.ok(after.ready.some((row) => row.id === "FIX-0" && row.kind === "work-item"));
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


function fourReady() {
  const base = workspaceIssues.data.issues.nodes;
  return Response.json({ data: { issues: { ...workspaceIssues.data.issues,
    nodes: [...base.map((node) => node.identifier === "FIX-1" ? {
      ...node, inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    } : node), ...[7, 10].flatMap((id) => [
      { ...base[3], id: `fix-${id}`, identifier: `FIX-${id}` },
      { ...base[4], id: `fix-${id + 1}`, identifier: `FIX-${id + 1}`, parent: { id: `fix-${id}` } },
    ])],
  } } });
}

test("two stopped Squadron lanes pause before the next start and preserve flying lanes", async (t) => {
  const { harness, native } = await setup(t, fourReady);
  for (const specId of ["FIX-1", "FIX-5", "FIX-7"]) {
    await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId });
  }
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  native.threads.set("thr_lead_1", { ...native.threads.get("thr_lead_1")!, status: "error" });
  const first = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(first.autopilot?.consecutiveStops, 1);
  assert.equal(first.autopilot?.status, "on");
  native.threads.set("thr_lead_2", { ...native.threads.get("thr_lead_2")!, status: "idle" });
  const paused = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(paused.autopilot, { status: "paused", laneLimit: 1, consecutiveStops: 2, pauseReason: "Two lanes in a row stopped" });
  assert.equal(paused.lanes.find((lane) => lane.specId === "FIX-7")?.state, "flying");
  await watcherCycle(harness);
  assert.equal(native.count, 3);
  assert.equal(native.threads.get("thr_lead_3")?.status, "active");
  assert.equal(harness.inspection.sdk.callsTo("threads.sendMessage").length, 0);
});

test("pause and outcome deduplication survive reload; only owner Resume clears the brake", async (t) => {
  const { harness, native } = await setup(t, fourReady);
  for (const specId of ["FIX-1", "FIX-5", "FIX-7"]) await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId });
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  native.threads.set("thr_lead_1", { ...native.threads.get("thr_lead_1")!, status: "idle" });
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  const once = await harness.lifecycle.reload(plugin);
  t.after(() => once.harness.lifecycle.dispose());
  await watcherCycle(once.harness);
  let board = await once.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.autopilot?.consecutiveStops, 1, "historical stop isn't counted after reload");
  native.threads.set("thr_lead_2", { ...native.threads.get("thr_lead_2")!, status: "error" });
  board = await once.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.autopilot?.status, "paused");
  const twice = await once.harness.lifecycle.reload(plugin);
  t.after(() => twice.harness.lifecycle.dispose());
  board = await twice.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.autopilot, { status: "paused", laneLimit: 1, consecutiveStops: 2, pauseReason: "Two lanes in a row stopped" });
  await assert.rejects(twice.harness.behavior.callRpc("autopilot.resume", { projectId: "proj-one" },
    { experimental_caller: { kind: "plugin", pluginId: "other" } }), /board/);
  assert.deepEqual(await twice.harness.behavior.callRpc("autopilot.resume", { projectId: "proj-one" }),
    { status: "on", laneLimit: 1, consecutiveStops: 0, pauseReason: null });
  for (let i = 0; i < 3; i++) {
    board = await twice.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
    assert.equal(board.autopilot?.consecutiveStops, 0, "Resume retains markers for old stopped lanes");
  }
  native.threads.set("thr_lead_3", { ...native.threads.get("thr_lead_3")!, status: "idle" });
  board = await twice.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.autopilot?.consecutiveStops, 1);
  assert.equal(board.autopilot?.status, "on");
  await watcherCycle(twice.harness);
  assert.equal(native.count, 4, "Resume allows the next Ready spec to start");
  assert.deepEqual(await twice.harness.behavior.callRpc("autopilot.get", { projectId: "proj-two" }),
    { status: "off", laneLimit: 3, consecutiveStops: 0, pauseReason: null });
});

test("a Landed lane between stops resets the count even when several outcomes arrive in one read", async (t) => {
  const { harness, native } = await setup(t, fourReady);
  for (const specId of ["FIX-1", "FIX-5", "FIX-7"]) await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId });
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  // Completion order differs from board/spec order: FIX-5 stopped, FIX-7 landed, FIX-1 stopped.
  native.threads.set("thr_lead_2", { ...native.threads.get("thr_lead_2")!, status: "error", updatedAt: 100 });
  native.threads.set("thr_lead_1", { ...native.threads.get("thr_lead_1")!, status: "idle", updatedAt: 300 });
  harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_3: { outcome: "available", pullRequest: {
    number: 7, title: "FIX-7", state: "merged", url: "https://github.com/fixture/repo/pull/7", baseRefName: "main",
    headRefName: "spec/fix-7", updatedAt: "1970-01-01T00:00:00.200Z", autoMerge: false, inMergeQueue: null,
    checks: { state: "passing", totalCount: 1, passedCount: 1, failedCount: 0, pendingCount: 0 },
    review: { state: "none", reviewRequestCount: 0 },
    mergeability: { state: "unknown", mergeStateStatus: null, mergeable: null }, attention: "none",
  } } }));
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes.find((lane) => lane.specId === "FIX-7")?.state, "landed");
  assert.equal(board.autopilot?.status, "on");
  assert.equal(board.autopilot?.consecutiveStops, 1);
});

test("Outside outcomes never increment or reset the Squadron brake, and owner questions keep their slot", async (t) => {
  const { harness, native } = await setup(t, fourReady);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-1" });
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  native.threads.set("outside", makeThreadResponse({ id: "outside", title: "Lead FIX-7", environmentId: "env_outside", projectId: "proj-one", status: "error" }));
  let waiting = true;
  native.threads.set("thr_lead_2", { ...native.threads.get("thr_lead_2")!, status: "idle" });
  harness.sdk.stub("threads.list", async () => [...native.threads.values()].map((thread) => ({ ...thread,
    environmentBranchName: "spec/fix-5", hasPendingInteraction: thread.id === "thr_lead_2" && waiting })));
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  let board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes.find((lane) => lane.specId === "FIX-7")?.outside, true);
  assert.equal(board.autopilot?.consecutiveStops, 0);
  native.threads.set("thr_lead_1", { ...native.threads.get("thr_lead_1")!, status: "error" });
  board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.autopilot?.consecutiveStops, 1);
  harness.sdk.stub("plugins.callRpc", async () => ({ env_outside: { outcome: "available", pullRequest: {
    number: 8, title: "FIX-7", state: "merged", url: "https://github.com/fixture/repo/pull/8", baseRefName: "main",
    headRefName: "outside", updatedAt: "2026-11-14T22:00:00Z", autoMerge: false, inMergeQueue: null,
    checks: { state: "passing", totalCount: 1, passedCount: 1, failedCount: 0, pendingCount: 0 },
    review: { state: "none", reviewRequestCount: 0 },
    mergeability: { state: "unknown", mergeStateStatus: null, mergeable: null }, attention: "none",
  } } }));
  board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes.find((lane) => lane.specId === "FIX-7")?.state, "landed");
  assert.equal(board.autopilot?.consecutiveStops, 1, "Outside landing doesn't reset a Squadron stop");
  waiting = false;
  native.threads.set("thr_lead_2", { ...native.threads.get("thr_lead_2")!, status: "error" });
  await watcherCycle(harness);
  const state = await harness.behavior.callRpc("autopilot.get", { projectId: "proj-one" });
  assert.deepEqual(state, { status: "paused", laneLimit: 1, consecutiveStops: 2, pauseReason: "Two lanes in a row stopped" });
  assert.equal(native.count, 2, "watcher applies the brake before filling the newly free slot");
});

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
  native.threads.set("thr_lead_1", { ...native.threads.get("thr_lead_1")!, status: "idle" });
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
  // Reload can show the saved reading immediately. Wait for the live refresh
  // before checking that Linear's newly cleared hold has reached the board.
  await next.harness.behavior.callRpc("board.projectCounts", null);
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

test("merged main failure pauses before any next start, links its host log, and deduplicates through refresh and reload", async (t) => {
  const linear = workspace({ issues: fourReady });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const checking = new Promise<void>((resolve) => { entered = resolve; });
  const result = new Promise<unknown>((resolve) => { finish = resolve; });
  const calls: unknown[] = [];
  const { bb, harness, native } = host(undefined, undefined, settingsFile, async (input) => {
    calls.push(input); entered(); return result;
  });
  t.after(async () => { finish({ passed: false, logPath: "/scratch/main.log", mergedCommit: "a".repeat(40), baseCommit: "b".repeat(40) }); fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_1: lanePr("merged") }));
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  await Promise.race([checking, new Promise((_, reject) => setTimeout(() => reject(new Error("main check never started")), 2000))]);
  assert.equal(native.count, 1, "no next lane may start while the main check runs");
  assert.deepEqual(calls, [{ checkoutPath: "/repo", prNumber: 7, quickCheck: "npm run check" }]);
  finish({ passed: false, logPath: "/scratch/main.log", mergedCommit: "a".repeat(40), baseCommit: "b".repeat(40) });
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.autopilot?.status, "paused");
  assert.equal(board.autopilot?.pauseReason, "Main fails its quick check");
  const { needsYou } = await import("../lib/board-model.js");
  assert.deepEqual((needsYou(board)[0] as any).log, { hostId: "repo-machine", path: "/scratch/main.log" });
  await watcherCycle(harness);
  assert.equal(native.count, 1);
  const next = await harness.lifecycle.reload(plugin);
  t.after(() => next.harness.lifecycle.dispose());
  next.harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_1: lanePr("merged") }));
  await next.harness.behavior.callRpc("board", { projectId: "proj-one" });
  await next.harness.behavior.callRpc("autopilot.resume", { projectId: "proj-one" });
  await watcherCycle(next.harness);
  assert.equal(calls.length, 1, "Resume and reload retain the merge receipt");
  assert.equal(native.count, 2);
});

test("main checks skip Off projects; a pass while Paused preserves the stop brake and deduplicates later reads", async (t) => {
  const linear = workspace({ issues: fourReady });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const calls: unknown[] = [];
  const { bb, harness, native } = host(undefined, undefined, settingsFile, (input) => {
    calls.push(input);
    return { passed: true, logPath: "/scratch/pass.log", mergedCommit: "a".repeat(40), baseCommit: "b".repeat(40) };
  });
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  for (const specId of ["FIX-1", "FIX-5", "FIX-7"]) await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId });
  harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_3: lanePr("merged") }));
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  assert.equal(calls.length, 0);
  // Stop the two other lanes, then observe their stops before the merge appears.
  harness.sdk.stub("plugins.callRpc", async () => ({}));
  native.threads.set("thr_lead_1", { ...native.threads.get("thr_lead_1")!, status: "error" });
  native.threads.set("thr_lead_2", { ...native.threads.get("thr_lead_2")!, status: "error" });
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  const stopped = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(stopped.autopilot?.pauseReason, "Two lanes in a row stopped");
  harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_3: lanePr("merged") }));
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(calls.length, 1);
  assert.equal(board.autopilot?.status, "paused");
  assert.equal(board.autopilot?.pauseReason, "Two lanes in a row stopped");
  assert.equal(board.autopilot?.pauseLog, undefined);
  await Promise.all([1, 2, 3].map(() => harness.behavior.callRpc("board", { projectId: "proj-one" })));
  assert.equal(calls.length, 1);
});

test("a returning Lead cannot hide the previous lane's unchecked merge from the main brake", async (t) => {
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  let checks = 0;
  const { bb, harness, native } = host(undefined, undefined, settingsFile, () => {
    checks++;
    return { passed: false, logPath: "/scratch/old.log", mergedCommit: "a".repeat(40), baseCommit: "b".repeat(40) };
  });
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_1: lanePr("merged") }));
  native.threads.set("thr_lead_1", { ...native.threads.get("thr_lead_1")!, status: "idle" });
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  assert.equal(native.count, 2);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(checks, 1);
  assert.equal(board.autopilot?.status, "paused");
  assert.equal(board.lanes[0].leadThreadId, "thr_lead_2");
  assert.equal(native.threads.get("thr_lead_2")?.status, "active");
});

test("a merged Outside lane also checks shared main without changing the stop brake or its threads", async (t) => {
  const linear = workspace({ issues: fourReady });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  let checks = 0;
  const { bb, harness, native } = host(undefined, undefined, settingsFile, () => {
    checks++;
    return { passed: false, logPath: "/scratch/outside.log", mergedCommit: "a".repeat(40), baseCommit: "b".repeat(40) };
  });
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  native.threads.set("outside", makeThreadResponse({ id: "outside", title: "Lead FIX-7", environmentId: "env_outside", projectId: "proj-one", status: "active" }));
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  harness.sdk.stub("plugins.callRpc", async () => ({ env_outside: lanePr("merged") }));
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(checks, 1);
  assert.equal(board.autopilot?.status, "paused");
  assert.equal(board.autopilot?.consecutiveStops, 0);
  assert.equal(native.count, 0);
  assert.equal(native.threads.get("outside")?.status, "active");
  assert.equal(harness.inspection.sdk.callsTo("threads.sendMessage").length, 0);
});

test("merged main forwards the project's optional Check setup through settings to its host", async (t) => {
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const calls: unknown[] = [];
  const settings = settingsFile + '\n## Check setup\n\n```sh\n./prepare-check\n```\n';
  const { bb, harness } = host(undefined, undefined, settings, (input) => {
    calls.push(input);
    return { passed: false, logPath: "/scratch/setup-failed.log", mergedCommit: "a".repeat(40), baseCommit: "b".repeat(40) };
  });
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  await harness.behavior.callRpc("autopilot.set", { projectId: "proj-one", status: "on", laneLimit: 1 });
  harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_1: lanePr("merged") }));
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(calls, [{ checkoutPath: "/repo", prNumber: 7, quickCheck: "npm run check", checkSetup: "./prepare-check" }]);
  assert.equal(board.autopilot?.status, "paused");
  assert.deepEqual(board.autopilot?.pauseLog, { hostId: "repo-machine", path: "/scratch/setup-failed.log" });
});


test("work-item Start shares CLI and board dedupe, uses its labels over Lead, and supplies the whole lane prompt", async (t) => {
  const settings = settingsFile.replace("| `ui`", "| Lead | GPT | gpt-6.1-sol | medium |\n| `ui`");
  const { harness } = await setup(t, () => Response.json({ data: { issues: {
    ...workspaceIssues.data.issues, nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-9" ? {
      ...node, labels: { ...node.labels, nodes: [
        { id: "ready", name: "ready-for-agent", color: "#000000" },
        { id: "ui", name: "ui", color: "#000000" },
        { id: "accept", name: "accept:owner", color: "#000000" },
      ] },
    } : node),
  } } }), undefined, settings);
  const [cli, rpc] = await Promise.all([
    harness.behavior.runCli(["start", "FIX-9"], { projectId: "proj-one" }),
    harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-9" }),
  ]);
  assert.deepEqual(cli, { exitCode: 0, stdout: "Started FIX-9. @thread:thr_lead_1\n", stderr: "" });
  assert.deepEqual(rpc, { threadId: "thr_lead_1" });
  const spawns = harness.inspection.sdk.callsTo("threads.spawn");
  assert.equal(spawns.length, 1);
  const args = spawns[0][0] as Record<string, unknown>;
  assert.deepEqual([args.providerId, args.model, args.reasoningLevel, args.serviceTier],
    ["claude-code", "claude-opus-5-5", "high", "default"]);
  assert.equal(args.parentThreadId, undefined);
  assert.equal(args.title, "Work item FIX-9");
  assert.equal(args.visibility, "visible");
  assert.deepEqual(args.pluginMetadata, { role: "lead", specId: "fix-9", kind: "work-item", startedBy: "owner" });
  assert.deepEqual(args.environment, { type: "host", hostId: "repo-machine", workspace: {
    type: "managed-worktree", baseBranch: { kind: "default" },
  } });
  const prompt = String(args.prompt);
  for (const text of ["https://linear.app/fixture/issue/FIX-9", "AGENTS.md", "GLOSSARY.md", "docs/agents/",
    "docs/agents/squadron.md", "/owner/.bb-squadron/house-rules.md", "/owner/.bb-squadron/machine.md",
    "implement", "fresh", "code-review", "subagent", "review thread", "fix", "pr", "accept:owner",
    "5400000 ms", "whole lane", "two strikes", "Stop", "Resume", "In Progress", "Done",
    "hold, needs-triage, needs-info, ready-for-human, wontfix", "identity", "read back"]) {
    assert.ok(prompt.includes(text), `prompt includes ${text}`);
  }
  assert.match(prompt, /accept:owner.*wait/i);
  assert.match(prompt, /Treat the test approach named in the issue's acceptance criteria as the confirmed seam for tdd\./);
  assert.match(prompt, /Ask the owner about test seams only when the issue names none\./);
  const { harness: reloaded } = await harness.lifecycle.reload(plugin);
  t.after(() => reloaded.lifecycle.dispose());
  await assert.rejects(reloaded.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-9" }),
    { message: "FIX-9 already has a lane. Open its thread or use Resume if it is stopped." });
  assert.equal(reloaded.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("work-item Start falls back to the worker default and tells the agent to merge clean work with mapped statuses", async (t) => {
  const settings = settingsFile.replace("| `ui`", "| Lead | Claude | claude-opus-5-5 | medium |\n| `ui`")
    .replace("Default.", ["| State | Linear status |", "|---|---|", "| Ready | Todo |", "| Flying | Building |",
      "| In review | Waiting to Merge |", "| Landed | Shipped |", "| Waiting | Todo |", "| Working | Building |",
      "| In branch | Waiting to Merge |", "| Done | Shipped |"].join("\n"));
  const { harness } = await setup(t, () => Response.json({ data: { issues: {
    ...workspaceIssues.data.issues, nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-9" ? {
      ...node, labels: { ...node.labels, nodes: [{ id: "ready", name: "ready-for-agent", color: "#000000" }] },
    } : node),
  } } }), undefined, settings);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-9" });
  const args = harness.inspection.sdk.callsTo("threads.spawn")[0][0] as Record<string, unknown>;
  assert.deepEqual([args.providerId, args.model, args.reasoningLevel], ["codex", "gpt-6.1-sol", "high"]);
  const prompt = String(args.prompt);
  assert.match(prompt, /Otherwise squash-merge when the review findings are addressed and the quick check and required PR checks pass/);
  assert.match(prompt, /accept:owner means wait/);
  assert.match(prompt, /Flying = Building; In review = Waiting to Merge; Landed = Shipped/);
  assert.match(prompt, /Done only after its merge is confirmed/);
  assert.match(prompt, /the plugin stays tracker read-only/);
  assert.ok(prompt.indexOf("implement skill") < prompt.indexOf("fresh code-review"));
  assert.ok(prompt.indexOf("fresh code-review") < prompt.indexOf("Fix findings"));
  assert.ok(prompt.indexOf("Fix findings") < prompt.indexOf("Open the PR"));
});

test("work-item CLI and RPC share Start refusals for unready, held, blocked, planning and Doctor cases", async (t) => {
  for (const scenario of ["unready", "held", "blocked", "planning", "doctor"] as const) {
    await t.test(scenario, async (t) => {
      const { harness } = await setup(t, () => Response.json({ data: { issues: {
        ...workspaceIssues.data.issues, nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-9" ? {
          ...node,
          ...(scenario === "blocked" ? { inverseRelations: {
            ...node.inverseRelations, nodes: workspaceIssues.data.issues.nodes[0].inverseRelations.nodes.map((relation) => ({
              ...relation, id: "outside-blocks-work-item", relatedIssue: node,
            })),
          } } : {}),
          labels: { ...node.labels, nodes: scenario === "unready" ? [] : [
            { id: "ready", name: "ready-for-agent", color: "#000000" },
            ...(scenario === "held" ? [{ id: "hold", name: "hold", color: "#000000" }] : []),
          ] },
        } : node),
      } } }));
      if (scenario === "planning") await harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-9" });
      if (scenario === "doctor") harness.sdk.stub("skills.list", async () => ({ skills: [] }));
      const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
      const before = harness.inspection.sdk.callsTo("threads.spawn").length;
      const result = await harness.behavior.runCli(["start", "FIX-9"], { projectId: "proj-one" });
      assert.equal(result.exitCode, 1);
      const reason = result.stderr.trim();
      assert.ok(reason);
      await assert.rejects(harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-9" }), { message: reason });
      const ready = board.ready.find((row) => row.id === "FIX-9");
      if (scenario === "blocked" || scenario === "doctor") {
        assert.equal(reason, ready?.startReason);
      } else {
        assert.equal(ready, undefined);
        assert.ok(board.openIssues.some((row) => row.id === "FIX-9" && row.kind === "work-item"));
      }
      assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, before);
    });
  }
});

test("later work-item Start refuses through CLI and RPC, including a fresh hold and plugin reload", async (t) => {
  let held = false;
  const { harness, native } = await setup(t, () => {
    const response = readyWorkItem();
    if (!held) return response;
    return Response.json({ data: { issues: { ...workspaceIssues.data.issues,
      nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-9"
        ? { ...node, labels: { ...node.labels, nodes: [
          { id: "ready", name: "ready-for-agent", color: "#000000" },
          { id: "hold", name: "hold", color: "#000000" },
        ] } } : node),
    } } });
  });
  const start = () => harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-9" });
  assert.deepEqual(await Promise.all([start(), start()]), [{ threadId: "thr_lead_1" }, { threadId: "thr_lead_1" }]);
  let current = harness;
  for (const heldNow of [false, true]) {
    held = heldNow;
    const { harness: fresh } = await current.lifecycle.reload(plugin);
    current = fresh;
    t.after(() => fresh.lifecycle.dispose());
    const board = await fresh.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
    assert.ok(!board.ready.some((row) => row.id === "FIX-9"));
    const result = await fresh.behavior.runCli(["start", "FIX-9"], { projectId: "proj-one" });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr.trim(), "FIX-9 already has a lane. Open its thread or use Resume if it is stopped.");
    await assert.rejects(fresh.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-9" }), { message: result.stderr.trim() });
    assert.equal(native.count, 1);
  }
});

for (const reason of ["hold or blocker", "two strikes", "time limit"]) {
  test(`a work item's ${reason} wind-down uses shared Stop and remains Stopped after normal completion`, async (t) => {
    const { harness, native } = await setup(t, readyWorkItem);
    await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-9" });
    const prompt = (harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { prompt: string }).prompt;
    const running = native.threads.get("thr_lead_1")!;
    type Events = Awaited<ReturnType<import("@get-bb/plugin-sdk").BbPluginApi["sdk"]["threads"]["events"]["list"]>>;
    const events: Events = [];
    let sequence = 0;
    const readEvents = async ({ threadId, types, limit }: { threadId: string; types?: string[]; limit?: string }) => threadId === running.id
      ? events.filter((event) => !types || types.includes(event.type)).slice(0, Number(limit ?? 100)) : [];
    const send = async ({ threadId, input }: Parameters<import("@get-bb/plugin-sdk").BbPluginApi["sdk"]["threads"]["send"]>[0]) => {
      events.unshift({ id: `request-${++sequence}`, threadId, seq: sequence, createdAt: Date.now(), scope: { kind: "thread" },
        type: "client/turn/requested", data: { direction: "outbound", execution: { model: "fixture", permissionMode: "auto", reasoningLevel: "medium", serviceTier: "default", source: "client/turn/requested" },
          source: "tell", initiator: "agent", senderThreadId: running.id, input,
          request: { method: "turn/start", params: {} }, requestId: `request-${sequence}`, target: { kind: "auto", expectedTurnId: null } } });
      return { ok: true, delivery: "sent" as const };
    };
    harness.sdk.stub("threads.events.list", readEvents);
    harness.sdk.stub("threads.send", send);
    const completeNormally = () => {
      events.unshift({ id: `end-${++sequence}`, threadId: running.id, seq: sequence, createdAt: Date.now(), scope: { kind: "thread" },
        type: "turn/completed", data: { status: "completed", providerThreadId: null } });
      native.threads.set(running.id, { ...running, status: "idle", runtime: { displayStatus: "idle" } });
    };
    completeNormally();
    const board = async () => await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
    assert.equal((await board()).lanes[0].state, "flying", "ordinary completion supplies no stop signal");
    native.threads.set(running.id, running);
    // Follow the actual seeded policy instruction through the public CLI, not a private state flag.
    const command = prompt.match(/`bb squadron stop '(FIX-9)'`/);
    assert.ok(command, `${reason} must direct the agent to the canonical Stop control`);
    const result = await harness.behavior.runCli(["stop", command[1]], { projectId: "proj-one" });
    assert.equal(result.exitCode, 0);
    const sent = harness.inspection.sdk.callsTo("threads.send").at(-1)![0] as { threadId: string; mode: string; input: { text: string }[] };
    assert.deepEqual([sent.threadId, sent.mode, sent.input[0].text], [running.id, "steer-if-active", STOP_MESSAGE]);
    assert.equal((await board()).lanes[0].state, "flying", "the active wind-down keeps its capacity until it finishes");
    completeNormally();
    let stopped = await board();
    assert.equal(stopped.lanes[0].state, "stopped");
    assert.deepEqual(needsYou(stopped).map((need) => need.kind), ["stopped"]);
    const { harness: reloaded } = await harness.lifecycle.reload(plugin);
    t.after(() => reloaded.lifecycle.dispose());
    reloaded.sdk.stub("threads.events.list", readEvents);
    reloaded.sdk.stub("threads.send", send);
    stopped = await reloaded.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
    assert.equal(stopped.lanes[0].state, "stopped", "BB lifecycle history reconstructs Stop after reload");
    assert.deepEqual(needsYou(stopped).map((need) => need.kind), ["stopped"]);
    const refused = await reloaded.behavior.runCli(["start", "FIX-9"], { projectId: "proj-one" });
    assert.equal(refused.exitCode, 1, "Start cannot bypass a policy Stop");
    const resumedControl = await reloaded.behavior.runCli(["resume", "FIX-9"], { projectId: "proj-one" });
    assert.equal(resumedControl.exitCode, 0);
    completeNormally();
    const resumed = await reloaded.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
    assert.equal(resumed.lanes[0].state, "flying", "Resume supersedes the fixed Stop request");
    assert.deepEqual(needsYou(resumed), []);
    assert.match(prompt, /Resume doesn't reset strikes or the time budget/);
    assert.match(prompt, /Start and Resume grant no release, deploy, deletion or other held action/);
    assert.match(prompt, /Track cumulative elapsed time across Stop\/Resume/);
  });
}
