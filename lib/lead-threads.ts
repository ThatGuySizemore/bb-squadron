import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Route } from "./board-model.js";
import { STOP_MESSAGE } from "./lane-contract.js";
import { isActiveProjectThread } from "./project-thread.js";

type BbThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
/** The thread list adds whether a thread waits on the owner and whether its queued work failed. */
type Attention = Partial<Pick<Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number], "hasPendingInteraction" | "queuedWork" | "updatedAt" | "activity">>;

/** A child thread of a Lead: one of its workers, or its reviewer. */
export type WorkerThread = Pick<BbThread, "id" | "title" | "createdAt" | "status" | "runtime"> & Attention;

/** BB owns these records. Squadron reads them afresh rather than storing lanes. */
export interface LeadThread {
  specId: string;
  /** Epoch milliseconds of a normal terminal turn, never a generic row update. */
  idleSince?: number;
  thread: Pick<BbThread,
    "id" | "projectId" | "environmentId" | "providerId" | "createdAt" | "archivedAt" | "deletedAt" | "status" | "runtime" | "parentThreadId"> & Attention;
  route: Route;
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

/** The route BB actually runs on a thread, including its unavailable-model fallback. */
export function threadRoute(providerId: string | null, execution: { model?: string | null; reasoningLevel?: string | null } | null): Route {
  return { family: providerId === "claude-code" ? "claude" : "gpt",
    model: execution?.model ?? "Unknown model", effort: execution?.reasoningLevel === "high" ? "high" : "medium" };
}

export async function readWorkers(bb: BbPluginApi, projectId: string, leadId: string): Promise<WorkerThread[]> {
  const workers: WorkerThread[] = [];
  for (let offset = 0; ; offset += 200) {
    const threads = await bb.sdk.threads.list({ projectId, parentThreadId: leadId, archived: false, includeHidden: true, limit: 200, offset });
    workers.push(...threads.filter((thread) => thread.parentThreadId === leadId && isActiveProjectThread(thread, thread.id, projectId)));
    if (threads.length < 200) return workers;
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
      const execution = await bb.sdk.threads.defaultExecutionOptions({ threadId: thread.id });
      const idleSince = await readIdleSince(bb, thread);
      leads.push({ ...(idleSince !== undefined ? { idleSince } : {}), specId: metadata.specId, thread, branch: thread.environmentBranchName ?? "",
        workers: await readWorkers(bb, projectId, thread.id),
        route: threadRoute(thread.providerId, execution) });
    }
    if (threads.length < 200) return leads;
  }
}

/** Unknown history retains the existing Stopped fallback. No assistant text is classified. */
async function readIdleSince(bb: BbPluginApi, thread: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number]): Promise<number | undefined> {
  if (thread.status !== "idle" || thread.runtime.displayStatus !== "idle" || isRunningThread(thread)) return;
  try {
    const [terminal, requests] = await Promise.all([
      bb.sdk.threads.events.list({ threadId: thread.id, order: "desc", limit: "1", types: ["turn/completed", "system/thread/interrupted", "turn/started"] }),
      bb.sdk.threads.events.list({ threadId: thread.id, order: "desc", limit: "1", types: ["client/turn/requested"] }),
    ]);
    const end = terminal[0];
    const request = requests[0];
    // The board/CLI Stop sends this exact fixed input. A normal wind-down completion stays Stopped.
    if (request?.type === "client/turn/requested" && request.data.input?.some((part) => part.type === "text" && part.text === STOP_MESSAGE)) return;
    if (end?.type === "turn/completed" && end.data.status === "completed" && Number.isFinite(end.createdAt)) return end.createdAt;
  } catch { /* Unreadable lifecycle isn't evidence of a normal idle Lead. */ }
}

/** A live turn or work running behind one must finish before a quiet Question. */
export function isRunningThread(thread: { status: string } & Attention): boolean {
  return ["active", "starting", "pending", "stopping"].includes(thread.status) || thread.queuedWork === "waiting" ||
    (thread.activity?.activeBackgroundAgentCount ?? 0) > 0 || (thread.activity?.activeBackgroundCommandCount ?? 0) > 0 ||
    (thread.activity?.activeWorkflowCount ?? 0) > 0;
}
