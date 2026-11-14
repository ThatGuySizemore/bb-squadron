import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server.js";
import type { Board } from "../lib/board-model.js";
import { binding, workspace, workspaceIssues } from "./fixtures/board-workspace.js";
import { done, end, ready } from "./fixtures/linear-mirror.js";

const settings = readFileSync("tests/fixtures/squadron.md", "utf8");
const work = "a".repeat(40);
const head = "e".repeat(40);
const fix = "f".repeat(40);
const later = "9".repeat(40);
const PR_PLUGIN = "bb--github-pr-status";
type Row = { outcome: "available"; pullRequest: Record<string, unknown> } | { outcome: "absent" } | { outcome: "unavailable"; message: string };

export function pullRequest(overrides: Record<string, unknown> = {}, checks = "passing") {
  return { outcome: "available" as const, pullRequest: { number: 2, title: "Spec FIX-5", state: "open", url: "https://github.com/fixture/repo/pull/2",
    baseRefName: "main", headRefName: "bb/integration", updatedAt: "2026-11-14T01:00:00.000Z", autoMerge: false, inMergeQueue: null,
    checks: { state: checks, totalCount: 1, passedCount: checks === "passing" ? 1 : 0, failedCount: checks === "failing" ? 1 : 0, pendingCount: checks === "pending" ? 1 : 0 },
    review: { state: "none", reviewRequestCount: 0 }, mergeability: { state: "mergeable", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" },
    attention: "ready_to_merge", ...overrides } };
}

async function setup(t: import("node:test").TestContext, options: { acceptOwner?: boolean; leadFamily?: "gpt" | "claude" } = {}) {
  const nodes = structuredClone(workspaceIssues.data.issues.nodes);
  if (options.acceptOwner) nodes.find((issue) => issue.id === "fix-5")!.labels.nodes.push({ id: "label-owner", name: "accept:owner", color: "" } as never);
  if (options.leadFamily === "claude") nodes.find((issue) => issue.id === "fix-5")!.labels.nodes.push({ id: "label-ui", name: "ui", color: "" } as never);
  let refuseWrite = false;
  const linear = workspace({ issues: () => Response.json({ data: { issues: { nodes, pageInfo: end } } }),
    vocabulary: () => Response.json({ data: { workflowStates: { nodes: [ready, done,
      { id: "state-started", name: "In Progress", type: "started" }, { id: "state-review", name: "In Review", type: "started" }], pageInfo: end },
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
  // Git as the host sees it: local branch heads and their upstreams.
  const refs = new Map<string, string>([["bb/integration", head]]);
  const upstream = new Map<string, string>([["bb/integration", head]]);
  // What BB's pull-request plugin returns for each environment, or a thrown read.
  const rows = new Map<string, Row | Error>();
  const prCalls: Array<{ method: string; input: unknown }> = [];
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const pending = new Set<string>();
  let count = 0;
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", agentSkillIds: ["squadron-reviewer"], settings: { linearApiKey: "fake-key" },
    experimental_callHostRpc: async (request) => {
      const input = request.input as { branch: string; commit?: string; integrationBranch?: string };
      if (request.method === "verifyWorkerCommit") {
        const verified = refs.get(input.branch) === input.commit && (!input.integrationBranch || refs.has(input.integrationBranch));
        return { verified, head: verified ? (input.integrationBranch ? refs.get(input.integrationBranch)! : input.commit!) : null };
      }
      if (request.method === "pushedHead") return { head: refs.get(input.branch) ?? null, upstream: upstream.get(input.branch) ?? null };
      return { authenticated: true };
    },
    sdk: {
      plugins: { callRpc: async (args) => {
        if (args.pluginId !== PR_PLUGIN) return { ok: true, channels: [] } as never;
        prCalls.push({ method: args.method, input: args.input });
        if (args.method === "refresh") return { ok: true } as never;
        const keys = (args.input as { keys: string[] }).keys;
        const result: Record<string, Row> = {};
        for (const key of keys) {
          const row = rows.get(key);
          if (row instanceof Error) throw row;
          if (row) result[key] = row;
        }
        return args.outputSchema.parse(result);
      } },
      projects: { get: async ({ projectId }) => ({ id: projectId, name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId, hostId: "repo-host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
      files: { read: async ({ path }) => ({ content: settings, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: settings.length }) },
      skills: { list: async () => ({ skills: ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"].map((name) =>
        ({ id: name, name, description: null, manageable: false, pluginId: null, provider: null, registrySkillId: null,
          scope: "shared-project" as const, filePath: `/repo/.agents/skills/${name}/SKILL.md` })) }) },
      threads: {
        queuedMessages: {
          list: async ({ threadId }) => pending.has(threadId) ? [makeQueueEntry({ id: `queued-${threadId}`, threadId })] : [],
          send: async ({ threadId }) => { pending.delete(threadId); return { ok: true as const, delivery: "sent" as const }; },
        },
        send: async () => ({ ok: true as const, delivery: "sent" as const }),
        stop: async () => ({ ok: true }) as never,
        spawn: async (args) => {
          const id = count++ === 0 ? "thr_lead" : `thr_${count}`;
          pending.add(id);
          const environmentId = args.environment.type === "reuse" ? args.environment.environmentId : `env-${id}`;
          const value = makeThreadResponse({ id, projectId: args.projectId, environmentId, parentThreadId: args.parentThreadId ?? null, providerId: args.providerId });
          threads.set(id, value); return value;
        },
        get: async ({ threadId }) => threads.get(threadId) ?? makeThreadResponse({ id: threadId, projectId: "proj-one" }),
      },
      environments: { get: async ({ environmentId }) => ({ id: environmentId, projectId: "proj-one", hostId: "repo-host", status: "ready" as const,
        branchName: environmentId === "env-thr_lead" ? "bb/integration" : `bb/${environmentId}`, path: `/worktrees/${environmentId}`,
        baseBranch: environmentId === "env-thr_lead" ? "main" : "bb/integration", defaultBranch: "main", mergeBaseBranch: "main", name: null, createdAt: 0, updatedAt: 0,
        environmentProviderId: "environment-git-worktree", environmentProviderInstanceKey: "fixture", environmentProviderSelection: null,
        hostLifecycle: "active", isGitRepo: true, isWorktree: true, managed: true, workspaceProvisionType: "managed-worktree",
        lifecycle: { phase: "active", retireAt: null, teardown: null } }) },
    },
  });
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb); await harness.behavior.callRpc("linear.bind", binding);
  const lead = { threadId: "thr_lead", projectId: "proj-one" };
  const call = async (name: string, input: unknown, context = lead) => JSON.parse(String(await harness.behavior.callAgentTool(name, input, context)));
  const board = async () => await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  const sent = () => harness.inspection.sdk.callsTo("threads.send").map((item) => item[0] as Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0]);
  /** Start the lane and land FIX-6 in the integration branch with its approved ticket review. */
  async function integrated() {
    await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
    const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
    refs.set(`bb/env-${worker.threadId}`, work);
    await call("squadron_report", { type: "done", commit: work, summary: "Built with tests." }, { threadId: worker.threadId, projectId: "proj-one" });
    const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-6" });
    await call("squadron_report", { type: "verdict", commit: work, outcome: "approve", findings: [], resolvedFindingIds: [] }, { threadId: reviewer.threadId, projectId: "proj-one" });
    await call("squadron_report", { type: "integrated", ticketId: "FIX-6", commit: work });
    return worker;
  }
  async function specApproved() {
    await integrated();
    const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-5", commit: head });
    await call("squadron_report", { type: "verdict", commit: head, outcome: "approve", findings: [], resolvedFindingIds: [] }, { threadId: reviewer.threadId, projectId: "proj-one" });
    return reviewer;
  }
  async function drain(min: number) {
    const delivery = harness.behavior.runService("linear-outbox"); t.after(() => delivery.controller.abort());
    for (let i = 0; i < 300 && mutations.length < min; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { harness, call, board, sent, refs, upstream, rows, prCalls, threads, mutations, integrated, specApproved, drain,
    refuseWrites: () => { refuseWrite = true; }, restoreWrites: () => { refuseWrite = false; } };
}

test("SDK host end-to-end: integrated tickets -> other-family whole-branch review -> PR from BB's plugin -> merge check -> landed with Done statuses", async (t) => {
  const { call, board, sent, rows, prCalls, mutations, integrated, drain, harness } = await setup(t);
  await integrated();
  const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-5", commit: head });
  const spawn = harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
  // The Lead is GPT, so the whole-branch reviewer is Claude, in the Lead's own checkout.
  assert.deepEqual([spawn.providerId, spawn.model, spawn.reasoningLevel, spawn.parentThreadId], ["claude-code", "claude-opus-5-5", "high", "thr_lead"]);
  assert.deepEqual(spawn.environment, { type: "reuse", environmentId: "env-thr_lead" });
  assert.match(spawn.prompt ?? "", /whole branch/);
  assert.equal((await board()).lanes[0].state, "spec-review");
  const reviewerConfig = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: reviewer.threadId }, project: { id: "proj-one" } }));
  assert.deepEqual(reviewerConfig.tools.map((tool) => tool.name).sort(), ["squadron_report", "squadron_status"]);
  assert.deepEqual(reviewerConfig.skills, ["squadron-reviewer"]);
  await call("squadron_report", { type: "verdict", commit: head, outcome: "approve", findings: [], resolvedFindingIds: [] }, { threadId: reviewer.threadId, projectId: "proj-one" });
  assert.match(JSON.stringify(sent().at(-1)!.input), /whole-branch review verdict/);
  // No PR yet: BB's plugin reports none for the Lead's environment.
  rows.set("env-thr_lead", { outcome: "absent" });
  await assert.rejects(call("squadron_report", { type: "merge", commit: head }), /No PR is open/);
  rows.set("env-thr_lead", pullRequest());
  const check = await call("squadron_report", { type: "merge", commit: head });
  assert.deepEqual(check, { allowed: true, number: 2, commit: head, command: `gh pr merge 2 --squash --match-head-commit ${head}` });
  assert.ok(prCalls.some((item) => item.method === "pullRequests" && JSON.stringify(item.input) === JSON.stringify({ keys: ["env-thr_lead"] })));
  const open = (await board()).lanes[0];
  assert.equal(open.state, "pr-open");
  assert.deepEqual(open.pr, { number: 2, checks: "passing", url: "https://github.com/fixture/repo/pull/2" });
  rows.set("env-thr_lead", pullRequest({ state: "merged", attention: "merged" }));
  const landed = await call("squadron_report", { type: "landed" });
  assert.equal(landed.state, "landed");
  const lane = (await board()).lanes[0];
  assert.equal(lane.state, "landed"); assert.equal(typeof lane.landedAt, "number");
  await drain(6);
  const statuses = mutations.filter((item) => item.query.includes("issueUpdate")).map((item) => item.variables);
  assert.deepEqual(statuses.slice(-2), [{ id: "fix-6", input: { stateId: "state-done" } }, { id: "fix-5", input: { stateId: "state-done" } }]);
  assert.ok(mutations.some((item) => item.query.includes("commentCreate") && JSON.stringify(item.variables).includes(`Landed PR #2 at ${head}`)));
  // A landed lane grants no tools.
  await assert.rejects(call("squadron_status", {}), /not authorized/);
});

test("the merge check refuses failing or pending checks, absent or unavailable PR data, an unpushed or changed head and stale approval", async (t) => {
  const { call, board, rows, refs, upstream, specApproved } = await setup(t);
  await specApproved();
  const merge = () => call("squadron_report", { type: "merge", commit: head });
  rows.set("env-thr_lead", new Error("plugin missing"));
  await assert.rejects(merge(), /PR status is unavailable: BB's pull-request plugin couldn't be read/);
  rows.set("env-thr_lead", { outcome: "unavailable", message: "The machine is offline." });
  await assert.rejects(merge(), /PR status is unavailable: The machine is offline/);
  assert.equal((await board()).lanes[0].prNote, "PR status is unavailable: The machine is offline.");
  rows.delete("env-thr_lead");
  await assert.rejects(merge(), /returned no row/);
  rows.set("env-thr_lead", { outcome: "absent" });
  await assert.rejects(merge(), /No PR is open/);
  rows.set("env-thr_lead", pullRequest({}, "pending"));
  await assert.rejects(merge(), /checks are still running/);
  rows.set("env-thr_lead", pullRequest({}, "failing"));
  await assert.rejects(merge(), /checks fail/);
  rows.set("env-thr_lead", pullRequest({}, "no_checks"));
  await assert.rejects(merge(), /reports no checks/);
  rows.set("env-thr_lead", pullRequest({ headRefName: "someone-else" }));
  await assert.rejects(merge(), /another branch/);
  rows.set("env-thr_lead", pullRequest({ state: "draft" }));
  await assert.rejects(merge(), /is a draft/);
  rows.set("env-thr_lead", pullRequest());
  // Committed locally after the approval but not pushed: the plugin's upstream view and the local head disagree.
  refs.set("bb/integration", later);
  await assert.rejects(merge(), /couldn't verify the pushed integration head/);
  // Pushed: the PR head is a later commit than the one reviewed. It can't inherit the approval.
  upstream.set("bb/integration", later);
  await assert.rejects(call("squadron_report", { type: "merge", commit: later }), /moved after the whole-branch review/);
  await assert.rejects(merge(), /moved after the whole-branch review/);
  assert.match((await board()).lanes[0].prNote ?? "", /moved after the whole-branch review/);
  refs.set("bb/integration", head); upstream.set("bb/integration", head);
  await assert.rejects(call("squadron_report", { type: "merge", commit: later }), /isn't the approved, pushed PR head/);
  assert.equal((await merge()).allowed, true);
});

test("the whole-branch review waits for every ticket, binds the Lead's exact head, and only its reviewer's verdict at that head counts", async (t) => {
  const { harness, call, refs } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  await assert.rejects(call("squadron_spawn_reviewer", { ticketId: "FIX-5", commit: head }), /Every ticket must be in the integration branch.*FIX-6/);
  await assert.rejects(call("squadron_spawn_reviewer", { ticketId: "FIX-5" }), /full head commit/);
  const worker = await call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await assert.rejects(call("squadron_spawn_reviewer", { ticketId: "FIX-6", commit: head }), /pass a commit only for the whole-branch review/);
  refs.set(`bb/env-${worker.threadId}`, work);
  await call("squadron_report", { type: "done", commit: work, summary: "Built." }, { threadId: worker.threadId, projectId: "proj-one" });
  // Done is not approval or integration.
  await assert.rejects(call("squadron_spawn_reviewer", { ticketId: "FIX-5", commit: head }), /Waiting: FIX-6/);
});

test("whole-branch verdicts: forged, worker and stale-head verdicts never approve; a moved branch refuses the verdict", async (t) => {
  const { call, board, refs, integrated } = await setup(t);
  const worker = await integrated();
  await assert.rejects(call("squadron_spawn_reviewer", { ticketId: "FIX-5", commit: later }), /isn't at this exact commit/);
  const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-5", commit: head });
  await assert.rejects(call("squadron_spawn_reviewer", { ticketId: "FIX-5", commit: head }), /already has its whole-branch reviewer/);
  const approve = { type: "verdict", commit: head, outcome: "approve", findings: [], resolvedFindingIds: [] };
  await assert.rejects(call("squadron_report", approve, { threadId: "forged", projectId: "proj-one" }), /not authorized/);
  await assert.rejects(call("squadron_report", approve, { threadId: worker.threadId, projectId: "proj-one" }), /not authorized|not authorized for this reviewer/);
  assert.deepEqual(await call("squadron_report", { ...approve, commit: later }, { threadId: reviewer.threadId, projectId: "proj-one" }),
    { ignored: true, reason: "The verdict does not match the reviewed integration head." });
  refs.set("bb/integration", later);
  await assert.rejects(call("squadron_report", approve, { threadId: reviewer.threadId, projectId: "proj-one" }), /isn't at this exact commit/);
  assert.equal((await board()).lanes[0].state, "spec-review");
  refs.set("bb/integration", head);
  await call("squadron_report", approve, { threadId: reviewer.threadId, projectId: "proj-one" });
  const status = await call("squadron_status", {});
  assert.equal(status.lane.state, "spec-review");
});

test("accept:owner never merges without the owner's click for that exact PR head; a later commit needs a new click", async (t) => {
  const { harness, call, board, sent, rows, refs, upstream, specApproved } = await setup(t, { acceptOwner: true });
  await specApproved();
  rows.set("env-thr_lead", pullRequest());
  await assert.rejects(call("squadron_report", { type: "merge", commit: head }), /waits for the owner's Merge on the board/);
  const waiting = await board();
  assert.equal(waiting.lanes[0].state, "merge-waits");
  assert.equal(waiting.lanes[0].mergeCommit, head);
  // Agents and other plugins can't click Merge.
  await assert.rejects(harness.behavior.callRpc("lanes.merge", { projectId: "proj-one", specId: "FIX-5", number: 2, commit: head },
    { experimental_caller: { kind: "plugin", pluginId: "other" } }), /Only the owner/);
  // A click for a context the board no longer shows approves nothing.
  await assert.rejects(harness.behavior.callRpc("lanes.merge", { projectId: "proj-one", specId: "FIX-5", number: 3, commit: head }), /PR changed since the board showed it/);
  rows.set("env-thr_lead", pullRequest({}, "pending"));
  await assert.rejects(harness.behavior.callRpc("lanes.merge", { projectId: "proj-one", specId: "FIX-5", number: 2, commit: head }), /checks are still running.*Nothing was approved/);
  rows.set("env-thr_lead", pullRequest());
  await assert.rejects(call("squadron_report", { type: "merge", commit: head }), /waits for the owner's Merge/);
  assert.deepEqual(await harness.behavior.callRpc("lanes.merge", { projectId: "proj-one", specId: "FIX-5", number: 2, commit: head }), { state: "flying" });
  assert.match(JSON.stringify(sent().at(-1)!.input), new RegExp(`owner approved merging PR #2 at exactly ${head}`));
  assert.equal(sent().at(-1)!.threadId, "thr_lead");
  const approved = await board();
  assert.equal(approved.lanes[0].state, "pr-open");
  assert.match(approved.lanes[0].prNote ?? "", /You approved this merge/);
  // The branch moves after the click: the click doesn't carry over to the new head.
  refs.set("bb/integration", later); upstream.set("bb/integration", later);
  await assert.rejects(call("squadron_report", { type: "merge", commit: later }), /moved after the whole-branch review/);
  refs.set("bb/integration", head); upstream.set("bb/integration", head);
  assert.equal((await call("squadron_report", { type: "merge", commit: head })).command, `gh pr merge 2 --squash --match-head-commit ${head}`);
});

test("a merged PR without the Helper's merge check, or an accept:owner merge without the click, stops the lane instead of landing", async (t) => {
  await t.test("no merge check", async (t) => {
    const { call, board, rows, mutations, specApproved } = await setup(t);
    await specApproved();
    rows.set("env-thr_lead", pullRequest({ state: "merged" }));
    const result = await call("squadron_report", { type: "landed" });
    assert.equal(result.state, "stopped");
    const lane = (await board()).lanes[0];
    assert.equal(lane.state, "stopped"); assert.match(lane.stopReason ?? "", /without Squadron's merge check/);
    assert.equal(mutations.some((item) => JSON.stringify(item.variables).includes("state-done")), false);
  });
  await t.test("owner never clicked", async (t) => {
    const { call, board, rows, specApproved } = await setup(t, { acceptOwner: true });
    await specApproved();
    rows.set("env-thr_lead", pullRequest({ state: "merged" }));
    assert.equal((await call("squadron_report", { type: "landed" })).state, "stopped");
    assert.equal((await board()).lanes[0].state, "stopped");
  });
});

test("landing writes go through the outbox with the original workspace; a refused write is shown, retried with the same keys, and queued once", async (t) => {
  let at = Date.now();
  const clock = mock.method(Date, "now", () => at); t.after(() => clock.mock.restore());
  const { harness, call, board, rows, specApproved, refuseWrites, restoreWrites, mutations, drain } = await setup(t);
  await specApproved();
  rows.set("env-thr_lead", pullRequest());
  await call("squadron_report", { type: "merge", commit: head });
  rows.set("env-thr_lead", pullRequest({ state: "merged" }));
  refuseWrites(); at += 60_001;
  // The Lead's tools refuse while the workspace changed; the Helper's own pass still sees the merge.
  await assert.rejects(call("squadron_report", { type: "landed" }), /connection or binding changed/);
  const until = async (done: (value: Board) => boolean) => {
    for (let i = 0; i < 400 && !done(await board()); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const first = harness.behavior.runService("spec-merge");
  await until((value) => !!value.lanes[0].writeError);
  first.controller.abort();
  const refused = await board();
  assert.equal(refused.lanes[0].state, "landed");
  assert.match(refused.lanes[0].writeError ?? "", /couldn't queue its Done statuses/);
  restoreWrites(); at += 60_001;
  const second = harness.behavior.runService("spec-merge"); t.after(() => second.controller.abort());
  await until((value) => !value.lanes[0].writeError);
  const value = await board();
  assert.equal(value.lanes[0].writeError, undefined);
  await drain(6);
  const done = mutations.filter((item) => JSON.stringify(item.variables).includes("state-done")).map((item) => item.variables.id);
  assert.deepEqual(done, ["fix-6", "fix-5"]);
});

test("whole-branch changes: one fresh fix worker in the Lead's family, then the same reviewer's scoped second look at the merged head", async (t) => {
  const { harness, call, board, sent, refs, rows, integrated, mutations } = await setup(t);
  await integrated();
  const reviewer = await call("squadron_spawn_reviewer", { ticketId: "FIX-5", commit: head });
  const as = (threadId: string) => ({ threadId, projectId: "proj-one" });
  const findings = [{ id: "S1", kind: "in-spec", text: "Landing never moves FIX-6." }, { id: "Q1", kind: "question", text: "Should the PR body list owner questions?" }];
  await assert.rejects(call("squadron_report", { type: "fix", ticketId: "FIX-5" }), /Only one fix round/);
  await call("squadron_report", { type: "verdict", commit: head, outcome: "changes", findings, resolvedFindingIds: [] }, as(reviewer.threadId));
  rows.set("env-thr_lead", pullRequest());
  await assert.rejects(call("squadron_report", { type: "merge", commit: head }), /hasn't approved/);
  const fixer = await call("squadron_report", { type: "fix", ticketId: "FIX-5" });
  await assert.rejects(call("squadron_report", { type: "fix", ticketId: "FIX-5" }), /Only one fix round/);
  const spawn = harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
  assert.deepEqual([spawn.providerId, spawn.model, spawn.parentThreadId], ["codex", "gpt-6.1-sol", "thr_lead"]);
  assert.deepEqual(spawn.environment, { type: "host", hostId: "repo-host", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "bb/integration" } } });
  // Only the findings that need a fix go to the worker.
  assert.match(spawn.prompt ?? "", /Landing never moves FIX-6/);
  assert.doesNotMatch(spawn.prompt ?? "", /owner questions/);
  refs.set(`bb/env-${fixer.threadId}`, fix);
  await call("squadron_report", { type: "done", commit: fix, summary: "Fixed S1." }, as(fixer.threadId));
  assert.match(JSON.stringify(sent().at(-1)!.input), new RegExp(fix));
  // The second look waits until the fix is in the integration branch at the named head.
  await assert.rejects(call("squadron_spawn_reviewer", { ticketId: "FIX-5", commit: later }), /Merge the fix worker's reported commit/);
  refs.set("bb/integration", later);
  const second = await call("squadron_spawn_reviewer", { ticketId: "FIX-5", commit: later });
  assert.equal(second.threadId, reviewer.threadId);
  const look = sent().at(-1)!;
  assert.equal(look.threadId, reviewer.threadId);
  assert.match(JSON.stringify(look.input), /scoped second look of the whole branch/);
  await assert.rejects(call("squadron_report", { type: "verdict", commit: later, outcome: "approve", findings: [], resolvedFindingIds: [] }, as(reviewer.threadId)), /resolve every first-review fix finding/);
  await call("squadron_report", { type: "verdict", commit: later, outcome: "approve", findings: [], resolvedFindingIds: ["S1"] }, as(reviewer.threadId));
  assert.equal((await board()).lanes[0].state, "pr-open");
  // The fix worker queued no status of its own: the lane start's two writes and FIX-6's three remain.
  assert.equal((await board()).writes?.pendingCount, 5);
  assert.equal(mutations.length, 0);
});
