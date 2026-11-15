// SQD-259: Planning launches obey Squadron policy through the public planning.start RPC.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { workspace } from "./fixtures/board-workspace.js";
import { end, ready } from "./fixtures/linear-mirror.js";
import { shared, houseWith } from "./fixtures/model-routes.js";

const vocabulary = () => Response.json({ data: { workflowStates: { nodes: [ready], pageInfo: end }, issueLabels: { nodes: [], pageInfo: end } } });
const legacySettings = readFileSync("tests/fixtures/squadron.md", "utf8");
const withPlanningDefault = (markdown: string) => markdown.replace("| Planning | claude-code | claude-opus-5-5 | medium |", "| Planning | claude-code | claude-opus-5-5 | default |");
type Models = { id: string; efforts: string[]; defaultEffort?: string }[];
const known = (defaultEffort?: string): Models => [
  { id: "claude-sonnet-5-5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "claude-opus-5-5", efforts: ["low", "medium", "high"], ...(defaultEffort ? { defaultEffort } : {}) },
];

async function setup(t: import("node:test").TestContext, options: { settings: string | null; house: string | null; models: Models }) {
  const linear = workspace({ vocabulary });
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  let spawned = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "squadron", experimental_hostEntry: true, settings: { linearApiKey: "fake-planning-policy" },
    sdk: {
      projects: { get: async ({ projectId }) => ({ id: projectId, name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId, hostId: "repo-machine", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
      files: { read: async ({ path }) => {
        if (path === "/repo/docs/agents/squadron.md" && options.settings === null) throw new Error("missing");
        const content = path === "/repo/docs/agents/issue-tracker.md" ? readFileSync("tests/fixtures/trackers/bb-squadron.md", "utf8") : options.settings!;
        return { content, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: content.length };
      } },
      providers: {
        list: async () => [{ id: "claude-code" }, { id: "codex" }],
        models: async (args) => ({ modelLoadError: null, models: (args?.providerId === "claude-code" ? options.models : [{ id: "gpt-6.1-sol", efforts: ["medium", "high"], defaultEffort: "high" }])
          .map((model) => ({ id: model.id, supportedReasoningEfforts: model.efforts.map((reasoningEffort) => ({ reasoningEffort })),
            ...(model.defaultEffort ? { defaultReasoningEffort: model.defaultEffort } : {}) })) }),
      },
      threads: {
        spawn: async (args) => makeThreadResponse({ id: `thr_plan_${++spawned}`, projectId: args.projectId }),
        list: async () => [], getPluginMetadata: async () => ({}), updatePluginMetadata: async () => ({}),
      },
    },
    experimental_callHostRpc: async ({ method }) => method === "readModelRoutes" ? { markdown: options.house, policy: null } : { authenticated: true },
  });
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  const plan = () => harness.behavior.callRpc("planning.start", { projectId: "proj-one" });
  const spawns = () => harness.inspection.sdk.callsTo("threads.spawn");
  return { plan, spawns };
}

test("Planning on a native default that BB advertises as low is refused with no spawn, under off and mechanical only", async (t) => {
  for (const rows of [null, ["| Low effort | off |"], ["| Low effort | mechanical only |"]]) {
    const { plan, spawns } = await setup(t, { settings: shared, house: withPlanningDefault(houseWith(rows)), models: known("low") });
    await assert.rejects(plan(), /Planning route.*claude-code claude-opus-5-5's default effort \(low/s);
    assert.equal(spawns().length, 0);
  }
});

test("Planning on a higher or unreported native default still launches, requesting default", async (t) => {
  for (const models of [known("medium"), known()]) {
    const { plan, spawns } = await setup(t, { settings: shared, house: withPlanningDefault(houseWith(["| Low effort | off |"])), models });
    assert.deepEqual(await plan(), { threadId: "thr_plan_1" });
    const args = spawns()[0][0] as Record<string, unknown> & { pluginMetadata: { launch: { requested: unknown; policyResolved: boolean } } };
    assert.deepEqual([args.providerId, args.model, "reasoningLevel" in args], ["claude-code", "claude-opus-5-5", false]);
    assert.deepEqual(args.pluginMetadata.launch.requested, { providerId: "claude-code", model: "claude-opus-5-5", effort: "default", serviceTier: "default" });
    assert.equal(args.pluginMetadata.launch.policyResolved, true);
  }
});

test("configured settings that don't resolve refuse planning by name instead of launching on BB's default", async (t) => {
  const badPolicy = await setup(t, { settings: shared, house: houseWith(["| Escalation | maybe |"]), models: known("medium") });
  await assert.rejects(badPolicy.plan(), /Escalation.*maybe/s);
  assert.equal(badPolicy.spawns().length, 0);
  const unrunnable = await setup(t, { settings: shared, house: houseWith(null).replace("| Planning | claude-code | claude-opus-5-5 | medium |", "| Planning | claude-code | claude-opus-5-5 | ultra |"), models: known("medium") });
  await assert.rejects(unrunnable.plan(), /Planning.*ultra/s);
  assert.equal(unrunnable.spawns().length, 0);
});

test("absent project settings keep legacy planning on BB's default model", async (t) => {
  const { plan, spawns } = await setup(t, { settings: null, house: null, models: known("low") });
  assert.deepEqual(await plan(), { threadId: "thr_plan_1" });
  const args = spawns()[0][0] as Record<string, unknown>;
  assert.equal(args.providerId, undefined);
  assert.equal(args.model, undefined);
});

test("legacy settings with an unspecified Planning route keep launching on BB's default", async (t) => {
  const { plan, spawns } = await setup(t, { settings: legacySettings, house: null, models: known("low") });
  assert.deepEqual(await plan(), { threadId: "thr_plan_1" });
  assert.equal((spawns()[0][0] as Record<string, unknown>).model, undefined);
});
