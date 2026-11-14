import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { Board } from "../lib/board-model.js";
import { binding, workspace, workspaceIssues } from "./fixtures/board-workspace.js";
import { end, ready } from "./fixtures/linear-mirror.js";
import { registerLinearAuth } from "../lib/linear-auth.js";
import { registerLinearMirror } from "../lib/linear-mirror.js";
import { registerLinearOutbox } from "../lib/linear-outbox.js";
import { registerDoctor } from "../lib/doctor-service.js";
import { registerLanes, type LaneService } from "../lib/lane-service.js";
import { registerBoard } from "../lib/board-service.js";

const settings = readFileSync("tests/fixtures/squadron.md", "utf8");
const skills = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "expected auto-start to reconcile");
}

async function setup(t: import("node:test").TestContext, options: {
  trusted?: boolean; cap?: number; github?: boolean; moreSpecs?: boolean;
  githubCheck?: () => Promise<{ authenticated: boolean }>;
} = {}) {
  const linear = workspace({
    issues: () => Response.json({ data: { issues: { ...workspaceIssues.data.issues, nodes: [
      ...workspaceIssues.data.issues.nodes,
      ...(options.moreSpecs ? [
        { ...workspaceIssues.data.issues.nodes[3], id: "fix-7", identifier: "FIX-7", title: "Next spec" },
        { ...workspaceIssues.data.issues.nodes[4], id: "fix-8", identifier: "FIX-8", parent: { id: "fix-7" } },
      ] : []),
    ] } } }),
    vocabulary: () => Response.json({ data: {
    workflowStates: { nodes: [ready, { id: "state-started", name: "In Progress", type: "started" }], pageInfo: end },
    issueLabels: { nodes: [], pageInfo: end },
  } }) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const host = createFakePluginHost({
    pluginId: "squadron", settings: { linearApiKey: "fake-auto-start-key" },
    experimental_callHostRpc: async () => options.githubCheck ? options.githubCheck() : { authenticated: options.github ?? true },
    sdk: {
      projects: { get: async ({ projectId }) => ({ id: projectId, name: "Fixture", kind: "standard", gitRemoteUrl: null,
        createdAt: 0, updatedAt: 0, sources: [{ id: "source", projectId, hostId: "repo-host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
      files: { read: async ({ path }) => ({ content: settings.replace("| Lanes at once | 3 |", `| Lanes at once | ${options.cap ?? 3} |`), contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: settings.length }) },
      skills: { list: async () => ({ skills: skills.map((name) => ({ id: name, name, description: null, manageable: false,
        pluginId: null, provider: null, registrySkillId: null, scope: "shared-project" as const, filePath: `/repo/.agents/skills/${name}/SKILL.md` })) }) },
      threads: { spawn: async ({ projectId, pluginMetadata }) => makeThreadResponse({
        id: `thr_auto_${pluginMetadata?.specId}`, projectId, environmentId: `env-${pluginMetadata?.specId}`,
      }) },
      environments: { get: async ({ environmentId }) => ({ id: environmentId, projectId: "proj-one", hostId: "repo-host",
        status: "ready" as const, branchName: `bb/auto-${environmentId}`, path: "/worktree", baseBranch: "main", defaultBranch: "main",
        mergeBaseBranch: "main", name: null, createdAt: 0, updatedAt: 0, environmentProviderId: "environment-git-worktree",
        environmentProviderInstanceKey: "fixture", environmentProviderSelection: null, hostLifecycle: "active",
        isGitRepo: true, isWorktree: true, managed: true, workspaceProvisionType: "managed-worktree",
        lifecycle: { phase: "active", retireAt: null, teardown: null },
      }) },
    },
  });
  t.after(async () => { fetch.mock.restore(); await host.harness.lifecycle.dispose(); });
  let lanes: LaneService | undefined;
  if (options.trusted) {
    const auth = registerLinearAuth(host.bb);
    const mirror = registerLinearMirror(host.bb, auth);
    const outbox = registerLinearOutbox(host.bb, auth);
    const doctor = registerDoctor(host.bb, auth.getConnection);
    lanes = registerLanes(host.bb, { connection: auth.getConnection, mirror, outbox, doctor });
    registerBoard(host.bb, { connection: auth.getConnection, mirror, writes: (id) => outbox.getHealth(id), lanes });
  } else await plugin(host.bb);
  await host.harness.behavior.callRpc("linear.bind", binding);
  return { ...host, lanes };
}

test("auto-start is off by default, board-only and persists independently per BB project after reload", async (t) => {
  const { harness } = await setup(t);
  const board = (id = "proj-one") => harness.behavior.callRpc("board", { projectId: id }) as Promise<Board>;
  assert.equal((await board()).autoStart, false);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  await assert.rejects(harness.behavior.callRpc("lanes.setAutoStart", { projectId: "proj-one", enabled: true },
    { experimental_caller: { kind: "plugin", pluginId: "other-plugin" } }), /board/);
  assert.equal((await board()).autoStart, false);
  assert.deepEqual(await harness.behavior.callRpc("lanes.setAutoStart", { projectId: "proj-one", enabled: true }), { enabled: true });
  assert.equal((await board()).autoStart, true);
  assert.equal((await board("proj-two")).autoStart, false);
  const reloaded = await harness.lifecycle.reload(plugin);
  t.after(() => reloaded.harness.lifecycle.dispose());
  assert.equal((await reloaded.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board).autoStart, true);
  assert.equal((await reloaded.harness.behavior.callRpc("board", { projectId: "proj-two" }) as Board).autoStart, false);
  await reloaded.harness.behavior.callRpc("lanes.setAutoStart", { projectId: "proj-one", enabled: false });
  assert.equal((await reloaded.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board).autoStart, false);
});

test("the service retries persisted auto-start through Doctor after reload without an open board", async (t) => {
  const options = { trusted: true, github: false, moreSpecs: true, cap: 1 };
  const { harness, lanes } = await setup(t, options);
  assert.ok(lanes);
  await harness.behavior.callRpc("lanes.setAutoStart", { projectId: "proj-one", enabled: true });
  await assert.rejects(lanes.reconcile("proj-one"), /Open Doctor/);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  options.github = true;
  const reloaded = await harness.lifecycle.reload(plugin);
  t.after(() => reloaded.harness.lifecycle.dispose());
  const watching = reloaded.harness.behavior.runService("lane-starts");
  t.after(() => watching.controller.abort());
  await until(() => reloaded.harness.inspection.sdk.callsTo("threads.spawn").length === 1);
  const board = await reloaded.harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.autoStart, true);
  assert.deepEqual(board.lanes.map((lane) => lane.specId), ["FIX-5"]);
});

test("turning auto-start off while Doctor is pending prevents the queued launch", async (t) => {
  let checking = false;
  let release!: (value: { authenticated: boolean }) => void;
  const gate = new Promise<{ authenticated: boolean }>((resolve) => { release = resolve; });
  const { harness, lanes } = await setup(t, { trusted: true, githubCheck: async () => { checking = true; return gate; } });
  assert.ok(lanes);
  await harness.behavior.callRpc("lanes.setAutoStart", { projectId: "proj-one", enabled: true });
  const pending = lanes.reconcile("proj-one");
  await until(() => checking);
  await harness.behavior.callRpc("lanes.setAutoStart", { projectId: "proj-one", enabled: false });
  release({ authenticated: true });
  await pending;
  await lanes.reconcile("proj-one");
  assert.equal(lanes.autoStart("proj-one"), false);
  assert.deepEqual(lanes.list("proj-one"), []);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("turning auto-start off leaves current lanes running and prevents refill when one lands", async (t) => {
  const { harness, lanes } = await setup(t, { trusted: true, cap: 1, moreSpecs: true });
  assert.ok(lanes);
  await harness.behavior.callRpc("lanes.setAutoStart", { projectId: "proj-one", enabled: true });
  await lanes.reconcile("proj-one");
  await harness.behavior.callRpc("lanes.setAutoStart", { projectId: "proj-one", enabled: false });
  assert.equal(lanes.list("proj-one")[0].state, "flying");
  assert.equal(harness.inspection.sdk.callsTo("threads.stop").length, 0);
  lanes.save({ ...lanes.list("proj-one")[0], state: "landed" });
  await lanes.reconcile("proj-one");
  assert.deepEqual(lanes.list("proj-one").map((lane) => [lane.specId, lane.state]), [["FIX-5", "landed"]]);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
});

test("auto-start and manual Start share capacity, and trusted lane completion refills the free slot", async (t) => {
  const { harness, lanes } = await setup(t, { trusted: true, cap: 1, moreSpecs: true });
  assert.ok(lanes);
  await Promise.allSettled([
    harness.behavior.callRpc("lanes.setAutoStart", { projectId: "proj-one", enabled: true }),
    harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" }),
  ]);
  await lanes.reconcile("proj-one");
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
  assert.deepEqual(lanes.list("proj-one").map((lane) => lane.specId), ["FIX-5"]);
  const first = lanes.list("proj-one")[0];
  lanes.save({ ...first, state: "stopped" });
  await lanes.reconcile("proj-one");
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1, "stopped lanes retain their slot");
  lanes.save({ ...first, state: "landed" });
  await until(() => lanes.list("proj-one").some((lane) => lane.specId === "FIX-7" && lane.state === "flying"));
  assert.deepEqual(lanes.list("proj-one").map((lane) => [lane.specId, lane.state]), [["FIX-5", "landed"], ["FIX-7", "flying"]]);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 2);
  assert.ok(!lanes.list("proj-one").some((lane) => lane.specId === "FIX-1"), "the open cross-spec blocker still holds");
});
