import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Route } from "./board-model.js";
import { isActiveProjectThread } from "./project-thread.js";

/** BB owns these records. Squadron reads them afresh rather than storing lanes. */
export interface LeadThread {
  specId: string;
  thread: Pick<Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>,
    "id" | "projectId" | "environmentId" | "providerId" | "createdAt" | "archivedAt" | "deletedAt" | "status" | "runtime" | "parentThreadId">;
  route: Route;
  branch: string;
  /** The Lead's child threads: its workers, reviewer and anything else it started. */
  workers?: WorkerThread[];
}

export interface WorkerThread {
  id: string;
  title: string;
  createdAt: number;
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
      leads.push({ specId: metadata.specId, thread, branch: thread.environmentBranchName ?? "", workers: await readWorkers(bb, thread.id),
        route: { family: thread.providerId === "claude-code" ? "claude" : "gpt",
          model: execution?.model ?? "Unknown model", effort: execution?.reasoningLevel === "high" ? "high" : "medium" } });
    }
    if (threads.length < 200) return leads;
  }
}

/** The Lead's live child threads, in any order. */
async function readWorkers(bb: BbPluginApi, leadThreadId: string): Promise<WorkerThread[]> {
  const workers: WorkerThread[] = [];
  for (let offset = 0; ; offset += 200) {
    const threads = await bb.sdk.threads.list({ parentThreadId: leadThreadId, archived: false, includeHidden: true, limit: 200, offset });
    for (const { id, title, createdAt, deletedAt, archivedAt } of threads) {
      if (deletedAt === null && archivedAt === null) workers.push({ id, title: title ?? "", createdAt });
    }
    if (threads.length < 200) return workers;
  }
}
