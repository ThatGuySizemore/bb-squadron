import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, mock, type TestContext } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createDoctorHost } from "../host.js";
import plugin from "../server.js";
import type { Board } from "../lib/board-model.js";
import { canMerge } from "../lib/board-model.js";

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function fixture(t: TestContext, kind: "local-markdown" | "github" = "local-markdown") {
  const root = await mkdtemp(join(tmpdir(), "squadron-lanes-"));
  await mkdir(join(root, ".scratch/flight/issues"), { recursive: true });
  await mkdir(join(root, "docs/agents"), { recursive: true });
  await writeFile(join(root, ".scratch/flight/spec.md"), "# Spec: Flight\nStatus: ready-for-agent\n");
  await writeFile(join(root, ".scratch/flight/issues/01-reader.md"), "# 01: Reader\n**Status:** ready-for-agent\n");
  await writeFile(join(root, "docs/agents/issue-tracker.md"), kind === "github" ? "# Issue tracker: GitHub\nUse gh issue.\n" : "# Issue tracker: Local Markdown\nIssues live in `.scratch/`.\n");
  const settings = (await readFile("tests/fixtures/squadron.md", "utf8")).split("## Status mapping")[0];
  await writeFile(join(root, "docs/agents/squadron.md"), settings);
  git(root, "init", "-b", "main");
  let commitTime = Date.parse("2026-01-01T00:00:00Z");
  const commit = (message: string) => {
    git(root, "add", ".");
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", message],
      { env: { ...process.env, GIT_AUTHOR_DATE: new Date(commitTime).toISOString(), GIT_COMMITTER_DATE: new Date(commitTime).toISOString() }, stdio: "pipe" });
    commitTime += 10_000;
  };
  commit("Initial fixture");
  if (kind === "github") git(root, "remote", "add", "origin", "https://github.example/fixture/repo.git");
  const pages = await readFile("tests/fixtures/github/native.json", "utf8");
  const host = experimental_createHostEntryHarness(createDoctorHost(undefined, undefined, async (_command, args) => {
    if (kind !== "github") throw new Error("A no-remote local lane must not need gh");
    if (args[0] === "repo") return { code: 0, stdout: JSON.stringify({ nameWithOwner: "fixture/repo", url: "https://github.example/fixture/repo" }) };
    if (args[0] === "auth") return { code: 0, stdout: "" };
    assert.equal(args[0], "api");
    return { code: 0, stdout: pages };
  }));
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", experimental_hostEntry: true, sdk: {
    projects: { list: async () => [{ id: "project", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }],
      get: async () => ({ id: "project", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
      sources: [{ id: "source", projectId: "project", hostId: "repo-host", path: root, isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
    files: { read: async ({ path }) => ({ path, content: await readFile(path, "utf8"), contentEncoding: "utf8", sha256: "fixture", sizeBytes: 0 }) },
    skills: { list: async () => ({ skills: ["codex", "claude-code"].flatMap((provider) =>
      ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"].map((name) => ({
        id: `${provider}-${name}`, name: `mattpocock-skills:${name}`, description: null,
        filePath: `/plugins/${provider}/${name}/SKILL.md`, manageable: false, pluginId: "mattpocock-skills", provider,
        registrySkillId: null, scope: "plugin" as const,
      }))) }) },
    threads: {
      list: async (args) => [...threads.values()].filter((thread) => !args?.parentThreadId || thread.parentThreadId === args.parentThreadId)
        .map((thread) => ({ ...thread, environmentBranchName: "integration/flight" })),
      getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
      defaultExecutionOptions: async () => ({ model: "gpt-6.1-sol", reasoningLevel: "high", permissionMode: "auto", serviceTier: "default", source: "client/turn/start" }),
      spawn: async (args) => {
        const thread = makeThreadResponse({ id: "lead", projectId: args.projectId, providerId: args.providerId, environmentId: "environment", status: "active",
          createdAt: Date.parse("2026-01-01T00:00:01Z") });
        threads.set(thread.id, thread); metadata.set(thread.id, args.pluginMetadata ?? {});
        return thread;
      },
    },
  }, experimental_callHostRpc: async ({ method, input, hostId }) => {
    assert.equal(hostId, "repo-host");
    if (method === "inspectFiles") return { homePath: "/owner", repoRulesExists: true, playbookExists: false, machineProfileExists: false,
      setupFiles: ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"],
      regularSkillFiles: (input as { skillPaths: string[] }).skillPaths };
    return host.experimental_call(method as "githubRead", input as { checkoutPath: string; bbProjectId: string });
  } });
  t.after(async () => { await harness.lifecycle.dispose(); await host.experimental_dispose(); });
  await plugin(bb);
  return { root, commit, harness, threads, metadata,
    board: async () => await harness.behavior.callRpc("board", { projectId: "project" }) as Board };
}

test("a new no-remote branch at main stays Flying until it carries lane work that main contains", async (t) => {
  const { root, commit, harness, board } = await fixture(t);
  git(root, "branch", "integration/flight");
  await harness.behavior.callRpc("lane.start", { projectId: "project", specId: "flight" });
  assert.equal((await board()).lanes[0]?.state, "flying", "a branch cut at main is no landing evidence");
  git(root, "checkout", "integration/flight");
  await writeFile(join(root, "implementation.md"), "Lane work\n");
  commit("Lane implementation");
  git(root, "checkout", "main");
  assert.equal((await board()).lanes[0]?.state, "flying", "unmerged work is still Flying");
  git(root, "merge", "--ff-only", "integration/flight");
  assert.equal((await board()).lanes[0]?.state, "landed", "fast-forwarding actual lane work still lands");
});

test("Start in a no-remote local tracker spawns a Lead with its tracker instructions and needs no GitHub login", async (t) => {
  const { harness, board } = await fixture(t);
  assert.equal((await board()).ready[0]?.startReason, null);
  assert.deepEqual(await harness.behavior.callRpc("lane.start", { projectId: "project", specId: "flight" }), { threadId: "lead" });
  const seed = harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { prompt: string };
  assert.match(seed.prompt, /docs\/agents\/issue-tracker\.md/);
  assert.match(seed.prompt, /update.*tickets/i);
  assert.equal((await board()).lanes[0]?.state, "flying");
});

test("Start in GitHub uses the recorded reader and seeds the Lead with the repo's tracker instructions", async (t) => {
  const { harness, board } = await fixture(t, "github");
  assert.deepEqual(await harness.behavior.callRpc("lane.start", { projectId: "project", specId: "#1" }), { threadId: "lead" });
  const seed = harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { prompt: string; pluginMetadata: unknown };
  assert.match(seed.prompt, /Spec: https:\/\/github.example\/fixture\/repo\/issues\/1/);
  assert.match(seed.prompt, /docs\/agents\/issue-tracker\.md/);
  assert.deepEqual(seed.pluginMetadata, { role: "lead", specId: "I_1", startedBy: "owner" });
  assert.deepEqual((await board()).lanes[0]?.tickets.map(({ id, state }) => [id, state]).sort((a, b) => a[0].localeCompare(b[0])),
    [["#2", "working"], ["#3", "done"], ["#4", "working"], ["#5", "blocked"]]);
});

test("a Flying local lane reads committed branch Status lines while main remains the state of record", async (t) => {
  const { root, commit, harness, board } = await fixture(t);
  git(root, "checkout", "-b", "integration/flight");
  await writeFile(join(root, ".scratch/flight/issues/01-reader.md"), "# 01: Reader\n**Status:** resolved\n");
  await writeFile(join(root, ".scratch/flight/issues/02-follow-up.md"), "# 02: Follow up\nStatus: claimed\nBlocked by: 01\n");
  commit("Progress unrelated to status words");
  git(root, "checkout", "main");
  await harness.behavior.callRpc("lane.start", { projectId: "project", specId: "flight" });
  assert.deepEqual((await board()).lanes[0]?.tickets.map(({ id, state, blockedBy }) => [id, state, blockedBy]),
    [["flight/01", "branch", []], ["flight/02", "working", ["flight/01"]]]);
  assert.match(await readFile(join(root, ".scratch/flight/issues/01-reader.md"), "utf8"), /ready-for-agent/);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(git(root, "branch", "--show-current"), "main");
});

test("no-remote Merge messages the Lead with a fixed order, and actual ancestry lands the lane", async (t) => {
  const { root, commit, harness, board } = await fixture(t);
  git(root, "checkout", "-b", "integration/flight");
  await writeFile(join(root, ".scratch/flight/issues/01-reader.md"), "# 01: Reader\nStatus: done\n");
  commit("Fixture progress");
  git(root, "checkout", "main");
  await harness.behavior.callRpc("lane.start", { projectId: "project", specId: "flight" });
  const flying = (await board()).lanes[0];
  assert.equal(flying.state, "flying");
  assert.equal(canMerge(flying), true, "the board offers local Merge after its tickets reach the branch");
  const sent: unknown[] = [];
  harness.sdk.stub("threads.send", async (input) => {
    sent.push(input);
    return { ok: true, delivery: "sent" } as Awaited<ReturnType<import("@get-bb/plugin-sdk").BbPluginApi["sdk"]["threads"]["send"]>>;
  });
  harness.sdk.stub("plugins.callRpc", async () => { throw new Error("A local Merge must not call GitHub"); });
  const before = git(root, "show-ref");
  assert.deepEqual(await harness.behavior.callRpc("lane.merge", { projectId: "project", specId: "flight" }), { threadId: "lead" });
  assert.deepEqual(sent, [{ threadId: "lead", mode: "queue-if-active", input: [{ type: "text", mentions: [], text:
    "The owner pressed Merge on this no-remote lane. Follow the repo rules, quick check and final review requirements, then merge the integration branch into main locally. Update the spec and its tickets as docs/agents/issue-tracker.md describes and report the result."
  }] }]);
  assert.equal(git(root, "show-ref"), before, "the plugin only sends the order, leaving Git refs unchanged");
  assert.equal((await board()).lanes[0].state, "flying", "sending an order is not evidence of landing");
  await assert.rejects(harness.behavior.callRpc("lane.merge", { projectId: "project", specId: "flight" },
    { experimental_caller: { kind: "plugin", pluginId: "other" } }), /from the Squadron board/);
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "merge", "--no-ff", "integration/flight", "-m", "Merge lane fixture");
  const landed = (await board()).lanes[0];
  assert.equal(landed.state, "landed");
  assert.equal(landed.tickets[0]?.state, "done");
  assert.equal(canMerge(landed), false);
  const counts = await harness.behavior.callRpc("board.projectCounts", null) as { projects: { flying: number }[] };
  assert.equal(counts.projects[0].flying, 0, "the picker agrees that the local lane landed");
});

test("a no-remote spec marked done on main lands even without its ready label or a surviving branch", async (t) => {
  const { root, commit, threads, metadata, board } = await fixture(t);
  await writeFile(join(root, ".scratch/flight/spec.md"), "# Spec: Flight\n**Status:** closed\n");
  await writeFile(join(root, ".scratch/flight/issues/01-reader.md"), "# 01: Reader\nStatus: done\n");
  commit("Completion fixture");
  threads.set("lead", makeThreadResponse({ id: "lead", projectId: "project", providerId: "codex", environmentId: "environment", status: "idle" }));
  metadata.set("lead", { role: "lead", specId: ".scratch/flight/spec.md" });
  const landed = (await board()).lanes[0];
  assert.equal(landed.state, "landed");
  assert.equal(landed.tickets[0]?.state, "done");
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const html = renderToStaticMarkup(createElement(BoardView, { board: await board(), demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined }));
  assert.match(html, /Lane landed/);
  assert.doesNotMatch(html, /integration\/flight merged/, "a completed spec does not prove a branch merge");
  assert.match(html, /title="Open the issue"/);
  assert.doesNotMatch(html, /Open in Linear/);
});

test("stale Status lines stay Waiting despite a branch commit claiming completion", async (t) => {
  const { root, commit, harness, board } = await fixture(t);
  git(root, "checkout", "-b", "integration/flight");
  await writeFile(join(root, "work.md"), "Fixture implementation\n");
  commit("Merge completed ticket 01, done");
  git(root, "checkout", "main");
  await harness.behavior.callRpc("lane.start", { projectId: "project", specId: "flight" });
  assert.equal((await board()).lanes[0]?.tickets[0]?.state, "blocked");
});

test("returning local work reads the new lane branch and leaves the landed branch and workers attributable to the old Lead", async (t) => {
  let clock = Date.now();
  const now = mock.method(Date, "now", () => clock);
  t.after(() => now.mock.restore());
  const { root, commit, harness, threads, metadata, board } = await fixture(t);
  git(root, "checkout", "-b", "integration/flight");
  await writeFile(join(root, ".scratch/flight/issues/01-reader.md"), "# 01: Reader\nStatus: hold\n");
  commit("Deliver first lane with held work");
  git(root, "checkout", "main");
  await harness.behavior.callRpc("lane.start", { projectId: "project", specId: "flight" });
  git(root, "merge", "--ff-only", "integration/flight");
  threads.set("lead", { ...threads.get("lead")!, status: "idle" });
  const oldTip = git(root, "rev-parse", "integration/flight");
  clock += 31_000; // Let the tracker's public read cache expire.
  assert.equal((await board()).lanes[0].state, "landed");
  assert.equal((await board()).ready.length, 0);
  await writeFile(join(root, ".scratch/flight/issues/01-reader.md"), "# 01: Reader\nStatus: ready-for-agent\n");
  commit("Un-hold remaining work");
  clock += 31_000;
  assert.equal((await board()).ready[0]?.id, "flight");
  git(root, "branch", "integration/flight-return");
  harness.sdk.stub("threads.spawn", async (args: { providerId?: string; pluginMetadata?: Record<string, unknown> }) => {
    const next = makeThreadResponse({ id: "return-lead", projectId: "project", providerId: args.providerId,
      environmentId: "return-environment", status: "active", createdAt: Date.parse("2026-01-01T00:01:00Z") });
    threads.set(next.id, next); metadata.set(next.id, args.pluginMetadata ?? {});
    return next;
  });
  // The newer Lead precedes the older one in BB's response.
  harness.sdk.stub("threads.list", async () => [...threads.values()].reverse().map((thread) => ({ ...thread,
    environmentBranchName: thread.id === "lead" ? "integration/flight" : "integration/flight-return",
  })));
  assert.deepEqual(await harness.behavior.callRpc("lane.start", { projectId: "project", specId: "flight" }), { threadId: "return-lead" });
  const returned = (await board()).lanes[0];
  assert.deepEqual([returned.leadThreadId, returned.branch, returned.state], ["return-lead", "integration/flight-return", "flying"]);
  assert.deepEqual(returned.tickets.map(({ id, state }) => [id, state]), [["flight/01", "blocked"]]);
  assert.equal(git(root, "rev-parse", "integration/flight"), oldTip, "the landed branch stays intact");
  assert.ok(threads.has("lead"));
  assert.equal(metadata.get("lead")?.specId, ".scratch/flight/spec.md");
});


test("CLI local Merge follows board availability before completion, when ready and after landing", async (t) => {
  const { root, commit, harness, board } = await fixture(t);
  git(root, "branch", "integration/flight");
  await harness.behavior.runCli(["start", "flight"], { projectId: "project" });
  const sent: unknown[] = [];
  harness.sdk.stub("threads.send", async (input) => { sent.push(input); return { ok: true, delivery: "sent" }; });
  const merge = () => harness.behavior.runCli(["merge", "flight"], { projectId: "project" });
  assert.equal(canMerge((await board()).lanes[0]), false);
  assert.deepEqual(await merge(), { exitCode: 1, stdout: "", stderr: "flight isn't ready for a local merge. Read the board again.\n" });
  assert.deepEqual(sent, []);
  await assert.rejects(harness.behavior.callRpc("lane.merge", { projectId: "project", specId: "flight" }),
    { message: "flight isn't ready for a local merge. Read the board again." });
  git(root, "checkout", "integration/flight");
  await writeFile(join(root, ".scratch/flight/issues/01-reader.md"), "# 01: Reader\nStatus: done\n");
  commit("Ticket in branch");
  git(root, "checkout", "main");
  assert.equal(canMerge((await board()).lanes[0]), true);
  assert.deepEqual(await merge(), { exitCode: 0, stdout: "Asked the Lead for flight to merge locally. @thread:lead\n", stderr: "" });
  assert.equal(sent.length, 1);
  git(root, "merge", "--ff-only", "integration/flight");
  assert.equal((await board()).lanes[0].state, "landed");
  assert.equal((await merge()).exitCode, 1);
  assert.equal(sent.length, 1);
});
