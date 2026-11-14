import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Board } from "../lib/board-model.js";
import { workspace } from "./fixtures/board-workspace.js";

const epoch = Date.parse("2026-11-14T14:00:00Z");
async function settle() { for (let i = 0; i < 40; i++) await setImmediate(); }
async function fixture(t: TestContext, options: Parameters<typeof workspace>[0] = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  const linear = workspace(options);
  t.mock.method(globalThis, "fetch", linear.fetch);
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const events = new Map<string, Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>>();
  const projects = ["one", "two"].map((id) => ({ id, name: id === "one" ? "Fixture" : "Second", kind: "standard" as const, gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }));
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
    }, experimental_callHostRpc: async ({ method, input }) => method === "githubLogin" ? { authenticated: true } : method === "readRepositoryState"
      ? { hasRemote: true, mainUpdatedAt: null, mergedBranches: [], mergedBranchUpdatedAt: {} }
      : { homePath: "/owner", repoRulesExists: true, playbookExists: true, machineProfileExists: true,
        setupFiles: ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"], regularSkillFiles: (input as { skillPaths: string[] }).skillPaths },
  });
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
    get harness() { return harness; },
    startWatcher: async () => { harness.behavior.runService("board-watcher"); await settle(); },
    reload: async () => { ({ harness } = await harness.lifecycle.reload(plugin)); },
    board: async (projectId = "one") => await harness.behavior.callRpc("board", { projectId, visibleLaneIds: [] }) as Board,
  };
}

test("registered daily schedule queues one summary per project at 08:00 server local", async (t) => {
  const previous = process.env.TZ;
  process.env.TZ = "America/Chicago";
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  const f = await fixture(t);
  f.lead("one", "Lead"); f.lead("two");
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.deepEqual(f.sends(), [{ threadId: "helper", mode: "queue-if-active", input: [{ type: "text", mentions: [], text:
    "Daily summary\nFixture | Landed since last summary: none | Flying: FIX-5 | Needs you: 0\nSecond | Landed since last summary: none | Flying: FIX-5 | Needs you: 1" }] }]);
  await Promise.all([f.harness.behavior.runSchedule("helper-daily-summary"), f.harness.behavior.runSchedule("helper-daily-summary")]);
  assert.equal(f.sends().length, 1);
  await f.reload();
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.equal(f.sends().length, 0);
});

test("time changes apply immediately, Off and no Helper send nothing, and the local day sends once", async (t) => {
  const f = await fixture(t);
  const run = () => f.harness.behavior.runSchedule("helper-daily-summary");
  await f.harness.behavior.setSettings({ dailySummaryTime: "23:59" });
  await run();
  assert.equal(f.sends().length, 0);
  await f.harness.behavior.setSettings({ dailySummaryTime: "Off" });
  await run();
  assert.equal(f.sends().length, 0);
  await f.harness.behavior.setSettings({ dailySummaryTime: "00:00" });
  f.threads.delete("helper");
  await run();
  assert.equal(f.sends().length, 0);
  f.threads.set("helper", makeThreadResponse({ id: "helper", projectId: "one", status: "active" }));
  await run();
  assert.equal(f.sends().length, 1);
  await f.harness.behavior.setSettings({ dailySummaryTime: "01:00" });
  await run();
  assert.equal(f.sends().length, 1, "a settings change doesn't cause a second summary today");
  await assert.rejects(f.harness.behavior.setSettings({ dailySummaryTime: "25:00" }));
  await assert.rejects(f.harness.behavior.setSettings({ dailySummaryTime: "8am" }));
});

test("failed sends preserve observed landings across reload even when their Lead disappears", async (t) => {
  const f = await fixture(t);
  await f.harness.behavior.setSettings({ dailySummaryTime: "00:00" });
  f.lead("one", "Lead");
  const run = () => f.harness.behavior.runSchedule("helper-daily-summary");
  await run();
  await f.advance(86_400_000);
  f.harness.sdk.stub("plugins.callRpc", async () => ({ "env-one": { outcome: "available", pullRequest: {
    number: 12, state: "merged", url: "https://github.example/fixture/pull/12", updatedAt: new Date(Date.now()).toISOString(), checks: { state: "passing" },
  } } }));
  f.harness.sdk.stub("threads.send", async () => { throw new Error("delivery failed"); });
  await assert.rejects(run(), /delivery failed/);
  await f.reload();
  f.threads.delete("lead-one");
  f.harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "queued" }));
  await run();
  assert.equal(f.sends()[0].input[0].text,
    "Daily summary\nFixture | Landed since last summary: FIX-5 | Flying: none | Needs you: 0\nSecond | Landed since last summary: none | Flying: none | Needs you: 0");
  await f.advance(86_400_000);
  await f.reload();
  f.lead("one", "Lead");
  f.harness.sdk.stub("plugins.callRpc", async () => ({ "env-one": { outcome: "available", pullRequest: {
    number: 12, state: "merged", url: "https://github.example/fixture/pull/12", updatedAt: "2026-11-15T14:00:00Z", checks: { state: "passing" },
  } } }));
  await run();
  assert.equal(f.sends()[0].input[0].text,
    "Daily summary\nFixture | Landed since last summary: none | Flying: none | Needs you: 0\nSecond | Landed since last summary: none | Flying: none | Needs you: 0");
});

test("default time follows server-local DST, including a skipped time and a repeated hour", async (t) => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  const f = await fixture(t);
  const run = () => f.harness.behavior.runSchedule("helper-daily-summary");
  t.mock.timers.setTime(Date.parse("2026-11-14T12:59:00Z"));
  await run();
  assert.equal(f.sends().length, 0, "07:59 server local is before the default");
  t.mock.timers.setTime(Date.parse("2026-11-14T13:00:00Z"));
  await run();
  assert.equal(f.sends().length, 1, "08:00 server local sends, independent of UTC");
  await f.harness.behavior.setSettings({ dailySummaryTime: "02:30" });
  t.mock.timers.setTime(Date.parse("2027-03-14T06:59:00Z"));
  await run();
  assert.equal(f.sends().length, 1);
  t.mock.timers.setTime(Date.parse("2027-03-14T07:00:00Z"));
  await run();
  assert.equal(f.sends().length, 2, "a skipped local time catches up at 03:00");
  await f.harness.behavior.setSettings({ dailySummaryTime: "01:30" });
  t.mock.timers.setTime(Date.parse("2027-11-07T05:30:00Z"));
  await run();
  assert.equal(f.sends().length, 3);
  await f.reload();
  t.mock.timers.setTime(Date.parse("2027-11-07T06:30:00Z"));
  await run();
  assert.equal(f.sends().length, 0, "the repeated 01:30 doesn't send again after reload");
});

test("shared unattended observation retains a landing while summary is Off and the lane later disappears", async (t) => {
  const f = await fixture(t);
  await f.harness.behavior.setSettings({ dailySummaryTime: "Off" });
  f.lead("one", "Lead");
  await f.startWatcher();
  f.harness.sdk.stub("plugins.callRpc", async () => ({ "env-one": { outcome: "available", pullRequest: {
    number: 12, state: "merged", url: "https://github.example/fixture/pull/12", updatedAt: new Date(Date.now()).toISOString(), checks: { state: "passing" },
  } } }));
  await f.advance(30_000);
  await f.reload();
  f.threads.delete("lead-one");
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.equal(f.sends().length, 0);
  await f.harness.behavior.setSettings({ dailySummaryTime: "00:00" });
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.equal(f.sends()[0].input[0].text,
    "Daily summary\nFixture | Landed since last summary: FIX-5 | Flying: none | Needs you: 0\nSecond | Landed since last summary: none | Flying: none | Needs you: 0");
});

test("turning summary Off during board reads cancels delivery without consuming landing history", async (t) => {
  const f = await fixture(t);
  await f.harness.behavior.setSettings({ dailySummaryTime: "00:00" });
  f.lead("one", "Lead");
  f.harness.sdk.stub("plugins.callRpc", async () => {
    await f.harness.behavior.setSettings({ dailySummaryTime: "Off" });
    return { "env-one": { outcome: "available", pullRequest: {
      number: 12, state: "merged", url: "https://github.example/fixture/pull/12", updatedAt: new Date(Date.now()).toISOString(), checks: { state: "passing" },
    } } };
  });
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.equal(f.sends().length, 0);
  f.threads.delete("lead-one");
  await f.harness.behavior.setSettings({ dailySummaryTime: "00:00" });
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.equal(f.sends()[0].input[0].text,
    "Daily summary\nFixture | Landed since last summary: FIX-5 | Flying: none | Needs you: 0\nSecond | Landed since last summary: none | Flying: none | Needs you: 0");
});
