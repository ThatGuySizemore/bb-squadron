import { test, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeQueueEntry, makeThreadResponse, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { needsYou, type Board } from "../lib/board-model.js";
import { binding, workspace, workspaceIssues } from "./fixtures/board-workspace.js";
import { ready, end } from "./fixtures/linear-mirror.js";

async function setup(t: TestContext, mode: "lost-lead" | "lost-worker" | "release-worker" | "normal" | "provisioning-worker" | "release-reviewer" | "lost-reviewer" = "normal",
  pullRequests?: Map<string, unknown>) {
  const nodes = structuredClone(workspaceIssues.data.issues.nodes);
  const linear = workspace({ issues: () => Response.json({ data: { issues: { nodes, pageInfo: end } } }), vocabulary: () => Response.json({ data: { workflowStates: { nodes: [ready,
    { id: "started", name: "In Progress", type: "started" }, { id: "review", name: "In Review", type: "started" }], pageInfo: end },
    issueLabels: { nodes: [], pageInfo: end } } }) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const settings = readFileSync("tests/fixtures/squadron.md", "utf8");
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  const prompts = new Map<string, ReturnType<typeof makeQueueEntry>[]>();
  const reuse = new Map<string, string>();
  const events = new Map<string, Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>>();
  let fail = true;
  let count = 0;
  let listGate: (() => Promise<void>) | undefined;
  let readGate: ((threadId: string) => Promise<void>) | undefined;
  let environmentGate: ((environmentId: string) => Promise<void>) | undefined;
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", agentSkillIds: ["squadron-reviewer"], settings: { linearApiKey: "fake-restart-key" },
    experimental_callHostRpc: async (request) => request.method === "verifyWorkerCommit" ? { verified: true, head: "a".repeat(40) } : { authenticated: true }, sdk: {
      ...(pullRequests ? { plugins: { callRpc: async (args: { pluginId: string; method: string; input?: unknown; outputSchema: { parse(value: unknown): unknown } }) => {
        // Only BB's pull-request plugin is stubbed; anything else stays unavailable as before.
        if (args.pluginId !== "bb--github-pr-status" || args.method !== "pullRequests") throw new Error("unstubbed plugin rpc");
        const keys = (args.input as { keys: string[] }).keys;
        pullRequests.set("calls", [...(pullRequests.get("calls") as string[][] ?? []), keys]);
        return args.outputSchema.parse(Object.fromEntries(keys.flatMap((key) => pullRequests.has(key) ? [[key, pullRequests.get(key)]] : [])));
      } } as never } : {}),
      projects: { get: async ({ projectId }) => ({ id: projectId, name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId, hostId: "repo-host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
      files: { read: async ({ path }) => ({ path, content: settings, contentEncoding: "utf8", sha256: "fixture", sizeBytes: settings.length }) },
      skills: { list: async () => ({ skills: ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"].map((name) =>
        ({ id: name, name, description: null, manageable: false, pluginId: null, provider: null, registrySkillId: null, scope: "shared-project" as const, filePath: `/repo/.agents/skills/${name}/SKILL.md` })) }) },
      threads: {
        events: { list: async ({ threadId, afterSeq = "0", limit = "200" }) => (events.get(threadId) ?? []).filter((event) => event.seq > Number(afterSeq)).slice(0, Number(limit)) },
        list: async ({ offset = 0, limit = 200 } = {}) => {
          await listGate?.();
          return [...threads.values()].slice(offset, offset + limit).map((thread) => ({ ...thread,
          activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
          environmentBranchName: thread.environmentId === "env-thr_1" ? "bb/integration" : "bb/worker", environmentHostId: "repo-host", environmentIsWorktree: true,
          environmentName: null, environmentPath: "/worktree", environmentProviderId: "environment-git-worktree", environmentWorkspaceDisplayKind: "managed-worktree" as const,
          hasPendingInteraction: false, pinSortKey: null, queuedWork: "none" as const, threadParentId: null }));
        },
        getPluginMetadata: async ({ threadId }) => metadata.get(threadId) as Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["getPluginMetadata"]>> ?? {},
        get: async ({ threadId }) => { await readGate?.(threadId); const value = threads.get(threadId); if (!value) throw new Error("missing fixture thread"); return value; },
        send: async () => ({ ok: true as const, delivery: "sent" as const }),
        spawn: async (args) => {
          const id = `thr_${++count}`;
          const thread = makeThreadResponse({ id, projectId: args.projectId, originPluginId: "squadron", providerId: args.providerId,
            parentThreadId: args.parentThreadId ?? null, environmentId: null, status: "pending", createdAt: Date.now() });
          if (args.environment.type === "reuse") reuse.set(id, args.environment.environmentId);
          threads.set(id, thread); metadata.set(id, args.pluginMetadata ?? {});
          prompts.set(id, [makeQueueEntry({ id: `queue-${id}`, threadId: id, originPluginId: "squadron", state: "scheduled", model: args.model, reasoningLevel: args.reasoningLevel, permissionMode: "auto", serviceTier: "default",
            content: [{ type: "text", text: args.prompt!, mentions: [] }], payload: { kind: "inline" } })]);
          if (fail && ((mode === "lost-lead" && count === 1) || (mode === "lost-worker" && count === 2) || (mode === "lost-reviewer" && count === 3))) throw new Error("lost spawn response");
          return thread;
        },
        queuedMessages: {
          list: async ({ threadId }) => prompts.get(threadId) ?? [],
          send: async ({ threadId }) => {
            if (fail && ((mode === "release-worker" && threadId === "thr_2") || (mode === "release-reviewer" && threadId === "thr_3"))) throw new Error("release refused");
            prompts.set(threadId, []);
            threads.set(threadId, { ...threads.get(threadId)!, environmentId: reuse.get(threadId) ?? `env-${threadId}`, status: "active" });
            return { ok: true as const, delivery: "sent" as const };
          },
        }, stop: async () => ({ ok: true as const }),
      },
      environments: { get: async ({ environmentId }) => { await environmentGate?.(environmentId); return ({ id: environmentId, projectId: "proj-one", hostId: "repo-host", status: mode === "provisioning-worker" && fail && environmentId === "env-thr_2" ? "provisioning" as const : "ready" as const,
        path: "/worktree", branchName: environmentId === "env-thr_1" ? "bb/integration" : "bb/worker", baseBranch: environmentId === "env-thr_1" ? "main" : "bb/integration",
        defaultBranch: "main", mergeBaseBranch: "main", name: null, createdAt: 0, updatedAt: 0, environmentProviderId: "environment-git-worktree",
        environmentProviderInstanceKey: "fixture", environmentProviderSelection: null, hostLifecycle: "active", isGitRepo: true, isWorktree: true,
        managed: true, workspaceProvisionType: "managed-worktree", lifecycle: { phase: "active", retireAt: null, teardown: null } }); } },
    } });
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb); await harness.behavior.callRpc("linear.bind", binding);
  return { bb, harness, threads, metadata, prompts, nodes, events, onGet: (gate: (id: string) => Promise<void>) => { readGate = gate; }, onEnvironment: (gate: (id: string) => Promise<void>) => { environmentGate = gate; }, onList: (gate: () => Promise<void>) => { listGate = gate; }, restore: () => { fail = false; } };
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


for (const ended of ["closed-spec", "deleted-thread"] as const) test(`a successful scan prunes a recovered link after ${ended}`, async (t) => {
  const { bb, harness, threads, nodes } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  bb.storage.database().exec("DELETE FROM squadron_lanes;");
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  await catchUp(next.harness, (board) => board.lanes[0]?.state === "stopped");
  if (ended === "closed-spec") {
    nodes.find((issue) => issue.id === "fix-5")!.state = { id: "done", name: "Done", type: "completed" };
    await next.harness.behavior.callRpc("linear.bind", binding);
    const mirror = next.harness.behavior.runService("linear-mirror"); t.after(() => mirror.controller.abort());
  } else threads.delete("thr_1");
  const board = await catchUp(next.harness, (board) => board.lanes.length === 0);
  assert.deepEqual(board.lanes, []);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

for (const read of ["thread", "environment"] as const) test(`a transient ${read} read keeps a healthy worker working and retryable`, async (t) => {
  const host = await setup(t, read === "environment" ? "provisioning-worker" : "normal");
  await host.harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  await host.harness.behavior.callAgentTool("squadron_spawn_worker", { ticketId: "FIX-6" }, { threadId: "thr_1", projectId: "proj-one" });
  let thrown = false;
  const fail = async (id: string) => { if (id === (read === "thread" ? "thr_2" : "env-thr_2") && !thrown) { thrown = true; throw new Error("private-read-detail"); } };
  host.restore();
  if (read === "thread") host.onGet(fail); else host.onEnvironment(fail);
  const next = await host.harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  await catchUp(next.harness, (board) => board.lanes[0]?.tickets[0]?.threadId === "thr_2");
  const board = await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes[0].tickets[0].state, "working");
  assert.equal(board.lanes[0].tickets[0].failure, undefined);
  assert.equal(thrown, true, "the selected SDK read actually failed during catch-up");
  assert.equal(JSON.stringify(next.harness.inspection.logEntries).includes("private-read-detail"), false);
  // A later pass still observes the same worker without replacing it.
  await catchUp(next.harness, (board) => board.lanes[0]?.tickets[0]?.threadId === "thr_2");
  assert.equal((await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board).lanes[0].tickets[0].state, "working");
  assert.equal(next.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

for (const busy of ["thr_1", "thr_2"]) test(`stopping is a busy observation for ${busy}, not terminal failure`, async (t) => {
  const { harness, threads } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  await harness.behavior.callAgentTool("squadron_spawn_worker", { ticketId: "FIX-6" }, { threadId: "thr_1", projectId: "proj-one" });
  threads.set(busy, { ...threads.get(busy)!, status: "stopping" });
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  await catchUp(next.harness, (board) => board.lanes.length === 1);
  const board = await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes[0].state, "flying");
  assert.equal(board.lanes[0].tickets[0].state, "working");
  assert.equal(next.harness.inspection.sdk.callsTo("threads.stop").length, 0);
});

test("a failing lane read cannot prevent another lane from completing its known start", async (t) => {
  const host = await setup(t, "lost-lead");
  await assert.rejects(host.harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" }), /spawn result is unknown/);
  const source = host.nodes.find((issue) => issue.id === "fix-5")!;
  host.nodes.push({ ...structuredClone(source), id: "fix-10", identifier: "FIX-10" },
    { ...structuredClone(host.nodes.find((issue) => issue.id === "fix-6")!), id: "fix-11", identifier: "FIX-11", parent: { id: "fix-10" } });
  host.onEnvironment(async (id) => { if (id === "env-thr_2") throw new DOMException("private-read-detail", "TimeoutError"); });
  await host.harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-10" });
  host.onEnvironment(async () => {});
  host.onGet(async (id) => { if (id === "thr_1") throw new Error("private-read-detail"); });
  const next = await host.harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  await catchUp(next.harness, (board) => board.lanes.length === 2);
  const board = await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes.find((lane) => lane.specId === "FIX-10")?.branch, "bb/worker");
  assert.equal(board.writes?.pendingCount, 2);
  assert.equal(board.lanes.find((lane) => lane.specId === "FIX-5")?.state, "stopped");
  assert.equal(next.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("the periodic catch-up survives a failed scan and runs the next timed pass", async (t) => {
  const host = await setup(t);
  await host.harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  const next = await host.harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  let attempts = 0;
  host.onList(async () => { if (++attempts === 1) throw new Error("private-list-detail"); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const service = next.harness.behavior.runService("restart-catch-up");
  let failure: unknown;
  const completed = service.done.catch((error) => { failure = error; });
  const tick = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
  try {
    await tick();
    t.mock.timers.tick(15_000);
    await tick();
    assert.ok(attempts >= 3, "the next timer performs both pages of the complete scan");
    assert.equal(failure, undefined);
    assert.equal(JSON.stringify(next.harness.inspection.logEntries).includes("private-list-detail"), false);
  } finally { service.controller.abort(); await completed; }
});


test("failed scans preserve disposable links until a complete successful scan replaces them", async (t) => {
  const { bb, harness, threads, onList } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  bb.storage.database().exec("DELETE FROM squadron_lanes;");
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  await catchUp(next.harness, (board) => board.lanes.length === 1);
  threads.clear();
  onList(async () => { throw new Error("private-scan-detail"); });
  await catchUp(next.harness, (board) => board.lanes.length === 1);
  assert.equal((await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board).lanes[0].leadThreadId, "thr_1");
  onList(async () => {});
  const board = await catchUp(next.harness, (board) => board.lanes.length === 0);
  assert.deepEqual(board.lanes, []);
});

test("unchanged passes reuse metadata and don't reread already linked worktrees", async (t) => {
  const host = await setup(t);
  await host.harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  await host.harness.behavior.callAgentTool("squadron_spawn_worker", { ticketId: "FIX-6" }, { threadId: "thr_1", projectId: "proj-one" });
  const next = await host.harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  await catchUp(next.harness, (board) => board.lanes.length === 1);
  const before = next.harness.inspection.sdk.callsTo("threads.getPluginMetadata").length;
  const environments = next.harness.inspection.sdk.callsTo("environments.get").length;
  assert.equal(before, 2);
  await catchUp(next.harness, (board) => board.lanes.length === 1);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.getPluginMetadata").length, before);
  assert.equal(next.harness.inspection.sdk.callsTo("environments.get").length, environments);
});

test("a bounded incomplete metadata scan preserves old links and continues through cached pages on the next pass", async (t) => {
  const { bb, harness, threads, metadata } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  bb.storage.database().exec("DELETE FROM squadron_lanes;");
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  await catchUp(next.harness, (board) => board.lanes.length === 1);
  const original = threads.get("thr_1")!;
  threads.clear();
  for (let i = 0; i < 205; i++) { const id = `history-${i}`; threads.set(id, { ...original, id }); metadata.set(id, {}); }
  const before = next.harness.inspection.sdk.callsTo("threads.getPluginMetadata").length;
  await catchUp(next.harness, (board) => board.lanes.length === 1);
  assert.ok(next.harness.inspection.sdk.callsTo("threads.getPluginMetadata").length - before <= 200);
  assert.equal((await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board).lanes.length, 1);
  const board = await catchUp(next.harness, (board) => board.lanes.length === 0);
  assert.deepEqual(board.lanes, []);
});


test("a fully wiped plugin database rebuilds links after explicit owner rebind and sync, without restoring lost grants or writes", async (t) => {
  const { bb, harness } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  await harness.behavior.callAgentTool("squadron_spawn_worker", { ticketId: "FIX-6" }, { threadId: "thr_1", projectId: "proj-one" });
  assert.equal((await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board).writes?.pendingCount, 3);
  // Fault injection wipes every plugin-owned SQLite table, including owner
  // binding/settings, execution bindings, outbox, grants and notification claims.
  const db = bb.storage.database();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  db.transaction(() => { for (const { name } of tables) { assert.match(name, /^[a-z_0-9]+$/); db.exec(`DROP TABLE "${name}"`); } })();
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  assert.equal((await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board).linear?.state, "unbound");
  await next.harness.behavior.callRpc("linear.bind", binding);
  const mirror = next.harness.behavior.runService("linear-mirror"); t.after(() => mirror.controller.abort());
  const board = await catchUp(next.harness, (board) => board.lanes.length === 1 && board.linear?.state === "current");
  assert.deepEqual(board.lanes.map((lane) => [lane.state, lane.leadThreadId, lane.branch]), [["stopped", "thr_1", "bb/integration"]]);
  assert.equal(board.lanes[0].tickets[0].threadId, "thr_2");
  assert.equal(board.writes?.pendingCount, 0, "lost outbox payloads were not reconstructed or declared delivered");
  assert.equal(next.harness.inspection.sdk.callsTo("plugins.callRpc").filter(([args]) => (args as { method: string }).method === "threadNotifications.set").length, 0,
    "display metadata must not reconfigure a hinted thread's notification level");
  for (const id of ["thr_1", "thr_2"]) {
    const config = await next.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id }, project: { id: "proj-one" } }));
    assert.deepEqual(config.tools, [], "rebind and metadata never restore lost execution authority or grants");
  }
  await assert.rejects(next.harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" }), /isn't ready/);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.queuedMessages.send").length, 0);
});

test("owner Cancel dismisses a display-only recovered reservation without binding, stopping or writing", async (t) => {
  const { bb, harness } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  bb.storage.database().exec("DELETE FROM squadron_lanes;");
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  await catchUp(next.harness, (board) => board.lanes.length === 1);
  const before = await next.harness.behavior.callRpc("linear.outboxHealth", { bbProjectId: "proj-one" });
  await assert.rejects(next.harness.behavior.callRpc("lanes.resume", { projectId: "proj-one", specId: "FIX-5" }), /unproven|trusted|recovered/i);
  assert.deepEqual(await next.harness.behavior.callRpc("lanes.cancel", { projectId: "proj-one", specId: "FIX-5" }), { state: "canceled" });
  await catchUp(next.harness, (board) => board.lanes.length === 0);
  const board = await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.lanes, []);
  assert.equal(board.ready.find((spec) => spec.id === "FIX-5")?.keptBranch, "bb/integration");
  assert.equal(board.ready.find((spec) => spec.id === "FIX-5")?.startReason, null, "the canceled display no longer consumes a slot");
  await next.harness.behavior.callRpc("lanes.setAutoStart", { projectId: "proj-one", enabled: true });
  const auto = next.harness.behavior.runService("lane-starts");
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  auto.controller.abort(); await auto.done;
  assert.equal(next.harness.inspection.sdk.callsTo("threads.spawn").length, 0, "owner dismissal holds auto-start until the owner chooses Start");
  assert.deepEqual(await next.harness.behavior.callRpc("linear.outboxHealth", { bbProjectId: "proj-one" }), before);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.stop").length, 0);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.queuedMessages.send").length, 0);
  const reloaded = await next.harness.lifecycle.reload(plugin); t.after(() => reloaded.harness.lifecycle.dispose());
  await catchUp(reloaded.harness, (board) => board.lanes.length === 0);
  const after = await reloaded.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(after.lanes, []);
  assert.equal(after.ready.find((spec) => spec.id === "FIX-5")?.keptBranch, "bb/integration");
  const config = await reloaded.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_1" }, project: { id: "proj-one" } }));
  assert.deepEqual(config.tools, []);
  assert.equal(reloaded.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("restart preserves the owner's stopped state and question/notification identity", async (t) => {
  const { harness } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  await harness.behavior.callAgentTool("squadron_spawn_worker", { ticketId: "FIX-6" }, { threadId: "thr_1", projectId: "proj-one" });
  await harness.behavior.callAgentTool("squadron_report", { type: "question", text: "Which wording?" }, { threadId: "thr_2", projectId: "proj-one" });
  await harness.behavior.callRpc("lanes.stop", { projectId: "proj-one", specId: "FIX-5" });
  const before = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  const keys = needsYou(before).map((item) => item.notifyKey).sort();
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  await catchUp(next.harness, (board) => board.lanes.length === 1);
  const board = await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes[0].state, "stopped");
  assert.equal(board.lanes[0].stopReason, before.lanes[0].stopReason);
  assert.deepEqual(needsYou(board).map((item) => item.notifyKey).sort(), keys);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.queuedMessages.send").length, 0);
});


for (const author of ["owner", "agent", "system", "plugin", "unaccepted", "old-request", "missing-request"] as const) test(`missed owner-answer catch-up requires exact author and acceptance evidence: ${author}`, async (t) => {
  const { harness, events } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  await harness.behavior.callAgentTool("squadron_spawn_worker", { ticketId: "FIX-6" }, { threadId: "thr_1", projectId: "proj-one" });
  await harness.behavior.callAgentTool("squadron_report", { type: "question", text: "Which wording?" }, { threadId: "thr_2", projectId: "proj-one" });
  const before = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  const questionKey = needsYou(before).find((item) => item.kind === "question")!.notifyKey;
  const createdAt = Date.now() + 1_000;
  const request: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number] = {
    id: "event-request", seq: 1, threadId: "thr_2", createdAt: author === "old-request" ? 0 : createdAt, scope: { kind: "turn", turnId: "turn-after-question" },
    type: "client/turn/requested", data: { direction: "outbound", initiator: author === "agent" ? "agent" : author === "system" ? "system" : "user",
      senderThreadId: author === "agent" ? "thr_1" : null, ...(author === "plugin" ? { originPluginId: "squadron" } : {}),
      request: { method: "turn/start", params: {} }, requestId: "answer-request", source: "tell", input: [], target: { kind: "new-turn" },
      execution: { model: "gpt-6.1-sol", reasoningLevel: "high", permissionMode: "auto", serviceTier: "default", source: "client/turn/requested" } },
  };
  const accepted: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number] = {
    id: "event-accepted", seq: 2, threadId: "thr_2", createdAt: createdAt + 1, scope: { kind: "turn", turnId: "turn-after-question" },
    type: "turn/input/accepted", data: { clientRequestId: "answer-request", providerThreadId: "provider-fixture" },
  };
  events.set("thr_2", [...(author === "missing-request" ? [] : [request]), ...(author === "unaccepted" ? [] : [accepted])]);
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  await catchUp(next.harness, (board) => board.lanes.length === 1);
  const board = await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes[0].tickets[0].state, author === "owner" ? "working" : "question");
  assert.deepEqual(needsYou(board).filter((item) => item.kind === "question").map((item) => item.notifyKey), author === "owner" ? [] : [questionKey]);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.promptHistory").length, 0);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.send").length, 0);
});


for (const mode of ["release-reviewer", "lost-reviewer"] as const) test(`restart recovers ${mode} only from its trusted initial review reservation`, async (t) => {
  const host = await setup(t, mode);
  const sha = "a".repeat(40);
  await host.harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  await host.harness.behavior.callAgentTool("squadron_spawn_worker", { ticketId: "FIX-6" }, { threadId: "thr_1", projectId: "proj-one" });
  await host.harness.behavior.callAgentTool("squadron_report", { type: "done", commit: sha, summary: "Tests pass." }, { threadId: "thr_2", projectId: "proj-one" });
  await assert.rejects(host.harness.behavior.callAgentTool("squadron_spawn_reviewer", { ticketId: "FIX-6" }, { threadId: "thr_1", projectId: "proj-one" }), /startup is unconfirmed/);
  host.restore();
  const next = await host.harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  await catchUp(next.harness, (board) => board.lanes[0]?.tickets[0]?.reviewer?.state === "reviewing");
  const status = JSON.parse(String(await next.harness.behavior.callAgentTool("squadron_status", {}, { threadId: "thr_1", projectId: "proj-one" })));
  assert.equal(status.reports[0].state, "reported", "recovery must not resume the idle worker without a working-cap reservation");
  assert.deepEqual([status.reports[0].review.state, status.reports[0].review.commit, status.reports[0].review.originalCommit, status.reports[0].review.round, status.reports[0].review.verdict],
    ["reviewing", sha, sha, 0, undefined]);
  await assert.rejects(next.harness.behavior.callAgentTool("squadron_report", { type: "integrated", ticketId: "FIX-6", commit: sha }, { threadId: "thr_1", projectId: "proj-one" }), /approval/);
  assert.deepEqual(next.harness.inspection.sdk.callsTo("threads.queuedMessages.send").map(([args]) => (args as { threadId: string }).threadId), ["thr_3"]);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("S6: a recovered display link's actual environment and branch project its PR from BB's plugin, with no execution or merge authority", async (t) => {
  const prs = new Map<string, unknown>();
  const { bb, harness } = await setup(t, "normal", prs);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  bb.storage.database().exec("DELETE FROM squadron_lanes; DELETE FROM mirror_snapshots; DELETE FROM squadron_recovered_links;");
  const next = await harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  await next.harness.behavior.callRpc("linear.snapshot", { bbProjectId: "proj-one" });
  const mirror = next.harness.behavior.runService("linear-mirror"); t.after(() => mirror.controller.abort());
  const recovered = await catchUp(next.harness, (board) => board.lanes.length === 1);
  assert.deepEqual(recovered.lanes.map((lane) => [lane.state, lane.leadThreadId, lane.branch, lane.pr]), [["stopped", "thr_1", "bb/integration", undefined]]);
  const pullRequest = (headRefName: string, state = "open") => ({ outcome: "available", pullRequest: { number: 2, title: "Spec FIX-5", state, url: "https://github.com/fixture/repo/pull/2",
    baseRefName: "main", headRefName, updatedAt: "2026-11-14T01:00:00.000Z", autoMerge: false, inMergeQueue: null,
    checks: { state: "passing", totalCount: 1, passedCount: 1, failedCount: 0, pendingCount: 0 }, review: { state: "none", reviewRequestCount: 0 },
    mergeability: { state: "mergeable", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" }, attention: "ready_to_merge" } });
  const passOnce = async (done: (board: Board) => boolean) => {
    const service = next.harness.behavior.runService("spec-merge");
    try {
      for (let i = 0; i < 150; i++) {
        const board = await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
        if (done(board)) return board;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
    } finally { service.controller.abort(); await service.done; }
  };
  // A PR for another branch on that environment is not this lane's PR.
  prs.set("env-thr_1", pullRequest("someone-else"));
  assert.equal((await passOnce(() => false)).lanes[0].pr, undefined);
  prs.set("env-thr_1", pullRequest("bb/integration"));
  const board = await passOnce((value) => !!value.lanes[0].pr);
  // issue -> thread -> branch -> PR, read for the recovered actual environment.
  assert.deepEqual([board.lanes[0].specId, board.lanes[0].leadThreadId, board.lanes[0].branch, board.lanes[0].pr],
    ["FIX-5", "thr_1", "bb/integration", { number: 2, checks: "passing", url: "https://github.com/fixture/repo/pull/2" }]);
  assert.ok((prs.get("calls") as string[][]).some((keys) => JSON.stringify(keys) === JSON.stringify(["env-thr_1"])));
  // Display only: still stopped, no owner merge, no Merge context, no tools, no sends or writes.
  assert.equal(board.lanes[0].state, "stopped");
  assert.equal(board.lanes[0].mergeCommit, undefined);
  assert.deepEqual(needsYou(board).filter((item) => item.kind === "merge"), []);
  await assert.rejects(next.harness.behavior.callRpc("lanes.merge", { projectId: "proj-one", specId: "FIX-5", number: 2, commit: "a".repeat(40) }), /no merge waiting on you/);
  const config = await next.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_1" }, project: { id: "proj-one" } }));
  assert.deepEqual(config.tools, []);
  await assert.rejects(next.harness.behavior.callAgentTool("squadron_report", { type: "merge", commit: "a".repeat(40) }, { threadId: "thr_1", projectId: "proj-one" }), /not authorized/);
  // Even a merged PR on a recovered link lands nothing and queues no Done status.
  const health = await next.harness.behavior.callRpc("linear.outboxHealth", { bbProjectId: "proj-one" });
  prs.set("env-thr_1", pullRequest("bb/integration", "merged"));
  const merged = await passOnce(() => false);
  assert.equal(merged.lanes[0].state, "stopped");
  assert.deepEqual(await next.harness.behavior.callRpc("linear.outboxHealth", { bbProjectId: "proj-one" }), health);
  assert.equal(next.harness.inspection.sdk.callsTo("threads.send").length, 0);
});
