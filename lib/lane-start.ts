import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { laneContract, LOCAL_MERGE_MESSAGE, RESUME_MESSAGE, STOP_MESSAGE } from "./lane-contract.js";
import { deriveBoard } from "./board-derive.js";
import { isRunningThread, latestLeads, readLeadThreads } from "./lead-threads.js";
import { readProjectCheckout } from "./project-checkout.js";
import { providerFor, resolveLeadRoute, resolveRoute } from "./squadron-settings.js";
import { workItemPrompt } from "./work-item-prompt.js";
import type { DoctorReport } from "./doctor.js";
import { boardChanged, publishSquadronSignal } from "./realtime-contract.js";
import { PULL_REQUEST_PLUGIN, readPullRequests } from "./pull-requests.js";
import { canMerge } from "./board-model.js";
import { z } from "zod";
import type { TrackerReader } from "./tracker-contract.js";
import { readLaneProgress } from "./lane-progress.js";
import { outsideLaneSpecs, type OutsideLaneReader } from "./outside-lanes.js";
import { readPlanningThreads } from "./planning.js";
import type { LeadThread } from "./lead-threads.js";
import type { TrackerSnapshot } from "./tracker-contract.js";

export function registerLaneStart(bb: BbPluginApi, sources: {
  tracker: TrackerReader;
  onAction?(projectId: string): void;
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
    const leads = latestLeads(await readLeadThreads(bb, projectId));
    const spec = snapshot.issues.find((issue) => issue.identifier === specId && issue.inProject);
    const existing = spec && leads.find((lead) => lead.specId === spec.id);
    const planning = await readPlanningThreads(bb, projectId);
    const outside = spec ? (await outsideLanes(projectId, snapshot, leads, planning)).filter((lane) => lane.specId === spec.id) : [];
    if (outside.length) throw refuse(specId, "start another Lead for");
    const checkout = await readProjectCheckout(bb, projectId);
    if (!checkout) throw new Error("This BB project has no default checkout to start a lane in.");
    const progress = await readLaneProgress(bb, snapshot, leads);
    const pullRequests = await readPullRequests(bb, leads.flatMap((lead) => lead.thread.environmentId ? [lead.thread.environmentId] : []));
    const previous = deriveBoard({ snapshot, leads, planning, settings: checkout.settings, ...progress, pullRequests,
      connection: { status: "connected", message: "" }, now: Date.now() }).board;
    const returning = existing && previous.lanes.some((lane) => lane.leadThreadId === existing.thread.id && lane.state === "landed")
      && previous.ready.some((row) => row.id === specId);
    if (existing && (isRunningThread(existing.thread) || !returning)) {
      if (existing.kind === "work-item") throw new Error(`${specId} already has a lane. Open its thread or use Resume if it is stopped.`);
      return { threadId: existing.thread.id };
    }
    const doctor = await sources.doctor(projectId);
    const { board } = deriveBoard({ snapshot, leads: [...leads, ...outside], planning, settings: checkout.settings, doctor, ...progress, pullRequests,
      connection: { status: "connected", message: "" }, now: Date.now() });
    const ready = board.ready.find((row) => row.id === specId);
    if (!ready || !spec) throw new Error(`${specId} isn't a ready spec in this project's tracker. Read the board again.`);
    if (ready.startReason) throw new Error(ready.startReason);
    if (!checkout.settings?.ok) throw new Error("Fix docs/agents/squadron.md, then try Start again.");
    const workItem = ready.kind === "work-item";
    // Autopilot never starts work items, even if a caller supplies one directly.
    if (workItem && startedBy === "autopilot") return null;
    const route = (workItem ? resolveRoute : resolveLeadRoute)(checkout.settings.settings, spec.labels.map((label) => label.name));
    const { holdLabels } = checkout.settings.settings;
    const ownerPath = (id: "playbook" | "machine-profile") => doctor.configurationFiles.find((file) => file.id === id)?.path;
    if (allowed && !await allowed()) return null;
    const thread = await bb.sdk.threads.spawn({
      projectId, title: `${workItem ? "Work item" : "Lead"} ${spec.identifier}`, visibility: "visible",
      providerId: providerFor(route), model: route.model, ...(route.effort === "default" ? {} : { reasoningLevel: route.effort }), serviceTier: "default",
      pluginMetadata: { role: "lead", specId: spec.id, startedBy, ...(workItem ? { kind: "work-item" } : {}), ...(returning ? { previousLeadId: existing.thread.id } : {}) },
      environment: { type: "host", hostId: checkout.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
      prompt: workItem ? workItemPrompt({ identifier: spec.identifier, url: spec.url, settings: checkout.settings.settings,
        houseRules: ownerPath("playbook") ?? "~/.bb-squadron/house-rules.md",
        machine: ownerPath("machine-profile") ?? "~/.bb-squadron/machine.md", acceptOwner: ready.acceptOwner,
      }) : ["Use the squadron-lead skill for this spec.", "", `Spec: ${spec.url}`,
        ...(returning ? [
          `This spec's previous lane landed. Start a fresh integration branch from this new worktree's default branch; never reuse the landed branch ${existing.branch}.`,
          `Previous Lead: ${existing.thread.id}. Its branch, workers and PR are evidence for that lane only. Read remaining tickets afresh.`,
        ] : []),
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
    const leads = latestLeads(await readLeadThreads(bb, projectId));
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
    sources.onAction?.(projectId);
    const lead = await leadOf(projectId, specId, "merge");
    const environmentId = lead.thread.environmentId;
    const snapshot = await sources.tracker.getSnapshot(projectId);
    const progress = await readLaneProgress(bb, snapshot, [lead]);
    const checkout = await readProjectCheckout(bb, projectId);
    const { board } = deriveBoard({ snapshot, leads: [lead], settings: checkout?.settings ?? null,
      connection: { status: "connected", message: "" }, now: Date.now(), ...progress });
    const lane = board.lanes.find((lane) => lane.specId === specId);
    if (progress.repository?.hasRemote === false) {
      if (!lane || lane.state === "landed" || !canMerge(lane)) {
        throw new Error(`${specId} isn't ready for a local merge. Read the board again.`);
      }
      return tell(projectId, specId, LOCAL_MERGE_MESSAGE, "queue-if-active", "merge");
    }
    const row = environmentId ? (await readPullRequests(bb, [environmentId]))[environmentId] : undefined;
    const pr = row?.outcome === "available" ? row.pullRequest : undefined;
    if (!environmentId || !pr) throw new Error(`${specId} has no pull request to merge yet.`);
    if (!canMerge({ pr: { state: pr.state, checks: pr.checks.state === "no_checks" ? "none" : pr.checks.state } })) {
      throw new Error(pr.state === "open" ? `PR #${pr.number} can merge once its checks pass.` : `PR #${pr.number} is ${pr.state}, not open.`);
    }
    if (lane?.state === "landed") throw new Error(`${specId} has already landed. Read the board again.`);
    if (!lane) throw new Error(`${specId} isn't ready for a merge. Read the board again.`);
    await bb.sdk.plugins.callRpc({ pluginId: PULL_REQUEST_PLUGIN, method: "merge",
      input: { environmentId, method: "squash" }, outputSchema: z.object({ message: z.string() }) });
    publishSquadronSignal(bb.realtime, boardChanged, { projectId });
    return { number: pr.number };
  }
  /** Both owner and Autopilot use this path, including the in-flight dedupe and first message. */
  function startLane(projectId: string, specId: string, startedBy: "owner" | "autopilot", allowed?: () => Promise<boolean>) {
    sources.onAction?.(projectId);
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
  const actions = {
    merge,
    stop: (projectId: string, specId: string) => tell(projectId, specId, STOP_MESSAGE, "steer-if-active", "stop"),
    resume: (projectId: string, specId: string) => tell(projectId, specId, RESUME_MESSAGE, "queue-if-active", "resume"),
    start(projectId: string, specId: string) {
      return startLane(projectId, specId, "owner").then((result): Promise<{ threadId: string }> | { threadId: string } => {
        // An owner action outlives an automatic start cancelled by Off or a lower limit.
        if (result) return result;
        return startLane(projectId, specId, "owner").then((retried) => {
          if (!retried) throw new Error("Read the board and try Start again.");
          return retried;
        });
      });
    },
  };
  bb.rpc.register(laneContract, {
    "lane.stop": ({ projectId, specId }, context) => {
      fromBoard(context, "Stop");
      return actions.stop(projectId, specId);
    },
    "lane.resume": ({ projectId, specId }, context) => {
      fromBoard(context, "Resume");
      return actions.resume(projectId, specId);
    },
    "lane.merge": ({ projectId, specId }, context) => {
      fromBoard(context, "Merge");
      return actions.merge(projectId, specId);
    },
    "lane.start": ({ projectId, specId }, context) => {
      fromBoard(context, "Start");
      return actions.start(projectId, specId);
    },
  });
  return { ...actions, startAutomatic: startLane };
}

export type LaneActions = Pick<ReturnType<typeof registerLaneStart>, "start" | "stop" | "resume" | "merge">;
