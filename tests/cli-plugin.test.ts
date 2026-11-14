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
    experimental_callHostRpc: async ({ method, input }) => method === "githubLogin" ? { authenticated: true } : {
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

test("status lists every project with short owner-visible counts, even from a project thread", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("projects.list", async () => ["one", "two"].map((id) => ({
    id: `proj-${id}`, name: id === "one" ? "Fixture" : "Second", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
  })));
  assert.deepEqual(await harness.behavior.runCli(["status"], { projectId: "proj-one" }), {
    exitCode: 0, stderr: "", stdout: "Fixture | Tracker: Up to date with Linear. | Ready 2 | Shaping 0 | Flying 0 | Landed today 0 | Needs you 0\nSecond | Tracker: Up to date with Linear. | Ready 2 | Shaping 0 | Flying 0 | Landed today 0 | Needs you 0\n",
  });
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
    assert.deepEqual(await harness.behavior.runCli(["status", "--project", project]), { exitCode: 0, stdout: expected, stderr: "" });
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
  for (const args of [["needs"], ["needs", "--project", "Fixture"]]) {
    assert.deepEqual(await harness.behavior.runCli(args), { exitCode: 0, stdout: "Nothing needs you.\n", stderr: "" });
  }
});

test("needs lists each project's open questions with the spec, short text and thread link", async (t) => {
  const { harness, native } = await setup(t);
  harness.sdk.stub("projects.list", async () => ["one", "two"].map((id) => ({
    id: `proj-${id}`, name: id === "one" ? "Fixture" : "Second", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
  })));
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  harness.sdk.stub("threads.list", async (args: { parentThreadId?: string }) => [...native.threads.values()]
    .filter((thread) => !args?.parentThreadId || thread.parentThreadId === args.parentThreadId)
    .map((thread) => ({ ...thread, hasPendingInteraction: true, environmentBranchName: "spec/fix-5" })));
  assert.deepEqual(await harness.behavior.runCli(["needs"]), {
    exitCode: 0, stderr: "", stdout: "Fixture | Question | FIX-5 | The Lead for FIX-5 is waiting on you. | @thread:thr_lead_1\n",
  });
  assert.deepEqual(await harness.behavior.runCli(["needs", "--project", "Second"]), {
    exitCode: 0, stderr: "", stdout: "Nothing needs you.\n",
  });
});

test("CLI output keeps project names on one line", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("projects.list", async () => [{ id: "proj-one", name: "Fixture\nProject", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }]);
  assert.deepEqual(await harness.behavior.runCli(["status"]), {
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
  assert.deepEqual(await harness.behavior.runCli(["status"]), {
    exitCode: 1, stderr: "", stdout: "Fixture | Tracker: Up to date with Linear. | Ready 2 | Shaping 0 | Flying 0 | Landed today 0 | Needs you 0\nOffline | Tracker: Couldn't read this project. Make sure its machine is online. | Ready ? | Shaping ? | Flying ? | Landed today ? | Needs you ?\n",
  });
  assert.deepEqual(await harness.behavior.runCli(["needs"]), {
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
  assert.deepEqual(await harness.behavior.runCli(["needs"]), {
    exitCode: 0, stderr: "", stdout: "Fixture | Merge waiting | FIX-5 | PR #7 passed its checks and waits for your merge. | https://github.com/fixture/repo/pull/7\n",
  });
});

test("status counts Shaping, Flying and only today's landed specs from the board's lane evidence", async (t) => {
  const nodes = workspaceIssues.data.issues.nodes;
  const { harness } = await setup(t, { issues: () => Response.json({ data: { issues: {
    ...workspaceIssues.data.issues, nodes: [...nodes, { ...nodes[4], id: "fix-10", identifier: "FIX-10", parent: { id: "fix-9" } }],
  } } }) });
  harness.sdk.stub("projects.list", async () => [{ id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }]);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  assert.deepEqual(await harness.behavior.runCli(["status"]), {
    exitCode: 0, stderr: "", stdout: "Fixture | Tracker: Up to date with Linear. | Ready 1 | Shaping 1 | Flying 1 | Landed today 0 | Needs you 0\n",
  });
  for (const [updatedAt, count] of [[new Date().toISOString(), 1], [new Date(Date.now() - 86_400_000).toISOString(), 0]] as const) {
    harness.sdk.stub("plugins.callRpc", async () => ({ env_lead_1: { outcome: "available", pullRequest: {
      number: 7, state: "merged", url: "https://github.com/fixture/repo/pull/7", updatedAt, checks: { state: "passing" },
    } } }));
    assert.deepEqual(await harness.behavior.runCli(["status"]), {
      exitCode: 0, stderr: "", stdout: `Fixture | Tracker: Up to date with Linear. | Ready 1 | Shaping 1 | Flying 0 | Landed today ${count} | Needs you 0\n`,
    });
  }
});

test("failed tracker reads show unknown counts and a Setup item instead of a false empty result", async (t) => {
  const { harness } = await setup(t, { issues: () => new Response("unavailable", { status: 503 }) });
  harness.sdk.stub("projects.list", async () => [{ id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }]);
  const status = await harness.behavior.runCli(["status"]);
  assert.equal(status.exitCode, 1);
  assert.match(status.stdout, /Fixture \| Tracker: .+ \| Ready \? \| Shaping \? \| Flying 0 \| Landed today 0 \| Needs you 1\n$/);
  const needs = await harness.behavior.runCli(["needs"]);
  assert.equal(needs.exitCode, 1);
  assert.match(needs.stdout, /^Fixture \| Setup \| Project \| .+ \| \/plugins\/squadron\/board\n$/);
});

test("needs reports a stopped lane and status includes its Needs you count", async (t) => {
  const { harness, native } = await setup(t);
  harness.sdk.stub("projects.list", async () => [{ id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }]);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  native.threads.set("thr_lead_1", { ...native.threads.get("thr_lead_1")!, status: "idle" });
  assert.deepEqual(await harness.behavior.runCli(["needs"]), {
    exitCode: 0, stderr: "", stdout: "Fixture | Stopped | FIX-5 | The lane stopped. | @thread:thr_lead_1\n",
  });
  assert.deepEqual(await harness.behavior.runCli(["status"]), {
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
  assert.match(help.stdout, /bb squadron helper use/);
  assert.doesNotMatch(help.stdout, /bb squadron (start|stop|resume|merge)/);
  assert.deepEqual(await harness.behavior.runCli(["status"]), { exitCode: 0, stdout: "No projects.\n", stderr: "" });
  for (const args of [["needs", "--project"], ["status", "--unknown"], ["helper", "use"], ["start", "FIX-5"]]) {
    assert.equal((await harness.behavior.runCli(args)).exitCode, 1);
  }
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});
