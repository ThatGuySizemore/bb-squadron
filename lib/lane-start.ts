import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { laneContract, RESUME_MESSAGE, STOP_MESSAGE } from "./lane-contract.js";
import { deriveBoard } from "./board-derive.js";
import { readLeadThreads } from "./lead-threads.js";
import { readProjectCheckout } from "./project-checkout.js";
import { resolveRoute } from "./squadron-settings.js";
import type { DoctorReport } from "./doctor.js";
import type { MirrorSnapshot } from "./linear-mirror-contract.js";
import { boardChanged, publishSquadronSignal } from "./realtime-contract.js";
import { PULL_REQUEST_PLUGIN, readPullRequests } from "./pull-requests.js";
import { canMerge } from "./board-model.js";
import { z } from "zod";
import { linearTrackerSnapshot } from "./tracker-snapshot.js";

export function registerLaneStart(bb: BbPluginApi, sources: {
  mirror: { getSnapshot(projectId: string): MirrorSnapshot };
  doctor(projectId: string): Promise<DoctorReport>;
}) {
  const starting = new Map<string, Promise<{ threadId: string }>>();
  async function start(projectId: string, specId: string) {
    const snapshot = sources.mirror.getSnapshot(projectId);
    const leads = await readLeadThreads(bb, projectId);
    const spec = snapshot.issues.find((issue) => issue.identifier === specId && issue.inProject);
    const existing = spec && leads.find((lead) => lead.specId === spec.id);
    if (existing) return { threadId: existing.thread.id };
    const checkout = await readProjectCheckout(bb, projectId);
    if (!checkout) throw new Error("This BB project has no default checkout to start a lane in.");
    const doctor = await sources.doctor(projectId);
    const { board } = deriveBoard({ snapshot: linearTrackerSnapshot(projectId, snapshot), leads, settings: checkout.settings, doctor,
      connection: { status: "connected", message: "" }, now: Date.now() });
    const ready = board.ready.find((row) => row.id === specId);
    if (!ready || !spec) throw new Error(`${specId} isn't a ready spec in this project's Linear project. Read the board again.`);
    if (ready.startReason) throw new Error(ready.startReason);
    if (!checkout.settings?.ok) throw new Error("Fix docs/agents/squadron.md, then try Start again.");
    const route = resolveRoute(checkout.settings.settings, spec.labels.map((label) => label.name));
    const ownerPath = (id: "playbook" | "machine-profile") => doctor.configurationFiles.find((file) => file.id === id)?.path;
    const thread = await bb.sdk.threads.spawn({
      projectId, title: `Lead ${spec.identifier}`, visibility: "visible",
      providerId: route.family === "claude" ? "claude-code" : "codex", model: route.model, reasoningLevel: route.effort, serviceTier: "default",
      pluginMetadata: { role: "lead", specId: spec.id },
      environment: { type: "host", hostId: checkout.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
      prompt: ["Use the squadron-lead skill for this spec.", "", `Spec: ${spec.url}`,
        "Repo rules: AGENTS.md and docs/agents/", "Project settings: docs/agents/squadron.md",
        `Playbook: ${ownerPath("playbook") ?? "~/.bb-squadron/playbook.md"}`,
        `Machine profile: ${ownerPath("machine-profile") ?? "~/.bb-squadron/machine.md"}`,
      ].join("\n"),
    });
    publishSquadronSignal(bb.realtime, boardChanged, { projectId });
    return { threadId: thread.id };
  }
  async function leadOf(projectId: string, specId: string) {
    const spec = sources.mirror.getSnapshot(projectId).issues.find((issue) => issue.identifier === specId && issue.inProject);
    const lead = spec && (await readLeadThreads(bb, projectId)).find((found) => found.specId === spec.id);
    if (!lead) throw new Error(`${specId} has no Lead thread in this project. Read the board again.`);
    return lead;
  }
  /** Send the spec's own Lead a fixed message. Nothing is stored; the Lead's status is the lane's state. */
  async function tell(projectId: string, specId: string, text: string, mode: "steer-if-active" | "queue-if-active") {
    const lead = await leadOf(projectId, specId);
    await bb.sdk.threads.send({ threadId: lead.thread.id, mode, input: [{ type: "text", text, mentions: [] }] });
    publishSquadronSignal(bb.realtime, boardChanged, { projectId });
    return { threadId: lead.thread.id };
  }
  /** Squash-merge the Lead's PR, read afresh, only while it is open with passing checks. */
  async function merge(projectId: string, specId: string) {
    const environmentId = (await leadOf(projectId, specId)).thread.environmentId;
    const row = environmentId ? (await readPullRequests(bb, [environmentId]))[environmentId] : undefined;
    const pr = row?.outcome === "available" ? row.pullRequest : undefined;
    if (!environmentId || !pr) throw new Error(`${specId} has no pull request to merge yet.`);
    if (!canMerge({ pr: { state: pr.state, checks: pr.checks.state === "no_checks" ? "none" : pr.checks.state } })) {
      throw new Error(pr.state === "open" ? `PR #${pr.number} can merge once its checks pass.` : `PR #${pr.number} is ${pr.state}, not open.`);
    }
    await bb.sdk.plugins.callRpc({ pluginId: PULL_REQUEST_PLUGIN, method: "merge",
      input: { environmentId, method: "squash" }, outputSchema: z.object({ message: z.string() }) });
    publishSquadronSignal(bb.realtime, boardChanged, { projectId });
    return { number: pr.number };
  }
  const fromBoard = (context: { experimental_caller: { kind: string } }, action: string) => {
    if (context.experimental_caller.kind !== "client") throw new Error(`${action} a lane from the Squadron board.`);
  };
  bb.rpc.register(laneContract, {
    "lane.stop": ({ projectId, specId }, context) => {
      fromBoard(context, "Stop");
      return tell(projectId, specId, STOP_MESSAGE, "steer-if-active");
    },
    "lane.resume": ({ projectId, specId }, context) => {
      fromBoard(context, "Resume");
      return tell(projectId, specId, RESUME_MESSAGE, "queue-if-active");
    },
    "lane.merge": ({ projectId, specId }, context) => {
      fromBoard(context, "Merge");
      return merge(projectId, specId);
    },
    "lane.start": ({ projectId, specId }, context) => {
      fromBoard(context, "Start");
      const key = JSON.stringify([projectId, specId]);
      let running = starting.get(key);
      if (!running) {
        running = start(projectId, specId).finally(() => { starting.delete(key); });
        starting.set(key, running);
      }
      return running;
    },
  });
}
