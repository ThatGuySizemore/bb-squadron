import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Route } from "./board-model.js";
import { isActiveProjectThread } from "./project-thread.js";

type BbThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
/** The thread list adds whether a thread waits on the owner and whether its queued work failed. */
type Attention = Partial<Pick<Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number], "hasPendingInteraction" | "queuedWork">>;

/** A child thread of a Lead: one of its workers, or its reviewer. */
export type WorkerThread = Pick<BbThread, "id" | "title" | "createdAt" | "status" | "runtime"> & Attention;

/** BB owns these records. Squadron reads them afresh rather than storing lanes. */
export interface LeadThread {
  specId: string;
  thread: Pick<BbThread,
    "id" | "projectId" | "environmentId" | "providerId" | "createdAt" | "archivedAt" | "deletedAt" | "status" | "runtime" | "parentThreadId"> & Attention;
  route: Route;
  branch: string;
  /** The Lead's child threads that aren't archived or deleted. */
  workers?: WorkerThread[];
}

async function readWorkers(bb: BbPluginApi, projectId: string, leadId: string): Promise<WorkerThread[]> {
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
      leads.push({ specId: metadata.specId, thread, branch: thread.environmentBranchName ?? "",
        workers: await readWorkers(bb, projectId, thread.id),
        route: { family: thread.providerId === "claude-code" ? "claude" : "gpt",
          model: execution?.model ?? "Unknown model", effort: execution?.reasoningLevel === "high" ? "high" : "medium" } });
    }
    if (threads.length < 200) return leads;
  }
}
