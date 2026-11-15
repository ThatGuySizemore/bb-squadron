// Token usage as BB reports it for one thread: the provider's cumulative total,
// never context occupancy, account windows or prices.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export interface TokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}
export type ThreadUsage =
  | {
    state: "reported";
    /** The latest cumulative total BB reported for the thread's latest provider session. */
    total: TokenTotals;
    providerThreadId: string;
    /** The event the total came from, so a reader can check it. */
    seq: number;
    at: number;
    /**
     * one: the earliest and latest usage events name the same provider session.
     * several: they don't, so the total covers only the latest session and earlier sessions are left out, not added.
     */
    sessions: "one" | "several";
  }
  | { state: "unknown"; reason: string };

type UsageEvent = { seq: number; createdAt: number; data: { providerThreadId: string; tokenUsage: { total: TokenTotals } } };

/** Read-only. A thread with no usage event, or one BB can't read, is unknown rather than zero. */
export async function readThreadUsage(bb: BbPluginApi, threadId: string): Promise<ThreadUsage> {
  const read = async (order: "asc" | "desc") => {
    const rows = await bb.sdk.threads.events.list({ threadId, types: ["thread/tokenUsage/updated"], order, limit: "1" });
    const row = rows.find((event) => event.type === "thread/tokenUsage/updated");
    return row ? row as unknown as UsageEvent : null;
  };
  try {
    const latest = await read("desc");
    if (!latest) return { state: "unknown", reason: "BB has no token usage for this thread." };
    const earliest = await read("asc");
    const { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens } = latest.data.tokenUsage.total;
    return { state: "reported", total: { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens },
      providerThreadId: latest.data.providerThreadId, seq: latest.seq, at: latest.createdAt,
      sessions: earliest && earliest.data.providerThreadId !== latest.data.providerThreadId ? "several" : "one" };
  } catch {
    return { state: "unknown", reason: "BB couldn't read this thread's usage." };
  }
}
