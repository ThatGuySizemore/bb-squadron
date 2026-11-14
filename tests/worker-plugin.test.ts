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
async function setup(t: import("node:test").TestContext, options: { sendFailure?: "fix" | "verdict" | "second-look"; relationConflict?: string; verify?: boolean; spawnFails?: boolean; provisioning?: boolean; releaseFails?: "lead" | "worker" | "reviewer"; reviewName?: string; workerReleaseGate?: Promise<void>; deferWorkerEnvironment?: boolean; onEnvironmentRead?: (id: string) => Promise<void> } = {}) {
  const nodes = structuredClone(workspaceIssues.data.issues.nodes);
  const original = nodes.find((issue) => issue.id === "fix-6")!;
  for (const i of [7, 8, 10, 11]) nodes.push({ ...structuredClone(original), id: `fix-${i}`, identifier: `FIX-${i}`, title: `Ticket ${i}` });
  const successor = nodes.find((issue) => issue.id === "fix-7")!;
  successor.inverseRelations = { nodes: [{ id: "6-blocks-7", type: "blocks", issue: structuredClone(original), relatedIssue: structuredClone(successor) }], pageInfo: end } as unknown as typeof successor.inverseRelations;
  let refuseWrite = false;
  const linear = workspace({ issues: () => Response.json({ data: { issues: { nodes, pageInfo: end } } }),
    vocabulary: () => Response.json({ data: { workflowStates: { nodes: [ready,
      { id: "state-started", name: "In Progress", type: "started" }, { id: "state-review", name: options.reviewName ?? "In Review", type: "started" }], pageInfo: end },
      issueLabels: { nodes: [{ id: "label-triage", name: "needs-triage", color: "" }], pageInfo: end } } }) });
  const mutations: Array<{ query: string; variables: { id?: string; input: Record<string, string> } }> = [];
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (refuseWrite && body.query.includes("SquadronIdentity")) return Response.json({ data: { viewer: { id: "fixture-user", name: "Fixture" }, organization: { id: "changed", name: "Changed" } } });
    if (body.query.includes("SquadronRelatedLinks")) {
      const field = body.query.includes("inverseRelations(") ? "inverseRelations" : "relations";
      return Response.json({ data: { issue: { id: body.variables.id, [field]: { nodes: options.relationConflict && field === "inverseRelations"
        ? [{ id: "existing-link", type: options.relationConflict, issue: { id: "fix-5" }, relatedIssue: { id: body.variables.id } }] : [], pageInfo: end } } } });
    }
    if (!body.query.trimStart().startsWith("mutation")) return linear.fetch(url, init);
    mutations.push(body);
    return Response.json({ data: body.query.includes("issueUpdate") ? { issueUpdate: { success: true, issue: { id: body.variables.id } } }
      : body.query.includes("issueRelationCreate") ? { issueRelationCreate: { success: true, issueRelation: { id: body.variables.input.id } } }
      : body.query.includes("issueCreate") ? { issueCreate: { success: true, issue: { id: body.variables.input.id } } }
      : { commentCreate: { success: true, comment: { id: body.variables.input.id } } } });
  });
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  let count = 0;
  const reviewerEnvironments = new Map<string, string>();
  const pendingPrompts = new Set<string>();
  const firstConfigurations: Array<[string, string[]]> = [];
  const firstSkills: Array<[string, string[]]> = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", agentSkillIds: ["squadron-reviewer"], settings: { linearApiKey: "fake-worker-key" },
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
        list: async () => [],
        queuedMessages: {
          list: async ({ threadId }) => pendingPrompts.has(threadId) ? [makeQueueEntry({ id: `queued-${threadId}`, threadId })] : [],
          send: async ({ threadId }) => {
            const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: threadId }, project: { id: "proj-one" } }));
            firstConfigurations.push([threadId, config.tools.map((tool) => tool.name).sort()]);
            firstSkills.push([threadId, config.skills]);
            if (options.releaseFails === (threadId === "thr_lead" ? "lead" : reviewerEnvironments.has(threadId) ? "reviewer" : "worker")) throw new Error("fake-private-release-error");
            if (threadId !== "thr_lead" && options.workerReleaseGate) await options.workerReleaseGate;
            const value = threads.get(threadId)!;
            if (!options.deferWorkerEnvironment || threadId === "thr_lead") threads.set(threadId, { ...value, environmentId: reviewerEnvironments.get(threadId) ?? `env-${threadId}` });
            pendingPrompts.delete(threadId);
            return { ok: true as const, delivery: "sent" as const };
          },
        },
        send: async (args) => {
          const text = JSON.stringify(args.input);
          if ((options.sendFailure === "fix" && text.includes("authorizes your one fix round")) ||
            (options.sendFailure === "verdict" && text.includes("Squadron review verdict")) ||
            (options.sendFailure === "second-look" && text.includes("Run your one scoped second look"))) throw new Error("fake-private-send-error");
          return { ok: true as const, delivery: "sent" as const };
        },
        spawn: async (args) => {
          if (options.spawnFails && count) throw new Error("fake-private-spawn-error");
          const id = count++ === 0 ? "thr_lead" : `thr_worker_${count}`;
          pendingPrompts.add(id);
          if (args.environment.type === "reuse") reviewerEnvironments.set(id, args.environment.environmentId);
          const value = makeThreadResponse({ id, projectId: args.projectId, environmentId: null, parentThreadId: args.parentThreadId ?? null, providerId: args.providerId }); threads.set(id, value); return value;
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
  return { bb, harness, start, call, board, mutations, threads, firstConfigurations, firstSkills, refuseWrites: () => { refuseWrite = true; }, restoreWrites: () => { refuseWrite = false; } };
}

async function approve(call: Awaited<ReturnType<typeof setup>>["call"], ticketId: string, sha = commit) {
  const reviewer = await call("squadron_spawn_reviewer", { ticketId });
  await call("squadron_report", { type: "verdict", commit: sha, outcome: "approve", findings: [], resolvedFindingIds: [] },
    { threadId: reviewer.threadId, projectId: "proj-one" });
  return reviewer;
}

test("SDK host end-to-end: Start -> Lead worker spawn -> worker report -> verified integration -> status move", async (t) => {
  const { harness, start, call, board, mutations, firstConfigurations } = await setup(t);
  await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  assert.equal(worker.threadId, "thr_worker_2");
  assert.deepEqual(firstConfigurations, [
    ["thr_lead", ["squadron_report", "squadron_spawn_reviewer", "squadron_spawn_worker", "squadron_status"]],
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
  await approve(call, "FIX-6");
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
  await call("squadron_report", { type: "done", commit, summary: "Claude-built ticket." }, { threadId: "thr_worker_2", projectId: "proj-one" });
  await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
  const reviewer = harness.inspection.sdk.callsTo("threads.spawn")[2][0] as Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
  assert.deepEqual([reviewer.providerId, reviewer.model, reviewer.reasoningLevel], ["codex", "gpt-6.1-sol", "high"]);
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
  assert.deepEqual((await config("thr_lead")).tools.map((tool) => tool.name).sort(), ["squadron_report", "squadron_spawn_reviewer", "squadron_spawn_worker", "squadron_status"]);
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
  await approve(call, "FIX-6");
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
  await approve(call, "FIX-6");
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
  await approve(call, "FIX-6");
  await call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit });
  const result = await board();
  assert.equal(result.lanes[0].tickets.find((ticket) => ticket.id === "FIX-6")?.state, "branch");
  assert.equal(result.lanes[0].tickets.find((ticket) => ticket.id === "FIX-7")?.state, "ready");
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 3);
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

test("automatic continuation of a reported worker needs a fresh working reservation", async (t) => {
  const { harness, start, call } = await setup(t); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await call("squadron_report", { type: "done", commit, summary: "Tests pass." }, { threadId: worker.threadId, projectId: "proj-one" });
  const decision = await harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({
    thread: { id: worker.threadId }, project: { id: "proj-one" }, originPluginId: "squadron",
  }));
  assert.equal(decision.action, "reject");
});

test("commit-bound other-family reviewer approval is required before verified integration", async (t) => {
  const { start, call, harness, board, firstSkills } = await setup(t); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await call("squadron_report", { type: "done", commit, summary: "Tests pass." }, { threadId: worker.threadId, projectId: "proj-one" });
  await assert.rejects(call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit }), /approval/);
  const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
  const args = harness.inspection.sdk.callsTo("threads.spawn")[2][0] as Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
  assert.deepEqual([args.providerId, args.model, args.reasoningLevel, args.serviceTier], ["claude-code", "claude-opus-5-5", "high", "default"]);
  assert.match(args.prompt ?? "", /code-review/);
  assert.deepEqual(firstSkills.find(([id]) => id === reviewer.threadId), [reviewer.threadId, ["squadron-reviewer"]]);
  assert.ok(args.prompt?.includes(commit));
  assert.equal((await board()).lanes[0].tickets.find((ticket) => ticket.id === "FIX-6")?.reviewer?.threadId, reviewer.threadId);
  const verdict = { type: "verdict", commit, outcome: "approve", findings: [], resolvedFindingIds: [] };
  await assert.rejects(call("squadron_report", verdict), /not authorized/);
  await assert.rejects(call("squadron_report", verdict, { threadId: worker.threadId, projectId: "proj-one" }), /not authorized/);
  await call("squadron_report", verdict, { threadId: reviewer.threadId, projectId: "proj-one" });
  await call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit });
  assert.equal((await board()).lanes[0].tickets.find((ticket) => ticket.id === "FIX-7")?.state, "ready");
});

test("stale verdicts are ignored and a different reviewer or changed provider has no verdict authority", async (t) => {
  const { start, call, harness, threads } = await setup(t); await start();
  const first = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  const second = await call("squadron_spawn_worker", { ticketId: "FIX-8" });
  for (const worker of [first, second]) await call("squadron_report", { type: "done", commit, summary: "Tests." }, { threadId: worker.threadId, projectId: "proj-one" });
  const a = await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
  const b = await call("squadron_spawn_reviewer", { ticketId: "FIX-8" });
  const context = { threadId: a.threadId, projectId: "proj-one" };
  const verdict = { type: "verdict", commit, outcome: "approve", findings: [], resolvedFindingIds: [] };
  assert.equal((await call("squadron_report", { ...verdict, commit: "c".repeat(40) }, context)).ignored, true);
  await assert.rejects(call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit }), /approval/);
  await call("squadron_report", verdict, { threadId: b.threadId, projectId: "proj-one" });
  await assert.rejects(call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit }), /approval/);
  const thread = threads.get(a.threadId)!;
  threads.set(a.threadId, { ...thread, providerId: "codex" });
  await assert.rejects(call("squadron_report", verdict, context), /provider changed/);
  threads.set(a.threadId, { ...thread, parentThreadId: "forged-parent" });
  await assert.rejects(call("squadron_report", verdict, context), /not authorized/);
  threads.set(a.threadId, thread);
  const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: a.threadId }, project: { id: "proj-one" } }));
  assert.deepEqual(config.tools.map((tool) => tool.name).sort(), ["squadron_report", "squadron_status"]);
  assert.deepEqual(config.skills, ["squadron-reviewer"]);
  await call("squadron_report", verdict, context);
  assert.equal((await call("squadron_status", {}, context)).reports.length, 1);
});

test("one fix round returns in-spec findings to the same worker and second look is limited to those findings and the corrected SHA", async (t) => {
  const fixture = await setup(t); const { start, call, harness, board, mutations } = fixture; await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  const workerContext = { threadId: worker.threadId, projectId: "proj-one" };
  await call("squadron_report", { type: "done", commit, summary: "Initial tests." }, workerContext);
  const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
  const reviewerContext = { threadId: reviewer.threadId, projectId: "proj-one" };
  const finding = { id: "S1", kind: "in-spec", text: "Required behavior is missing." };
  await assert.rejects(call("squadron_report", { type: "verdict", commit, outcome: "approve", findings: [finding], resolvedFindingIds: [] }, reviewerContext), /inside the spec/);
  await call("squadron_report", { type: "verdict", commit, outcome: "changes", findings: [finding], resolvedFindingIds: [] }, reviewerContext);
  await call("squadron_report", { type: "fix", ticketId: "FIX-6" });
  assert.equal((await board()).lanes[0].tickets.find((ticket) => ticket.id === "FIX-6")?.state, "working");
  const sends = harness.inspection.sdk.callsTo("threads.send");
  const fix = sends.find((args) => (args[0] as { threadId: string }).threadId === worker.threadId)?.[0];
  assert.ok(JSON.stringify(fix).includes("S1"));
  await assert.rejects(call("squadron_report", { type: "fix", ticketId: "FIX-6" }), /one fix round/);
  const corrected = "c".repeat(40);
  await call("squadron_report", { type: "done", commit: corrected, summary: "Fixed S1; tests pass." }, workerContext);
  const waitingCard = (await board()).lanes[0].tickets.find((ticket) => ticket.id === "FIX-6")!;
  assert.equal(waitingCard.state, "review");
  assert.equal(waitingCard.reviewer?.state, "fixing", "corrected work waits for its scoped second look");
  const secondLook = await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
  assert.equal(secondLook.threadId, reviewer.threadId);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 3);
  const approval = { type: "verdict", commit: corrected, outcome: "approve", findings: [], resolvedFindingIds: ["S1"] };
  assert.equal((await call("squadron_report", { ...approval, commit }, reviewerContext)).ignored, true);
  await assert.rejects(call("squadron_report", { ...approval, resolvedFindingIds: [] }, reviewerContext), /every first-review/);
  await assert.rejects(call("squadron_report", { ...approval, outcome: "changes", findings: [{ ...finding, id: "new" }], resolvedFindingIds: [] }, reviewerContext), /only the first/);
  await call("squadron_report", approval, reviewerContext);
  await call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit: corrected });
  assert.equal((await board()).lanes[0].tickets.find((ticket) => ticket.id === "FIX-7")?.state, "ready");
  await flushRecordedWrites(t, fixture);
  assert.equal(mutations.filter((item) => item.query.includes("issueCreate")).length, 0, "in-spec findings must not file an issue");
});

test("fix resume and a new frontier worker serialize their claims on the last configured slot", async (t) => {
  for (const fixFirst of [true, false]) await t.test(fixFirst ? "fix claims first" : "frontier claims first", async (t) => {
    const { start, call, harness, board } = await setup(t); await start();
    const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
    await call("squadron_report", { type: "done", commit, summary: "Initial tests." }, { threadId: worker.threadId, projectId: "proj-one" });
    const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
    await call("squadron_report", { type: "verdict", commit, outcome: "changes",
      findings: [{ id: "S1", kind: "in-spec", text: "Missing behavior." }], resolvedFindingIds: [] }, { threadId: reviewer.threadId, projectId: "proj-one" });
    await call("squadron_spawn_worker", { ticketId: "FIX-8" });
    const sendCount = harness.inspection.sdk.callsTo("threads.send").length;
    const releaseCount = harness.inspection.sdk.callsTo("threads.queuedMessages.send").length;
    const fix = () => call("squadron_report", { type: "fix", ticketId: "FIX-6" });
    const spawn = () => call("squadron_spawn_worker", { ticketId: "FIX-10" });
    const results = await Promise.allSettled(fixFirst ? [fix(), spawn()] : [spawn(), fix()]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    if (results[1].status === "rejected") assert.match(String(results[1].reason), /slots are full/);
    const cards = (await board()).lanes[0].tickets;
    assert.equal(cards.filter((ticket) => ticket.state === "working").length, 2);
    assert.equal(cards.find((ticket) => ticket.id === "FIX-6")?.threadId, worker.threadId);
    assert.equal(harness.inspection.sdk.callsTo("threads.send").length - sendCount, fixFirst ? 1 : 0, "refused fix must not call SDK send");
    assert.equal(harness.inspection.sdk.callsTo("threads.queuedMessages.send").length - releaseCount, fixFirst ? 0 : 1);
    await assert.rejects(call("squadron_spawn_worker", { ticketId: "FIX-11" }), /slots are full/);
    if (!fixFirst) {
      await assert.rejects(fix(), /slots are full/);
      assert.equal(harness.inspection.sdk.callsTo("threads.send").length, sendCount);
      assert.equal((await call("squadron_status", {})).reports.find((item: { ticketId: string }) => item.ticketId === "FIX-6").review.round, 0);
    }
  });
});

test("only recorded outside-spec defects can be filed, deduped once by the Lead and linked to the spec with needs-triage", async (t) => {
  const { start, call, harness, mutations } = await setup(t); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await call("squadron_report", { type: "done", commit, summary: "Tests." }, { threadId: worker.threadId, projectId: "proj-one" });
  const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
  const findings = [{ id: "S1", kind: "in-spec", text: "Required behavior missing." }, { id: "O1", kind: "outside-spec", text: "A separate existing feature breaks." }];
  await call("squadron_report", { type: "verdict", commit, outcome: "changes", findings, resolvedFindingIds: [] }, { threadId: reviewer.threadId, projectId: "proj-one" });
  const report = { type: "defect", ticketId: "FIX-6", findingId: "O1", title: "A separate feature breaks", description: "Steps and observed defect.",
    dedupeKey: "separate-feature-breaks", dedupeEvidence: "Checked existing project issues including follow-ups; none matches." };
  await assert.rejects(call("squadron_report", { ...report, findingId: "S1" }), /inside the spec/);
  await assert.rejects(call("squadron_report", report, { threadId: reviewer.threadId, projectId: "proj-one" }), /Only the bound Lead/);
  const first = await call("squadron_report", report);
  const again = await call("squadron_report", report);
  assert.equal(first.issueId, again.issueId);
  assert.equal(first.receiptId, again.receiptId);
  const service = harness.behavior.runService("linear-outbox"); t.after(() => service.controller.abort());
  for (let i = 0; i < 200 && !mutations.some((item) => item.query.includes("issueRelationCreate")); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const creates = mutations.filter((item) => item.query.includes("issueCreate"));
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].variables.input.labelIds, ["label-triage"]);
  assert.equal(creates[0].variables.input.parentId, undefined);
  assert.deepEqual(mutations.find((item) => item.query.includes("issueRelationCreate"))?.variables.input,
    { id: first.linkReceiptId, issueId: first.issueId, relatedIssueId: "fix-5", type: "related" });
  const duplicate = await call("squadron_report", { ...report, existingIssueId: "fix-9", dedupeKey: "known-defect" });
  assert.equal(duplicate.issueId, first.issueId, "a retry cannot replace the already filed defect");
});

test("dedupe reuse never replaces an existing blocker or duplicate link to the spec", async (t) => {
  for (const relationConflict of ["blocks", "duplicate"]) await t.test(relationConflict, async (t) => {
    const { start, call, harness, mutations, board } = await setup(t, { relationConflict }); await start();
    const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
    await call("squadron_report", { type: "done", commit, summary: "Tests." }, { threadId: worker.threadId, projectId: "proj-one" });
    const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
    await call("squadron_report", { type: "verdict", commit, outcome: "approve", findings: [{ id: "O1", kind: "outside-spec", text: "Existing defect." }], resolvedFindingIds: [] },
      { threadId: reviewer.threadId, projectId: "proj-one" });
    await call("squadron_report", { type: "defect", ticketId: "FIX-6", findingId: "O1", title: "Existing defect", description: "Steps.", dedupeKey: "existing-defect",
      dedupeEvidence: "Existing FIX-9 covers it.", existingIssueId: "fix-9" });
    const service = harness.behavior.runService("linear-outbox"); t.after(() => service.controller.abort());
    for (let i = 0; i < 200 && !(await board()).writes?.blockedCount; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(mutations.filter((item) => item.query.includes("issueCreate")).length, 0);
    assert.equal(mutations.filter((item) => item.query.includes("issueRelationCreate")).length, 0, "existing relation must remain untouched");
    assert.ok((await board()).writes?.blocked.some((item) => item.reason === "conflict"));
  });
});

test("a reported worker cannot restart through a queued dispatch without its cap reservation", async (t) => {
  const { start, call, harness } = await setup(t); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await call("squadron_report", { type: "done", commit, summary: "Tests." }, { threadId: worker.threadId, projectId: "proj-one" });
  const gate = harness.inspection.registrations.hooks["message.dispatch"]!;
  assert.equal((await gate(makeMessageDispatchHookContext({ thread: { id: worker.threadId }, project: { id: "proj-one" }, originPluginId: "squadron" }))).action, "reject");
});

test("a matching verdict still requires fresh Git proof, and integration rechecks Git after approval", async (t) => {
  const options = { verify: true };
  const { start, call, board } = await setup(t, options); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await call("squadron_report", { type: "done", commit, summary: "Tests." }, { threadId: worker.threadId, projectId: "proj-one" });
  const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
  const context = { threadId: reviewer.threadId, projectId: "proj-one" };
  const verdict = { type: "verdict", commit, outcome: "approve", findings: [], resolvedFindingIds: [] };
  options.verify = false;
  await assert.rejects(call("squadron_report", verdict, context), /could not be verified/);
  assert.equal((await call("squadron_status", {}, context)).reports[0].review.state, "reviewing");
  options.verify = true;
  await call("squadron_report", verdict, context);
  options.verify = false;
  await assert.rejects(call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit }), /could not be verified/);
  assert.equal((await board()).lanes[0].tickets.find((ticket) => ticket.id === "FIX-7")?.state, "blocked");
});

test("a failed second look cannot get a second fix round or new reviewer", async (t) => {
  const { start, call, harness } = await setup(t); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  const workerContext = { threadId: worker.threadId, projectId: "proj-one" };
  await call("squadron_report", { type: "done", commit, summary: "Tests." }, workerContext);
  const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
  const context = { threadId: reviewer.threadId, projectId: "proj-one" };
  const finding = { id: "S1", kind: "in-spec", text: "Missing requirement." };
  await call("squadron_report", { type: "verdict", commit, outcome: "changes", findings: [finding], resolvedFindingIds: [] }, context);
  await call("squadron_report", { type: "fix", ticketId: "FIX-6" });
  const corrected = "c".repeat(40);
  await call("squadron_report", { type: "done", commit: corrected, summary: "Attempted fix." }, workerContext);
  await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
  await assert.rejects(call("squadron_report", { type: "verdict", commit: corrected, outcome: "approve", findings: [{ ...finding, kind: "outside-spec" }], resolvedFindingIds: [] }, context), /only the first/);
  await call("squadron_report", { type: "verdict", commit: corrected, outcome: "changes", findings: [finding], resolvedFindingIds: [] }, context);
  const sends = harness.inspection.sdk.callsTo("threads.send").length;
  await assert.rejects(call("squadron_report", { type: "fix", ticketId: "FIX-6" }), /one fix round/);
  await assert.rejects(call("squadron_spawn_reviewer", { ticketId: "FIX-6" }), /already has a reviewer/);
  assert.equal(harness.inspection.sdk.callsTo("threads.send").length, sends);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 3);
  await assert.rejects(call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit: corrected }), /approval/);
});

test("a refused verdict notification preserves the exact approval and retries safely without exposing provider text", async (t) => {
  const options: { sendFailure?: "verdict" } = { sendFailure: "verdict" };
  const { start, call, harness } = await setup(t, options); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await call("squadron_report", { type: "done", commit, summary: "Tests." }, { threadId: worker.threadId, projectId: "proj-one" });
  const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
  const context = { threadId: reviewer.threadId, projectId: "proj-one" };
  const verdict = { type: "verdict", commit, outcome: "approve", findings: [], resolvedFindingIds: [] };
  await assert.rejects(call("squadron_report", verdict, context), /verdict is saved.*Lead.*notified/);
  assert.equal((await call("squadron_status", {}, context)).reports[0].review.state, "approved");
  options.sendFailure = undefined;
  await call("squadron_report", verdict, context);
  const sent = harness.inspection.sdk.callsTo("threads.send").length;
  await call("squadron_report", verdict, context);
  assert.equal(harness.inspection.sdk.callsTo("threads.send").length, sent);
  assert.ok(!JSON.stringify(harness.inspection.logEntries).includes("fake-private-send-error"));
});

test("failed reviewer startup keeps its trusted binding visible and cannot grant a verdict or dispatch", async (t) => {
  const { start, call, harness, board, threads } = await setup(t, { releaseFails: "reviewer" }); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await call("squadron_report", { type: "done", commit, summary: "Tests." }, { threadId: worker.threadId, projectId: "proj-one" });
  await assert.rejects(call("squadron_spawn_reviewer", { ticketId: "FIX-6" }), /startup is unconfirmed/);
  const review = (await board()).lanes[0].tickets.find((ticket) => ticket.id === "FIX-6")?.reviewer!;
  assert.equal(review.threadId, "thr_worker_3"); assert.equal(review.state, "failed");
  await assert.rejects(call("squadron_spawn_reviewer", { ticketId: "FIX-6" }), /already has a reviewer/);
  await assert.rejects(call("squadron_report", { type: "verdict", commit, outcome: "approve", findings: [], resolvedFindingIds: [] },
    // Release failed before SDK assigned the reused environment, so the first
    // refusal is specifically the real-thread binding check.
    { threadId: review.threadId!, projectId: "proj-one" }), { message: "This thread is not authorized for this lane." });
  const reviewerThread = threads.get(review.threadId!)!;
  const workerThread = threads.get(worker.threadId)!;
  threads.set(review.threadId!, { ...reviewerThread, environmentId: workerThread.environmentId });
  await assert.rejects(call("squadron_report", { type: "verdict", commit, outcome: "approve", findings: [], resolvedFindingIds: [] },
    { threadId: review.threadId!, projectId: "proj-one" }), { message: "This review isn't awaiting a verdict." });
  const gate = harness.inspection.registrations.hooks["message.dispatch"]!;
  assert.equal((await gate(makeMessageDispatchHookContext({ thread: { id: review.threadId! }, project: { id: "proj-one" }, originPluginId: "squadron" }))).action, "reject");
  await assert.rejects(call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit }), /approval/);
  assert.ok(!JSON.stringify(harness.inspection.logEntries).includes("fake-private-release-error"));
});

async function outsideReview(call: Awaited<ReturnType<typeof setup>>["call"], ticketId: string, findingId = "O1") {
  const worker = await call("squadron_spawn_worker", { ticketId });
  await call("squadron_report", { type: "done", commit, summary: "Tests." }, { threadId: worker.threadId, projectId: "proj-one" });
  const reviewer = await call("squadron_spawn_reviewer", { ticketId });
  await call("squadron_report", { type: "verdict", commit, outcome: "approve", findings: [{ id: findingId, kind: "outside-spec", text: "Defect in another feature." }], resolvedFindingIds: [] },
    { threadId: reviewer.threadId, projectId: "proj-one" });
  return { threadId: reviewer.threadId, projectId: "proj-one" };
}

async function flushRecordedWrites(t: import("node:test").TestContext, fixture: Awaited<ReturnType<typeof setup>>) {
  const service = fixture.harness.behavior.runService("linear-outbox"); t.after(() => service.controller.abort());
  for (let i = 0; i < 200 && (await fixture.board()).writes?.pendingCount; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const writes = (await fixture.board()).writes;
  assert.equal(writes?.pendingCount, 0, "all recorded writes must finish before inspecting mutations");
  assert.equal(writes?.blockedCount, 0);
}

test("queued defects dedupe across ticket/key changes by normalized title before mirror catch-up", async (t) => {
  const fixture = await setup(t); const { start, call, mutations } = fixture; await start();
  await outsideReview(call, "FIX-6");
  const secondReviewer = await outsideReview(call, "FIX-8");
  const report = { type: "defect", ticketId: "FIX-6", findingId: "O1", title: "An outside defect", description: "Reproduction.", dedupeKey: "first-key", dedupeEvidence: "Checked project issues." };
  const first = await call("squadron_report", report);
  const second = await call("squadron_report", { ...report, ticketId: "FIX-8", title: "  AN   outside DEFECT  ", dedupeKey: "different-key" });
  assert.equal(second.issueId, first.issueId);
  assert.equal(second.receiptId, first.receiptId);
  const status = await call("squadron_status", {}, secondReviewer);
  assert.equal(status.reports[0].review.defects.O1.normalizedTitle, "an outside defect");
  await flushRecordedWrites(t, fixture);
  assert.equal(mutations.filter((item) => item.query.includes("issueCreate")).length, 1);
  assert.equal(mutations.filter((item) => item.query.includes("issueRelationCreate")).length, 1);
});

test("an outside defect cannot reuse this spec or one of its own tickets by title or explicit ID", async (t) => {
  const fixture = await setup(t); const { start, call, harness, mutations } = fixture; await start();
  await outsideReview(call, "FIX-6");
  const status = await call("squadron_status", {});
  const report = { type: "defect", ticketId: "FIX-6", findingId: "O1", description: "Reproduction.", dedupeKey: "in-spec-collision", dedupeEvidence: "Checked project issues." };
  for (const title of [status.lane.title, "Ticket 8"]) await assert.rejects(call("squadron_report", { ...report, title }), /spec and its own tickets/);
  for (const existingIssueId of ["fix-5", "fix-8", "FIX-6"]) await assert.rejects(call("squadron_report", { ...report, title: "Different title", existingIssueId }), /spec and its own tickets/);
  await flushRecordedWrites(t, fixture);
  assert.equal(mutations.filter((item) => item.query.includes("issueCreate") || item.query.includes("issueRelationCreate")).length, 0);
  const after = await call("squadron_status", {});
  assert.equal(after.reports[0].review.defects, undefined);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 3);
});

test("defect dedupe reuses a mirror title and a saved cross-ticket key through public receipts", async (t) => {
  for (const source of ["mirror title", "saved key"]) await t.test(source, async (t) => {
    const fixture = await setup(t); const { start, call, mutations } = fixture; await start();
    await outsideReview(call, "FIX-6"); await outsideReview(call, "FIX-8");
    const report = { type: "defect", ticketId: "FIX-6", findingId: "O1", title: source === "mirror title" ? "  LINEAR   WEBHOOKS " : "First outside title",
      description: "Reproduction.", dedupeKey: "one-semantic-defect", dedupeEvidence: "Checked all project issues." };
    const first = await call("squadron_report", report);
    const second = await call("squadron_report", { ...report, ticketId: "FIX-8", title: "Different wording for same defect" });
    assert.equal(second.issueId, first.issueId);
    assert.equal(second.receiptId, first.receiptId);
    if (source === "mirror title") assert.equal(first.issueId, "fix-9");
    await flushRecordedWrites(t, fixture);
    assert.equal(mutations.filter((item) => item.query.includes("issueCreate")).length, source === "mirror title" ? 0 : 1);
    assert.equal(mutations.filter((item) => item.query.includes("issueRelationCreate")).length, 1);
  });
});

test("dropped smells approve only with a short single-line reason and disposition is exclusive to smells", async (t) => {
  const { start, call } = await setup(t); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await call("squadron_report", { type: "done", commit, summary: "Tests." }, { threadId: worker.threadId, projectId: "proj-one" });
  const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
  const context = { threadId: reviewer.threadId, projectId: "proj-one" };
  const verdict = { type: "verdict", commit, outcome: "approve", resolvedFindingIds: [] };
  for (const kind of ["in-spec", "question", "not-proven", "outside-spec"]) await assert.rejects(call("squadron_report", {
    ...verdict, findings: [{ id: "D1", kind, text: "This needs owner attention.", disposition: "drop" }],
  }, context), /disposition.*smell/);
  for (const text of ["Two\nlines", "Two\rlines", " ", "x".repeat(301)]) await assert.rejects(call("squadron_report", {
    ...verdict, findings: [{ id: "D1", kind: "smell", disposition: "drop", text }],
  }, context), /single-line reason/);
  const accepted = await call("squadron_report", { ...verdict, findings: [{ id: "D1", kind: "smell", disposition: "drop", text: "The optional rewrite would add complexity without changing behavior." }] }, context);
  assert.equal(accepted.state, "approved");
  assert.equal((await call("squadron_status", {}, context)).reports[0].review.firstFindings[0].disposition, "drop");
});

test("Lead startup and registered tool descriptions explain review, fix, dedupe and PR duties", async (t) => {
  const { start, harness } = await setup(t); await start();
  const args = harness.inspection.sdk.callsTo("threads.spawn")[0][0] as Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
  for (const text of ["squadron_spawn_reviewer", "squadron_report", "dedupeEvidence", "Open questions", "Not proven"]) assert.ok(args.prompt?.includes(text), `Lead prompt must name ${text}`);
  const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_lead" }, project: { id: "proj-one" } }));
  const description = config.tools.find((tool) => tool.name === "squadron_report")?.description ?? "";
  for (const text of ["verdict", "fix", "defect", "duplicate", "Open questions", "Not proven"]) assert.ok(description.includes(text), `report tool must explain ${text}`);
  assert.match(config.tools.find((tool) => tool.name === "squadron_spawn_reviewer")?.description ?? "", /second look/);
});

test("fix-round delivery sends only requires-fix findings while preserving other findings for the Lead", async (t) => {
  const { start, call, harness } = await setup(t); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await call("squadron_report", { type: "done", commit, summary: "Tests." }, { threadId: worker.threadId, projectId: "proj-one" });
  const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
  const finding = { id: "S1", kind: "in-spec", text: "Fix the missing behavior." };
  const findings = [finding, { id: "Q1", kind: "question", text: "Owner decision." }, { id: "N1", kind: "not-proven", text: "No device proof." },
    { id: "O1", kind: "outside-spec", text: "Other feature breaks." }, { id: "D1", kind: "smell", disposition: "drop", text: "The optional rewrite adds complexity." }];
  await call("squadron_report", { type: "verdict", commit, outcome: "changes", findings, resolvedFindingIds: [] }, { threadId: reviewer.threadId, projectId: "proj-one" });
  await call("squadron_report", { type: "fix", ticketId: "FIX-6" });
  const messages = harness.inspection.sdk.callsTo("threads.send").map((args) => args[0] as Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0]);
  const fix = messages.find((message) => message.threadId === worker.threadId)!;
  const text = (fix.input[0] as { text: string }).text;
  assert.deepEqual(JSON.parse(text.split("\n").at(-1)!).findings, [finding]);
  assert.deepEqual((await call("squadron_status", {})).reports[0].review.firstFindings, findings);
});

test("B4 Stop/Resume preserves B3 review binding, stops its reviewer and wakes only active review work", async (t) => {
  const { start, call, harness } = await setup(t); await start();
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await call("squadron_report", { type: "done", commit, summary: "Tests." }, { threadId: worker.threadId, projectId: "proj-one" });
  const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
  const rpc = (name: string) => harness.behavior.callRpc(name, { projectId: "proj-one", specId: "FIX-5" });
  await rpc("lanes.stop");
  assert.ok(harness.inspection.sdk.callsTo("threads.stop").some((args) => (args[0] as { threadId: string }).threadId === reviewer.threadId));
  const before = harness.inspection.sdk.callsTo("threads.send").length;
  await rpc("lanes.resume");
  const woken = harness.inspection.sdk.callsTo("threads.send").slice(before).map((args) => (args[0] as { threadId: string }).threadId);
  assert.deepEqual(woken, ["thr_lead", reviewer.threadId]);
  const context = { threadId: reviewer.threadId, projectId: "proj-one" };
  assert.equal((await call("squadron_status", {}, context)).reports[0].review.commit, commit);
  await call("squadron_report", { type: "verdict", commit, outcome: "approve", findings: [], resolvedFindingIds: [] }, context);
  await rpc("lanes.stop");
  const approvedBefore = harness.inspection.sdk.callsTo("threads.send").length;
  await rpc("lanes.resume");
  assert.deepEqual(harness.inspection.sdk.callsTo("threads.send").slice(approvedBefore).map((args) => (args[0] as { threadId: string }).threadId), ["thr_lead"]);
  await rpc("lanes.cancel");
  await assert.rejects(call("squadron_status", {}, context), /not authorized/);
});
