import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { familyForProvider } from "./squadron-settings.js";
import type { LaunchView, Route } from "./board-model.js";
import { launchView, readLaunchMetadata, reportedRoute, type LaunchRecord, type ReportedRoute } from "./launch-record.js";
import type { LaneLaunch } from "./final-reviewer.js";
import { readWaitTarget, STOP_MESSAGE, TWO_STRIKES_STOP_MESSAGE } from "./lane-contract.js";
import { isActiveProjectThread } from "./project-thread.js";

type BbThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
/** The thread list adds whether a thread waits on the owner and whether its queued work failed. */
type Attention = Partial<Pick<Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number], "hasPendingInteraction" | "queuedWork" | "updatedAt" | "activity">>;

/** A child thread of a Lead: one of its workers, or its reviewer. */
export type WorkerThread = Pick<BbThread, "id" | "title" | "createdAt" | "status" | "runtime"> & Partial<Pick<BbThread, "providerId">> & Attention & {
  /** The launch record of a child started with squadron launch, beside BB's report. */
  launch?: LaunchView;
  /** The record itself, which names the tickets the child builds. */
  record?: LaunchRecord;
};

/** BB owns these records. Squadron reads them afresh rather than storing lanes. */
export interface LeadThread {
  specId: string;
  /** Omitted metadata from existing lanes means spec. Both use the same reader and controls. */
  kind?: "spec" | "work-item";
  /** A returning Lead must establish its own PR or local branch landing. */
  previousLeadId?: string;
  /** Epoch milliseconds of a normal terminal turn, never a generic row update. */
  idleSince?: number;
  /** The latest reply in the completed turn explicitly asks the owner to act. */
  asksOwner?: boolean;
  /** A policy stop recorded by a fixed control input, never inferred from reply prose. */
  stopReason?: "two-strikes";
  /** What the Lead declared it waits on, from a fixed control input; never from reply prose. */
  declaredWait?: string;
  thread: Pick<BbThread,
    "id" | "projectId" | "environmentId" | "providerId" | "createdAt" | "archivedAt" | "deletedAt" | "status" | "runtime" | "parentThreadId"> & Attention;
  /** What BB reports the Lead runs, including a substituted model. */
  route: Route;
  /** The Lead's launch record beside BB's report; absent for Leads started before records. */
  launch?: LaunchView;
  /** The record itself. A work item's own thread is its builder. */
  record?: LaunchRecord;
  /** Every child, active and archived, with its record or null: the final reviewer's builder evidence. */
  launches?: LaneLaunch[];
  branch: string;
  /** The Lead's child threads that aren't archived or deleted. */
  workers?: WorkerThread[];
  /** A thread Squadron didn't start that names the spec: an Outside lane. Squadron never steers it. */
  outside?: true;
  /** Branches that may be the lane's integration branch, most likely first. The first readable one wins. */
  branchCandidates?: string[];
}

/** One current lane per spec. Older Leads remain in BB with their own environment,
 * branch, workers and PR; list order must never make their evidence current again. */
export function latestLeads(leads: LeadThread[]): LeadThread[] {
  const current = new Map<string, LeadThread>();
  for (const lead of leads) {
    const previous = current.get(lead.specId);
    if (!previous || lead.thread.createdAt > previous.thread.createdAt ||
      (lead.thread.createdAt === previous.thread.createdAt && lead.thread.id.localeCompare(previous.thread.id) > 0)) {
      current.set(lead.specId, lead);
    }
  }
  return [...current.values()];
}

/** A board route from BB's report: provider, model, effort and service tier. */
export function reportedThreadRoute(reported: ReportedRoute): Route {
  // An unreported level keeps the board's earlier "default" wording; the launch view keeps it unknown.
  return { family: familyForProvider(reported.providerId ?? ""), ...(reported.providerId ? { providerId: reported.providerId } : {}),
    model: reported.model ?? "Unknown model", effort: reported.effort ?? "default", ...(reported.serviceTier ? { serviceTier: reported.serviceTier } : {}) };
}

/** The route BB actually runs on a thread, including its unavailable-model fallback. */
export function threadRoute(providerId: string | null, execution: { model?: string | null; reasoningLevel?: string | null } | null): Route {
  return { family: familyForProvider(providerId ?? ""),
    ...(providerId && !["claude-code", "codex"].includes(providerId) ? { providerId } : {}),
    model: execution?.model ?? "Unknown model", effort: execution?.reasoningLevel ?? "default" };
}

export async function readWorkers(bb: BbPluginApi, projectId: string, leadId: string): Promise<WorkerThread[]> {
  const workers: WorkerThread[] = [];
  for (let offset = 0; ; offset += 200) {
    const threads = await bb.sdk.threads.list({ projectId, parentThreadId: leadId, archived: false, includeHidden: true, limit: 200, offset });
    for (const thread of threads) {
      if (thread.parentThreadId !== leadId || !isActiveProjectThread(thread, thread.id, projectId)) continue;
      const record = readLaunchMetadata(await Promise.resolve().then(() => bb.sdk.threads.getPluginMetadata({ threadId: thread.id })).catch(() => null));
      workers.push(record ? { ...thread, record, launch: launchView(record, await reportedRoute(bb, thread)) } : thread);
    }
    if (threads.length < 200) return workers;
  }
}

/**
 * A Lead's children as builder evidence: active workers already read, plus archived children.
 * Finished workers are often archived, and their records still say who built each ticket.
 */
export async function readLaneLaunches(bb: BbPluginApi, projectId: string, leadId: string, active?: readonly WorkerThread[]): Promise<LaneLaunch[]> {
  const launches: LaneLaunch[] = (active ?? await readWorkers(bb, projectId, leadId)).map((worker) =>
    ({ threadId: worker.id, createdAt: worker.createdAt, providerId: worker.providerId ?? null, record: worker.record ?? null }));
  for (let offset = 0; ; offset += 200) {
    const threads = await bb.sdk.threads.list({ projectId, parentThreadId: leadId, archived: true, includeHidden: true, limit: 200, offset });
    for (const thread of threads) {
      if (thread.parentThreadId !== leadId || thread.projectId !== projectId || thread.deletedAt !== null || thread.archivedAt === null) continue;
      const record = readLaunchMetadata(await Promise.resolve().then(() => bb.sdk.threads.getPluginMetadata({ threadId: thread.id })).catch(() => null));
      launches.push({ threadId: thread.id, createdAt: thread.createdAt, providerId: thread.providerId ?? null, record });
    }
    if (threads.length < 200) return launches;
  }
}

export async function readLeadThreads(bb: BbPluginApi, projectId: string): Promise<LeadThread[]> {
  const leads: LeadThread[] = [];
  for (let offset = 0; ; offset += 200) {
    const threads = await bb.sdk.threads.list({ projectId, originPluginId: bb.pluginId, archived: false, includeHidden: true, limit: 200, offset });
    for (const thread of threads) {
      if (!isActiveProjectThread(thread, thread.id, projectId)) continue;
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id });
      if (metadata.role !== "lead" || typeof metadata.specId !== "string" || !metadata.specId) continue;
      const reported = await reportedRoute(bb, thread);
      const record = readLaunchMetadata(metadata);
      const idle = await readLeadLifecycle(bb, thread);
      const workers = await readWorkers(bb, projectId, thread.id);
      leads.push({ ...(metadata.kind === "work-item" || metadata.kind === "spec" ? { kind: metadata.kind } : {}),
        ...(typeof metadata.previousLeadId === "string" ? { previousLeadId: metadata.previousLeadId } : {}), ...idle, specId: metadata.specId, thread, branch: thread.environmentBranchName ?? "",
        asksOwner: idle.idleSince !== undefined && await readOwnerQuestion(bb, thread.id),
        workers, launches: await readLaneLaunches(bb, projectId, thread.id, workers),
        route: reported ? reportedThreadRoute(reported) : threadRoute(thread.providerId, null),
        ...(record ? { record, launch: launchView(record, reported) } : {}) });
    }
    if (threads.length < 200) return leads;
  }
}

/** Conservative fallback for questions asked without a native pending request.
 * Read only this turn's latest top-level reply; never forward its private prose. */
async function readOwnerQuestion(bb: BbPluginApi, threadId: string): Promise<boolean> {
  try {
    const [boundaries, requests, items] = await Promise.all([
      bb.sdk.threads.events.list({ threadId, order: "desc", limit: "2", types: ["turn/completed", "turn/started", "system/thread/interrupted"] }),
      bb.sdk.threads.events.list({ threadId, order: "desc", limit: "1", types: ["client/turn/requested"] }),
      bb.sdk.threads.events.list({ threadId, order: "desc", limit: "50", types: ["item/completed"] }),
    ]);
    const end = boundaries[0];
    if (end?.type !== "turn/completed" || end.data.status !== "completed") return false;
    const after = Math.max(boundaries[1]?.seq ?? -1, requests[0]?.seq ?? -1);
    const reply = items.find((event) => event.seq > after && event.seq < end.seq &&
      event.type === "item/completed" && event.data.item.type === "agentMessage" && !event.data.item.parentToolCallId);
    if (reply?.type !== "item/completed" || reply.data.item.type !== "agentMessage") return false;
    // Ignore quoted/code questions. Explicit Needs you copy also supports requests without a question mark.
    let fence: string | undefined;
    const prose = reply.data.item.text.split("\n").filter((line) => {
      if (/^\s*>/.test(line) || /^(?: {4}|\t)/.test(line)) return false;
      const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = undefined;
        return false;
      }
      if (mark) { fence = mark[1]; return false; }
      return true;
    }).join("\n").replace(/(`+)[\s\S]*?\1(?!`)/g, "");
    // A marker starts a line/sentence or has explicit Markdown emphasis. An
    // incidental phrase such as "Nothing needs you:" is status, not a marker.
    const markers = /(?:^|[.!?;:,]\s+|(?=[*_]))[ \t]*(?:[-+#]\s+)?(?:[*_]{1,3})?Needs you(?:[*_]{1,3})?:[ \t]*(?:[*_]{1,3})?/gim;
    for (const marker of prose.matchAll(markers)) {
      // Consume formatting before checking payload, so it cannot backtrack
      // into a fake request. A next-line list remains a real request.
      const request = prose.slice(marker.index + marker[0].length).trim().replace(/^[*_]+/, "").trim();
      if (request && !/^(?:none|nothing|0)[.!]?(?:\s*$|\n)/i.test(request)) return true;
    }
    return /^\s*(?:Josh[,.:]?\s+)?(?:can|could|would|will|do|are) you\b[^\n]*\?\s*$/im.test(prose);
  } catch { return false; }
}

/** Unknown history retains the existing Stopped fallback. No assistant text is classified. */
async function readLeadLifecycle(bb: BbPluginApi, thread: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number]): Promise<Pick<LeadThread, "idleSince" | "stopReason" | "declaredWait">> {
  if (thread.status !== "idle" || thread.runtime.displayStatus !== "idle" || isRunningThread(thread)) return {};
  try {
    const [terminal, request, started] = await Promise.all([
      bb.sdk.threads.events.list({ threadId: thread.id, order: "desc", limit: "1", types: ["turn/completed", "system/thread/interrupted", "turn/started"] }),
      readLatestControl(bb, thread.id),
      bb.sdk.threads.events.list({ threadId: thread.id, order: "desc", limit: "1", types: ["turn/started"] }),
    ]);
    const end = terminal[0];
    // The board/CLI Stop sends this exact fixed input. A normal wind-down completion stays Stopped.
    if (request?.type === "client/turn/requested") {
      if (request.data.input?.some((part) => part.type === "text" && part.text === TWO_STRIKES_STOP_MESSAGE))
        return { stopReason: "two-strikes" };
      if (request.data.input?.some((part) => part.type === "text" && part.text === STOP_MESSAGE)) return {};
      // A wait is steered into the Lead's own turn, so no turn starts after it. A later turn means work began again.
      const declared = request.data.input?.flatMap((part) => part.type === "text" ? [readWaitTarget(part.text)] : []).find((target) => target !== null);
      if (declared && end?.type === "turn/completed" && end.data.status === "completed" && (started[0]?.seq ?? -1) < request.seq)
        return { declaredWait: declared };
    }
    if (end?.type === "turn/completed" && end.data.status === "completed" && Number.isFinite(end.createdAt)) return { idleSince: end.createdAt };
  } catch { /* Unreadable lifecycle isn't evidence of a normal idle Lead. */ }
  return {};
}

/** Child outcomes and other automatic system deliveries aren't Stop or Resume.
 * Page past them so saving workers cannot erase the lane's latest control. */
async function readLatestControl(bb: BbPluginApi, threadId: string) {
  let beforeSeq: string | undefined;
  for (;;) {
    const events = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "200", beforeSeq, types: ["client/turn/requested"] });
    const control = events.find((event) => event.type === "client/turn/requested" &&
      (!event.data.systemMessageKind || event.data.systemMessageKind === "unlabeled"));
    if (control || events.length < 200) return control;
    beforeSeq = String(events[events.length - 1].seq);
  }
}

/** A live turn or work running behind one must finish before a quiet Question. */
export function isRunningThread(thread: { status: string } & Attention): boolean {
  return ["active", "starting", "pending", "stopping"].includes(thread.status) || thread.queuedWork === "waiting" ||
    (thread.activity?.activeBackgroundAgentCount ?? 0) > 0 || (thread.activity?.activeBackgroundCommandCount ?? 0) > 0 ||
    (thread.activity?.activeWorkflowCount ?? 0) > 0;
}
