import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Durable author and acceptance evidence only. Prompt text is never read. */
export async function hasAcceptedOwnerAnswer(bb: BbPluginApi, threadId: string, askedAt: number, signal: AbortSignal): Promise<boolean> {
  const ownerRequests = new Set<string>();
  const accepted = new Set<string>();
  const rejected = new Set<string>();
  let after = 0;
  // A bounded history read may leave the answer unproven. It never substitutes
  // promptHistory text or an assistant claim for missing author evidence.
  for (let page = 0; page < 5; page++) {
    const rows = await bb.sdk.threads.events.list({ threadId, afterSeq: String(after), order: "asc", limit: "200", signal,
      types: ["client/turn/requested", "turn/input/accepted", "client/turn/rejected"] });
    for (const row of rows) {
      if (row.threadId !== threadId || row.createdAt <= askedAt) continue;
      if (row.type === "client/turn/requested" && row.data.initiator === "user" && row.data.senderThreadId === null && !row.data.originPluginId) ownerRequests.add(row.data.requestId);
      if (row.type === "turn/input/accepted") accepted.add(row.data.clientRequestId);
      if (row.type === "client/turn/rejected") rejected.add(row.data.requestId);
    }
    if ([...ownerRequests].some((id) => accepted.has(id) && !rejected.has(id))) return true;
    if (rows.length < 200) return false;
    const next = rows.at(-1)!.seq;
    if (next <= after) return false;
    after = next;
  }
  return false;
}
