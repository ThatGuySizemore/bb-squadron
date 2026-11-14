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
        route: { family: thread.providerId === "claude-code" ? "claude" : "gpt",
          model: execution?.model ?? "Unknown model", effort: execution?.reasoningLevel === "high" ? "high" : "medium" } });
    }
    if (threads.length < 200) return leads;
  }
}
