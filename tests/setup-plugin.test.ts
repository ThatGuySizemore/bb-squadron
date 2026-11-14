// SIZE-953: Set up, and seeing a board before starting. The real server.ts on
// the SDK's fake plugin host, with recorded Linear responses.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server.js";
import type { Board } from "../lib/board-model.js";
import { parseSquadronSettings } from "../lib/squadron-settings.js";
import { DEFAULT_SQUADRON_TEMPLATE } from "../lib/squadron-template.js";
import { binding, workspace } from "./fixtures/board-workspace.js";

const skillNames = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];
const allSetupFiles = ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"];

/** A project with Matt's plugin installed but no docs/agents/squadron.md. */
function host(options: { setupFiles: string[] }) {
  const spawned: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0][] = [];
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  const fake = createFakePluginHost({
    pluginId: "squadron", experimental_hostEntry: true,
    settings: { linearApiKey: "fake-setup-key" },
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
        throw new Error("ENOENT: no such file");
      } },
      skills: { list: async () => ({ skills: ["claude-code", "codex"].flatMap((provider) => skillNames.map((name) => ({
        id: `${provider}-${name}`, name: `mattpocock-skills:${name}`, description: null,
        filePath: `/plugins/${provider}/${name}/SKILL.md`, manageable: false, pluginId: "mattpocock-skills", provider,
        registrySkillId: null, scope: "plugin" as const,
      }))) }) },
      threads: {
        spawn: async (args) => {
          spawned.push(args);
          const thread = makeThreadResponse({ id: `thr_setup_${spawned.length}`, projectId: args.projectId });
          threads.set(thread.id, thread); metadata.set(thread.id, args.pluginMetadata ?? {});
          return thread;
        },
        list: async () => [...threads.values()],
        getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
      },
    },
    experimental_callHostRpc: async ({ method, input }) => method === "githubLogin" ? { authenticated: true } : {
      homePath: "/owner", repoRulesExists: true, playbookExists: true, machineProfileExists: true,
      setupFiles: options.setupFiles, regularSkillFiles: (input as { skillPaths: string[] }).skillPaths,
    },
  });
  return { ...fake, spawned };
}

async function setup(t: import("node:test").TestContext, options: { setupFiles: string[] }) {
  const linear = workspace();
  const fetch = mock.method(globalThis, "fetch", linear.fetch);
  const found = host(options);
  t.after(async () => { fetch.mock.restore(); await found.harness.lifecycle.dispose(); });
  await plugin(found.bb);
  await found.harness.behavior.callRpc("linear.bind", binding);
  return found;
}

test("a project without squadron.md still shows its board, and Start explains what's missing", async (t) => {
  const { harness, spawned } = await setup(t, { setupFiles: allSetupFiles });
  const board = await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  assert.equal(board.tracker?.state, "current");
  assert.deepEqual(board.ready.map((spec) => spec.id), ["FIX-1", "FIX-5"], "Ready shows without project settings");
  assert.deepEqual(board.openIssues.map((issue) => issue.id), ["FIX-9"]);
  const reason = board.ready.find((spec) => spec.id === "FIX-5")?.startReason;
  assert.match(reason ?? "", /docs\/agents\/squadron\.md/, "Start names the missing file");
  assert.match(reason ?? "", /Set up/, "and the button that fixes it");
  await assert.rejects(harness.behavior.callRpc("lane.start", { projectId: "proj-one", specId: "FIX-5" }), (error: Error) => error.message === reason);
  assert.equal(spawned.length, 0, "no Lead starts");
});

test("Set up starts one thread in the project checkout that runs Matt's setup when it's missing, then writes squadron.md from the default template", async (t) => {
  const { harness, spawned } = await setup(t, { setupFiles: ["docs/agents/issue-tracker.md"] });
  const started = await harness.behavior.callRpc("planning.setup", { projectId: "proj-one" }) as { threadId: string };
  assert.equal(started.threadId, "thr_setup_1");
  assert.equal(spawned.length, 1);
  const [args] = spawned;
  assert.deepEqual(args.environment, { type: "host", hostId: "repo-machine", workspace: { type: "unmanaged", path: "/repo" } });
  assert.deepEqual(args.pluginMetadata, { role: "setup" });
  assert.equal(args.visibility, "visible");
  assert.match(args.title ?? "", /Set up/);
  const prompt = String(args.prompt);
  assert.match(prompt, /setup-matt-pocock-skills/);
  assert.match(prompt, /docs\/agents\/triage-labels\.md/, "names the missing setup files");
  assert.ok(prompt.indexOf("setup-matt-pocock-skills") < prompt.indexOf("docs/agents/squadron.md"), "Matt's setup comes first");
  assert.ok(prompt.includes(DEFAULT_SQUADRON_TEMPLATE.trim()), "the default template is in the seed");

  const again = await harness.behavior.callRpc("planning.setup", { projectId: "proj-one" }) as { threadId: string };
  assert.equal(again.threadId, "thr_setup_1", "a second Set up reopens the open setup thread");
  assert.equal(spawned.length, 1);
});

test("Set up skips Matt's setup when its files are present", async (t) => {
  const { harness, spawned } = await setup(t, { setupFiles: allSetupFiles });
  await harness.behavior.callRpc("planning.setup", { projectId: "proj-one" });
  const prompt = String(spawned[0].prompt);
  assert.ok(!/Run the setup-matt-pocock-skills/.test(prompt), "no setup run is asked for");
  assert.match(prompt, /docs\/agents\/squadron\.md/);
});

test("Set up refuses calls that don't come from the board", async (t) => {
  const { harness } = await setup(t, { setupFiles: allSetupFiles });
  await assert.rejects(harness.behavior.callRpc("planning.setup", { projectId: "proj-one" }, { experimental_caller: { kind: "plugin", pluginId: "other" } }), /Set up a project from the Squadron board/);
});

test("the default squadron.md template is valid settings for every tracker", () => {
  for (const kind of ["linear", "github", "local-markdown"] as const) {
    assert.equal(parseSquadronSettings(DEFAULT_SQUADRON_TEMPLATE, kind).ok, true, kind);
  }
});
