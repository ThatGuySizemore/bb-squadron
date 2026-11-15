import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { Board } from "../lib/board-model.js";
import type { DoctorReport } from "../lib/doctor.js";
import { compareEffort, readLaunchRecords, verify, type LaunchRecord } from "../lib/launch-record.js";
import { workspace } from "./fixtures/board-workspace.js";
import { shared, house } from "./fixtures/model-routes.js";

// SQD-257: every launch records the route it was given, and Doctor, Start and the board read one resolver.
const legacySettings = readFileSync("tests/fixtures/squadron.md", "utf8");
const skillNames = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];
const catalog: Record<string, Record<string, string[]>> = {
  // BB's advertised lists, in BB's order: unranked levels such as ultracode and ultra sit among ranked ones.
  "claude-code": { "claude-sonnet-5-5": ["low", "medium", "high", "xhigh", "ultracode"], "claude-opus-5-5": ["low", "medium", "high", "xhigh", "ultracode", "max"] },
  codex: { "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max", "ultra"] },
};
type Native = {
  count: number;
  threads: Map<string, ReturnType<typeof makeThreadResponse>>;
  metadata: Map<string, Record<string, unknown>>;
  routes: Map<string, { model: string; reasoningLevel?: string; serviceTier?: string }>;
  fallbacks: Map<string, string>;
};

async function setup(t: import("node:test").TestContext, settings = shared, policy: string | null = house) {
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const native: Native = { count: 0, threads: new Map(), metadata: new Map(), routes: new Map(), fallbacks: new Map() };
  const { bb, harness } = createFakePluginHost({
    pluginId: "squadron", experimental_hostEntry: true,
    settings: { linearApiKey: "fake-launch-key" },
    sdk: {
      projects: {
        list: async () => [{ id: "proj-one", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }],
        get: async ({ projectId }) => ({
          id: projectId, name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
          sources: [{ id: "source", projectId, hostId: "repo-machine", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }],
        }),
      },
      files: { read: async ({ path }) => {
        const content = path === "/repo/docs/agents/issue-tracker.md" ? readFileSync("tests/fixtures/trackers/bb-squadron.md", "utf8") : settings;
        return { content, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: content.length };
      } },
      skills: { list: async () => ({ skills: ["claude-code", "codex"].flatMap((provider) => skillNames.map((name) => ({
        id: `${provider}-${name}`, name: `mattpocock-skills:${name}`, description: null,
        filePath: `/plugins/${provider}/${name}/SKILL.md`, manageable: false, pluginId: "mattpocock-skills", provider,
        registrySkillId: null, scope: "plugin" as const,
      }))) }) },
      providers: {
        list: async () => Object.keys(catalog).map((id) => ({ id })),
        models: async (args) => ({ modelLoadError: null,
          models: Object.entries(catalog[args?.providerId ?? ""] ?? {}).map(([id, efforts]) => ({
            id, supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
          })),
        }),
      },
      threads: {
        list: async (args) => [...native.threads.values()].filter((thread) => (!args?.projectId || thread.projectId === args.projectId)
          && (!args?.parentThreadId || thread.parentThreadId === args.parentThreadId)
          && (args?.archived === undefined || (thread.archivedAt !== null) === args.archived))
          .map((thread) => ({ ...thread, environmentBranchName: "spec/fix-5" })),
        get: async ({ threadId }) => native.threads.get(threadId)!,
        getPluginMetadata: async ({ threadId }) => native.metadata.get(threadId) ?? {},
        defaultExecutionOptions: async ({ threadId }) => {
          const route = native.routes.get(threadId);
          return route ? { ...route, permissionMode: "auto", source: "client/thread/start" } : null;
        },
        events: { list: async ({ threadId, types }) => {
          const fallback = native.fallbacks.get(threadId);
          if (!fallback || !(types as readonly string[] | undefined)?.includes("provider/modelFallback")) return [];
          return [{ id: "evt", threadId, seq: 9, createdAt: 1, type: "provider/modelFallback",
            data: { type: "provider/modelFallback", threadId, providerThreadId: "p", originalModel: "x", fallbackModel: fallback, reason: "provider", message: "" } }];
        } },
        spawn: async (args) => {
          const id = `thr_${++native.count}`;
          const thread = makeThreadResponse({ id, projectId: args.projectId, providerId: args.providerId ?? "claude-code",
            parentThreadId: args.parentThreadId ?? null, title: args.title ?? null,
            environmentId: `env_${native.count}`, status: "active", createdAt: native.count * 1000 });
          native.threads.set(id, thread);
          native.metadata.set(id, args.pluginMetadata ?? {});
          native.routes.set(id, { model: args.model ?? "claude-sonnet-5-5", reasoningLevel: args.reasoningLevel ?? "medium", serviceTier: args.serviceTier ?? "priority" });
          return thread;
        },
      },
    },
    experimental_callHostRpc: async ({ method, input }) => method === "readModelRoutes" ? { markdown: policy }
      : method === "githubLogin" ? { authenticated: true } : method === "codexMattSkills" ? { skills: [] } : {
        homePath: "/owner", repoRulesExists: true, playbookExists: false, machineProfileExists: false,
        setupFiles: ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"],
        regularSkillFiles: (input as { skillPaths: string[] }).skillPaths,
      },
  });
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  await harness.behavior.callRpc("board", { projectId: "proj-one" });
  const spawnArgs = (index: number) => harness.inspection.sdk.callsTo("threads.spawn")[index][0] as Record<string, unknown> & { pluginMetadata: { launch: LaunchRecord } };
  const launch = (args: string[]) => harness.behavior.runCli(["launch", ...args], { threadId: "thr_1", projectId: "proj-one" });
  return { harness, native, bb, spawnArgs, launch };
}

test("Start records the Lead's route as passed to BB, and Doctor, the Start brief and the board read the same resolver", async (t) => {
  const { harness, spawnArgs } = await setup(t);
  const report = await harness.behavior.callRpc("doctor", { projectId: "proj-one" }) as DoctorReport;
  assert.equal(report.ready, true, JSON.stringify(report.checks));
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  const args = spawnArgs(0);
  const lead = { providerId: "claude-code", model: "claude-sonnet-5-5", effort: "high", serviceTier: "default" };
  assert.deepEqual([args.providerId, args.model, args.reasoningLevel, args.serviceTier], ["claude-code", "claude-sonnet-5-5", "high", "default"]);
  const record = args.pluginMetadata.launch;
  assert.equal(record.version, 1);
  assert.equal(record.role, "Lead");
  assert.equal(record.category, null);
  assert.equal(record.policyResolved, true);
  assert.equal(record.specId, "fix-5");
  assert.deepEqual(record.tickets, []);
  assert.equal(record.launchedBy, "owner");
  assert.equal(record.escalation, null);
  assert.deepEqual(record.requested, lead);
  // Doctor's route view: the same Lead row, plus the ui exception a ticket would launch on.
  assert.deepEqual(report.routes?.find((row) => row.role === "Lead" && row.category === null)?.route, lead);
  assert.deepEqual(report.routes?.find((row) => row.category === "ui")?.route,
    { providerId: "claude-code", model: "claude-opus-5-5", effort: "high", serviceTier: "default" });
  assert.deepEqual(report.routes?.find((row) => row.role === "Review of claude-code")?.route,
    { providerId: "codex", model: "gpt-6.1-sol", effort: "high", serviceTier: "default" });
  // The Lead's brief carries the same resolved routes and the one launch path.
  assert.match(String(args.prompt), /- Lead: claude-code claude-sonnet-5-5, high effort, default tier/);
  assert.match(String(args.prompt), /- Worker for ui tickets: claude-code claude-opus-5-5, high effort, default tier/);
  assert.match(String(args.prompt), /bb squadron launch/);
  // SQD-258: the brief names the one final-review launch and the reviewer today's ticket routes project.
  assert.match(String(args.prompt), /Final review: once every ticket is integrated, launch it once with `bb squadron launch final-review --base-branch <branch> --prompt-stdin`\. It runs on the Review of <provider> route above for the family that built the most integrated tickets/);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.deepEqual(board.lanes[0].launch?.requested, lead);
  assert.deepEqual(board.lanes[0].launch?.reported, lead);
  assert.deepEqual(board.lanes[0].launch?.mismatch, []);
  assert.equal(board.lanes[0].launch?.role, "Lead");
});

test("the board lane shows provider, model, effort and tier as BB reports them, and flags a substitution", async (t) => {
  const { harness, native } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  native.routes.set("thr_1", { model: "claude-sonnet-5-5", reasoningLevel: "high", serviceTier: "default" });
  native.fallbacks.set("thr_1", "claude-haiku-5-5");
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  const lane = board.lanes[0];
  assert.deepEqual(lane.launch?.reported, { providerId: "claude-code", model: "claude-haiku-5-5", effort: "high", serviceTier: "default" });
  assert.deepEqual(lane.launch?.mismatch, ["model"]);
  assert.equal(lane.launch?.verification, "mismatch");
  assert.equal(lane.lead.model, "claude-haiku-5-5", "the lane shows what BB runs, never the request");
  assert.equal(lane.lead.serviceTier, "default");
  assert.equal(lane.lead.providerId, "claude-code");
});

test("a Lead launches a worker through squadron launch, recording the ticket's route and linkage", async (t) => {
  const { harness, spawnArgs, launch } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  const result = await launch(["worker", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "Build FIX-6."]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Worker FIX-6 on claude-code claude-sonnet-5-5, medium effort, default tier @thread:thr_2/);
  const args = spawnArgs(1);
  assert.equal(args.parentThreadId, "thr_1");
  assert.equal(args.parentNotifications, "auto");
  assert.equal(args.title, "Worker FIX-6");
  assert.equal(args.prompt, "Build FIX-6.");
  assert.deepEqual([args.providerId, args.model, args.reasoningLevel, args.serviceTier], ["claude-code", "claude-sonnet-5-5", "medium", "default"]);
  assert.deepEqual(args.environment, { type: "host", hostId: "repo-machine", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "spec/fix-5" } } });
  assert.equal((args.pluginMetadata as Record<string, unknown>).role, undefined, "a launched child is never mistaken for a Lead or planning thread");
  const record = args.pluginMetadata.launch;
  assert.equal(record.role, "Worker");
  assert.equal(record.launchedBy, "lead");
  assert.equal(record.leadThreadId, "thr_1");
  assert.equal(record.specId, "fix-5");
  assert.deepEqual(record.tickets, [{ id: "fix-6", identifier: "FIX-6" }]);
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  const ticket = board.lanes[0].tickets.find((row) => row.id === "FIX-6")!;
  assert.equal(ticket.threadId, "thr_2");
  assert.deepEqual(ticket.launch?.reported, { providerId: "claude-code", model: "claude-sonnet-5-5", effort: "medium", serviceTier: "default" });
  assert.equal(ticket.launch?.role, "Worker");
});

test("squadron launch refuses callers that aren't Squadron Leads and tickets outside the Lead's spec", async (t) => {
  const { harness } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  const outside = await harness.behavior.runCli(["launch", "worker", "--ticket", "FIX-6", "--base-branch", "b", "--prompt", "p"], { threadId: "thr_other", projectId: "proj-one" });
  assert.equal(outside.exitCode, 1);
  assert.match(outside.stderr, /inside a Squadron Lead thread/);
  const foreign = await harness.behavior.runCli(["launch", "worker", "--ticket", "FIX-2", "--base-branch", "b", "--prompt", "p"], { threadId: "thr_1", projectId: "proj-one" });
  assert.equal(foreign.exitCode, 1);
  assert.match(foreign.stderr, /FIX-2 isn't an open ticket of FIX-5/);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
});

test("effort-only escalation keeps the Worker role and model, raises supported effort and keeps the reason", async (t) => {
  const { harness, spawnArgs, launch } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  assert.equal((await launch(["worker", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "p"])).exitCode, 0);
  const reason = "First attempt skipped the parser's edge cases; investigation was too thin.";
  for (const [extra, problem] of [
    [["--effort", "xhigh"], /reason/],
    [["--effort", "medium", "--reason", reason], /medium isn't higher than thr_2's medium/],
    [["--effort", "low", "--reason", reason], /low isn't higher than thr_2's medium/],
    [["--effort", "max", "--reason", reason], /claude-sonnet-5-5: doesn't support max effort/],
    [["--effort", "ultracode", "--reason", reason], /BB doesn't rank ultracode against thr_2's medium effort/],
    [["--reason", reason], /only when a replacement runs at a higher effort or on a hard route/],
  ] as const) {
    const refused = await launch(["worker", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "p", "--replaces", "thr_2", ...extra]);
    assert.equal(refused.exitCode, 1, extra.join(" "));
    assert.match(refused.stderr, problem);
  }
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 2, "a refused escalation launches nothing, never a substitute");
  const raised = await launch(["worker", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "p", "--replaces", "thr_2", "--effort", "xhigh", "--reason", reason]);
  assert.equal(raised.exitCode, 0, raised.stderr);
  const args = spawnArgs(2);
  assert.deepEqual([args.providerId, args.model, args.reasoningLevel], ["claude-code", "claude-sonnet-5-5", "xhigh"]);
  const record = args.pluginMetadata.launch;
  assert.equal(record.role, "Worker", "an effort-only escalation never becomes Worker (hard)");
  assert.equal(record.requested.effort, "xhigh");
  assert.equal(record.replacesThreadId, "thr_2");
  assert.deepEqual(record.escalation, { kind: "effort", reason });
});

test("stronger-model escalation launches Worker (hard) and keeps the reason; upfront hard work carries none", async (t) => {
  const { harness, spawnArgs, launch } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  assert.equal((await launch(["worker", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "p"])).exitCode, 0);
  const missing = await launch(["worker-hard", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "p", "--replaces", "thr_2"]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /reason/);
  const reason = "A thorough investigation still lacked the insight into the settings parser.";
  const hard = await launch(["worker-hard", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "p", "--replaces", "thr_2", "--reason", reason]);
  assert.equal(hard.exitCode, 0, hard.stderr);
  const record = spawnArgs(2).pluginMetadata.launch;
  assert.equal(record.role, "Worker (hard)");
  assert.deepEqual(record.requested, { providerId: "claude-code", model: "claude-opus-5-5", effort: "high", serviceTier: "default" });
  assert.deepEqual(record.escalation, { kind: "model", reason });
  assert.equal(record.replacesThreadId, "thr_2");
  assert.equal((await launch(["worker-hard", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "p"])).exitCode, 0);
  assert.equal(spawnArgs(3).pluginMetadata.launch.escalation, null);
  assert.equal(spawnArgs(3).pluginMetadata.launch.role, "Worker (hard)");
});

test("review, mechanical and planning launches record their own roles and routes", async (t) => {
  const { harness, spawnArgs, launch } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  assert.equal((await launch(["review-of-claude-code", "--base-branch", "spec/fix-5", "--prompt", "Review the branch."])).exitCode, 0);
  assert.equal(spawnArgs(1).title, "Review FIX-5");
  assert.deepEqual(spawnArgs(1).pluginMetadata.launch.requested, { providerId: "codex", model: "gpt-6.1-sol", effort: "high", serviceTier: "default" });
  assert.equal(spawnArgs(1).pluginMetadata.launch.role, "Review of claude-code");
  assert.equal((await launch(["mechanical", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "Format."])).exitCode, 0);
  assert.equal(spawnArgs(2).pluginMetadata.launch.role, "Mechanical");
  assert.equal(spawnArgs(2).pluginMetadata.launch.requested.effort, "low");
  await harness.behavior.callRpc("planning.start", { projectId: "proj-one", issueId: "FIX-1" });
  const planning = spawnArgs(3);
  assert.equal((planning.pluginMetadata as Record<string, unknown>).role, "planning");
  assert.deepEqual([planning.providerId, planning.model, planning.reasoningLevel, planning.serviceTier], ["claude-code", "claude-opus-5-5", "medium", "default"]);
  assert.equal(planning.pluginMetadata.launch.role, "Planning");
  assert.equal(planning.pluginMetadata.launch.specId, "fix-1");
});

test("the launch reader returns every attempt with spec, ticket and role linkage, including archived ones", async (t) => {
  const { harness, native, bb, launch } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  assert.equal((await launch(["worker", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "p"])).exitCode, 0);
  native.threads.set("thr_2", { ...native.threads.get("thr_2")!, archivedAt: 5000 });
  assert.equal((await launch(["worker", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "p", "--replaces", "thr_2", "--effort", "high", "--reason", "too thin"])).exitCode, 0);
  // A child the Lead spawned outside the launch path is listed, never dropped.
  native.threads.set("thr_manual", makeThreadResponse({ id: "thr_manual", projectId: "proj-one", parentThreadId: "thr_1", createdAt: 9000 }));
  native.routes.set("thr_3", { model: "claude-opus-5-5", reasoningLevel: "high", serviceTier: "default" });
  const read = await readLaunchRecords(bb, "proj-one");
  assert.deepEqual(read.attempts.map((attempt) => [attempt.threadId, attempt.record.role, attempt.archivedAt !== null]),
    [["thr_1", "Lead", false], ["thr_2", "Worker", true], ["thr_3", "Worker", false]]);
  assert.deepEqual(read.attempts[2].record.tickets, [{ id: "fix-6", identifier: "FIX-6" }]);
  assert.equal(read.attempts[2].record.replacesThreadId, "thr_2");
  assert.deepEqual(read.attempts[2].mismatch, ["model"]);
  assert.equal(read.attempts[2].reported?.model, "claude-opus-5-5");
  assert.deepEqual(read.attempts.map((attempt) => attempt.verification), ["verified", "verified", "mismatch"]);
  assert.equal(read.firstVerifiedPolicyWorker?.threadId, "thr_2", "the cohort opens at the first verified policy Worker, even if later archived");
  assert.deepEqual(read.unrecorded.map((thread) => [thread.threadId, thread.parentThreadId]), [["thr_manual", "thr_1"]]);
  assert.deepEqual((await readLaunchRecords(bb, "proj-one", { specId: "fix-1" })).attempts, []);
});

test("a repo without shared defaults records its legacy Lead route, outside the policy cohort", async (t) => {
  const { harness, spawnArgs } = await setup(t, legacySettings, null);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  const record = spawnArgs(0).pluginMetadata.launch;
  assert.equal(record.role, "Lead");
  assert.equal(record.policyResolved, false);
  assert.deepEqual(record.requested, { providerId: "codex", model: "gpt-6.1-sol", effort: "high", serviceTier: "default" });
});

test("BB's own effort order must agree before a level counts as raised", () => {
  assert.deepEqual(compareEffort("max", "high", ["low", "medium", "high", "xhigh", "max", "ultra"]), { higher: true });
  const reversed = compareEffort("max", "high", ["max", "high"]);
  assert.equal(reversed.higher, false);
  assert.match(!reversed.higher ? reversed.problem : "", /BB lists max before high/);
  const unranked = compareEffort("ultra", "high", ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.match(!unranked.higher ? unranked.problem : "", /doesn't rank ultra/);
});

test("a partial BB report stays unknown: only known differing fields prove a substitution", () => {
  const requested = { providerId: "claude-code", model: "claude-sonnet-5-5", effort: "medium", serviceTier: "default" };
  const full = { providerId: "claude-code", model: "claude-sonnet-5-5", effort: "medium", serviceTier: "default" };
  assert.deepEqual(verify(requested, full), { mismatch: [], verification: "verified" });
  assert.deepEqual(verify(requested, null), { mismatch: [], verification: "unknown" });
  for (const field of ["providerId", "model", "effort", "serviceTier"] as const) {
    assert.deepEqual(verify(requested, { ...full, [field]: null }), { mismatch: [], verification: "unknown" }, `${field} absent`);
  }
  assert.deepEqual(verify(requested, { ...full, model: "claude-haiku-5-5", serviceTier: null }), { mismatch: ["model"], verification: "mismatch" },
    "a known substitution stays visible beside an unreported tier");
  assert.deepEqual(verify({ ...requested, effort: "default" }, { ...full, effort: null }), { mismatch: [], verification: "verified" },
    "BB's default effort needs no report");
});

test("an unverified policy Worker never opens the evaluation cohort", async (t) => {
  const { harness, native, bb, launch } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  assert.equal((await launch(["worker", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "p"])).exitCode, 0);
  assert.equal((await launch(["worker", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "p"])).exitCode, 0);
  native.routes.set("thr_2", { model: "claude-sonnet-5-5", reasoningLevel: "medium" });
  const read = await readLaunchRecords(bb, "proj-one");
  assert.deepEqual(read.attempts.map((attempt) => [attempt.threadId, attempt.verification, attempt.mismatch]),
    [["thr_1", "verified", []], ["thr_2", "unknown", []], ["thr_3", "verified", []]]);
  assert.equal(read.firstVerifiedPolicyWorker?.threadId, "thr_3");
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  const ticket = board.lanes[0].tickets.find((row) => row.id === "FIX-6")!;
  assert.equal(ticket.threadId, "thr_3");
});

test("the lane's chips say provider, model, effort and tier, a reported substitution in words, and the escalation reason", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { JSDOM } = await import("jsdom");
  const { BoardView } = await import("../board/Board.js");
  const requested = { providerId: "claude-code", model: "claude-sonnet-5-5", effort: "high", serviceTier: "default" };
  const reason = "First attempt was too thin.";
  const lane: import("../lib/board-model.js").Lane = { specId: "FIX-5", title: "Doctor checks", state: "flying", minutes: 3,
    lead: { family: "claude", providerId: "claude-code", model: "claude-haiku-5-5", effort: "high", serviceTier: "default" }, leadThreadId: "thr_1",
    launch: { role: "Lead", category: null, policyResolved: true, requested, reported: { ...requested, model: "claude-haiku-5-5" },
      mismatch: ["model"], verification: "mismatch", escalation: null, replacesThreadId: null },
    branch: "spec/fix-5", acceptOwner: false, tickets: [{ id: "FIX-6", title: "Settings parser", blockedBy: [], state: "working", minutes: 2, threadId: "thr_3",
      route: { family: "claude", model: "claude-sonnet-5-5", effort: "medium" },
      launch: { role: "Worker", category: null, policyResolved: true, requested: { ...requested, effort: "xhigh" }, reported: { ...requested, effort: "xhigh", serviceTier: "priority" },
        mismatch: ["serviceTier"], verification: "mismatch", escalation: { kind: "effort", reason }, replacesThreadId: "thr_2" } }] };
  const board: Board = { tick: 0, laneCapacity: 2, workersPerLane: 2, autoStart: false, lanes: [lane], ready: [], shaping: [], openIssues: [] };
  const html = renderToStaticMarkup(createElement(BoardView, { board, placement: "page", demo: false,
    modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined }));
  const doc = new JSDOM(html).window.document;
  const chips = [...doc.querySelectorAll(".sq-ai")];
  const leadChip = chips.find((chip) => chip.textContent?.includes("Lead"))!;
  assert.match(leadChip.getAttribute("title")!, /claude-code · claude-haiku-5-5 · high effort · default tier/);
  assert.match(leadChip.getAttribute("title")!, /instead of the requested claude-sonnet-5-5, high effort, default tier/);
  assert.equal(leadChip.querySelector(".sq-ai-swap")?.textContent, "substituted");
  const workerChip = chips.find((chip) => chip.textContent?.includes("xhigh"))!;
  assert.match(workerChip.textContent!, /claude-sonnet-5-5 xhigh · priority/, "a non-default tier is visible, not only on hover");
  assert.match(workerChip.getAttribute("title")!, new RegExp(`Effort raised: ${reason}`));
  assert.equal(workerChip.querySelector(".sq-ai-swap")?.textContent, "substituted");
});

test("effort-only escalation compares with the replaced attempt's own record: medium to high, then high to xhigh", async (t) => {
  const { harness, native, spawnArgs, launch } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  const worker = (...extra: string[]) => launch(["worker", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "p", ...extra]);
  assert.equal((await worker()).exitCode, 0);
  const first = await worker("--replaces", "thr_2", "--effort", "high", "--reason", "too thin");
  assert.equal(first.exitCode, 0, first.stderr);
  assert.deepEqual([spawnArgs(2).pluginMetadata.launch.requested.effort, spawnArgs(2).pluginMetadata.launch.escalation?.kind], ["high", "effort"]);
  // A same-effort retry of the escalated attempt is not an escalation, even though today's route is medium.
  const same = await worker("--replaces", "thr_3", "--effort", "high", "--reason", "again");
  assert.equal(same.exitCode, 1);
  assert.match(same.stderr, /high isn't higher than thr_3's high effort/);
  const second = await worker("--replaces", "thr_3", "--effort", "xhigh", "--reason", "still too thin");
  assert.equal(second.exitCode, 0, second.stderr);
  const record = spawnArgs(3).pluginMetadata.launch;
  assert.deepEqual([record.role, record.requested.model, record.requested.effort, record.replacesThreadId, record.escalation],
    ["Worker", "claude-sonnet-5-5", "xhigh", "thr_3", { kind: "effort", reason: "still too thin" }]);
  assert.deepEqual((native.metadata.get("thr_3") as { launch: LaunchRecord }).launch, spawnArgs(2).pluginMetadata.launch,
    "a replacement never rewrites the attempt it replaces");
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 4, "the refused retry launched nothing");
});

test("effort-only escalation refuses a changed role, provider or model and an unranked earlier effort", async (t) => {
  const { harness, native, launch } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  const run = (role: string, ...extra: string[]) => launch([role, "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "p", ...extra]);
  assert.equal((await run("worker-hard")).exitCode, 0);
  const demoted = await run("worker", "--replaces", "thr_2", "--effort", "high", "--reason", "cheaper");
  assert.equal(demoted.exitCode, 1, "a Worker (hard) Opus attempt can't be replaced by Worker Sonnet as an effort-only escalation");
  assert.match(demoted.stderr, /thr_2 ran as Worker \(hard\); an effort-only escalation keeps that role/);
  assert.equal((await run("worker")).exitCode, 0);
  const recorded = (native.metadata.get("thr_3") as { launch: LaunchRecord }).launch;
  for (const [changed, named] of [
    [{ ...recorded.requested, model: "claude-opus-5-5" }, /thr_3 ran on claude-code claude-opus-5-5, but today's Worker route is claude-code claude-sonnet-5-5/],
    [{ ...recorded.requested, providerId: "codex", model: "gpt-6.1-sol" }, /thr_3 ran on codex gpt-6.1-sol, but today's Worker route is claude-code claude-sonnet-5-5/],
    [{ ...recorded.requested, effort: "default" }, /BB doesn't rank default against thr_3's/],
    [{ ...recorded.requested, providerId: null, model: null }, /thr_3 ran on BB's default model, so a raised effort can't be compared/],
  ] as const) {
    // The earlier launch was made under different settings; its own record is what the escalation must match.
    native.metadata.set("thr_3", { launch: { ...recorded, requested: changed } });
    const refused = await run("worker", "--replaces", "thr_3", "--effort", "high", "--reason", "too thin");
    assert.equal(refused.exitCode, 1, JSON.stringify(changed));
    assert.match(refused.stderr, named);
  }
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 3, "no refused escalation launched a thread");
});

// SQD-258: the final review launches on the review route its recorded builders choose.
test("final-review: a Claude-built branch launches the GPT review route, and the board shows the same reviewer and boundary", async (t) => {
  const { harness, native, spawnArgs, launch } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  assert.equal((await launch(["worker", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "p"])).exitCode, 0);
  // Finished workers are archived; their records still say who built the ticket.
  native.threads.set("thr_2", { ...native.threads.get("thr_2")!, archivedAt: 5000 });
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  const boundary = "Claude builds 1 of 1 ticket so far, so the Review of claude-code route reviews. Independent of FIX-6.";
  assert.deepEqual(board.lanes[0].reviewer, { family: "gpt", providerId: "codex", model: "gpt-6.1-sol", effort: "high", role: "Review of claude-code" });
  assert.equal(board.lanes[0].finalReview, `Final review: codex gpt-6.1-sol, high effort, default tier. ${boundary}`);
  const reviewed = await launch(["final-review", "--base-branch", "spec/fix-5", "--prompt", "Review the whole branch."]);
  assert.equal(reviewed.exitCode, 0, reviewed.stderr);
  assert.match(reviewed.stdout, /Launched Review FIX-5 on codex gpt-6.1-sol, high effort, default tier @thread:thr_3/);
  assert.ok(reviewed.stdout.includes(boundary), reviewed.stdout);
  const args = spawnArgs(2);
  assert.deepEqual([args.providerId, args.model, args.reasoningLevel, args.serviceTier], ["codex", "gpt-6.1-sol", "high", "default"]);
  assert.equal(args.prompt, `Review the whole branch.\n\nFinal review: codex gpt-6.1-sol, high effort, default tier. ${boundary}`);
  const record = args.pluginMetadata.launch;
  assert.deepEqual([record.role, record.tickets, record.escalation, record.leadThreadId], ["Review of claude-code", [], null, "thr_1"]);
});

test("final-review: a GPT Lead with a Claude worker still launches the GPT review route", async (t) => {
  const gptLead = shared.replace("| Label | Provider | Model | Effort |", "| Label | Provider | Model | Effort | Note |")
    .replace("|---|---|---|---|", "|---|---|---|---|---|")
    .replace("| ui | claude-code | claude-opus-5-5 | high |", "| Lead | codex | gpt-6.1-sol | medium | override: FIX-5 lane, Josh fixture approval |");
  const { harness, spawnArgs, launch } = await setup(t, gptLead);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  assert.equal(spawnArgs(0).providerId, "codex");
  assert.equal((await launch(["worker", "--ticket", "FIX-6", "--base-branch", "spec/fix-5", "--prompt", "p"])).exitCode, 0);
  assert.equal(spawnArgs(1).providerId, "claude-code");
  const reviewed = await launch(["final-review", "--base-branch", "spec/fix-5", "--prompt", "Review."]);
  assert.equal(reviewed.exitCode, 0, reviewed.stderr);
  assert.deepEqual([spawnArgs(2).providerId, spawnArgs(2).model, spawnArgs(2).reasoningLevel], ["codex", "gpt-6.1-sol", "high"]);
  assert.equal(spawnArgs(2).pluginMetadata.launch.role, "Review of claude-code");
});

test("final-review refuses, launching nothing, when no ticket has a recorded builder: unrecorded threads are never synthesised", async (t) => {
  const { harness, native, launch } = await setup(t);
  await harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" });
  native.threads.set("thr_manual", makeThreadResponse({ id: "thr_manual", projectId: "proj-one", parentThreadId: "thr_1", providerId: "codex", createdAt: 9000 }));
  native.threads.set("thr_manual_done", makeThreadResponse({ id: "thr_manual_done", projectId: "proj-one", parentThreadId: "thr_1", providerId: "claude-code", createdAt: 9500, archivedAt: 9900 }));
  const refused = await launch(["final-review", "--base-branch", "spec/fix-5", "--prompt", "Review."]);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr, /no reviewer chosen\. No ticket has a recorded builder, and 2 threads in this lane have no launch record\./);
  for (const extra of [["--ticket", "FIX-6"], ["--effort", "xhigh"], ["--reason", "why"]]) {
    const wrong = await launch(["final-review", "--base-branch", "spec/fix-5", "--prompt", "Review.", ...extra]);
    assert.equal(wrong.exitCode, 1, extra.join(" "));
    assert.match(wrong.stderr, /final review/i);
  }
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1, "only the Lead was ever launched");
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.lanes[0].reviewer, undefined, "the board shows no placeholder reviewer either");
  assert.match(board.lanes[0].finalReview ?? "", /no reviewer chosen/);
});
