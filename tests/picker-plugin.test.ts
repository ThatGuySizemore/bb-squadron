import { fixtureProviders } from "./fixtures/provider-catalog.js";
// SIZE-953: the board's project picker, its remembered pick and per-project
// polling, on the SDK's fake plugin host with recorded Linear responses.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server.js";
import { registerLinearAuth } from "../lib/linear-auth.js";
import { registerLinearReader } from "../lib/linear-reader.js";
import { registerBoard } from "../lib/board-service.js";
import { registerTracker } from "../lib/tracker-service.js";
import { readLeadThreads } from "../lib/lead-threads.js";
import type { TrackerReader, TrackerSnapshot } from "../lib/tracker-contract.js";
import { workspace } from "./fixtures/board-workspace.js";

const settingsFile = readFileSync("tests/fixtures/squadron.md", "utf8");
const projects = [
  { id: "proj-squadron", name: "BB Squadron", path: "/squadron", tracker: "tests/fixtures/trackers/bb-squadron.md" },
  { id: "proj-wordwell", name: "WordWell", path: "/wordwell", tracker: "tests/fixtures/trackers/wordwell.md" },
  { id: "proj-bbbot", name: "bb-bot", path: "/bbbot", tracker: "tests/fixtures/trackers/local.md" },
];
const project = (id: string) => {
  const found = projects.find((item) => item.id === id);
  assert.ok(found, `unexpected project ${id}`);
  return found;
};
const response = (id: string) => ({ id, name: project(id).name, kind: "standard" as const, gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
  sources: [{ id: `source-${id}`, projectId: id, hostId: "repo-machine", path: project(id).path, isDefault: true, type: "local_path" as const, createdAt: 0, updatedAt: 0 }] });

/** WordWell has one Lead flying FIX-5, started from its board. */
const wordwellLead = makeThreadResponse({ id: "thr_ww_lead", projectId: "proj-wordwell", providerId: "codex", status: "active", createdAt: Date.now() });

function host() {
  return createFakePluginHost({
    pluginId: "squadron",
    experimental_hostEntry: true,
    settings: { linearApiKey: "fake-picker-key" },
    experimental_callHostRpc: async ({ method }) => method === "githubLogin" ? { authenticated: true } : {
      homePath: "/owner", repoRulesExists: true, playbookExists: true, machineProfileExists: true,
      setupFiles: ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"], regularSkillFiles: [],
    },
    sdk: {
      providers: fixtureProviders,
      skills: { list: async () => ({ skills: [] }) },
      projects: {
        list: async () => projects.map(({ id }) => response(id)),
        get: async ({ projectId }) => response(projectId),
      },
      files: { read: async ({ path }) => {
        const found = projects.find((item) => path.startsWith(`${item.path}/`));
        assert.ok(found, `unexpected read ${path}`);
        const content = path.endsWith("issue-tracker.md") ? readFileSync(found.tracker, "utf8") : settingsFile;
        return { content, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: content.length };
      } },
      threads: {
        list: async (args) => args?.projectId === "proj-wordwell" && !args.parentThreadId ? [wordwellLead] : [],
        getPluginMetadata: async () => ({ role: "lead", specId: "fix-5" }),
        defaultExecutionOptions: async () => ({ model: "gpt-6.1-sol", permissionMode: "auto", reasoningLevel: "high", serviceTier: "default", source: "client/turn/start" }),
      },
    },
  });
}

/** bb-bot's planning tracker is local markdown: one ready spec with one open ticket, read through the snapshot contract. */
const bbBotSnapshot: TrackerSnapshot = {
  kind: "local-markdown", bbProjectId: "proj-bbbot", project: { name: "bb-bot" },
  issues: [
    { id: ".scratch/bot/spec.md", identifier: "bot", title: "The bot answers", description: null, url: ".scratch/bot/spec.md",
      updatedAt: "2026-11-13T20:00:00.000Z", parentId: null, state: { id: "open", name: "ready-for-agent", type: "unstarted" },
      labels: [{ id: "ready-for-agent", name: "ready-for-agent", color: "" }], assignees: [], inProject: true, path: ".scratch/bot/spec.md" },
    { id: ".scratch/bot/issues/01-reply.md", identifier: "bot#01", title: "Reply", description: null, url: ".scratch/bot/issues/01-reply.md",
      updatedAt: "2026-11-13T20:00:00.000Z", parentId: ".scratch/bot/spec.md", state: { id: "open", name: "ready-for-agent", type: "unstarted" },
      labels: [], assignees: [], inProject: true, path: ".scratch/bot/issues/01-reply.md" },
  ],
  relations: [], labels: [], states: [], syncedAt: Date.now(), error: null,
};

type Counts = { projects: { id: string; tracker: string | null; ready: number | null; flying: number | null; note: string | null }[] };
type Listed = { projects: { id: string; name: string }[]; lastPick: string | null };

/** Registers the board with the real Linear reader, and bb-bot's local snapshot behind the same reader contract. */
function compose(bb: BbPluginApi) {
  const auth = registerLinearAuth(bb);
  const mirror = registerLinearReader(bb, auth);
  const real = registerTracker(bb, mirror);
  const tracker: TrackerReader = { ...real, getSnapshot: (id) => id === "proj-bbbot" ? bbBotSnapshot : real.getSnapshot(id),
    refresh: async (id) => id === "proj-bbbot" ? bbBotSnapshot : real.refresh(id) };
  registerBoard(bb, { connection: () => auth.getConnection(), tracker, leads: (id) => readLeadThreads(bb, id) });
}

test("the picker lists BB Squadron, WordWell and bb-bot, each with its tracker kind and its Ready and Flying counts", async (t) => {
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  compose(bb);
  await harness.behavior.callRpc("board", { projectId: "proj-squadron" });
  await harness.behavior.callRpc("board", { projectId: "proj-wordwell" });

  const listed = await harness.behavior.callRpc("board.projects", null) as Listed;
  assert.deepEqual(listed.projects, [
    { id: "proj-squadron", name: "BB Squadron" }, { id: "proj-wordwell", name: "WordWell" }, { id: "proj-bbbot", name: "bb-bot" },
  ]);
  const counts = await harness.behavior.callRpc("board.projectCounts", null) as Counts;
  assert.deepEqual(counts.projects.map(({ id, tracker, ready, flying }) => ({ id, tracker, ready, flying })), [
    { id: "proj-squadron", tracker: "linear", ready: 2, flying: 0 },
    { id: "proj-wordwell", tracker: "linear", ready: 1, flying: 1 },
    { id: "proj-bbbot", tracker: "local-markdown", ready: 1, flying: 0 },
  ]);
  assert.ok(!linear.operations.some((name) => !name.startsWith("Squadron")), "the picker only reads");
});

test("a project whose tracker can't be read yet still lists, with its kind and a reason instead of counts", async (t) => {
  const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  const counts = await harness.behavior.callRpc("board.projectCounts", null) as Counts;
  const wordwell = counts.projects.find((row) => row.id === "proj-wordwell");
  assert.deepEqual([wordwell?.tracker, wordwell?.ready, wordwell?.flying], ["linear", null, null], "an unreadable Linear project has no counts");
  assert.equal(wordwell?.note, "Linear is unavailable. Try again shortly.", "and says why");
  assert.equal(counts.projects.find((row) => row.id === "proj-bbbot")?.tracker, "local-markdown");
});

test("the board remembers the last pick across a reload, and forgets a project that no longer exists", async (t) => {
  const { bb, harness: first } = host();
  await plugin(bb);
  assert.equal((await first.behavior.callRpc("board.projects", null) as Listed).lastPick, null);
  await first.behavior.callRpc("board.pick", { projectId: "proj-wordwell" });
  const { harness } = await first.lifecycle.reload((api) => plugin(api));
  t.after(() => harness.lifecycle.dispose());
  assert.equal((await harness.behavior.callRpc("board.projects", null) as Listed).lastPick, "proj-wordwell");
  await harness.behavior.callRpc("board.pick", { projectId: "proj-gone" });
  assert.equal((await harness.behavior.callRpc("board.projects", null) as Listed).lastPick, null);
});

async function settleWatchers() { for (let i = 0; i < 50; i++) await setImmediate(); }

test("the Linear poller keeps every discovered project current without an open board", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { await harness.lifecycle.dispose(); fetch.mock.restore(); t.mock.timers.reset(); });
  await plugin(bb);
  const synced = async (id: string) => (await harness.behavior.callRpc("linear.snapshot", { bbProjectId: id }) as { syncedAt: number | null }).syncedAt;
  harness.behavior.runService("board-watcher");
  await settleWatchers();
  assert.notEqual(await synced("proj-squadron"), null, "the watcher discovers an unseen project");
  assert.notEqual(await synced("proj-wordwell"), null, "the watcher discovers the second unseen project");
  harness.behavior.runService("linear-reader");
  await settleWatchers();
  t.mock.timers.tick(30_000);
  await settleWatchers();
  assert.equal(await synced("proj-squadron"), 1_000_000, "the first background project does not read at 30 seconds");
  assert.equal(await synced("proj-wordwell"), 1_000_000, "the second background project does not read at 30 seconds");
  t.mock.timers.tick(269_999);
  await settleWatchers();
  assert.equal(await synced("proj-squadron"), 1_000_000, "the first project waits the full five minutes");
  assert.equal(await synced("proj-wordwell"), 1_000_000, "the second project waits the full five minutes");
  t.mock.timers.tick(1);
  await settleWatchers();
  assert.equal(await synced("proj-squadron"), 1_300_000, "the first project keeps polling");
  assert.equal(await synced("proj-wordwell"), 1_300_000, "the second project keeps polling");
});

test("the board watcher refreshes all projects, including projects no page has ever shown", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const { bb, harness } = host();
  t.after(async () => { await harness.lifecycle.dispose(); t.mock.timers.reset(); });
  const reads: string[] = [];
  const tracker: TrackerReader = { onChange: () => () => undefined,
    getSnapshot: (id) => { reads.push(id); return { ...bbBotSnapshot, bbProjectId: id }; } };
  registerBoard(bb, { connection: async () => ({ status: "connected", message: "" }) as never, tracker });
  await harness.behavior.callRpc("board", { projectId: "proj-squadron" });
  await harness.behavior.callRpc("board", { projectId: "proj-wordwell" });
  t.mock.timers.tick(80_000);
  await harness.behavior.callRpc("board", { projectId: "proj-wordwell" });
  reads.length = 0;
  harness.behavior.runService("board-watcher");
  await settleWatchers();
  assert.ok(reads.includes("proj-wordwell"), "the shown project is refreshed");
  assert.ok(reads.includes("proj-squadron"), "a formerly shown project is refreshed");
  assert.ok(reads.includes("proj-bbbot"), "a project never shown is refreshed");
  reads.length = 0;
  t.mock.timers.tick(30_000);
  await settleWatchers();
  assert.deepEqual([...new Set(reads)].sort(), ["proj-bbbot", "proj-squadron", "proj-wordwell"]);
});
