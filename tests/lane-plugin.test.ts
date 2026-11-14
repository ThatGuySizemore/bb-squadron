import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server.js";
import type { Board } from "../lib/board-model.js";
import { binding, workspace } from "./fixtures/board-workspace.js";
import { end, ready } from "./fixtures/linear-mirror.js";

const settings = readFileSync("tests/fixtures/squadron.md", "utf8");
const skills = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];

async function setup(t: import("node:test").TestContext, options: { github?: boolean; provisioningFails?: boolean } = {}) {
  const linear = workspace({ vocabulary: () => Response.json({ data: {
    workflowStates: { nodes: [ready, { id: "state-started", name: "In Progress", type: "started" }], pageInfo: end },
    issueLabels: { nodes: [], pageInfo: end },
  } }) });
  const mutations: Array<{ query: string; variables: { id?: string; input: Record<string, string> } }> = [];
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    if (!request.query.trimStart().startsWith("mutation")) return linear.fetch(url, init);
    mutations.push(request);
    return Response.json({ data: request.query.includes("issueUpdate")
      ? { issueUpdate: { success: true, issue: { id: request.variables.id } } }
      : { commentCreate: { success: true, comment: { id: request.variables.input.id } } } });
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "squadron", settings: { linearApiKey: "fake-lane-key" },
    experimental_callHostRpc: async () => ({ authenticated: options.github ?? true }),
    sdk: {
      projects: { get: async ({ projectId }) => ({ id: projectId, name: "Fixture", kind: "standard", gitRemoteUrl: null,
        createdAt: 0, updatedAt: 0, sources: [{ id: "source", projectId, hostId: "repo-host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
      files: { read: async ({ path }) => ({ content: settings, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: settings.length }) },
      skills: { list: async () => ({ skills: skills.map((name) => ({ id: name, name, description: null, manageable: false,
        pluginId: null, provider: null, registrySkillId: null, scope: "shared-project" as const, filePath: `/repo/.agents/skills/${name}/SKILL.md` })) }) },
      threads: {
        spawn: async ({ projectId }) => makeThreadResponse({ id: "thr_lead", projectId, environmentId: "env-lane" }),
        stop: async () => ({ ok: true as const }),
      },
      environments: { get: async () => ({ id: "env-lane", projectId: "proj-one", hostId: "repo-host",
        status: options.provisioningFails ? "error" as const : "ready" as const, branchName: "bb/lead-fix-5", path: "/worktree",
        baseBranch: "main", defaultBranch: "main", mergeBaseBranch: "main", name: null, createdAt: 0, updatedAt: 0,
        environmentProviderId: "environment-git-worktree", environmentProviderInstanceKey: "fixture", environmentProviderSelection: null,
        hostLifecycle: "active", isGitRepo: true, isWorktree: true, managed: true, workspaceProvisionType: "managed-worktree",
        lifecycle: { phase: "active", retireAt: null, teardown: null },
      }) },
    },
  });
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("linear.bind", binding);
  return { harness, mutations };
}

test("Start spawns one routed Lead in a managed integration worktree, links Flying and queues signed status writes", async (t) => {
  const { harness, mutations } = await setup(t);
  const [first, second] = await Promise.all([1, 2].map(() => harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" })));
  assert.deepEqual(first, second);
  assert.match((first as { laneId: string }).laneId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(first, { laneId: (first as { laneId: string }).laneId, threadId: "thr_lead", branch: "bb/lead-fix-5" });
  const spawns = harness.inspection.sdk.callsTo("threads.spawn");
  assert.equal(spawns.length, 1);
  const args = spawns[0][0] as Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
  assert.deepEqual(args.environment, { type: "host", hostId: "repo-host", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } });
  assert.deepEqual([args.providerId, args.model, args.reasoningLevel, args.permissionMode, args.serviceTier],
    ["codex", "gpt-6.1-sol", "high", "auto", "default"]);
  assert.deepEqual([args.pluginMetadata?.specId, args.pluginMetadata?.specIssueId, args.pluginMetadata?.role], ["FIX-5", "fix-5", "Lead"]);
  assert.match(args.prompt ?? "", /implement-spec/);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.lanes.map((lane) => [lane.specId, lane.leadThreadId, lane.branch, lane.state]), [["FIX-5", "thr_lead", "bb/lead-fix-5", "flying"]]);
  assert.ok(!board.ready.some((spec) => spec.id === "FIX-5"));
  assert.equal(board.writes?.pendingCount, 2);
  const delivery = harness.behavior.runService("linear-outbox");
  t.after(() => delivery.controller.abort());
  for (let i = 0; i < 200 && mutations.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(mutations.length, 2);
  assert.deepEqual(mutations[0].variables, { id: "fix-5", input: { stateId: "state-started" } });
  assert.equal(mutations[1].variables.input.issueId, "fix-5");
  assert.match(mutations[1].variables.input.body, /^Lead · GPT-6.1 Sol \(via Squadron\)\n\n/);
});

test("Doctor refuses Start before any Lead or write", async (t) => {
  const { harness } = await setup(t, { github: false });
  await assert.rejects(harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" }), /Open Doctor/);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  assert.equal((await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board).writes?.pendingCount, 0);
});

test("a current open spec blocker refuses Start through the real server handler", async (t) => {
  const { harness } = await setup(t);
  await assert.rejects(harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-1" }), /Waits on OUT-10/);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("failed provisioning retains the Lead link, stops it and prevents a duplicate launch", async (t) => {
  const { harness } = await setup(t, { provisioningFails: true });
  const start = () => harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  await assert.rejects(start(), /Lane start didn't finish/);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.lanes.map((lane) => [lane.state, lane.leadThreadId]), [["stopped", "thr_lead"]]);
  assert.equal(board.writes?.pendingCount, 0);
  assert.deepEqual(harness.inspection.sdk.callsTo("threads.stop")[0][0], { threadId: "thr_lead" });
  await assert.rejects(start(), /isn't ready to start/);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
});

test("a service reload retains the integration branch and prevents starting the same lane again", async (t) => {
  const { harness } = await setup(t);
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  const reloaded = await harness.lifecycle.reload((bb) => plugin(bb));
  t.after(() => reloaded.harness.lifecycle.dispose());
  const board = await reloaded.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.lanes.map((lane) => [lane.specId, lane.leadThreadId, lane.branch]), [["FIX-5", "thr_lead", "bb/lead-fix-5"]]);
  await assert.rejects(reloaded.harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" }), /isn't ready to start/);
  assert.equal(reloaded.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});
