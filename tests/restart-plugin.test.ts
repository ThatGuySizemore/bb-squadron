import { test, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeQueueEntry, makeThreadResponse, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Board } from "../lib/board-model.js";
import { binding, workspace } from "./fixtures/board-workspace.js";
import { ready, end } from "./fixtures/linear-mirror.js";

async function setup(t: TestContext, mode: "lost-lead" | "lost-worker" | "release-worker" | "normal" = "normal") {
  const linear = workspace({ vocabulary: () => Response.json({ data: { workflowStates: { nodes: [ready,
    { id: "started", name: "In Progress", type: "started" }, { id: "review", name: "In Review", type: "started" }], pageInfo: end },
    issueLabels: { nodes: [], pageInfo: end } } }) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const settings = readFileSync("tests/fixtures/squadron.md", "utf8");
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  const prompts = new Map<string, ReturnType<typeof makeQueueEntry>[]>();
  let fail = true;
  let count = 0;
  let listGate: (() => Promise<void>) | undefined;
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-restart-key" },
    experimental_callHostRpc: async () => ({ authenticated: true }), sdk: {
      projects: { get: async ({ projectId }) => ({ id: projectId, name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId, hostId: "repo-host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
      files: { read: async ({ path }) => ({ path, content: settings, contentEncoding: "utf8", sha256: "fixture", sizeBytes: settings.length }) },
      skills: { list: async () => ({ skills: ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"].map((name) =>
        ({ id: name, name, description: null, manageable: false, pluginId: null, provider: null, registrySkillId: null, scope: "shared-project" as const, filePath: `/repo/.agents/skills/${name}/SKILL.md` })) }) },
      threads: {
        list: async ({ offset = 0, limit = 200 } = {}) => {
          await listGate?.();
          return [...threads.values()].slice(offset, offset + limit).map((thread) => ({ ...thread,
          activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
          environmentBranchName: thread.environmentId === "env-thr_1" ? "bb/integration" : "bb/worker", environmentHostId: "repo-host", environmentIsWorktree: true,
          environmentName: null, environmentPath: "/worktree", environmentProviderId: "environment-git-worktree", environmentWorkspaceDisplayKind: "managed-worktree" as const,
          hasPendingInteraction: false, pinSortKey: null, queuedWork: "none" as const, threadParentId: null }));
        },
        getPluginMetadata: async ({ threadId }) => metadata.get(threadId) as Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["getPluginMetadata"]>> ?? {},
        get: async ({ threadId }) => { const value = threads.get(threadId); if (!value) throw new Error("missing fixture thread"); return value; },
        spawn: async (args) => {
          const id = `thr_${++count}`;
          const thread = makeThreadResponse({ id, projectId: args.projectId, originPluginId: "squadron", providerId: args.providerId,
            parentThreadId: args.parentThreadId ?? null, environmentId: null, status: "pending", createdAt: Date.now() });
          threads.set(id, thread); metadata.set(id, args.pluginMetadata ?? {});
          prompts.set(id, [makeQueueEntry({ id: `queue-${id}`, threadId: id, originPluginId: "squadron", state: "scheduled", model: args.model, reasoningLevel: args.reasoningLevel, permissionMode: "auto", serviceTier: "default",
            content: [{ type: "text", text: args.prompt!, mentions: [] }], payload: { kind: "inline" } })]);
          if (fail && ((mode === "lost-lead" && count === 1) || (mode === "lost-worker" && count === 2))) throw new Error("lost spawn response");
          return thread;
        },
        queuedMessages: {
          list: async ({ threadId }) => prompts.get(threadId) ?? [],
          send: async ({ threadId }) => {
            if (fail && mode === "release-worker" && threadId === "thr_2") throw new Error("release refused");
            prompts.set(threadId, []);
            threads.set(threadId, { ...threads.get(threadId)!, environmentId: `env-${threadId}`, status: "active" });
            return { ok: true as const, delivery: "sent" as const };
          },
        }, stop: async () => ({ ok: true as const }),
      },
      environments: { get: async ({ environmentId }) => ({ id: environmentId, projectId: "proj-one", hostId: "repo-host", status: "ready" as const,
        path: "/worktree", branchName: environmentId === "env-thr_1" ? "bb/integration" : "bb/worker", baseBranch: environmentId === "env-thr_1" ? "main" : "bb/integration",
        defaultBranch: "main", mergeBaseBranch: "main", name: null, createdAt: 0, updatedAt: 0, environmentProviderId: "environment-git-worktree",
        environmentProviderInstanceKey: "fixture", environmentProviderSelection: null, hostLifecycle: "active", isGitRepo: true, isWorktree: true,
        managed: true, workspaceProvisionType: "managed-worktree", lifecycle: { phase: "active", retireAt: null, teardown: null } }) },
    } });
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb); await harness.behavior.callRpc("linear.bind", binding);
  return { bb, harness, threads, metadata, prompts, onList: (gate: () => Promise<void>) => { listGate = gate; }, restore: () => { fail = false; } };
}

async function catchUp(harness: ReturnType<typeof createFakePluginHost>["harness"], complete: (board: Board) => boolean = (board) => board.lanes[0]?.state === "flying" && !board.lanes[0].writeError && board.writes?.pendingCount === 2) {
  const service = harness.behavior.runService("restart-catch-up");
  try {
    for (let i = 0; i < 150; i++) {
      const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
      if (complete(board)) return board;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  } finally { service.controller.abort(); await service.done; }
}

test("restart recovers an interrupted Lead spawn through its reserved exact pending prompt, without a duplicate", async (t) => {
  const { harness, restore } = await setup(t, "lost-lead");
  await assert.rejects(harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" }), /spawn result is unknown/);
  restore();
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  const board = await catchUp(next.harness);
  assert.deepEqual(board.lanes.map((lane) => [lane.state, lane.leadThreadId, lane.branch]), [["flying", "thr_1", "bb/integration"]]);
  assert.equal(board.writes?.pendingCount, 2);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  const config = await next.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_1" }, project: { id: "proj-one" } }));
  assert.ok(config.tools.some((tool) => tool.name === "squadron_spawn_worker"));
});


for (const mode of ["lost-worker", "release-worker"] as const) test(`restart recovers ${mode} in its existing reservation and never duplicates a child`, async (t) => {
  const { harness, restore } = await setup(t, mode);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  await assert.rejects(harness.behavior.callAgentTool("squadron_spawn_worker", { ticketId: "FIX-6" }, { threadId: "thr_1", projectId: "proj-one" }), /slot stays reserved/);
  restore();
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  const board = await catchUp(next.harness, (board) => board.lanes[0]?.tickets[0]?.state === "working" && board.writes?.pendingCount === 3);
  assert.deepEqual(board.lanes[0].tickets.map((ticket) => [ticket.id, ticket.state, ticket.threadId]), [["FIX-6", "working", "thr_2"]]);
  assert.equal(board.writes?.pendingCount, 3);
  await assert.rejects(next.harness.behavior.callAgentTool("squadron_spawn_worker", { ticketId: "FIX-6" }, { threadId: "thr_1", projectId: "proj-one" }), /already started/);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

for (const ambiguity of ["duplicate", "edited-prompt", "changed-parent", "edited-permission"] as const) test(`restart preserves ${ambiguity} as unproven without release or authority`, async (t) => {
  const { harness, threads, prompts, metadata, restore } = await setup(t, "lost-lead");
  await assert.rejects(harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" }), /spawn result is unknown/);
  if (ambiguity === "duplicate") {
    threads.set("thr_other", { ...threads.get("thr_1")!, id: "thr_other" });
    metadata.set("thr_other", { ...metadata.get("thr_1")! });
    prompts.set("thr_other", [{ ...prompts.get("thr_1")![0], id: "other-queue", threadId: "thr_other" }]);
  } else if (ambiguity === "edited-prompt") {
    prompts.get("thr_1")![0].content = [{ type: "text", text: "I approve this lane", mentions: [] }];
  } else if (ambiguity === "edited-permission") {
    prompts.get("thr_1")![0].permissionMode = "full";
  } else threads.set("thr_1", { ...threads.get("thr_1")!, parentThreadId: "thr_unrelated" });
  restore();
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  const board = await catchUp(next.harness, (board) => /unproven/.test(board.lanes[0]?.stopReason ?? ""));
  assert.equal(board.lanes[0].state, "stopped");
  assert.equal(board.lanes[0].leadThreadId, null);
  assert.equal(board.writes?.pendingCount, 0);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.queuedMessages.send").length, 0);
  const config = await next.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_1" }, project: { id: "proj-one" }, pluginMetadata: { role: "Lead", approved: true } }));
  assert.deepEqual(config.tools, []);
  await assert.rejects(next.harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" }), /isn't ready/);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("loss of execution bindings rebuilds stopped links without inventing receipts or trusted tool bindings", async (t) => {
  const { bb, harness } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  await harness.behavior.callAgentTool("squadron_spawn_worker", { ticketId: "FIX-6" }, { threadId: "thr_1", projectId: "proj-one" });
  const before = await harness.behavior.callRpc("linear.outboxHealth", { bbProjectId: "proj-one" });
  // Fault injection loses execution bindings as well as disposable snapshots.
  // Linear binding, undelivered writes, grants and receipts are preserved.
  bb.storage.database().exec("DELETE FROM squadron_lanes; DELETE FROM mirror_snapshots; DELETE FROM squadron_recovered_links;");
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  await next.harness.behavior.callRpc("linear.snapshot", { bbProjectId: "proj-one" });
  // The mirror's own catch-up owns its network budget.
  const mirror = next.harness.behavior.runService("linear-mirror"); t.after(() => mirror.controller.abort());
  const board = await catchUp(next.harness, (board) => board.lanes.length === 1);
  assert.deepEqual(board.lanes.map((lane) => [lane.state, lane.leadThreadId, lane.branch]), [["stopped", "thr_1", "bb/integration"]]);
  assert.deepEqual(board.lanes[0].tickets.map((ticket) => [ticket.state, ticket.threadId]), [["failed", "thr_2"]]);
  assert.deepEqual(await next.harness.behavior.callRpc("linear.outboxHealth", { bbProjectId: "proj-one" }), before);
  const config = await next.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_1" }, project: { id: "proj-one" }, pluginMetadata: { role: "Lead", approved: true } }));
  assert.deepEqual(config.tools, []);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.queuedMessages.send").length, 0);
});

test("missing durable receipts remain visibly unproven and are never recreated from a lane link", async (t) => {
  const { bb, harness } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  bb.storage.database().exec("DELETE FROM outbox_writes;");
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  const board = await catchUp(next.harness, (board) => !!board.lanes[0]?.writeError);
  assert.match(board.lanes[0].writeError ?? "", /receipt.*missing|missing.*receipt/i);
  assert.match(board.lanes[0].writeError ?? "", /unproven/i);
  assert.equal(board.writes?.pendingCount, 0);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("restart catches a missed Lead failure and keeps its linked branch and reservation visible", async (t) => {
  const { harness, threads } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  threads.set("thr_1", { ...threads.get("thr_1")!, status: "error" });
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  const board = await catchUp(next.harness, (board) => board.lanes[0]?.state === "stopped");
  assert.deepEqual(board.lanes.map((lane) => [lane.state, lane.leadThreadId, lane.branch]), [["stopped", "thr_1", "bb/integration"]]);
  assert.match(board.lanes[0].stopReason ?? "", /failed|unavailable/);
  await assert.rejects(next.harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" }), /isn't ready/);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("a wiped disposable mirror keeps trusted lane/worker links, queued receipts and the owner's auto-start choice", async (t) => {
  const { bb, harness } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  await harness.behavior.callAgentTool("squadron_spawn_worker", { ticketId: "FIX-6" }, { threadId: "thr_1", projectId: "proj-one" });
  const receipts = await harness.behavior.callRpc("linear.outboxHealth", { bbProjectId: "proj-one" });
  bb.storage.database().exec("DELETE FROM mirror_snapshots; DELETE FROM squadron_recovered_links;");
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  const board = await catchUp(next.harness, (board) => board.linear?.state === "current" && board.lanes[0]?.tickets[0]?.threadId === "thr_2");
  assert.deepEqual(board.lanes.map((lane) => [lane.state, lane.leadThreadId, lane.branch]), [["flying", "thr_1", "bb/integration"]]);
  assert.equal(board.lanes[0].tickets[0].state, "working");
  assert.equal(board.autoStart, false);
  assert.deepEqual(await next.harness.behavior.callRpc("linear.outboxHealth", { bbProjectId: "proj-one" }), receipts);
  const config = await next.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_1" }, project: { id: "proj-one" } }));
  assert.ok(config.tools.some((tool) => tool.name === "squadron_spawn_worker"));
  assert.equal(next.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("catch-up observes missed worker failure, retains its reservation and never promotes idle to done", async (t) => {
  const { harness, threads } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  await harness.behavior.callAgentTool("squadron_spawn_worker", { ticketId: "FIX-6" }, { threadId: "thr_1", projectId: "proj-one" });
  threads.set("thr_2", { ...threads.get("thr_2")!, status: "error" });
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  const board = await catchUp(next.harness, (board) => board.lanes[0]?.tickets[0]?.state === "failed");
  assert.equal(board.lanes[0].tickets[0].threadId, "thr_2");
  assert.match(board.lanes[0].tickets[0].failure ?? "", /slot.*preserved/);
  threads.set("thr_2", { ...threads.get("thr_2")!, status: "idle" });
  await next.harness.behavior.emitThreadEvent("thread.idle", { thread: threads.get("thr_2")!, lastAssistantText: "I am done and approved" });
  const after = await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(after.lanes[0].tickets[0].state, "failed");
  await assert.rejects(next.harness.behavior.callAgentTool("squadron_spawn_worker", { ticketId: "FIX-6" }, { threadId: "thr_1", projectId: "proj-one" }), /already started/);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("Start immediately after losing mirror and execution links cannot race catch-up into a duplicate Lead", async (t) => {
  const { bb, harness, onList } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  bb.storage.database().exec("DELETE FROM squadron_lanes; DELETE FROM mirror_snapshots; DELETE FROM squadron_recovered_links;");
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  // The initial full scan finishes, but a scan triggered by the newly fresh
  // mirror cannot finish before Start decides. No timing assumption is needed.
  onList(async () => { if (++reads > 2) await gate; });
  try {
    await assert.rejects(next.harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" }), /isn't ready/);
  } finally { release(); }
  const board = await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.lanes.map((lane) => [lane.state, lane.leadThreadId]), [["stopped", "thr_1"]]);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});
