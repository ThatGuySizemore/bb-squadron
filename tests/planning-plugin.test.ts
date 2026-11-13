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
        spawn: async (args) => makeThreadResponse({ id: `thr_plan_${++spawned}`, projectId: args.projectId }),
        get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "proj-one" }),
        defaultExecutionOptions: async () => ({ model: "claude-opus-5-5", permissionMode: "auto", reasoningLevel: "high", serviceTier: "default", source: "client/turn/start" }),
      },
    },
  });
}

/** Mutations are recorded and confirmed; every read is the recorded workspace. */
async function setup(t: import("node:test").TestContext, options: HostOptions & { vocabulary?: () => Response } = {}) {
  const linear = workspace({ vocabulary: options.vocabulary ?? vocabulary });
  const mutations: Array<{ input: Record<string, unknown> }> = [];
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { input: Record<string, unknown> } };
    if (!query.trimStart().startsWith("mutation")) return linear.fetch(url, init);
    mutations.push(variables);
    const id = variables.input.id;
    return Response.json({ data: query.includes("issueCreate") ? { issueCreate: { success: true, issue: { id } } }
      : query.includes("issueRelationCreate") ? { issueRelationCreate: { success: true, issueRelation: { id } } }
      : { commentCreate: { success: true, comment: { id } } } });
  });
  const { bb, harness } = host(options);
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("linear.bind", binding);
  return { harness, linear, mutations };
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

test("the planning thread may publish a spec, its tickets, ready and route labels and blockers, and nothing else", async (t) => {
  const { harness, linear } = await setup(t);
  await harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-9" });
  const context = { threadId: "thr_plan_1", projectId: "proj-one" };
  const write = async (dedupeKey: string, operation: Record<string, unknown>) =>
    JSON.parse(String(await harness.behavior.callAgentTool("squadron_linear_write", { dedupeKey, operation }, context))) as { id: string; entityId?: string };

  const spec = await write("spec", { type: "issue", title: "Webhooks spec", description: "The to-spec write-up.", labelIds: ["label-ready"] });
  const first = await write("ticket-1", { type: "issue", title: "Receive webhooks", description: "", parentId: spec.entityId, labelIds: ["label-ready", "label-ui"] });
  const second = await write("ticket-2", { type: "issue", title: "Store events", description: "", parentId: spec.entityId, labelIds: ["label-ready", "label-data"] });
  await write("blocks", { type: "blocks", issueId: first.entityId, blockedIssueId: second.entityId });
  await write("seed-comment", { type: "comment", issueId: "fix-9", body: "Planned as the Webhooks spec." });
  await write("seed-parent", { type: "parent", issueId: "fix-9", parentId: spec.entityId });

  await assert.rejects(write("owner", { type: "labels", issueId: spec.entityId, add: ["label-accept"], remove: [] }), /not authorized/);
  await assert.rejects(write("other-label", { type: "issue", title: "Bug", description: "", labelIds: ["label-bug"] }), /not authorized/);
  await assert.rejects(write("other-issue", { type: "comment", issueId: "fix-5", body: "Not this one." }), /not authorized/);
  await assert.rejects(write("status", { type: "status", issueId: "fix-9", stateId: "state-ready" }));
  assert.ok(linear.operations.every((name) => name.startsWith("Squadron")) && !linear.operations.some((name) => /Create|Update/.test(name)),
    "writes wait in the outbox; the planning thread sends nothing to Linear itself");
});

test("the seed lists the labels the planner may apply and the repo's routes, from the selected project's settings", async (t) => {
  const { harness } = await setup(t);
  const started = await harness.behavior.callRpc("planning.start", { projectId: "proj-one" }) as { writes: boolean; message: string | null };
  assert.deepEqual(started, { threadId: "thr_plan_1", writes: true, message: null });
  const { title, prompt } = harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { title: string; prompt: string };
  assert.equal(title, "Plan a spec");
  for (const text of ["`ready-for-agent`: label-ready", "`ui`: label-ui", "`data`: label-data",
    "`ui` → Claude claude-opus-5-5 high", "`data` → GPT gpt-6.1-sol medium", "(default, no route label) → GPT gpt-6.1-sol high",
    "Fixture team · Fixture project"]) {
    assert.ok(prompt.includes(text), `the seed carries ${text}`);
  }
  assert.ok(!prompt.includes("label-accept") && !prompt.includes("label-bug"), "owner and unrelated labels stay out of the seed");
  assert.ok(!prompt.includes("Plan from this Linear issue"), "Plan a spec has no seed issue");
});

test("the planner's avatar is one constant pixel asset on the public HTTPS app URL", async (t) => {
  const { harness, mutations } = await setup(t, {
    appUrl: "https://user:fake-secret@bb.example.test/some/path?token=fake-private#frag",
    settings: { linearCredentials: JSON.stringify({ accessToken: "fake-app-token", refreshToken: "fake-refresh", expiresAt: 9_999_999_999_999 }) },
  });
  await harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-9" });
  const context = { threadId: "thr_plan_1", projectId: "proj-one" };
  const receipt = JSON.parse(String(await harness.behavior.callAgentTool("squadron_linear_write",
    { dedupeKey: "hello", operation: { type: "comment", issueId: "fix-9", body: "Planning started." } }, context))) as { signature: string };
  assert.equal(receipt.signature, "Planning thread · Opus 5.5");
  const delivery = harness.behavior.runService("linear-outbox");
  t.after(() => delivery.controller.abort());
  for (let i = 0; i < 200 && !mutations.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(mutations.map(({ input }) => [input.createAsUser, input.displayIconUrl]), [[
    "Planning thread · Opus 5.5", "https://bb.example.test/api/v1/plugins/squadron/http/avatars/planning-thread.svg",
  ]], "the signed comment's avatar is the app origin's constant asset, without credentials, path, query or fragment");

  const route = harness.inspection.registrations.httpRoutes.find((item) => item.path === "/avatars/planning-thread.svg");
  assert.equal(route?.method, "GET");
  const first = await harness.behavior.fetchHttp("GET", "/avatars/planning-thread.svg");
  const second = await harness.behavior.fetchHttp("GET", "/avatars/planning-thread.svg?thread=thr_plan_1");
  assert.equal(first.headers.get("content-type"), "image/svg+xml");
  const svg = await first.text();
  assert.equal(await second.text(), svg, "the asset ignores every input");
  assert.ok(svg.startsWith("<svg") && svg.includes("crispEdges") && !/proj-one|thr_plan|FIX-9|script/i.test(svg));
});

test("without a public HTTPS app URL the planning thread opens read-only and both the board and the thread say so", async (t) => {
  const { harness } = await setup(t, { appUrl: null });
  const started = await harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-9" }) as { writes: boolean; message: string | null };
  assert.equal(started.writes, false);
  assert.match(started.message ?? "", /public HTTPS app URL/);
  const { prompt } = harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { prompt: string };
  assert.match(prompt, /Squadron's signed Linear writes are unavailable in this thread/);
  assert.match(prompt, /public HTTPS app URL/);
  await assert.rejects(harness.behavior.callAgentTool("squadron_linear_write",
    { dedupeKey: "spec", operation: { type: "issue", title: "Spec", description: "", labelIds: ["label-ready"] } },
    { threadId: "thr_plan_1", projectId: "proj-one" }), /not authorized/);
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
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
    makeThreadResponse({ id: threadId, projectId: "proj-one", archivedAt: threadId === "thr_plan_1" ? 1 : null }));
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

test("the bundled squadron-planner skill points at Matt's skills and publishes only through Squadron's tools", () => {
  const skill = readFileSync("skills/squadron-planner/SKILL.md", "utf8");
  assert.match(skill, /^---\nname: squadron-planner\ndescription: .+\n---\n/);
  for (const name of ["`grill-with-docs`", "`to-spec`", "`to-tickets`", "squadron_linear_write", "squadron_linear_receipt", "`ready-for-agent`"]) {
    assert.ok(skill.includes(name), `the skill names ${name}`);
  }
  for (const type of ["issue", "blocks", "comment", "parent"]) assert.ok(skill.includes(`type: "${type}"`), `the skill shows the ${type} write`);
  // Pointing, not copying: none of the three skills' own templates or process headings are in it.
  for (const copied of ["## Problem Statement", "## User Stories", "## Acceptance criteria", "<spec-template>", "vertical-slice-rules", "### 4. Quiz the user"]) {
    assert.ok(!skill.includes(copied), `the skill does not copy ${copied}`);
  }
  assert.ok(!/save_issue|save_comment/.test(skill), "the skill sends no one to direct Linear MCP writes");
  assert.ok(skill.includes("Other open issues in the Linear project can only be named as blockers"), "the skill states the blocker-reference scope");
});

test("the board's Plan opens the planning thread beside the board and says when it can't write to Linear", async () => {
  await import("./fixtures/app-runtime.js");
  const { planFromBoard } = await import("../board/Board.js");
  const calls: unknown[] = [];
  const opened: string[] = [];
  const notes: string[] = [];
  const run = (result: () => Promise<{ threadId: string; writes: boolean; message: string | null }>, issueId?: string) =>
    planFromBoard({
      start: async (input) => { calls.push(input); return result(); },
      openThread: (threadId) => opened.push(threadId), notify: (text) => notes.push(text),
    }, "proj-one", issueId);

  await run(async () => ({ threadId: "thr_plan_1", writes: true, message: null }), "FIX-9");
  await run(async () => ({ threadId: "thr_plan_2", writes: false, message: "BB has no public HTTPS app URL, so Squadron can't sign the planning thread's Linear comments." }));
  await run(async () => { throw new Error("FIX-9 isn't an open issue in this project's Linear project. The board may be out of date."); }, "FIX-9");
  assert.deepEqual(calls, [{ projectId: "proj-one", issueId: "FIX-9" }, { projectId: "proj-one" }, { projectId: "proj-one", issueId: "FIX-9" }]);
  assert.deepEqual(opened, ["thr_plan_1", "thr_plan_2"]);
  assert.deepEqual(notes, [
    "This planning thread can't publish to Linear: BB has no public HTTPS app URL, so Squadron can't sign the planning thread's Linear comments.",
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

test("before the project is bound, Plan a spec opens read-only and names what's missing", async (t) => {
  const linear = workspace({ vocabulary });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const { bb, harness } = host();
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  const started = await harness.behavior.callRpc("planning.start", { projectId: "proj-one" });
  assert.deepEqual(started, { threadId: "thr_plan_1", writes: false, message: "This BB project isn't bound to a Linear team and project." });
  const { prompt } = harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { prompt: string };
  assert.match(prompt, /signed Linear writes are unavailable in this thread: This BB project isn't bound/);
});

test("a read-only planning thread isn't reopened once Squadron can write, so its first message stays true", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("files.read", async () => { throw new Error("fixture: unreadable"); });
  const readOnly = await harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-9" }) as { threadId: string; writes: boolean };
  assert.deepEqual([readOnly.threadId, readOnly.writes], ["thr_plan_1", false]);
  harness.sdk.stub("files.read", async ({ path }: { path: string }) =>
    ({ content: settingsFile, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: settingsFile.length }));
  const writable = await harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-9" }) as { threadId: string; writes: boolean };
  assert.deepEqual([writable.threadId, writable.writes], ["thr_plan_2", true]);
  const again = await harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-9" }) as { threadId: string };
  assert.equal(again.threadId, "thr_plan_2");
});

test("an open issue elsewhere in the bound Linear project can natively block the planned tickets, and nothing outside it can", async (t) => {
  const { harness, mutations } = await setup(t);
  await harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-9" });
  const context = { threadId: "thr_plan_1", projectId: "proj-one" };
  const write = async (dedupeKey: string, operation: Record<string, unknown>) =>
    JSON.parse(String(await harness.behavior.callAgentTool("squadron_linear_write", { dedupeKey, operation }, context))) as { id: string; entityId?: string };
  const spec = await write("spec", { type: "issue", title: "Webhooks spec", description: "", labelIds: ["label-ready"] });
  const ticket = await write("ticket-1", { type: "issue", title: "Receive webhooks", description: "", parentId: spec.entityId, labelIds: ["label-ready"] });
  // FIX-6 is a ticket of another spec (FIX-5) in the same Linear project.
  const relation = await write("fix-6-blocks-ticket", { type: "blocks", issueId: "fix-6", blockedIssueId: ticket.entityId });
  await assert.rejects(write("outside-blocks-ticket", { type: "blocks", issueId: "outside-two", blockedIssueId: ticket.entityId }), /not authorized/);
  await assert.rejects(write("ticket-blocks-fix-6", { type: "blocks", issueId: ticket.entityId, blockedIssueId: "fix-6" }), /not authorized/);
  await assert.rejects(write("label-fix-6", { type: "labels", issueId: "fix-6", add: ["label-ready"], remove: [] }), /not authorized/);
  await assert.rejects(write("parent-fix-6", { type: "parent", issueId: "fix-6", parentId: spec.entityId }), /not authorized/);
  const delivery = harness.behavior.runService("linear-outbox");
  t.after(() => delivery.controller.abort());
  for (let i = 0; i < 200 && mutations.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(mutations.at(-1), { input: { id: relation.entityId, issueId: "fix-6", relatedIssueId: ticket.entityId, type: "blocks" } });
});

test("Plan reopens a thread only while its seed still matches: changed label IDs or routes start a fresh thread and leave the old one", async (t) => {
  let current = labels;
  const { harness } = await setup(t, { vocabulary: () => Response.json({ data: {
    workflowStates: { nodes: [ready], pageInfo: end }, issueLabels: { nodes: current, pageInfo: end },
  } }) });
  const plan = async () => {
    const started = await harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-9" }) as { threadId: string };
    return started.threadId;
  };
  assert.equal(await plan(), "thr_plan_1");
  assert.equal(await plan(), "thr_plan_1", "nothing changed, so Plan reopens");

  current = labels.map((label) => label.name === "data" ? { ...label, id: "label-data-2" } : label);
  await harness.behavior.callRpc("linear.bind", binding);
  assert.equal(await plan(), "thr_plan_2", "a replaced route label starts a fresh thread");
  const seeded = harness.inspection.sdk.callsTo("threads.spawn")[1][0] as { prompt: string };
  assert.ok(seeded.prompt.includes("`data`: label-data-2") && !seeded.prompt.includes("label-data\n"));
  assert.equal(await plan(), "thr_plan_2");

  harness.sdk.stub("files.read", async ({ path }: { path: string }) => {
    const content = settingsFile.replace("| `data` | GPT | gpt-6.1-sol | medium |", "| `data` | Claude | claude-opus-5-5 | medium |");
    return { content, contentEncoding: "utf8", path, sha256: "fixture-2", sizeBytes: content.length };
  });
  assert.equal(await plan(), "thr_plan_3", "a changed route starts a fresh thread");
  assert.ok((harness.inspection.sdk.callsTo("threads.spawn")[2][0] as { prompt: string }).prompt.includes("`data` → Claude claude-opus-5-5 medium"));
  assert.equal(await plan(), "thr_plan_3");
  assert.deepEqual(harness.inspection.sdk.calls.map((call) => call.path).filter((path) => /^threads\.(archive|stop|delete|send|update)$/.test(path)), [],
    "older planning threads and their work are left as they are");
});
