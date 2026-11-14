// SIZE-957: lanes started outside Squadron show on the board, read-only.
// The fixture is shaped like bb-bot: a hand-started thread that names its local
// markdown spec, and a no-remote integration branch whose Status lines differ from main.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createDoctorHost } from "../host.js";
import plugin from "../server.js";
import { canMerge, needsYou, type Board } from "../lib/board-model.js";

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** bb-bot's first message, trimmed to what names the spec and its integration branch. */
const BB_BOT_SEED = [
  "/mattpocock-skills:implement-spec", "", "Implement the whole bb Bot spec in this repo.", "",
  "- Spec: `.scratch/bb-bot/spec.md`", "- Tickets: `.scratch/bb-bot/issues/`",
  "- Tracker and label rules: `AGENTS.md` and `docs/agents/`",
  "- Git only. No GitHub remote, no PR. Integration branch: `integration/bb-bot`, based on `main`.",
].join("\n");

type Row = ReturnType<typeof makeThreadResponse> & { environmentBranchName: string | null; firstMessage: string };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "squadron-outside-"));
  await mkdir(join(root, ".scratch/bb-bot/issues"), { recursive: true });
  await mkdir(join(root, "docs/agents"), { recursive: true });
  await writeFile(join(root, ".scratch/bb-bot/spec.md"), "# Spec: bb Bot\n\nStatus: ready-for-agent\n");
  await writeFile(join(root, ".scratch/bb-bot/issues/01-walking-skeleton.md"), "# 01: Walking skeleton\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n");
  await writeFile(join(root, ".scratch/bb-bot/issues/02-personality-context.md"), "# 02: Personality context\n\n**Blocked by:** 01\n\n**Status:** ready-for-agent\n");
  await writeFile(join(root, ".scratch/bb-bot/issues/03-conversational-setup.md"), "# 03: Conversational setup\n\n**Blocked by:** 02\n\n**Status:** ready-for-agent\n");
  await writeFile(join(root, "docs/agents/issue-tracker.md"), "# Issue tracker: Local Markdown\nIssues live in `.scratch/`.\n");
  await writeFile(join(root, "docs/agents/squadron.md"), (await readFile("tests/fixtures/squadron.md", "utf8")).split("## Status mapping")[0]);
  git(root, "init", "-b", "main");
  const commit = (message: string) => {
    git(root, "add", ".");
    git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", message);
  };
  commit("Initial fixture");
  // The integration branch moves ahead of main; the thread's own worktree branch stays at main.
  git(root, "branch", "bb/implement-bb-bot-spec-thr_bbbot");
  git(root, "checkout", "-b", "integration/bb-bot");
  await writeFile(join(root, ".scratch/bb-bot/issues/01-walking-skeleton.md"), "# 01: Walking skeleton\n\n**Blocked by:** None\n\n**Status:** done\n");
  await writeFile(join(root, ".scratch/bb-bot/issues/02-personality-context.md"), "# 02: Personality context\n\n**Blocked by:** 01\n\n**Status:** in-progress\n");
  commit("Merge ticket 01: walking skeleton");
  git(root, "checkout", "main");

  const host = experimental_createHostEntryHarness(createDoctorHost(undefined, undefined, async () => {
    throw new Error("A no-remote local project must not need gh");
  }));
  const threads = new Map<string, Row>();
  const metadata = new Map<string, Record<string, unknown>>();
  const add = (overrides: Partial<Row> & { id: string; firstMessage: string }) => {
    const row = { ...makeThreadResponse({ projectId: "project", providerId: "claude-code", status: "active", createdAt: 1_000, ...overrides }),
      environmentBranchName: null, ...overrides } as Row;
    threads.set(row.id, row);
    return row;
  };
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", experimental_hostEntry: true, sdk: {
    projects: { list: async () => [{ id: "project", name: "bb-bot", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }],
      get: async () => ({ id: "project", name: "bb-bot", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId: "project", hostId: "repo-host", path: root, isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
    files: { read: async ({ path }) => ({ path, content: await readFile(path, "utf8"), contentEncoding: "utf8", sha256: "fixture", sizeBytes: 0 }) },
    skills: { list: async () => ({ skills: ["codex", "claude-code"].flatMap((provider) =>
      ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"].map((name) => ({
        id: `${provider}-${name}`, name: `mattpocock-skills:${name}`, description: null,
        filePath: `/plugins/${provider}/${name}/SKILL.md`, manageable: false, pluginId: "mattpocock-skills", provider,
        registrySkillId: null, scope: "plugin" as const,
      }))) }) },
    threads: {
      list: async (args) => [...threads.values()].filter((thread) =>
        (!args?.projectId || thread.projectId === args.projectId) &&
        (args?.parentThreadId === undefined || thread.parentThreadId === args.parentThreadId) &&
        (args?.originPluginId === undefined || thread.originPluginId === args.originPluginId) &&
        (args?.archived !== false || thread.archivedAt === null))
        .map(({ firstMessage: _, ...thread }) => thread),
      getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
      defaultExecutionOptions: async () => ({ model: "claude-opus-5-5", reasoningLevel: "high", permissionMode: "auto", serviceTier: "default", source: "client/turn/start" }),
      events: {
        list: async ({ threadId, types }) => {
          const thread = threads.get(threadId);
          if (!thread || (types && !types.includes("client/turn/requested"))) return [];
          return [{ id: `evt_${threadId}`, scope: { kind: "thread" }, threadId, seq: 1, createdAt: thread.createdAt, type: "client/turn/requested",
            data: { direction: "outbound", requestId: "creq", source: "spawn", initiator: "user", senderThreadId: null,
              input: [{ type: "text", text: thread.firstMessage, mentions: [] }], target: { kind: "thread-start" } } }] as never;
        },
      },
      send: async () => { throw new Error("Squadron never steers a thread it didn't start"); },
    },
  }, experimental_callHostRpc: async ({ method, input, hostId }) => {
    assert.equal(hostId, "repo-host");
    if (method === "inspectFiles") return { homePath: "/owner", repoRulesExists: true, playbookExists: false, machineProfileExists: false,
      setupFiles: ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"],
      regularSkillFiles: (input as { skillPaths: string[] }).skillPaths };
    return host.experimental_call(method as "readLocalMarkdown", input as { checkoutPath: string; bbProjectId: string; projectName: string });
  } });
  t.after(async () => { await harness.lifecycle.dispose(); await host.experimental_dispose(); });
  await plugin(bb);
  return { root, harness, threads, metadata, add,
    board: async () => await harness.behavior.callRpc("board", { projectId: "project" }) as Board };
}

test("a hand-started thread naming a local spec flies as an outside lane with ticket states from its integration branch", async (t) => {
  const { root, add, board } = await fixture(t);
  add({ id: "thr_bbbot", title: "Implement bb Bot spec", firstMessage: BB_BOT_SEED, environmentBranchName: "bb/implement-bb-bot-spec-thr_bbbot" });
  add({ id: "thr_bbbot_worker", title: "Ticket 02 worker", parentThreadId: "thr_bbbot", createdAt: 2_000,
    firstMessage: "Build ticket 02 of `.scratch/bb-bot/spec.md` on `integration/bb-bot`." });
  const result = await board();
  assert.deepEqual(result.ready, [], "the spec isn't offered for Start while a lane flies it");
  assert.equal(result.lanes.length, 1, "the worker under the lane's thread is part of that lane, not a second one");
  const lane = result.lanes[0];
  assert.equal(lane.outside, true);
  assert.equal(lane.leadThreadId, "thr_bbbot");
  assert.equal(lane.branch, "integration/bb-bot");
  assert.equal(lane.state, "flying");
  assert.deepEqual(lane.tickets.map(({ id, state }) => [id, state]),
    [["bb-bot/01", "branch"], ["bb-bot/02", "working"], ["bb-bot/03", "blocked"]]);
  assert.equal(git(root, "branch", "--show-current"), "main");
  assert.equal(git(root, "status", "--porcelain"), "", "reading the lane writes nothing");
});

test("a thread Squadron started, or one under it, is never an outside lane", async (t) => {
  const { add, metadata, board } = await fixture(t);
  // Started by the plugin itself, with no Lead metadata (for example a Set up thread).
  add({ id: "thr_origin", title: "Implement bb Bot spec", originPluginId: "squadron", firstMessage: BB_BOT_SEED });
  // Carries Squadron's metadata without the plugin origin.
  add({ id: "thr_metadata", title: "Plan bb Bot spec", firstMessage: BB_BOT_SEED });
  metadata.set("thr_metadata", { role: "setup" });
  // A worker a Squadron thread started names the spec in its first message.
  add({ id: "thr_child", title: "Worker", parentThreadId: "thr_origin", firstMessage: BB_BOT_SEED });
  const result = await board();
  assert.deepEqual(result.lanes, []);
  assert.deepEqual(result.ready.map((row) => row.id), ["bb-bot"], "the spec stays Ready for Start");
});

test("an outside lane's fresh worktree branch at main is not a landed lane", async (t) => {
  const { root, add, board } = await fixture(t);
  const mainTime = Number(git(root, "show", "-s", "--format=%ct", "main")) * 1000;
  add({ id: "thr_bbbot", title: "Implement bb Bot spec", firstMessage: "Implement `.scratch/bb-bot/spec.md`.",
    createdAt: mainTime + 1_000, environmentBranchName: "bb/implement-bb-bot-spec-thr_bbbot" });
  const lane = (await board()).lanes[0];
  assert.equal(lane.branch, "bb/implement-bb-bot-spec-thr_bbbot");
  assert.equal(lane.outside, true);
  assert.equal(lane.state, "flying");
});

test("an outside lane has no lane buttons, and Start, Stop, Resume and Merge refuse it without messaging its thread", async (t) => {
  const { add, harness, board } = await fixture(t);
  // Idle, so a Squadron lane would offer Resume; its tickets reached the branch, so it would offer a local Merge.
  add({ id: "thr_bbbot", title: "Implement bb Bot spec", status: "idle", firstMessage: BB_BOT_SEED });
  const result = await board();
  const lane = result.lanes[0];
  assert.equal(lane.outside, true);
  assert.equal(lane.state, "flying", "an idle outside lane still flies; Stopped is Squadron's own lane state");
  assert.equal(canMerge(lane), false);
  assert.deepEqual(needsYou(result).filter((item) => item.specId === "bb-bot" && ["stopped", "merge"].includes(item.kind)), []);

  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const html = renderToStaticMarkup(createElement(BoardView, {
    board: result, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined,
  }));
  assert.ok(html.includes("Started outside Squadron"), "the lane carries the outside tag");
  assert.match(html, /no Stop, Resume or Merge/, "the read-only line replaces the actions");
  for (const label of ["Stop", "Resume", "Merge", "Start"]) {
    assert.doesNotMatch(html, new RegExp(`<button[^>]*>${label}</button>`), `no ${label} button`);
  }

  const sent: unknown[] = [];
  harness.sdk.stub("threads.send", async (input) => { sent.push(input); throw new Error("must not send"); });
  for (const method of ["lane.stop", "lane.resume", "lane.merge", "lane.start"] as const) {
    await assert.rejects(harness.behavior.callRpc(method, { projectId: "project", specId: "bb-bot" }), /started outside Squadron/, method);
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(harness.inspection.sdk.callsTo("threads.spawn"), []);
});

test("matching names a spec as a whole identifier and prefers the thread whose title names it", async () => {
  const { matchOutsideLanes } = await import("../lib/outside-lanes.js");
  const spec = (id: string, title: string) => ({ id: `uuid-${id}`, identifier: id, title, description: null, url: "", updatedAt: "",
    parentId: null, state: { id: "s", name: "Todo", type: "unstarted" }, labels: [], assignees: [], inProject: true });
  const thread = (id: string, title: string, firstMessage: string, createdAt: number, parentThreadId: string | null = null) =>
    ({ id, title, firstMessage, createdAt, parentThreadId, squadron: false });
  const lanes = matchOutsideLanes([spec("SIZE-947", "Squadron connects nothing to something"), spec("SIZE-94", "Older spec")], [
    thread("thr_helper", "Evaluate squadron implementation", "Brief the Lead for SIZE-947.", 1),
    thread("thr_lead", "Lead · Connect (SIZE-947)", "You are the Lead for SIZE-947. The integration branch `connect` exists.", 2),
    thread("thr_worker", "Worker SIZE-957", "Build SIZE-957 for SIZE-947.", 3, "thr_lead"),
  ]);
  assert.deepEqual([...lanes], [["uuid-SIZE-947", "thr_lead"]], "SIZE-94 isn't named by SIZE-947, and the titled Lead wins over an older mention");
  const { namedIntegrationBranches } = await import("../lib/outside-lanes.js");
  assert.deepEqual(namedIntegrationBranches("You are the Lead. The integration branch `connect` already exists on origin."), ["connect"]);
});
