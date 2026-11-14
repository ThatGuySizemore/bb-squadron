import type { TestContext } from "node:test";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../../server.js";
import type { Board } from "../../lib/board-model.js";
import { workspace } from "./board-workspace.js";

export async function settle() { for (let i = 0; i < 40; i++) await setImmediate(); }
export async function helperFixture(t: TestContext, epoch: number, options: Parameters<typeof workspace>[0] = {}, storedNotifications?: unknown) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  const linear = workspace(options);
  t.mock.method(globalThis, "fetch", linear.fetch);
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const events = new Map<string, Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>>();
  const projects = ["one", "two"].map((id) => ({ id, name: id === "one" ? "Fixture" : "Second", kind: "standard" as const, gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }));
  let mainCheck = async () => ({ passed: true, logPath: "/scratch/main.log", mergedCommit: "a".repeat(40), baseCommit: "b".repeat(40) });
  const fake = createFakePluginHost({ pluginId: "squadron", experimental_hostEntry: true,
    settings: { linearApiKey: "fake-wake-key" }, sdk: {
      projects: { list: async () => projects, get: async ({ projectId }) => ({ ...projects.find((p) => p.id === projectId)!,
        sources: [{ id: "source", projectId, hostId: "host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
      files: { read: async ({ path }) => { const content = readFileSync(path.endsWith("issue-tracker.md") ? "tests/fixtures/trackers/bb-squadron.md" : "tests/fixtures/squadron.md", "utf8");
        return { path, content, contentEncoding: "utf8", sha256: "fixture", sizeBytes: content.length }; } },
      skills: { list: async () => ({ skills: ["codex", "claude-code"].flatMap((provider) => ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"].map((name) => ({
        id: `${provider}-${name}`, name: `mattpocock-skills:${name}`, description: null, filePath: `/plugins/${provider}/${name}/SKILL.md`, manageable: false, pluginId: "mattpocock-skills", provider, registrySkillId: null, scope: "plugin" as const,
      }))) }) },
      threads: {
        events: { list: async ({ threadId, types, limit }) => (events.get(threadId) ?? []).filter((event) => !types || types.includes(event.type)).slice(0, Number(limit ?? 100)) },
        list: async (args) => [...threads.values()].filter((thread) => thread.projectId === args?.projectId &&
          (!args?.parentThreadId || thread.parentThreadId === args.parentThreadId)).map((thread) => ({ ...thread, environmentBranchName: "spec/fix-5", hasPendingInteraction: thread.title === "Question" })),
        get: async ({ threadId }) => { const thread = threads.get(threadId); if (!thread) throw new Error("Thread not found"); return thread; },
        getPluginMetadata: async ({ threadId }) => threadId.startsWith("lead-") ? { role: "lead", specId: "fix-5" } : {},
        defaultExecutionOptions: async () => ({ model: "gpt-6.1-sol", reasoningLevel: "medium", permissionMode: "auto", serviceTier: "default", source: "client/turn/start" }),
        send: async () => ({ ok: true, delivery: "queued" }),
      },
    }, experimental_callHostRpc: async ({ method, input }) => method === "runMainQuickCheck" ? mainCheck() : method === "githubLogin" ? { authenticated: true } : method === "readRepositoryState"
      ? { hasRemote: true, mainUpdatedAt: null, mergedBranches: [], mergedBranchUpdatedAt: {} }
      : { homePath: "/owner", repoRulesExists: true, playbookExists: true, machineProfileExists: true,
        setupFiles: ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"], regularSkillFiles: (input as { skillPaths: string[] }).skillPaths },
  });
  if (storedNotifications !== undefined) await fake.bb.storage.kv.set("helper.notifications.v1", storedNotifications);
  let harness = fake.harness;
  t.after(async () => { await harness.lifecycle.dispose(); t.mock.timers.reset(); });
  await plugin(fake.bb);
  const lead = (projectId: string, title = "Question") => {
    const thread = makeThreadResponse({ id: `lead-${projectId}`, projectId, title, status: "active", environmentId: `env-${projectId}`, createdAt: epoch });
    threads.set(thread.id, thread); return thread;
  };
  const helper = makeThreadResponse({ id: "helper", projectId: "one", status: "active" });
  threads.set(helper.id, helper);
  // Choose through SQD-199's public path; ignore only its skill-seeding send.
  await harness.behavior.callRpc("helper.use", { projectId: "one", threadId: "helper" });
  const sends = () => harness.inspection.sdk.callsTo("threads.send").map((call) => call[0] as { threadId: string; mode: string; input: { text: string }[] })
    .filter((call) => !call.input[0].text.startsWith("Use the squadron-helper skill"));
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await settle(); };
  return { threads, projects, lead, sends, advance, linear, events,
    setMainCheck: (check: typeof mainCheck) => { mainCheck = check; },
    get harness() { return harness; },
    startWatcher: async () => { harness.behavior.runService("board-watcher"); await settle(); },
    reload: async () => { ({ harness } = await harness.lifecycle.reload(plugin)); },
    board: async (projectId = "one") => await harness.behavior.callRpc("board", { projectId, visibleLaneIds: [] }) as Board,
  };
}
