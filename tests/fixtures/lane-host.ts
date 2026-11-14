// SDK plugin-host fixture for lane lifecycle and Needs-you notifications.
// Synthetic recorded Linear responses and fake BB threads only.
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeQueueEntry, makeThreadResponse, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerSquadron } from "../../server.js";
import type { Board } from "../../lib/board-model.js";
import { binding, workspace, workspaceIssues } from "./board-workspace.js";
import { end, ready } from "./linear-mirror.js";

const settings = readFileSync("tests/fixtures/squadron.md", "utf8");
export const commit = "a".repeat(40);
const head = "b".repeat(40);

export interface Push { title: string; body?: string; threadId?: string }

export async function laneHost(t: import("node:test").TestContext, options: { queueNudges?: boolean; now?: () => number; pushFails?: boolean; leadSpawnFails?: boolean; leadEnvironmentGate?: Promise<void>;
  /** Holds the first write's identity check after the Lead's worktree is ready: the start status enqueue, in flight. */
  holdStartWrite?: Promise<void> } = {}) {
  const nodes = structuredClone(workspaceIssues.data.issues.nodes);
  const original = nodes.find((issue) => issue.id === "fix-6")!;
  for (const i of [7, 8]) nodes.push({ ...structuredClone(original), id: `fix-${i}`, identifier: `FIX-${i}`, title: `Ticket ${i}` });
  const linear = workspace({ issues: () => Response.json({ data: { issues: { nodes, pageInfo: end } } }),
    vocabulary: () => Response.json({ data: { workflowStates: { nodes: [ready,
      { id: "state-started", name: "In Progress", type: "started" }, { id: "state-review", name: "In Review", type: "started" }], pageInfo: end },
      issueLabels: { nodes: [], pageInfo: end } } }) });
  const mutations: Array<{ query: string; variables: { id?: string; input: Record<string, string> } }> = [];
  let armed = false;
  let reached!: () => void;
  const startWriteHeld = new Promise<void>((resolve) => { reached = resolve; });
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (armed && body.query.includes("SquadronIdentity")) { armed = false; reached(); await options.holdStartWrite; }
    if (!body.query.trimStart().startsWith("mutation")) return linear.fetch(url, init);
    mutations.push(body);
    return Response.json({ data: body.query.includes("issueUpdate") ? { issueUpdate: { success: true, issue: { id: body.variables.id } } }
      : { commentCreate: { success: true, comment: { id: body.variables.input.id } } } });
  });
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const queued = new Map<string, number>();
  const nudgeRows: ReturnType<typeof makeQueueEntry>[] = [];
  const sends: Array<{ threadId: string; text: string }> = [];
  const pushes: Push[] = [];
  const levels: Array<{ threadId: string; level: string }> = [];
  let count = 0;
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", agentSkillIds: ["squadron-planner", "squadron-lead", "squadron-worker"], settings: { linearApiKey: "fake-lane-key" },
    experimental_callHostRpc: async (request) => request.method === "verifyWorkerCommit" ? { verified: true, head } : { authenticated: true },
    sdk: {
      projects: { get: async ({ projectId }) => ({ id: projectId, name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId, hostId: "repo-host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
      files: { read: async ({ path }) => ({ content: settings, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: settings.length }) },
      skills: { list: async () => ({ skills: ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"].map((name) =>
        ({ id: name, name, description: null, manageable: false, pluginId: null, provider: null, registrySkillId: null,
          scope: "shared-project" as const, filePath: `/repo/.agents/skills/${name}/SKILL.md` })) }) },
      plugins: { callRpc: async (args) => {
        if (args.pluginId !== "push-notifications") throw new Error("unexpected plugin");
        if (args.method === "threadNotifications.set") { levels.push(args.input as unknown as { threadId: string; level: string }); return { ok: true }; }
        if (args.method !== "notifications.send") throw new Error("unexpected method");
        if (options.pushFails) throw new Error("fake-private-push-error");
        pushes.push(args.input as unknown as Push);
        return { ok: true, channels: ["mobile"] };
      } },
      threads: {
        queuedMessages: {
          list: async ({ threadId }) => Array.from({ length: queued.get(threadId) ?? 0 }, (_, i) => makeQueueEntry({ id: `queued-${threadId}-${i}`, threadId })),
          send: async ({ threadId }) => {
            queued.set(threadId, Math.max(0, (queued.get(threadId) ?? 0) - 1));
            const value = threads.get(threadId)!;
            threads.set(threadId, { ...value, environmentId: `env-${threadId}` });
            return { ok: true as const, delivery: "sent" as const };
          },
        },
        send: async (args) => {
          sends.push({ threadId: args.threadId, text: args.input.map((part) => "text" in part ? part.text : "").join("") });
          if (options.queueNudges && args.input.some((part) => "text" in part && part.text.includes("Act at once"))) {
            const entry = makeQueueEntry({ id: `nudge-${nudgeRows.length}`, threadId: args.threadId });
            nudgeRows.push(entry);
            return { ok: true as const, delivery: "queued" as const, queuedMessage: entry };
          }
          return { ok: true as const, delivery: "sent" as const };
        },
        stop: async ({ threadId }) => ({ threadId, stopped: true }),
        spawn: async (args) => {
          if (options.leadSpawnFails && count === 0) throw new Error("fake-private-spawn-error");
          const id = count++ === 0 ? "thr_lead" : `thr_worker_${count}`;
          queued.set(id, 1);
          const value = makeThreadResponse({ id, projectId: args.projectId, environmentId: null, parentThreadId: args.parentThreadId ?? null });
          threads.set(id, value); return value;
        },
        get: async ({ threadId }) => threads.get(threadId) ?? makeThreadResponse({ id: threadId, projectId: "proj-one" }),
      },
      environments: { get: async ({ environmentId }) => {
        if (environmentId === "env-thr_lead") { await options.leadEnvironmentGate; if (options.holdStartWrite && !mutations.length) armed = true; }
        return { id: environmentId, projectId: "proj-one", hostId: "repo-host", status: "ready" as const,
        branchName: environmentId === "env-thr_lead" ? "bb/integration" : `bb/${environmentId}`, path: "/worktree",
        baseBranch: environmentId === "env-thr_lead" ? "main" : "bb/integration", defaultBranch: "main", mergeBaseBranch: "main", name: null, createdAt: 0, updatedAt: 0,
        environmentProviderId: "environment-git-worktree", environmentProviderInstanceKey: "fixture", environmentProviderSelection: null,
        hostLifecycle: "active", isGitRepo: true, isWorktree: true, managed: true, workspaceProvisionType: "managed-worktree",
        lifecycle: { phase: "active", retireAt: null, teardown: null } }; } },
    },
  });
  t.after(async () => { fetch.mock.restore(); await harness.lifecycle.dispose(); });
  const { safety } = await registerSquadron(bb, { now: options.now }); await harness.behavior.callRpc("linear.bind", binding);
  const lead = { threadId: "thr_lead", projectId: "proj-one" };
  const call = async (name: string, input: unknown, context = lead) => JSON.parse(String(await harness.behavior.callAgentTool(name, input, context)));
  const board = async () => await harness.behavior.callRpc("board", { projectId: "proj-one" }) as Board;
  const rpc = async (method: string, input: Record<string, unknown> = {}) => await harness.behavior.callRpc(method, { projectId: "proj-one", specId: "FIX-5", ...input });
  /** A message reaching a thread, as BB's dispatch checkpoint sees it. */
  const dispatch = async (threadId: string, from: { initiator: "user" | "agent" | "system"; senderThreadId?: string | null; originPluginId?: string | null }) =>
    await harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread: { id: threadId }, project: { id: "proj-one" },
      initiator: from.initiator, senderThreadId: from.senderThreadId ?? null, ...(from.originPluginId ? { originPluginId: from.originPluginId } : {}) }));
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 2)); };
  return { nudgeRows, safety, startWriteHeld, bb: bb as BbPluginApi, harness, call, board, rpc, dispatch, settle, mutations, threads, queued, sends, pushes, levels };
}
