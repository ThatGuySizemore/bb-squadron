import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeQueueEntry, makeThreadResponse, makePluginAgentConfigurationContext, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server.js";
import { LinearRequestError } from "../lib/linear-auth.js";
import type { Board } from "../lib/board-model.js";
import { binding, workspace, workspaceIssues } from "./fixtures/board-workspace.js";
import { end, ready } from "./fixtures/linear-mirror.js";

const settings = readFileSync("tests/fixtures/squadron.md", "utf8");
const commit = "a".repeat(40);
const head = "b".repeat(40);
async function setup(t: import("node:test").TestContext, options: { verify?: boolean; spawnFails?: boolean; provisioning?: boolean; releaseFails?: "lead" | "worker"; reviewName?: string; workerReleaseGate?: Promise<void>; deferWorkerEnvironment?: boolean; onEnvironmentRead?: (id: string) => Promise<void> } = {}) {
  const nodes = structuredClone(workspaceIssues.data.issues.nodes);
  const original = nodes.find((issue) => issue.id === "fix-6")!;
  for (const i of [7, 8, 10, 11]) nodes.push({ ...structuredClone(original), id: `fix-${i}`, identifier: `FIX-${i}`, title: `Ticket ${i}` });
  const successor = nodes.find((issue) => issue.id === "fix-7")!;
  successor.inverseRelations = { nodes: [{ id: "6-blocks-7", type: "blocks", issue: structuredClone(original), relatedIssue: structuredClone(successor) }], pageInfo: end } as unknown as typeof successor.inverseRelations;
  let refuseWrite = false;
  const linear = workspace({ issues: () => Response.json({ data: { issues: { nodes, pageInfo: end } } }),
    vocabulary: () => Response.json({ data: { workflowStates: { nodes: [ready,
      { id: "state-started", name: "In Progress", type: "started" }, { id: "state-review", name: options.reviewName ?? "In Review", type: "started" }], pageInfo: end },
      issueLabels: { nodes: [], pageInfo: end } } }) });
  const mutations: Array<{ query: string; variables: { id?: string; input: Record<string, string> } }> = [];
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (refuseWrite && body.query.includes("SquadronIdentity")) return Response.json({ data: { viewer: { id: "fixture-user", name: "Fixture" }, organization: { id: "changed", name: "Changed" } } });
    if (!body.query.trimStart().startsWith("mutation")) return linear.fetch(url, init);
    mutations.push(body);
    return Response.json({ data: body.query.includes("issueUpdate") ? { issueUpdate: { success: true, issue: { id: body.variables.id } } }
      : { commentCreate: { success: true, comment: { id: body.variables.input.id } } } });
  });
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  let count = 0;
  const firstConfigurations: Array<[string, string[]]> = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", settings: { linearApiKey: "fake-worker-key" },
    experimental_callHostRpc: async (request) => request.method === "verifyWorkerCommit"
      ? { verified: options.verify ?? true, head: options.verify === false ? null : head } : { authenticated: true },
    sdk: {
      projects: { get: async ({ projectId }) => ({ id: projectId, name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId, hostId: "repo-host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
      files: { read: async ({ path }) => ({ content: settings, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: settings.length }) },
      skills: { list: async () => ({ skills: ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"].map((name) =>
        ({ id: name, name, description: null, manageable: false, pluginId: null, provider: null, registrySkillId: null,
          scope: "shared-project" as const, filePath: `/repo/.agents/skills/${name}/SKILL.md` })) }) },
      threads: {
        queuedMessages: {
          list: async ({ threadId }) => [makeQueueEntry({ id: `queued-${threadId}`, threadId })],
          send: async ({ threadId }) => {
            const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: threadId }, project: { id: "proj-one" } }));
            firstConfigurations.push([threadId, config.tools.map((tool) => tool.name).sort()]);
            if (options.releaseFails === (threadId === "thr_lead" ? "lead" : "worker")) throw new Error("fake-private-release-error");
            if (threadId !== "thr_lead" && options.workerReleaseGate) await options.workerReleaseGate;
            const value = threads.get(threadId)!;
            if (!options.deferWorkerEnvironment || threadId === "thr_lead") threads.set(threadId, { ...value, environmentId: `env-${threadId}` });
            return { ok: true as const, delivery: "sent" as const };
          },
        },
        send: async () => ({ ok: true as const, delivery: "sent" as const }),
        spawn: async (args) => {
          if (options.spawnFails && count) throw new Error("fake-private-spawn-error");
          const id = count++ === 0 ? "thr_lead" : `thr_worker_${count}`;
          const value = makeThreadResponse({ id, projectId: args.projectId, environmentId: null, parentThreadId: args.parentThreadId ?? null }); threads.set(id, value); return value;
        },
        get: async ({ threadId }) => threads.get(threadId) ?? makeThreadResponse({ id: threadId, projectId: "proj-one" }),
      },
      environments: { get: async ({ environmentId }) => {
        await options.onEnvironmentRead?.(environmentId);
        return ({ id: environmentId, projectId: "proj-one", hostId: "repo-host",
        status: options.provisioning && environmentId !== "env-thr_lead" ? "provisioning" as const : "ready" as const,
        branchName: environmentId === "env-thr_lead" ? "bb/integration" : `bb/${environmentId}`, path: "/worktree",
        baseBranch: environmentId === "env-thr_lead" ? "main" : "bb/integration", defaultBranch: "main", mergeBaseBranch: "main", name: null, createdAt: 0, updatedAt: 0,
        environmentProviderId: "environment-git-worktree", environmentProviderInstanceKey: "fixture", environmentProviderSelection: null,
        hostLifecycle: "active", isGitRepo: true, isWorktree: true, managed: true, workspaceProvisionType: "managed-worktree",
        lifecycle: { phase: "active", retireAt: null, teardown: null } }); } },
    },
  });
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb); await harness.behavior.callRpc("linear.bind", binding);
  const lead = { threadId: "thr_lead", projectId: "proj-one" };
  const call = async (name: string, input: unknown, context = lead) => JSON.parse(String(await harness.behavior.callAgentTool(name, input, context)));
  const board = async () => await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  const start = async () => await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  return { bb, harness, start, call, board, mutations, threads, firstConfigurations, refuseWrites: () => { refuseWrite = true; }, restoreWrites: () => { refuseWrite = false; } };
}

test("SDK host end-to-end: Start -> Lead worker spawn -> worker report -> verified integration -> status move", async (t) => {
  const { harness, start, call, board, mutations, firstConfigurations } = await setup(t);
  await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  assert.equal(worker.threadId, "thr_worker_2");
  assert.deepEqual(firstConfigurations, [
    ["thr_lead", ["squadron_report", "squadron_spawn_worker", "squadron_status"]],
    ["thr_worker_2", ["squadron_report", "squadron_status"]],
  ]);
  const spawns = harness.inspection.sdk.callsTo("threads.spawn");
  const args = spawns[1][0] as Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
  assert.equal(args.parentThreadId, "thr_lead");
  assert.deepEqual(args.environment, { type: "host", hostId: "repo-host", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "bb/integration" } } });
  assert.deepEqual([args.providerId, args.model, args.reasoningLevel, args.serviceTier], ["codex", "gpt-6.1-sol", "high", "default"]);
  assert.deepEqual([args.pluginMetadata?.role, args.pluginMetadata?.ticketId, args.pluginMetadata?.specId], ["Worker", "FIX-6", "FIX-5"]);
  assert.match(args.prompt ?? "", /tdd/);
  assert.match(args.prompt ?? "", /Merge the latest integration branch tip into your own branch before reporting done\./);
  assert.match(args.prompt ?? "", /Do not merge into the integration branch or open or merge the PR\./);
  await call("squadron_report", { type: "done", commit, summary: "Built with tests." }, { threadId: worker.threadId, projectId: "proj-one" });
  await assert.rejects(call("squadron_spawn_worker", { ticketId: "FIX-7" }), /Waits on FIX-6/);
  await call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit });
  const value = await board();
  assert.equal(value.lanes[0].tickets.find((ticket) => ticket.id === "FIX-6")?.state, "branch");
  assert.equal(value.lanes[0].tickets.find((ticket) => ticket.id === "FIX-7")?.state, "ready");
  assert.equal(value.lanes[0].tickets.find((ticket) => ticket.id === "FIX-6")?.threadId, worker.threadId);
  const delivery = harness.behavior.runService("linear-outbox"); t.after(() => delivery.controller.abort());
  for (let i = 0; i < 200 && mutations.length < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const statuses = mutations.filter((item) => item.query.includes("issueUpdate"));
  assert.deepEqual(statuses.map((item) => item.variables), [
    { id: "fix-5", input: { stateId: "state-started" } }, { id: "fix-6", input: { stateId: "state-started" } },
    { id: "fix-6", input: { stateId: "state-review" } },
  ]);
  assert.equal(statuses.some((item) => item.variables.input.stateId === "state-done"), false);
  await call("squadron_spawn_worker", { ticketId: "FIX-7" });
});

test("unbound and forged-role threads cannot call lane tools; only a bound Lead can spawn and record integration", async (t) => {
  const { start, call, board } = await setup(t); await start();
  await assert.rejects(call("squadron_spawn_worker", { ticketId: "FIX-6" }, { threadId: "forged-lead", projectId: "proj-one" }), /not authorized/);
  await assert.rejects(call("squadron_status", {}, { threadId: "thr_lead", projectId: "other-project" }), /not authorized/);
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  const context = { threadId: worker.threadId, projectId: "proj-one" };
  await assert.rejects(call("squadron_spawn_worker", { ticketId: "FIX-8" }, context), /Only the bound Lead/);
  await assert.rejects(call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit }, context), /not authorized/);
  await assert.rejects(call("squadron_report", { type: "done", commit, summary: "Forged done." }), /not authorized/);
  const status = await call("squadron_status", {}, context);
  assert.equal(status.role, "Worker");
  assert.equal((await board()).lanes[0].tickets.find((item) => item.id === "FIX-6")?.state, "working");
});

test("concurrent worker dispatch reserves cap and duplicate slots before spawning", async (t) => {
  const { start, call, harness } = await setup(t); await start();
  const results = await Promise.allSettled([6, 6, 8, 10].map((i) => call("squadron_spawn_worker", { ticketId: `FIX-${i}` })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  const reasons = results.flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []);
  assert.ok(reasons.some((reason) => reason.includes("already started")));
  assert.ok(reasons.some((reason) => reason.includes("slots are full")));
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 3);
});

test("only a verified worker commit can report done or release its successor", async (t) => {
  const { start, call, board } = await setup(t, { verify: false }); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await assert.rejects(call("squadron_report", { type: "done", commit, summary: "Unverified." }, { threadId: worker.threadId, projectId: "proj-one" }), /could not be verified/);
  await assert.rejects(call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit }), /report done before integration/);
  assert.equal((await board()).lanes[0].tickets.find((item) => item.id === "FIX-7")?.state, "blocked");
});

test("owner changes a ticket's route before dispatch; thread uses it and further changes are refused", async (t) => {
  const { start, call, harness, board } = await setup(t); await start();
  const route = { family: "claude", model: "claude-opus-5-5", effort: "high" };
  await harness.behavior.callRpc("workers.route", { projectId: "proj-one", specId: "FIX-5", ticketId: "FIX-6", route });
  assert.equal((await board()).lanes[0].tickets.find((item) => item.id === "FIX-6")?.route.family, "claude");
  await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  const args = harness.inspection.sdk.callsTo("threads.spawn")[1][0] as Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
  assert.deepEqual([args.providerId, args.model, args.reasoningLevel], ["claude-code", "claude-opus-5-5", "high"]);
  await assert.rejects(harness.behavior.callRpc("workers.route", { projectId: "proj-one", specId: "FIX-5", ticketId: "FIX-6", route }), /locked once work starts/);
  await assert.rejects(harness.behavior.callRpc("workers.route", { projectId: "proj-one", specId: "FIX-5", ticketId: "FIX-8", route: { ...route, model: "invented" } }), /Choose a route/);
});

test("agent configuration selects role tools from trusted bindings and ignores forged metadata", async (t) => {
  const { start, call, harness } = await setup(t); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  const config = (threadId: string) => harness.behavior.resolveAgentConfiguration({
    pluginMetadata: { role: "Lead", laneId: "forged", specId: "FIX-5" },
    thread: { id: threadId, title: "Fixture", parentThreadId: null, sourceThreadId: null },
    project: { id: "proj-one", kind: "standard", name: "Fixture", gitRemoteUrl: null },
    environment: { id: "env", name: null, path: "/repo", branchName: "branch", workspaceProvisionType: "managed-worktree" },
    host: { id: "repo-host", name: "Fixture host" }, provider: { id: "codex", model: "gpt-6.1-sol", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId: null },
  });
  assert.deepEqual((await config("forged")).tools, []);
  assert.deepEqual((await config("thr_lead")).tools.map((tool) => tool.name).sort(), ["squadron_report", "squadron_spawn_worker", "squadron_status"]);
  assert.deepEqual((await config(worker.threadId)).tools.map((tool) => tool.name).sort(), ["squadron_report", "squadron_status"]);
});

test("ambiguous worker spawn reserves the ticket and a slow known worktree remains linked", async (t) => {
  await t.test("unknown spawn", async (t) => {
    const { start, call, board, harness } = await setup(t, { spawnFails: true }); await start();
    await assert.rejects(call("squadron_spawn_worker", { ticketId: "FIX-6" }), /spawn result is unknown/);
    await assert.rejects(call("squadron_spawn_worker", { ticketId: "FIX-6" }), /already started/);
    const ticket = (await board()).lanes[0].tickets.find((item) => item.id === "FIX-6")!;
    assert.equal(ticket.state, "failed"); assert.equal(ticket.threadId, undefined);
    assert.match(ticket.failure ?? "", /slot stays reserved/);
    assert.ok(!JSON.stringify(harness.inspection.logEntries).includes("fake-private-spawn-error"));
  });
  await t.test("provisioning", async (t) => {
    const { start, call, board, harness } = await setup(t, { provisioning: true }); await start();
    const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
    assert.equal(worker.branch, null);
    await assert.rejects(call("squadron_report", { type: "done", commit, summary: "Too early." }, { threadId: worker.threadId, projectId: "proj-one" }), /still provisioning/);
    assert.equal((await board()).lanes[0].tickets.find((item) => item.id === "FIX-6")?.threadId, worker.threadId);
    assert.equal(harness.inspection.sdk.callsTo("threads.stop").length, 0);
  });
});

test("a worker report reaches its Lead, and a refused status preserves progress and retries through the same keys", async (t) => {
  let at = Date.now();
  const clock = mock.method(Date, "now", () => at); t.after(() => clock.mock.restore());
  const { start, call, harness, threads, refuseWrites, restoreWrites, board } = await setup(t); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await call("squadron_report", { type: "done", commit, summary: "Tests pass." }, { threadId: worker.threadId, projectId: "proj-one" });
  const messages = harness.inspection.sdk.callsTo("threads.send");
  assert.equal(messages.length, 1);
  const message = messages[0][0] as Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0];
  assert.equal(message.threadId, "thr_lead");
  assert.ok(JSON.stringify(message.input).includes(commit));
  refuseWrites();
  await call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit });
  const ticket = (await board()).lanes[0].tickets.find((item) => item.id === "FIX-6")!;
  assert.equal(ticket.state, "branch"); assert.match(ticket.writeError ?? "", /couldn't queue/);
  assert.ok(harness.inspection.logEntries.some((entry) => /Lane .* worker .* queue-integrated: workspace_changed/.test(entry.message)));
  restoreWrites(); at += 60_001; // The connection's documented identity reuse expires.
  await call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit });
  assert.equal((await board()).writes?.pendingCount, 5);
  await call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit });
  assert.equal((await board()).writes?.pendingCount, 5);
  const current = threads.get(worker.threadId)!; threads.set(worker.threadId, { ...current, archivedAt: 1 });
  await assert.rejects(call("squadron_status", {}, { threadId: worker.threadId, projectId: "proj-one" }), /not authorized/);
});

test("a failed first-prompt release keeps its binding visible and refuses a later automatic scheduled dispatch", async (t) => {
  await t.test("Lead", async (t) => {
    const { start, board, harness } = await setup(t, { releaseFails: "lead" });
    await assert.rejects(start(), /first prompt couldn't be released/);
    const lane = (await board()).lanes[0]; assert.equal(lane.leadThreadId, "thr_lead"); assert.equal(lane.state, "stopped");
    const decision = await harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({
      thread: { id: "thr_lead" }, project: { id: "proj-one" }, origin: "plugin", originPluginId: "squadron",
    }));
    assert.equal(decision.action, "reject");
  });
  await t.test("Worker", async (t) => {
    const { start, call, board, harness } = await setup(t, { releaseFails: "worker" }); await start();
    await assert.rejects(call("squadron_spawn_worker", { ticketId: "FIX-6" }), /first prompt couldn't be released/);
    const ticket = (await board()).lanes[0].tickets.find((item) => item.id === "FIX-6")!;
    assert.equal(ticket.state, "failed"); assert.equal(ticket.threadId, "thr_worker_2");
    const gate = harness.inspection.registrations.hooks["message.dispatch"]!;
    assert.equal((await gate(makeMessageDispatchHookContext({ thread: { id: "thr_worker_2" }, project: { id: "proj-one" }, originPluginId: "squadron" }))).action, "reject");
    assert.equal((await gate(makeMessageDispatchHookContext({ thread: { id: "unbound" }, project: { id: "proj-one" }, originPluginId: "squadron" }))).action, "reject");
    assert.equal((await gate(makeMessageDispatchHookContext({ thread: { id: "ordinary" }, project: { id: "proj-one" }, originPluginId: "other-plugin" }))).action, "proceed");
  });
});

test("a corrected done report names its new verified commit and invalidates attempts to integrate the earlier report", async (t) => {
  const { start, call, harness } = await setup(t); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  const context = { threadId: worker.threadId, projectId: "proj-one" };
  await call("squadron_report", { type: "done", commit, summary: "First report." }, context);
  await call("squadron_report", { type: "done", commit, summary: "First report." }, context);
  assert.equal(harness.inspection.sdk.callsTo("threads.send").length, 1);
  const corrected = "c".repeat(40);
  await call("squadron_report", { type: "done", commit: corrected, summary: "Review fixes and tests." }, context);
  assert.equal(harness.inspection.sdk.callsTo("threads.send").length, 2);
  await assert.rejects(call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit }), /different commit/);
  const status = await call("squadron_status", {});
  assert.equal(status.reports[0].commit, corrected);
});

test("the manual lane's Waiting to Merge vocabulary represents In Review without inventing a state", async (t) => {
  const { start, call } = await setup(t, { reviewName: "Waiting to Merge" }); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await call("squadron_report", { type: "done", commit, summary: "Tests pass." }, { threadId: worker.threadId, projectId: "proj-one" });
  assert.equal((await call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit })).state, "integrated");
});

test("auto-start's concurrent timer preserves a bound worker waiting on its first prompt without duplicate Leads or workers", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { start, call, board, harness, firstConfigurations } = await setup(t, { workerReleaseGate: gate });
  await start();
  const spawning = call("squadron_spawn_worker", { ticketId: "FIX-6" });
  try {
    for (let i = 0; i < 200 && firstConfigurations.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(firstConfigurations.length, 2, "the saved child binding was visible before release");
    await harness.behavior.callRpc("lanes.setAutoStart", { projectId: "proj-one", enabled: true });
    const timer = harness.behavior.runService("lane-starts"); t.after(() => timer.controller.abort());
    const waiting = await board();
    assert.equal(waiting.autoStart, true);
    assert.equal(waiting.lanes.length, 1);
    assert.equal(waiting.lanes[0].tickets.find((ticket) => ticket.id === "FIX-6")?.threadId, "thr_worker_2");
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 2);
  } finally { release(); }
  const worker = await spawning;
  await call("squadron_report", { type: "done", commit, summary: "Combined source checks." }, { threadId: worker.threadId, projectId: "proj-one" });
  await call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit });
  const result = await board();
  assert.equal(result.lanes[0].tickets.find((ticket) => ticket.id === "FIX-6")?.state, "branch");
  assert.equal(result.lanes[0].tickets.find((ticket) => ticket.id === "FIX-7")?.state, "ready");
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 2);
});

test("environment refresh preserves a newer worker reservation and the refreshed worker's newer done state", async (t) => {
  let entered!: () => void;
  let release!: () => void;
  const refreshing = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const { start, call, board, threads } = await setup(t, { deferWorkerEnvironment: true,
    onEnvironmentRead: async (id) => {
      if (id === "env-thr_worker_2" && ++reads === 1) { entered(); await gate; }
    },
  });
  await start();
  const first = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  assert.equal(first.branch, null);
  threads.set(first.threadId, { ...threads.get(first.threadId)!, environmentId: "env-thr_worker_2" });
  const workerContext = { threadId: first.threadId, projectId: "proj-one" };
  const pendingStatus = call("squadron_status", {}, workerContext);
  try {
    await refreshing;
    const next = await call("squadron_spawn_worker", { ticketId: "FIX-8" });
    await call("squadron_report", { type: "done", commit, summary: "Finished while status waited." }, workerContext);
    release();
    await pendingStatus;
    const cards = (await board()).lanes[0].tickets;
    assert.equal(cards.find((ticket) => ticket.id === "FIX-8")?.threadId, next.threadId, "the later child must retain its reservation and link");
    assert.equal(cards.find((ticket) => ticket.id === "FIX-6")?.state, "review", "refresh must preserve the newer done report");
    assert.equal((await call("squadron_status", {})).reports.find((report: { ticketId: string }) => report.ticketId === "FIX-6")?.commit, commit);
    await assert.rejects(call("squadron_spawn_worker", { ticketId: "FIX-8" }), /already started/);
  } finally { release(); await pendingStatus; }
});

test("worker diagnostics retain safe classes and codes without leaking provider messages", async (t) => {
  const cases = [
    { name: "timeout", error: new DOMException("fake-private-diagnostic-detail", "TimeoutError"), expected: "TimeoutError" },
    { name: "abort", error: new DOMException("fake-private-diagnostic-detail", "AbortError"), expected: "AbortError" },
    { name: "Linear code", error: new LinearRequestError("rate_limited"), expected: "LinearRequestError:rate_limited" },
    { name: "type", error: new TypeError("fake-private-diagnostic-detail"), expected: "TypeError" },
  ];
  for (const item of cases) await t.test(item.name, async (t) => {
    const { start, call, harness } = await setup(t, { onEnvironmentRead: async (id) => {
      if (id !== "env-thr_lead") throw item.error;
    } });
    await start();
    await call("squadron_spawn_worker", { ticketId: "FIX-6" });
    assert.ok(harness.inspection.logEntries.some((entry) => entry.message.startsWith("Lane ") && entry.message.includes(" worker ") && entry.message.endsWith(`provisioning: ${item.expected}`)));
    assert.ok(!JSON.stringify(harness.inspection.logEntries).includes("fake-private-diagnostic-detail"));
  });
});
