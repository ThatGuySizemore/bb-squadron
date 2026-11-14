// A6's end-to-end tests: the real server.ts on the SDK's fake plugin host, a
// recorded Linear workspace behind fetch, and the board's Plan through RPC.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { binding, workspace } from "./fixtures/board-workspace.js";
import { end, ready } from "./fixtures/linear-mirror.js";

const settingsFile = readFileSync("tests/fixtures/squadron.md", "utf8");
const labels = [
  { id: "label-ready", name: "ready-for-agent", color: "#00aa00" },
  { id: "label-ui", name: "ui", color: "#0000aa" },
  { id: "label-data", name: "data", color: "#aa00aa" },
  { id: "label-accept", name: "accept:owner", color: "#aa0000" },
  { id: "label-bug", name: "bug", color: "#aaaa00" },
];
const vocabulary = () => Response.json({ data: {
  workflowStates: { nodes: [ready], pageInfo: end }, issueLabels: { nodes: labels, pageInfo: end },
} });

type HostOptions = { appUrl?: string | null; settings?: Record<string, string> };
function host(options: HostOptions = {}) {
  let spawned = 0;
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  return createFakePluginHost({
    pluginId: "squadron",
    appUrl: options.appUrl === undefined ? "https://bb.example.test" : options.appUrl,
    settings: options.settings ?? { linearApiKey: "fake-planning-key" },
    sdk: {
      projects: { get: async ({ projectId }) => ({
        id: projectId, name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId, hostId: "repo-machine", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }],
      }) },
      files: { read: async ({ path }) => {
        assert.equal(path, "/repo/docs/agents/squadron.md");
        return { content: settingsFile, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: settingsFile.length };
      } },
      threads: {
        spawn: async (args) => {
          const thread = makeThreadResponse({ id: `thr_plan_${++spawned}`, projectId: args.projectId });
          threads.set(thread.id, thread);
          metadata.set(thread.id, args.pluginMetadata ?? {});
          return thread;
        },
        list: async () => [...threads.values()],
        getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
        get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "proj-one" }),
        defaultExecutionOptions: async () => ({ model: "claude-opus-5-5", permissionMode: "auto", reasoningLevel: "high", serviceTier: "default", source: "client/turn/start" }),
      },
    },
  });
}

/** Only recorded read queries are allowed across the external Linear boundary. */
async function setup(t: import("node:test").TestContext) {
  const linear = workspace({ vocabulary });
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    assert.match(query, /^query /);
    return linear.fetch(url, init);
  });
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("linear.bind", binding);
  return { harness, linear };
}

test("Plan on an Unplanned issue opens a planning thread in the project checkout, seeded with the issue and the squadron-planner skill", async (t) => {
  const { harness } = await setup(t);
  const started = await harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-9" }) as { threadId: string };
  assert.equal(started.threadId, "thr_plan_1");

  const spawns = harness.inspection.sdk.callsTo("threads.spawn");
  assert.equal(spawns.length, 1);
  const args = spawns[0][0] as { projectId: string; environment: unknown; title: string; prompt: string };
  assert.equal(args.projectId, "proj-one");
  assert.deepEqual(args.environment, { type: "host", hostId: "repo-machine", workspace: { type: "unmanaged", path: "/repo" } });
  assert.equal(args.title, "Plan FIX-9: Linear webhooks");
  for (const text of ["squadron-planner", "FIX-9", "fix-9", "Linear webhooks", "https://linear.app/fixture/issue/FIX-9"]) {
    assert.ok(args.prompt.includes(text), `the seed names ${text}`);
  }
});

test("the seed carries the repo's routes and bound project without a plugin write path", async (t) => {
  const { harness } = await setup(t);
  const started = await harness.behavior.callRpc("planning.start", { projectId: "proj-one" }) as { threadId: string };
  assert.deepEqual(started, { threadId: "thr_plan_1" });
  const { title, prompt } = harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { title: string; prompt: string };
  assert.equal(title, "Plan a spec");
  for (const text of ["`ui` → Claude claude-opus-5-5 high", "`data` → GPT gpt-6.1-sol medium", "(default, no route label) → GPT gpt-6.1-sol high",
    "Fixture team · Fixture project"]) {
    assert.ok(prompt.includes(text), `the seed carries ${text}`);
  }
  assert.ok(!/squadron_linear|signed Linear|label-ready|label-accept/.test(prompt));
  assert.ok(!prompt.includes("Plan from this Linear issue"), "Plan a spec has no seed issue");
});

test("Plan on an issue that already has a planning thread reopens that thread, even on a double click", async (t) => {
  const { harness } = await setup(t);
  const start = () => harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-9" }) as Promise<{ threadId: string }>;
  const [first, second] = await Promise.all([start(), start()]);
  const third = await start();
  assert.deepEqual([first.threadId, second.threadId, third.threadId], ["thr_plan_1", "thr_plan_1", "thr_plan_1"]);
  const fresh = await harness.behavior.callRpc("planning.start", { projectId: "proj-one" }) as { threadId: string };
  assert.equal(fresh.threadId, "thr_plan_2", "Plan a spec always starts a new thread");
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 2);
});

test("a planning thread that was archived is replaced by a new one", async (t) => {
  const { harness } = await setup(t);
  await harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-9" });
  harness.sdk.stub("threads.list", async () => []);
  const again = await harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-9" }) as { threadId: string };
  assert.equal(again.threadId, "thr_plan_2");
});

test("Plan refuses issues outside the board, callers other than the board, and projects without a checkout", async (t) => {
  const { harness } = await setup(t);
  await assert.rejects(harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "OUT-10" }),
    /OUT-10 isn't an open issue in this project's Linear project/);
  await assert.rejects(harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-9" },
    { experimental_caller: { kind: "plugin", pluginId: "other" } }), /Start planning from the Squadron board/);
  harness.sdk.stub("projects.get", async ({ projectId }: { projectId: string }) => ({
    id: projectId, name: "Empty", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0, sources: [] }));
  await assert.rejects(harness.behavior.callRpc("planning.start", { projectId: "proj-one" }), /no default checkout/);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("the bundled planner points at Matt's skills and the repo's issue tracker instructions", () => {
  const skill = readFileSync("skills/squadron-planner/SKILL.md", "utf8");
  assert.match(skill, /^---\nname: squadron-planner\ndescription: .+\n---\n/);
  for (const name of ["`grill-with-docs`", "`to-spec`", "`to-tickets`", "docs/agents/issue-tracker.md", "`ready-for-agent`"]) {
    assert.ok(skill.includes(name), `the skill names ${name}`);
  }
  for (const removed of ["squadron_linear_write", "squadron_linear_receipt", "## Receipts", "## Publishing"]) {
    assert.ok(!skill.includes(removed), `the removed write path is absent: ${removed}`);
  }
});

test("the board's Plan opens the planning thread beside the board and reports start failures", async () => {
  await import("./fixtures/app-runtime.js");
  const { planFromBoard } = await import("../board/Board.js");
  const calls: unknown[] = [];
  const opened: string[] = [];
  const notes: string[] = [];
  const run = (result: () => Promise<{ threadId: string }>, issueId?: string) =>
    planFromBoard({
      start: async (input) => { calls.push(input); return result(); },
      openThread: (threadId) => opened.push(threadId), notify: (text) => notes.push(text),
    }, "proj-one", issueId);

  await run(async () => ({ threadId: "thr_plan_1" }), "FIX-9");
  await run(async () => ({ threadId: "thr_plan_2" }));
  await run(async () => { throw new Error("FIX-9 isn't an open issue in this project's Linear project. The board may be out of date."); }, "FIX-9");
  assert.deepEqual(calls, [{ projectId: "proj-one", issueId: "FIX-9" }, { projectId: "proj-one" }, { projectId: "proj-one", issueId: "FIX-9" }]);
  assert.deepEqual(opened, ["thr_plan_1", "thr_plan_2"]);
  assert.deepEqual(notes, [
    "FIX-9 isn't an open issue in this project's Linear project. The board may be out of date.",
  ]);
});

test("while a planning thread opens, its Plan button says so and waits", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BoardView } = await import("../board/Board.js");
  const board = { tick: 0, laneCapacity: 3, workersPerLane: 2, autoStart: false, lanes: [], ready: [],
    unplanned: [{ id: "FIX-9", title: "Linear webhooks", labels: [] }, { id: "FIX-12", title: "Another", labels: [] }] };
  const html = renderToStaticMarkup(createElement(BoardView, {
    board, demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined, planning: "FIX-9",
  }));
  assert.equal((html.match(/<button[^>]*disabled=""[^>]*>Opening…<\/button>/g) ?? []).length, 1, "only FIX-9's Plan waits");
  assert.equal((html.match(/>Plan<\/button>/g) ?? []).length, 1);
  assert.ok(html.includes(">Plan a spec</button>"));
});
