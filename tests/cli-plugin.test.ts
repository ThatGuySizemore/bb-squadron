import { fixtureProviders } from "./fixtures/provider-catalog.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { workspace, workspaceIssues } from "./fixtures/board-workspace.js";

const settingsFile = readFileSync("tests/fixtures/squadron.md", "utf8");
const skillNames = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];
function nativeThreads() {
  return { count: 0, threads: new Map<string, ReturnType<typeof makeThreadResponse>>(),
    metadata: new Map<string, Record<string, unknown>>(), routes: new Map<string, { model: string; reasoningLevel: string }>() };
}
function host(native = nativeThreads(), settings = settingsFile) {
  const { threads, metadata, routes } = native;
  return { native, ...createFakePluginHost({
    pluginId: "squadron", experimental_hostEntry: true,
    settings: { linearApiKey: "fake-start-key" },
    sdk: {
      providers: fixtureProviders,
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
        return { content: settings, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: settings.length };
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
    experimental_callHostRpc: async ({ method, input }) => method === "readModelRoutes" ? { markdown: null, policy: null } : method === "githubLogin" ? { authenticated: true } : {
      homePath: "/owner", repoRulesExists: true, playbookExists: false, machineProfileExists: false,
      setupFiles: ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"],
      regularSkillFiles: (input as { skillPaths: string[] }).skillPaths,
    },
  }) };
}
async function setup(t: import("node:test").TestContext, options: Parameters<typeof workspace>[0] = {}) {
  const linear = workspace(options);
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness, native } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  return { harness, native };
}

test("status defaults to the calling thread's project with short owner-visible counts", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("projects.list", async () => ["one", "two"].map((id) => ({
    id: `proj-${id}`, name: id === "one" ? "Fixture" : "Second", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
  })));
  assert.deepEqual(await harness.behavior.runCli(["status"], { projectId: "proj-one" }), {
    exitCode: 0, stderr: "", stdout: "Fixture | Tracker: Up to date with Linear. | Ready 2 | Shaping 0 | Flying 0 | Landed today 0 | Needs you 0\n",
  });
});

test("status --all lists every project even from a project thread", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("projects.list", async () => ["one", "two"].map((id) => ({
    id: `proj-${id}`, name: id === "one" ? "Fixture" : "Second", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
  })));
  assert.deepEqual(await harness.behavior.runCli(["status", "--all"], { projectId: "proj-one" }), {
    exitCode: 0, stderr: "", stdout: "Fixture | Tracker: Up to date with Linear. | Ready 2 | Shaping 0 | Flying 0 | Landed today 0 | Needs you 0\nSecond | Tracker: Up to date with Linear. | Ready 2 | Shaping 0 | Flying 0 | Landed today 0 | Needs you 0\n",
  });
});

test("read commands require an explicit selection without caller context and reject conflicting selectors", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("projects.list", async () => [{ id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }]);
  for (const command of ["status", "needs"]) {
    const missing = await harness.behavior.runCli([command]);
    assert.equal(missing.exitCode, 1);
    assert.equal(missing.stdout, "");
    assert.match(missing.stderr, /Choose a project with --project or use --all/);
    const conflict = await harness.behavior.runCli([command, "--all", "--project", "Fixture"], { projectId: "proj-one" });
    assert.equal(conflict.exitCode, 1);
    assert.equal(conflict.stdout, "");
    assert.match(conflict.stderr, /Use either --project or --all/);
  }
});

test("status narrows by project ID or unique name and explains unknown or ambiguous names", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("projects.list", async () => [
    { id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 },
    { id: "proj-two", name: "Shared", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 },
    { id: "proj-three", name: "Shared", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 },
  ]);
  const expected = "Fixture | Tracker: Up to date with Linear. | Ready 2 | Shaping 0 | Flying 0 | Landed today 0 | Needs you 0\n";
  for (const project of ["proj-one", "Fixture"]) {
    assert.deepEqual(await harness.behavior.runCli(["status", "--project", project], { projectId: "proj-two" }), { exitCode: 0, stdout: expected, stderr: "" });
  }
  for (const [project, reason] of [["missing", 'No project matches "missing".'], ["Shared", 'More than one project matches "Shared". Use its project ID.']]) {
    const result = await harness.behavior.runCli(["status", "--project", project]);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes(reason), result.stderr);
    assert.equal(result.stdout, "");
  }
});

test("needs prints one short line when nothing needs you, across all or one project", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("projects.list", async () => [{ id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }]);
  for (const args of [["needs", "--all"], ["needs", "--project", "Fixture"]]) {
    assert.deepEqual(await harness.behavior.runCli(args), { exitCode: 0, stdout: "Nothing needs you.\n", stderr: "" });
  }
});

test("needs defaults to its caller and lets explicit selectors read other projects", async (t) => {
  const { harness, native } = await setup(t);
  harness.sdk.stub("projects.list", async () => ["one", "two"].map((id) => ({
    id: `proj-${id}`, name: id === "one" ? "Fixture" : "Second", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
  })));
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  harness.sdk.stub("threads.list", async (args: { parentThreadId?: string }) => [...native.threads.values()]
    .filter((thread) => !args?.parentThreadId || thread.parentThreadId === args.parentThreadId)
    .map((thread) => ({ ...thread, hasPendingInteraction: true, environmentBranchName: "spec/fix-5" })));
  for (const [args, projectId] of [
    [["needs"], "proj-one"], [["needs", "--all"], "proj-two"], [["needs", "--project", "Fixture"], "proj-two"],
  ] as const) {
    assert.deepEqual(await harness.behavior.runCli([...args], { projectId }), {
      exitCode: 0, stderr: "", stdout: "Fixture | Question | FIX-5 | The Lead for FIX-5 is waiting on you. | @thread:thr_lead_1\n",
    });
  }
  assert.deepEqual(await harness.behavior.runCli(["needs"], { projectId: "proj-two" }), {
    exitCode: 0, stderr: "", stdout: "Nothing needs you.\n",
  });
  assert.deepEqual(await harness.behavior.runCli(["needs", "--project", "Second"]), {
    exitCode: 0, stderr: "", stdout: "Nothing needs you.\n",
  });
});

test("CLI output keeps project names on one line", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("projects.list", async () => [{ id: "proj-one", name: "Fixture\nProject", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }]);
  assert.deepEqual(await harness.behavior.runCli(["status", "--all"]), {
    exitCode: 0, stderr: "", stdout: "Fixture Project | Tracker: Up to date with Linear. | Ready 2 | Shaping 0 | Flying 0 | Landed today 0 | Needs you 0\n",
  });
});

test("an unreadable project doesn't hide other projects or pretend nothing needs you", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("projects.list", async () => ["one", "two"].map((id) => ({
    id: `proj-${id}`, name: id === "one" ? "Fixture" : "Offline", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
  })));
  harness.sdk.stub("threads.list", async (args: { projectId?: string }) => {
    if (args?.projectId === "proj-two") throw new Error("private host error");
    return [];
  });
  assert.deepEqual(await harness.behavior.runCli(["status", "--all"]), {
    exitCode: 1, stderr: "", stdout: "Fixture | Tracker: Up to date with Linear. | Ready 2 | Shaping 0 | Flying 0 | Landed today 0 | Needs you 0\nOffline | Tracker: Couldn't read this project. Make sure its machine is online. | Ready ? | Shaping ? | Flying ? | Landed today ? | Needs you ?\n",
  });
  assert.deepEqual(await harness.behavior.runCli(["needs", "--all"]), {
    exitCode: 1, stderr: "", stdout: "Offline | Setup | Project | Couldn't read this project. Make sure its machine is online. | /plugins/squadron/board\n",
  });
});

test("needs names a waiting merge in owner words and links its PR", async (t) => {
  const spec = workspaceIssues.data.issues.nodes.find((node) => node.identifier === "FIX-5")!;
  const ownerSpec = { ...spec, labels: { ...spec.labels, nodes: [...spec.labels.nodes, { id: "owner", name: "accept:owner", color: "#000000" }] } };
  const { harness } = await setup(t, {
    issues: () => Response.json({ data: { issues: { ...workspaceIssues.data.issues,
      nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-5" ? ownerSpec : node),
    } } }),
    laneSpec: () => Response.json({ data: { issue: { ...ownerSpec, children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
  });
  harness.sdk.stub("projects.list", async () => [{ id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }]);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_1: { outcome: "available", pullRequest: {
    number: 7, state: "open", url: "https://github.com/fixture/repo/pull/7", updatedAt: new Date().toISOString(), checks: { state: "passing" },
  } } }));
  assert.deepEqual(await harness.behavior.runCli(["needs", "--all"]), {
    exitCode: 0, stderr: "", stdout: "Fixture | Merge waiting | FIX-5 | PR #7 passed its checks and waits for your merge. | https://github.com/fixture/repo/pull/7\n",
  });
});

test("status counts Shaping, Flying and only today's landed specs from the board's lane evidence", async (t) => {
  let delivered = false;
  const nodes = workspaceIssues.data.issues.nodes;
  const { harness } = await setup(t, { issues: () => Response.json({ data: { issues: {
    // This case counts a fully delivered lane. Open tickets after landing are
    // returning work, covered separately below, rather than completed delivery.
    ...workspaceIssues.data.issues, nodes: [...nodes.map((node) => node.identifier === "FIX-6" && delivered
      ? { ...node, state: { id: "done", name: "Done", type: "completed" } } : node),
      { ...nodes[4], id: "fix-10", identifier: "FIX-10", parent: { id: "fix-9" } }],
  } } }) });
  harness.sdk.stub("projects.list", async () => [{ id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }]);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  assert.deepEqual(await harness.behavior.runCli(["status", "--all"]), {
    exitCode: 0, stderr: "", stdout: "Fixture | Tracker: Up to date with Linear. | Ready 1 | Shaping 1 | Flying 1 | Landed today 0 | Needs you 0\n",
  });
  delivered = true; // The tracker records completion before the merged PR is observed.
  for (const [updatedAt, count] of [[new Date().toISOString(), 1], [new Date(Date.now() - 86_400_000).toISOString(), 0]] as const) {
    harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_1: { outcome: "available", pullRequest: {
      number: 7, state: "merged", url: "https://github.com/fixture/repo/pull/7", updatedAt, checks: { state: "passing" },
    } } }));
    assert.deepEqual(await harness.behavior.runCli(["status", "--all"]), {
      exitCode: 0, stderr: "", stdout: `Fixture | Tracker: Up to date with Linear. | Ready 1 | Shaping 1 | Flying 0 | Landed today ${count} | Needs you 0\n`,
    });
  }
});

// SQD-279 replaces "status counts a landed spec with remaining open tickets as Ready": a merged PR with an open ticket left
// doesn't land its lane, so status counts it Flying and keeps it out of Ready.
test("status counts a spec whose PR merged with tickets still open as Flying, never Ready or Landed", async (t) => {
  const { harness, native } = await setup(t);
  harness.sdk.stub("projects.list", async () => [{ id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }]);
  await harness.behavior.runCli(["start", "FIX-5"], { projectId: "proj-one" });
  harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_1: { outcome: "available", pullRequest: {
    number: 7, state: "merged", url: "https://github.com/fixture/repo/pull/7", updatedAt: new Date().toISOString(), checks: { state: "passing" },
  } } }));
  assert.deepEqual(await harness.behavior.runCli(["status", "--all"]), {
    exitCode: 0, stderr: "", stdout: "Fixture | Tracker: Up to date with Linear. | Ready 1 | Shaping 0 | Flying 1 | Landed today 0 | Needs you 0\n",
  });
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as import("../lib/board-model.js").Board;
  assert.deepEqual(board.ready.map((spec) => spec.id), ["FIX-1"]);
  assert.deepEqual(board.lanes.map((lane) => [lane.specId, lane.leadThreadId, lane.pr?.number]), [["FIX-5", "thr_lead_1", 7]]);
  assert.notEqual(board.lanes[0].state, "landed");
  assert.ok(native.threads.has("thr_lead_1"));
  assert.equal(native.count, 1);
});

test("failed tracker reads show unknown counts and a Setup item instead of a false empty result", async (t) => {
  const { harness } = await setup(t, { issues: () => new Response("unavailable", { status: 503 }) });
  harness.sdk.stub("projects.list", async () => [{ id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }]);
  const status = await harness.behavior.runCli(["status", "--all"]);
  assert.equal(status.exitCode, 1);
  assert.match(status.stdout, /Fixture \| Tracker: .+ \| Ready \? \| Shaping \? \| Flying 0 \| Landed today 0 \| Needs you 1\n$/);
  const needs = await harness.behavior.runCli(["needs", "--all"]);
  assert.equal(needs.exitCode, 1);
  assert.match(needs.stdout, /^Fixture \| Setup \| Project \| .+ \| \/plugins\/squadron\/board\n$/);
});

test("needs reports a stopped lane and status includes its Needs you count", async (t) => {
  const { harness, native } = await setup(t);
  harness.sdk.stub("projects.list", async () => [{ id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }]);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  native.threads.set("thr_lead_1", { ...native.threads.get("thr_lead_1")!, status: "idle" });
  // An idle Lead with no recorded history at all: nothing was read, so nothing says it ran.
  harness.sdk.stub("threads.events.list", async () => []);
  assert.deepEqual(await harness.behavior.runCli(["needs", "--all"]), {
    exitCode: 0, stderr: "", stdout: "Fixture | Stopped | FIX-5 | The lane stopped. | @thread:thr_lead_1\n",
  });
  assert.deepEqual(await harness.behavior.runCli(["status", "--all"]), {
    exitCode: 0, stderr: "", stdout: "Fixture | Tracker: Up to date with Linear. | Ready 1 | Shaping 0 | Flying 1 | Landed today 0 | Needs you 1\n",
  });
});

test("CLI help, usage errors and an empty install stay short and don't run lane actions", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("projects.list", async () => []);
  const help = await harness.behavior.runCli(["--help"]);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /bb squadron status/);
  assert.match(help.stdout, /bb squadron needs/);
  for (const command of ["helper use", "start", "stop", "resume", "merge"]) {
    assert.ok(help.stdout.includes(`bb squadron ${command}`), `${command} appears in help`);
  }
  assert.deepEqual(await harness.behavior.runCli(["status", "--all"]), { exitCode: 0, stdout: "No projects.\n", stderr: "" });
  for (const args of [["needs", "--project"], ["status", "--unknown"], ["helper", "use"], ["start", "FIX-5"]]) {
    assert.equal((await harness.behavior.runCli(args)).exitCode, 1);
  }
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});


test("start uses the caller's project and shares the board's existing Lead", async (t) => {
  const { harness } = await setup(t);
  const [started, boardStart] = await Promise.all([
    harness.behavior.runCli(["start", "FIX-5"], { projectId: "proj-one" }),
    harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" }),
  ]);
  assert.deepEqual(started, { exitCode: 0, stderr: "", stdout: "Started FIX-5. @thread:thr_lead_1\n" });
  assert.deepEqual(boardStart, { threadId: "thr_lead_1" });
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
});


test("stop and resume send the board's fixed messages, while RPC caller restrictions remain", async (t) => {
  const { harness } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
  for (const action of ["stop", "resume"] as const) {
    assert.equal((await harness.behavior.runCli([action, "FIX-5"], { projectId: "proj-one" })).exitCode, 0);
    const cliSend = harness.inspection.sdk.callsTo("threads.send").at(-1);
    await harness.behavior.callRpc(`lane.${action}`, { projectId: "proj-one", specId: "FIX-5" });
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.send").at(-1), cliSend);
  }
  const before = harness.inspection.sdk.callsTo("threads.send").length;
  for (const action of ["start", "stop", "resume", "merge"]) {
    await assert.rejects(harness.behavior.callRpc(`lane.${action}`, { projectId: "proj-one", specId: "FIX-5" },
      { experimental_caller: { kind: "plugin", pluginId: "other" } }), /from the Squadron board/);
  }
  assert.equal(harness.inspection.sdk.callsTo("threads.send").length, before);
});


test("merge uses the board's PR path and refuses missing, pending, failing and closed PRs", async (t) => {
  const { harness } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  let pr: { number: number; state: string; checks: { state: string } } | undefined;
  harness.sdk.stub("plugins.callRpc", async (args: { method: string }) => args.method === "merge"
    ? { message: "Merged." } : pr ? { env_lead_1: { outcome: "available", pullRequest: pr } } : {});
  const run = () => harness.behavior.runCli(["merge", "FIX-5"], { projectId: "proj-one" });
  const cases = [
    [undefined, "FIX-5 has no pull request to merge yet."],
    [{ number: 7, state: "open", checks: { state: "no_checks" } }, "PR #7 can merge once its checks pass."],
    [{ number: 7, state: "open", checks: { state: "pending" } }, "PR #7 can merge once its checks pass."],
    [{ number: 7, state: "open", checks: { state: "failing" } }, "PR #7 can merge once its checks pass."],
    [{ number: 7, state: "closed", checks: { state: "passing" } }, "PR #7 is closed, not open."],
    [{ number: 7, state: "merged", checks: { state: "passing" } }, "PR #7 is merged, not open."],
  ] as const;
  for (const [row, reason] of cases) {
    pr = row;
    assert.deepEqual(await run(), { exitCode: 1, stdout: "", stderr: `${reason}\n` });
    await assert.rejects(harness.behavior.callRpc("lane.merge", { projectId: "proj-one", specId: "FIX-5" }), { message: reason });
  }
  assert.equal(harness.inspection.sdk.callsTo("plugins.callRpc").filter(([args]) => (args as { method: string }).method === "merge").length, 0);
  pr = { number: 7, state: "open", checks: { state: "passing" } };
  assert.deepEqual(await run(), { exitCode: 0, stdout: "Squash-merged PR #7 for FIX-5.\n", stderr: "" });
  const merges = harness.inspection.sdk.callsTo("plugins.callRpc").filter(([args]) => (args as { method: string }).method === "merge");
  assert.equal(merges.length, 1);
  assert.deepEqual((merges[0][0] as { input: unknown }).input, { environmentId: "env_lead_1", method: "squash" });
});


test("actions select explicit or caller projects and refuse ambiguity without effects", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("projects.list", async () => [
    { id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 },
    { id: "proj-two", name: "Shared", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 },
    { id: "proj-three", name: "Shared", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 },
  ]);
  for (const action of ["start", "stop", "resume", "merge"]) {
    for (const [args, reason] of [
      [[action, "FIX-5"], "Choose a project with --project."],
      [[action, "FIX-5", "--project", "Shared"], 'More than one project matches "Shared". Use its project ID.'],
      [[action, "FIX-5", "--project", "Missing"], 'No project matches "Missing".'],
    ] as const) {
      assert.deepEqual(await harness.behavior.runCli([...args]), { exitCode: 1, stdout: "", stderr: `${reason}\n` });
    }
    assert.equal((await harness.behavior.runCli([action, "FIX-5", "--owner-approved"], { projectId: "proj-one" })).exitCode, 1);
  }
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  assert.equal(harness.inspection.sdk.callsTo("threads.send").length, 0);
  assert.equal((await harness.behavior.runCli(["start", "FIX-5", "--project", "Fixture"], { projectId: "proj-two" })).exitCode, 0);
  assert.equal((harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { projectId: string }).projectId, "proj-one");
});

test("CLI Start prints the board's refusal and never spawns for an unready spec", async (t) => {
  const { harness } = await setup(t);
  const reason = "FIX-9 isn't a ready spec in this project's tracker. Read the board again.";
  assert.deepEqual(await harness.behavior.runCli(["start", "FIX-9"], { projectId: "proj-one" }),
    { exitCode: 1, stdout: "", stderr: `${reason}\n` });
  await assert.rejects(harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-9" }), { message: reason });
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});


test("CLI Start keeps Doctor's board refusal and single-project actions need no project flag", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("projects.list", async () => [{ id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }]);
  harness.sdk.stub("skills.list", async () => ({ skills: [] }));
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as import("../lib/board-model.js").Board;
  const reason = board.ready.find((spec) => spec.id === "FIX-5")!.startReason;
  assert.ok(reason);
  assert.deepEqual(await harness.behavior.runCli(["start", "FIX-5"]), { exitCode: 1, stdout: "", stderr: `${reason}\n` });
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});


test("remote CLI and board Merge refuse a Done spec even with an open passing PR", async (t) => {
  const spec = workspaceIssues.data.issues.nodes.find((node) => node.identifier === "FIX-5")!;
  const done = { ...spec, state: { id: "done", name: "Done", type: "completed" } };
  const { harness, native } = await setup(t, { laneSpec: () => Response.json({ data: { issue: { ...done,
    children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }), issues: () => Response.json({ data: { issues: {
    ...workspaceIssues.data.issues,
    nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-5"
      ? { ...node, state: { id: "done", name: "Done", type: "completed" } } : node),
  } } }) });
  native.threads.set("thr_lead_1", makeThreadResponse({ id: "thr_lead_1", projectId: "proj-one",
    providerId: "codex", environmentId: "env_lead_1", status: "active" }));
  native.metadata.set("thr_lead_1", { role: "lead", specId: spec.id });
  native.routes.set("thr_lead_1", { model: "gpt-6.1-sol", reasoningLevel: "medium" });
  harness.sdk.stub("plugins.callRpc", async (args: { method: string }) => args.method === "merge"
    ? { message: "Merged." } : { env_lead_1: { outcome: "available", pullRequest: {
      number: 7, state: "open", checks: { state: "passing" }, updatedAt: "2026-11-14T12:00:00Z",
      url: "https://github.com/fixture/repo/pull/7",
    } } });
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one", visibleLaneIds: [] }) as import("../lib/board-model.js").Board;
  assert.equal(board.lanes.find((lane) => lane.specId === "FIX-5")?.state, "landed");
  assert.deepEqual(await harness.behavior.runCli(["merge", "FIX-5"], { projectId: "proj-one" }), {
    exitCode: 1, stdout: "", stderr: "FIX-5 has already landed. Read the board again.\n",
  });
  await assert.rejects(harness.behavior.callRpc("lane.merge", { projectId: "proj-one", specId: "FIX-5" }),
    { message: "FIX-5 has already landed. Read the board again." });
  assert.equal(harness.inspection.sdk.callsTo("plugins.callRpc").filter(([args]) => (args as { method: string }).method === "merge").length, 0);
});
