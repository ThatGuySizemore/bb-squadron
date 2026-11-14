import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { laneContract, LOCAL_MERGE_MESSAGE, RESUME_MESSAGE, STOP_MESSAGE } from "./lane-contract.js";
import { deriveBoard } from "./board-derive.js";
import { readLeadThreads } from "./lead-threads.js";
import { readProjectCheckout } from "./project-checkout.js";
import { resolveLeadRoute } from "./squadron-settings.js";
import type { DoctorReport } from "./doctor.js";
import { boardChanged, publishSquadronSignal } from "./realtime-contract.js";
import { PULL_REQUEST_PLUGIN, readPullRequests } from "./pull-requests.js";
import { canMerge } from "./board-model.js";
import { z } from "zod";
import type { TrackerReader } from "./tracker-contract.js";
import { repositoryHostContract } from "./repository-contract.js";
import { outsideLaneSpecs, type OutsideLaneReader } from "./outside-lanes.js";
import { readPlanningThreads } from "./planning.js";
import type { LeadThread } from "./lead-threads.js";
import type { TrackerSnapshot } from "./tracker-contract.js";

export function registerLaneStart(bb: BbPluginApi, sources: {
  tracker: TrackerReader;
  doctor(projectId: string): Promise<DoctorReport>;
  /** Lanes started outside Squadron: Start, Stop, Resume and Merge all refuse them. */
  outside?: OutsideLaneReader;
}) {
  /** The outside lane flying this spec, if a thread Squadron didn't start names it. */
  async function outsideLanes(projectId: string, snapshot: TrackerSnapshot, leads: LeadThread[], planning?: Awaited<ReturnType<typeof readPlanningThreads>>): Promise<LeadThread[]> {
    if (!sources.outside) return [];
    return sources.outside(projectId, outsideLaneSpecs(snapshot, leads, planning ?? await readPlanningThreads(bb, projectId)));
  }
  const refuse = (specId: string, action: string) =>
    new Error(`${specId} was started outside Squadron, so Squadron doesn't ${action} it. Open its thread to follow it.`);
  const starting = new Map<string, Promise<{ threadId: string } | null>>();
  async function start(projectId: string, specId: string, startedBy: "owner" | "autopilot", allowed?: () => Promise<boolean>) {
    const snapshot = await sources.tracker.getSnapshot(projectId);
    const leads = await readLeadThreads(bb, projectId);
    const spec = snapshot.issues.find((issue) => issue.identifier === specId && issue.inProject);
    const existing = spec && leads.find((lead) => lead.specId === spec.id);
    if (existing) return { threadId: existing.thread.id };
    const planning = await readPlanningThreads(bb, projectId);
    const outside = spec ? (await outsideLanes(projectId, snapshot, leads, planning)).filter((lane) => lane.specId === spec.id) : [];
    if (outside.length) throw refuse(specId, "start another Lead for");
    const checkout = await readProjectCheckout(bb, projectId);
    if (!checkout) throw new Error("This BB project has no default checkout to start a lane in.");
    const doctor = await sources.doctor(projectId);
    const { board } = deriveBoard({ snapshot, leads: [...leads, ...outside], planning, settings: checkout.settings, doctor,
      connection: { status: "connected", message: "" }, now: Date.now() });
    const ready = board.ready.find((row) => row.id === specId);
    if (!ready || !spec) throw new Error(`${specId} isn't a ready spec in this project's tracker. Read the board again.`);
    if (ready.startReason) throw new Error(ready.startReason);
    if (!checkout.settings?.ok) throw new Error("Fix docs/agents/squadron.md, then try Start again.");
    const route = resolveLeadRoute(checkout.settings.settings, spec.labels.map((label) => label.name));
    const { holdLabels } = checkout.settings.settings;
    const ownerPath = (id: "playbook" | "machine-profile") => doctor.configurationFiles.find((file) => file.id === id)?.path;
    if (allowed && !await allowed()) return null;
    const thread = await bb.sdk.threads.spawn({
      projectId, title: `Lead ${spec.identifier}`, visibility: "visible",
      providerId: route.family === "claude" ? "claude-code" : "codex", model: route.model, reasoningLevel: route.effort, serviceTier: "default",
      pluginMetadata: { role: "lead", specId: spec.id, startedBy },
      environment: { type: "host", hostId: checkout.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
      prompt: ["Use the squadron-lead skill for this spec.", "", `Spec: ${spec.url}`,
        ...(snapshot.kind === "linear" ? [] : ["Read docs/agents/issue-tracker.md and update the spec and its tickets as that file describes. Tell workers to do the same."]),
        "Repo rules: AGENTS.md and docs/agents/", "Project settings: docs/agents/squadron.md",
        `House rules: ${ownerPath("playbook") ?? "~/.bb-squadron/house-rules.md"}`,
        `This machine: ${ownerPath("machine-profile") ?? "~/.bb-squadron/machine.md"}`,
        `Held tickets carry one of these labels or Status lines: ${holdLabels.join(", ")}.${holdLabels.some((label) => label.endsWith("*")) ? " A trailing * matches a prefix." : ""}`,
      ].join("\n"),
    });
    publishSquadronSignal(bb.realtime, boardChanged, { projectId });
    return { threadId: thread.id };
  }
  /** Only a Lead Squadron started can be told anything; an outside lane's thread never is. */
  async function leadOf(projectId: string, specId: string, action: string) {
    const snapshot = await sources.tracker.getSnapshot(projectId);
    const spec = snapshot.issues.find((issue) => issue.identifier === specId && issue.inProject);
    const leads = await readLeadThreads(bb, projectId);
    const lead = spec && leads.find((found) => found.specId === spec.id);
    if (lead) return lead;
    if (spec && (await outsideLanes(projectId, snapshot, leads)).some((lane) => lane.specId === spec.id)) throw refuse(specId, action);
    throw new Error(`${specId} has no Lead thread in this project. Read the board again.`);
  }
  /** Send the spec's own Lead a fixed message. Nothing is stored; the Lead's status is the lane's state. */
  async function tell(projectId: string, specId: string, text: string, mode: "steer-if-active" | "queue-if-active", action: string) {
    const lead = await leadOf(projectId, specId, action);
    await bb.sdk.threads.send({ threadId: lead.thread.id, mode, input: [{ type: "text", text, mentions: [] }] });
    publishSquadronSignal(bb.realtime, boardChanged, { projectId });
    return { threadId: lead.thread.id };
  }
  /** Squash-merge the Lead's PR, read afresh, only while it is open with passing checks. */
  async function merge(projectId: string, specId: string) {
    const environmentId = (await leadOf(projectId, specId, "merge")).thread.environmentId;
    const checkout = await readProjectCheckout(bb, projectId);
    if (checkout) {
      const repository = await bb.hosts.experimental_client({ contract: repositoryHostContract }).call("readRepositoryState",
        { checkoutPath: checkout.path, branches: [] }, { hostId: checkout.hostId, timeoutMs: 15_000 }).catch(() => null);
      if (repository?.hasRemote === false) return tell(projectId, specId, LOCAL_MERGE_MESSAGE, "queue-if-active", "merge");
    }
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
  /** Both owner and Autopilot use this path, including the in-flight dedupe and first message. */
  function startLane(projectId: string, specId: string, startedBy: "owner" | "autopilot", allowed?: () => Promise<boolean>) {
    const key = JSON.stringify([projectId, specId]);
    let running = starting.get(key);
    if (!running) {
      running = start(projectId, specId, startedBy, allowed).finally(() => { starting.delete(key); });
      starting.set(key, running);
    }
    return running;
  }
  const fromBoard = (context: { experimental_caller: { kind: string } }, action: string) => {
    if (context.experimental_caller.kind !== "client") throw new Error(`${action} a lane from the Squadron board.`);
  };
  bb.rpc.register(laneContract, {
    "lane.stop": ({ projectId, specId }, context) => {
      fromBoard(context, "Stop");
      return tell(projectId, specId, STOP_MESSAGE, "steer-if-active", "stop");
    },
    "lane.resume": ({ projectId, specId }, context) => {
      fromBoard(context, "Resume");
      return tell(projectId, specId, RESUME_MESSAGE, "queue-if-active", "resume");
    },
    "lane.merge": ({ projectId, specId }, context) => {
      fromBoard(context, "Merge");
      return merge(projectId, specId);
    },
    "lane.start": ({ projectId, specId }, context) => {
      fromBoard(context, "Start");
      return startLane(projectId, specId, "owner").then((result): Promise<{ threadId: string }> | { threadId: string } => {
        // An owner click outlives an automatic start cancelled by Off or a lower limit.
        if (result) return result;
        return startLane(projectId, specId, "owner").then((retried) => {
          if (!retried) throw new Error("Read the board and try Start again.");
          return retried;
        });
      });
    },
  });
  return { start: startLane };
}
