import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { isActiveTicket } from "./ticket-activity.js";
import type { Board, Lane } from "./board-model.js";

type Timeline = Extract<Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>>, { rows: unknown }>;
type TimelineRow = Timeline["rows"][number];

export const liveStepSchema = z.object({
  status: z.enum(["active", "idle", "error", "waiting-for-host", "pending", "provisioning", "starting", "stopping"]),
  step: z.string().max(60), since: z.number().nullable(),
});
export type LiveStep = z.infer<typeof liveStepSchema>;
export const LIVE_STEP_MS = 15_000;

function latest(rows: TimelineRow[]): TimelineRow | undefined {
  return rows.flatMap((row): TimelineRow[] => row.kind === "turn" ? row.children ?? [] : [row])
    .filter((row) => row.kind === "work" || row.kind === "conversation" && row.role === "assistant")
    .sort((a, b) => b.sourceSeqEnd - a.sourceSeqEnd || b.startedAt - a.startedAt)[0];
}

function stepOf(row: TimelineRow): string {
  // Assistant prose can quote arbitrary file contents. Only typed work metadata
  // supplies specific activity copy; a message contributes its kind and time.
  if (row.kind === "conversation") return "Agent message";
  if (row.kind !== "work") return "No recent activity";
  if (row.workKind === "command") {
    const npm = /^npm (?:test|run [a-z][a-z0-9:-]{0,30})$/.exec(row.command.trim());
    return npm ? `Running ${npm[0]}` : "Running command";
  }
  if (row.workKind === "file-change") {
    const name = row.change.path.split(/[\\/]/).pop() ?? "";
    return /^[a-z][a-z0-9_.-]{0,40}\.(?:md|tsx?|jsx?|css|json|swift)$/i.test(name) ? `Editing ${name}` : "Editing file";
  }
  // The native work kind is safe metadata. Arguments, commands, file bodies,
  // presentation strings and output may carry private content, so don't copy them.
  const labels: Record<string, string> = {
    tool: "Using tool",
    "web-search": "Searching the web", "web-fetch": "Reading a web page", "file-read": "Reading file",
    search: "Searching", "plan-steps": "Updating plan", question: "Asking a question", approval: "Waiting for approval",
    delegation: "Waiting on worker", workflow: "Running workflow",
  };
  return labels[row.workKind] ?? "Using tool";
}

export async function readLiveStep(bb: BbPluginApi, threadId: string): Promise<LiveStep | undefined> {
  try {
    const [thread, timeline] = await Promise.all([
      bb.sdk.threads.get({ threadId }),
      bb.sdk.threads.timeline({ threadId, segmentLimit: "1", includeNestedRows: "true", deferContent: "true" }),
    ]);
    const row = latest(timeline.rows);
    return { status: thread.runtime.displayStatus, step: row ? stepOf(row) : "No recent activity", since: row?.startedAt ?? null };
  } catch { return undefined; }
}

/** One in-flight/cached read per lane across pages. Background watchers never call this. */
export function createLiveStepReader(bb: BbPluginApi, now: () => number) {
  const cache = new Map<string, { at: number; value: Promise<Map<string, LiveStep>> }>();
  return async (board: Board, projectId: string, visibleLaneIds?: string[], force = false): Promise<Board> => {
    const allowed = new Set(visibleLaneIds);
    const lanes = await Promise.all(board.lanes.map(async (lane): Promise<Lane> => {
      if (lane.state !== "flying" || visibleLaneIds && !allowed.has(lane.specId)) return lane;
      const ids = [...new Set([lane.leadThreadId, ...lane.tickets.filter((ticket) => isActiveTicket(ticket.state)).flatMap((ticket) => ticket.threadId ? [ticket.threadId] : [])])];
      const key = `${projectId}:${lane.specId}`;
      let entry = cache.get(key);
      if (!entry || force || now() - entry.at >= LIVE_STEP_MS) {
        entry = { at: now(), value: Promise.all(ids.map(async (id) => [id, await readLiveStep(bb, id)] as const))
          .then((values) => new Map(values.filter((pair): pair is readonly [string, LiveStep] => pair[1] !== undefined))) };
        cache.set(key, entry);
      }
      const steps = await entry.value;
      return { ...lane, ...(steps.has(lane.leadThreadId) ? { liveStep: steps.get(lane.leadThreadId)! } : {}), tickets: lane.tickets.map((ticket) => ({ ...ticket,
        ...(ticket.threadId && isActiveTicket(ticket.state) && steps.has(ticket.threadId) ? { liveStep: steps.get(ticket.threadId)! } : {}),
      })) };
    }));
    const keys = new Set(board.lanes.filter((lane) => lane.state === "flying").map((lane) => `${projectId}:${lane.specId}`));
    for (const key of cache.keys()) if (key.startsWith(`${projectId}:`) && !keys.has(key)) cache.delete(key);
    return { ...board, lanes };
  };
}
