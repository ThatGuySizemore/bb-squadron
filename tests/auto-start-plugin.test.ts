import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { Board } from "../lib/board-model.js";
import { binding, workspace, workspaceIssues } from "./fixtures/board-workspace.js";
import { end, openExternalBlocker, ready } from "./fixtures/linear-mirror.js";
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
  githubCheck?: (hostId: string) => Promise<{ authenticated: boolean }>;
  issues?: () => Response;
  watchMirror?: boolean;
} = {}) {
  const linear = workspace({
    issues: options.issues ?? (() => Response.json({ data: { issues: { ...workspaceIssues.data.issues, nodes: [
      ...workspaceIssues.data.issues.nodes,
      ...(options.moreSpecs ? [
        { ...workspaceIssues.data.issues.nodes[3], id: "fix-7", identifier: "FIX-7", title: "Next spec" },
        { ...workspaceIssues.data.issues.nodes[4], id: "fix-8", identifier: "FIX-8", parent: { id: "fix-7" } },
      ] : []),
    ] } } })),
    vocabulary: () => Response.json({ data: {
    workflowStates: { nodes: [ready, { id: "state-started", name: "In Progress", type: "started" }], pageInfo: end },
    issueLabels: { nodes: [], pageInfo: end },
  } }) });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const environmentProjects = new Map<string, string>();
  const host = createFakePluginHost({
    pluginId: "squadron", settings: { linearApiKey: "fake-auto-start-key" },
    experimental_callHostRpc: async (call) => options.githubCheck ? options.githubCheck(call.hostId) : { authenticated: options.github ?? true },
    sdk: {
      projects: { get: async ({ projectId }) => ({ id: projectId, name: "Fixture", kind: "standard", gitRemoteUrl: null,
        createdAt: 0, updatedAt: 0, sources: [{ id: "source", projectId, hostId: projectId === "proj-two" ? "repo-host-two" : "repo-host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
      files: { read: async ({ path }) => ({ content: settings.replace("| Lanes at once | 3 |", `| Lanes at once | ${options.cap ?? 3} |`), contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: settings.length }) },
      skills: { list: async () => ({ skills: skills.map((name) => ({ id: name, name, description: null, manageable: false,
        pluginId: null, provider: null, registrySkillId: null, scope: "shared-project" as const, filePath: `/repo/.agents/skills/${name}/SKILL.md` })) }) },
      threads: {
        queuedMessages: {
          list: async ({ threadId }) => [makeQueueEntry({ id: `queued-${threadId}`, threadId })],
          send: async () => ({ ok: true as const, delivery: "sent" as const }),
        },
        spawn: async ({ projectId, pluginMetadata }) => {
        const environmentId = `env-${projectId}-${pluginMetadata?.specId}`;
        environmentProjects.set(environmentId, projectId);
        return makeThreadResponse({ id: `thr_auto_${projectId}_${pluginMetadata?.specId}`, projectId, environmentId });
      } },
      environments: { get: async ({ environmentId }) => ({ id: environmentId, projectId: environmentProjects.get(environmentId) ?? "proj-one",
        hostId: environmentProjects.get(environmentId) === "proj-two" ? "repo-host-two" : "repo-host",
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
  let trustedMirror: ReturnType<typeof registerLinearMirror> | undefined;
  if (options.trusted) {
    const auth = registerLinearAuth(host.bb);
    const mirror = trustedMirror = registerLinearMirror(host.bb, auth);
    const outbox = registerLinearOutbox(host.bb, auth);
    const doctor = registerDoctor(host.bb, auth.getConnection);
    lanes = registerLanes(host.bb, { connection: auth.getConnection,
      mirror: options.watchMirror === false ? { getSnapshot: mirror.getSnapshot, sync: mirror.sync } : mirror, outbox, doctor });
    registerBoard(host.bb, { connection: auth.getConnection, mirror, writes: (id) => outbox.getHealth(id), lanes });
  } else await plugin(host.bb);
  await host.harness.behavior.callRpc("linear.bind", binding);
  return { ...host, lanes, linear, mirror: trustedMirror };
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

test("the timer refills another project while the first project's Doctor is pending", async (t) => {
  let readySpecs = false;
  let checkingFirst = false;
  let release!: (value: { authenticated: boolean }) => void;
  const gate = new Promise<{ authenticated: boolean }>((resolve) => { release = resolve; });
  const { harness, lanes, mirror } = await setup(t, { trusted: true, cap: 1, watchMirror: false,
    issues: () => readySpecs ? Response.json(workspaceIssues) : Response.json({ data: { issues: { nodes: [], pageInfo: end } } }),
    githubCheck: async (hostId) => {
      if (hostId === "repo-host") { checkingFirst = true; return gate; }
      return { authenticated: true };
    },
  });
  assert.ok(lanes && mirror);
  await harness.behavior.callRpc("linear.bind", { ...binding, bbProjectId: "proj-two" });
  for (const projectId of ["proj-one", "proj-two"]) {
    await harness.behavior.callRpc("lanes.setAutoStart", { projectId, enabled: true });
    await lanes.reconcile(projectId);
  }
  readySpecs = true;
  await Promise.all([mirror.sync("proj-one"), mirror.sync("proj-two")]);
  const service = harness.behavior.runService("lane-starts");
  t.after(() => service.controller.abort());
  try {
    await until(() => checkingFirst);
    await until(() => harness.inspection.sdk.callsTo("threads.spawn").some((call) =>
      (call[0] as { projectId: string }).projectId === "proj-two"));
    assert.ok(!harness.inspection.sdk.callsTo("threads.spawn").some((call) =>
      (call[0] as { projectId: string }).projectId === "proj-one"));
  } finally { release({ authenticated: true }); }
});

test("full-capacity, no-ready and disabled reconciles perform no Linear or Doctor calls", async (t) => {
  for (const state of ["full", "no-ready", "disabled"] as const) await t.test(state, async (t) => {
    let checks = 0;
    const { harness, lanes, linear } = await setup(t, { trusted: true, cap: 1,
      githubCheck: async () => { checks++; return { authenticated: true }; },
      ...(state === "no-ready" ? { issues: () => Response.json({ data: { issues: { nodes: [], pageInfo: end } } }) } : {}),
    });
    assert.ok(lanes);
    if (state === "full") await harness.behavior.callRpc("lanes.start", { projectId: "proj-one", specId: "FIX-5" });
    if (state !== "disabled") await harness.behavior.callRpc("lanes.setAutoStart", { projectId: "proj-one", enabled: true });
    await lanes.reconcile("proj-one");
    const before = { linear: linear.operations.length, checks, spawns: harness.inspection.sdk.callsTo("threads.spawn").length };
    for (let i = 0; i < 4; i++) await lanes.reconcile("proj-one");
    assert.deepEqual({ linear: linear.operations.length, checks, spawns: harness.inspection.sdk.callsTo("threads.spawn").length }, before);
    if (state === "no-ready") assert.equal(checks, 0);
  });
});

test("a cached candidate still waits when the fresh dispatch walk finds a blocker", async (t) => {
  let blocked = false;
  let checks = 0;
  const nodes = workspaceIssues.data.issues.nodes;
  const { harness, lanes, linear } = await setup(t, { trusted: true,
    githubCheck: async () => { checks++; return { authenticated: true }; },
    issues: () => Response.json({ data: { issues: { ...workspaceIssues.data.issues, nodes: nodes.map((node) =>
      blocked && node.id === "fix-5" ? { ...node, inverseRelations: { nodes: [
        { id: "outside-blocks-fix-5", type: "blocks", issue: openExternalBlocker, relatedIssue: node },
      ], pageInfo: end } } : node) } } }),
  });
  assert.ok(lanes);
  blocked = true;
  await harness.behavior.callRpc("lanes.setAutoStart", { projectId: "proj-one", enabled: true });
  await lanes.reconcile("proj-one");
  assert.equal(checks, 1, "the cached candidate received fresh preflight");
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  assert.deepEqual(lanes.list("proj-one"), []);
  const before = linear.operations.length;
  await lanes.reconcile("proj-one");
  assert.equal(checks, 1);
  assert.equal(linear.operations.length, before, "the fresh blocker now gates further walks locally");
});

test("an automatic dispatch rate limit leaves retries to mirror recovery without repeated Doctor checks", async (t) => {
  let limited = false;
  let checks = 0;
  const { harness, lanes, mirror, linear } = await setup(t, { trusted: true,
    githubCheck: async () => { checks++; return { authenticated: true }; },
    issues: () => limited ? Response.json({ errors: [{ message: "Fixture rate limit" }] }, { status: 429, headers: { "retry-after": "60" } })
      : Response.json(workspaceIssues),
  });
  assert.ok(lanes && mirror);
  limited = true;
  await harness.behavior.callRpc("lanes.setAutoStart", { projectId: "proj-one", enabled: true });
  await assert.rejects(lanes.reconcile("proj-one"), /request budget is exhausted/);
  assert.equal(checks, 1);
  assert.match(mirror.getSnapshot("proj-one").error ?? "", /request budget is exhausted/);
  const before = linear.operations.length;
  for (let i = 0; i < 4; i++) await lanes.reconcile("proj-one");
  assert.equal(checks, 1);
  assert.equal(linear.operations.length, before);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("the service retries persisted auto-start through Doctor after reload without an open board", async (t) => {
  const options = { trusted: true, github: false, moreSpecs: true, cap: 1 };
  const { harness, lanes } = await setup(t, options);
  assert.ok(lanes);
  await harness.behavior.callRpc("lanes.setAutoStart", { projectId: "proj-one", enabled: true });
  await assert.rejects(lanes.reconcile("proj-one"), /Open Doctor/);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  options.github = true;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const reloaded = await harness.lifecycle.reload(plugin);
  t.after(() => reloaded.harness.lifecycle.dispose());
  // BB starts the mirror too. Its catch-up owns refreshing the pre-restart
  // snapshot before the lane service considers an automatic candidate.
  const before = await reloaded.harness.behavior.callRpc("linear.snapshot", { bbProjectId: "proj-one" }) as { syncedAt: number };
  const mirror = reloaded.harness.behavior.runService("linear-mirror");
  t.after(() => mirror.controller.abort());
  let caughtUp = false;
  for (let i = 0; i < 200 && !caughtUp; i++) {
    const current = await reloaded.harness.behavior.callRpc("linear.snapshot", { bbProjectId: "proj-one" }) as { syncedAt: number };
    caughtUp = current.syncedAt > before.syncedAt;
    if (!caughtUp) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(caughtUp, "the mirror's startup walk refreshed the persisted copy");
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
