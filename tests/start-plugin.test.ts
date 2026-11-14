import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
        if (path === "/repo/docs/agents/issue-tracker.md") {
          const content = readFileSync("tests/fixtures/trackers/bb-squadron.md", "utf8");
          return { content, contentEncoding: "utf8", path, sha256: "tracker", sizeBytes: content.length };
        }
        assert.equal(path, "/repo/docs/agents/squadron.md");
        return { content: settingsFile, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: settingsFile.length };
      } },
      skills: { list: async () => ({ skills: ["claude-code", "codex"].flatMap((provider) => skillNames.map((name) => ({
        id: `${provider}-${name}`, name: `mattpocock-skills:${name}`, description: null,
        filePath: `/plugins/${provider}/${name}/SKILL.md`, manageable: false, pluginId: "mattpocock-skills", provider,
        registrySkillId: null, scope: "plugin" as const,
      }))) }) },
      threads: {
        list: async (args) => [...threads.values()].filter((thread) => !args?.parentThreadId || thread.parentThreadId === args.parentThreadId)
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
  assert.deepEqual(args.pluginMetadata, { role: "lead", specId: "fix-5" });
  assert.deepEqual(args.environment, { type: "host", hostId: "repo-machine", workspace: {
    type: "managed-worktree", baseBranch: { kind: "default" },
  } });
  assert.equal(args.prompt, [
    "Use the squadron-lead skill for this spec.", "", "Spec: https://linear.app/fixture/issue/FIX-5",
    "Repo rules: AGENTS.md and docs/agents/", "Project settings: docs/agents/squadron.md",
    "Playbook: /owner/.bb-squadron/playbook.md", "Machine profile: /owner/.bb-squadron/machine.md",
    "Held tickets carry one of these labels or Status lines: hold, needs-triage, needs-info, ready-for-human, wontfix.",
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
