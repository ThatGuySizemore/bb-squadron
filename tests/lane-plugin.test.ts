import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server.js";
import { needsYou, type Board } from "../lib/board-model.js";
import { binding, workspace } from "./fixtures/board-workspace.js";
import { end, ready } from "./fixtures/linear-mirror.js";

const settings = readFileSync("tests/fixtures/squadron.md", "utf8");
const skills = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];

async function setup(t: import("node:test").TestContext, options: {
  github?: boolean; provisioningFails?: boolean; spawnFails?: boolean; provisioningTimeout?: boolean;
  refuseWrite?: "status" | "comment";
  appMode?: boolean;
} = {}) {
  let environmentReads = 0;
  let branchReady = false;
  let writeIdentities = 0;
  const linear = workspace({ vocabulary: () => Response.json({ data: {
    workflowStates: { nodes: [ready, { id: "state-started", name: "In Progress", type: "started" }], pageInfo: end },
    issueLabels: { nodes: [], pageInfo: end },
  } }) });
  const mutations: Array<{ query: string; variables: { id?: string; input: Record<string, string> } }> = [];
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    if (request.query.includes("SquadronIdentity") && branchReady && options.refuseWrite &&
      ++writeIdentities >= (options.refuseWrite === "status" ? 1 : 2)) {
      return Response.json({ data: { viewer: { id: "fixture-user", name: "Fixture user" },
        organization: { id: "other-workspace", name: "Other workspace" } } });
    }
    if (!request.query.trimStart().startsWith("mutation")) return linear.fetch(url, init);
    mutations.push(request);
    return Response.json({ data: request.query.includes("issueUpdate")
      ? { issueUpdate: { success: true, issue: { id: request.variables.id } } }
      : { commentCreate: { success: true, comment: { id: request.variables.input.id } } } });
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "squadron", appUrl: "https://user:fake-password@bb.example.test/path?private=fake",
    settings: options.appMode ? { linearCredentials: JSON.stringify({ accessToken: "fake-app-token", refreshToken: "fake-refresh", expiresAt: 9_999_999_999_999 }) }
      : { linearApiKey: "fake-lane-key" },
    experimental_callHostRpc: async () => ({ authenticated: options.github ?? true }),
    sdk: {
      projects: { get: async ({ projectId }) => ({ id: projectId, name: "Fixture", kind: "standard", gitRemoteUrl: null,
        createdAt: 0, updatedAt: 0, sources: [{ id: "source", projectId, hostId: "repo-host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
      files: { read: async ({ path }) => ({ content: settings, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: settings.length }) },
      skills: { list: async () => ({ skills: skills.map((name) => ({ id: name, name, description: null, manageable: false,
        pluginId: null, provider: null, registrySkillId: null, scope: "shared-project" as const, filePath: `/repo/.agents/skills/${name}/SKILL.md` })) }) },
      threads: {
        spawn: async ({ projectId }) => {
          if (options.spawnFails) throw new Error("fake-private-spawn-detail");
          return makeThreadResponse({ id: "thr_lead", projectId, environmentId: "env-lane" });
        },
        stop: async () => ({ ok: true as const }),
      },
      environments: { get: async () => {
        if (options.provisioningTimeout && ++environmentReads === 1) throw new DOMException("fake-private-provisioning-detail", "TimeoutError");
        branchReady = !options.provisioningFails;
        return { id: "env-lane", projectId: "proj-one", hostId: "repo-host",
        status: options.provisioningFails ? "error" as const : "ready" as const, branchName: "bb/lead-fix-5", path: "/worktree",
        baseBranch: "main", defaultBranch: "main", mergeBaseBranch: "main", name: null, createdAt: 0, updatedAt: 0,
        environmentProviderId: "environment-git-worktree", environmentProviderInstanceKey: "fixture", environmentProviderSelection: null,
        hostLifecycle: "active", isGitRepo: true, isWorktree: true, managed: true, workspaceProvisionType: "managed-worktree",
        lifecycle: { phase: "active", retireAt: null, teardown: null },
      }; } },
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

test("a throwing spawn keeps a visible reserved lane without inventing a Lead link", async (t) => {
  const { harness } = await setup(t, { spawnFails: true });
  const start = () => harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  await assert.rejects(start(), /spawn result is unknown/);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.lanes.map((lane) => [lane.specId, lane.state, lane.leadThreadId]), [["FIX-5", "stopped", null]]);
  assert.deepEqual(needsYou(board).map((item) => [item.kind, item.specId, item.threadId]), [["stopped", "FIX-5", null]]);
  assert.match(board.lanes[0].stopReason ?? "", /check BB threads/i);
  assert.ok(!board.ready.some((row) => row.id === "FIX-5"));
  assert.equal(board.writes?.pendingCount, 0);
  await assert.rejects(start(), /isn't ready to start/);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
  assert.equal(harness.inspection.sdk.callsTo("threads.stop").length, 0);
  assert.ok(harness.inspection.logEntries.some((entry) => entry.level === "warn" && entry.message.includes("spawn")));
  assert.ok(!JSON.stringify(harness.inspection.logEntries).includes("fake-private-spawn-detail"));
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

test("a provisioning timeout leaves the Lead starting and a later pass completes the same lane", async (t) => {
  const { harness } = await setup(t, { provisioningTimeout: true });
  const started = await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" }) as { threadId: string; branch: string | null };
  assert.deepEqual([started.threadId, started.branch], ["thr_lead", null]);
  const pending = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(pending.lanes.map((lane) => [lane.leadThreadId, lane.branch, lane.state]), [["thr_lead", "Preparing integration branch", "flying"]]);
  assert.equal(pending.writes?.pendingCount, 0);
  assert.equal(needsYou(pending).length, 0);
  assert.equal(harness.inspection.sdk.callsTo("threads.stop").length, 0);
  const watching = harness.behavior.runService("lane-starts");
  t.after(() => watching.controller.abort());
  for (let i = 0; i < 200; i++) {
    const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
    if (board.lanes[0].branch === "bb/lead-fix-5" && board.writes?.pendingCount === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const ready = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(ready.lanes[0].branch, "bb/lead-fix-5");
  assert.equal(ready.writes?.pendingCount, 2);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
  assert.equal(harness.inspection.sdk.callsTo("threads.stop").length, 0);
});

test("an outbox refusal after branch readiness keeps the Lead alive and shows which write could not be queued", async (t) => {
  for (const refused of ["status", "comment"] as const) await t.test(refused, async (t) => {
    const { harness } = await setup(t, { refuseWrite: refused });
    const result = await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" }) as { message?: string };
    const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
    assert.deepEqual(board.lanes.map((lane) => [lane.state, lane.leadThreadId, lane.branch]), [["flying", "thr_lead", "bb/lead-fix-5"]]);
    assert.equal(harness.inspection.sdk.callsTo("threads.stop").length, 0);
    assert.equal(board.writes?.pendingCount, refused === "status" ? 0 : 1);
    assert.match(result.message ?? "", refused === "status" ? /couldn't queue the spec status/ : /couldn't queue the signed Lead comment/);
    const write = needsYou(board).find((item) => item.kind === "write" && item.specId === "FIX-5");
    assert.equal(write?.threadId, "thr_lead");
    assert.equal(write?.text, result.message);
    assert.ok(!/delivered|moved to In Progress/.test(write?.text ?? ""));
    assert.ok(harness.inspection.logEntries.some((entry) => entry.message.includes(`queue-${refused}`) && entry.message.includes("workspace_changed")));
  });
});

test("app comments use a distinct public Lead avatar through the shared origin-only URL builder", async (t) => {
  const { harness, mutations } = await setup(t, { appMode: true });
  await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
  const pending = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(pending.writes?.pendingCount, 2);
  assert.equal(mutations.length, 0);
  const delivery = harness.behavior.runService("linear-outbox");
  t.after(() => delivery.controller.abort());
  for (let i = 0; i < 200 && mutations.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(mutations.length, 2);
  assert.equal(mutations[1].variables.input.createAsUser, "Lead · GPT-6.1 Sol");
  assert.equal(mutations[1].variables.input.displayIconUrl, "https://bb.example.test/api/v1/plugins/squadron/http/avatars/lead-thread.svg");
  const lead = await harness.behavior.fetchHttp("GET", "/avatars/lead-thread.svg");
  const planning = await harness.behavior.fetchHttp("GET", "/avatars/planning-thread.svg");
  assert.equal(lead.headers.get("content-type"), "image/svg+xml");
  const svg = await lead.text();
  assert.notEqual(svg, await planning.text());
  assert.ok(!/thr_lead|proj-one|FIX-5|fake-password/.test(svg));
});
