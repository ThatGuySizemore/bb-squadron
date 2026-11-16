// A lane's time limit counts only the time its threads run a turn, read from BB's turn events.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isRunningThread, type LeadThread } from "./lead-threads.js";

type ThreadEvent = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];
export type Interval = readonly [start: number, end: number];

/** BB rejects event pages over 100. */
const PAGE = 100;

/**
 * The spans one thread spent running a turn: `turn/started` to the next `turn/completed` or `system/thread/interrupted`.
 * A start that never recorded its end closes at the next start. A turn still open at the end counts up to `now`
 * only while the thread is running; otherwise its end went unrecorded and it counts nothing.
 */
export function turnIntervals(events: readonly ThreadEvent[], now: number, running: boolean): Interval[] {
  const spans: Interval[] = [];
  let open: number | undefined;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.type === "turn/started") {
      if (open !== undefined) spans.push([open, event.createdAt]);
      open = event.createdAt;
    } else if (event.type === "turn/completed" || event.type === "system/thread/interrupted") {
      if (open !== undefined) spans.push([open, Math.max(open, event.createdAt)]);
      open = undefined;
    }
  }
  if (open !== undefined && running) spans.push([open, Math.max(open, now)]);
  return spans;
}

/** Total length of the intervals, with overlapping time counted once. */
export function unionMs(intervals: readonly Interval[]): number {
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

async function readTurnEvents(bb: BbPluginApi, threadId: string): Promise<ThreadEvent[]> {
  const all: ThreadEvent[] = [];
  for (let beforeSeq: string | undefined; ;) {
    const page = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: String(PAGE), beforeSeq,
      types: ["turn/started", "turn/completed", "system/thread/interrupted"] });
    all.push(...page);
    if (page.length < PAGE) return all;
    beforeSeq = String(Math.min(...page.map((event) => event.seq)));
  }
}

export interface ActiveTime {
  /** The Lead and its children together, overlap counted once. */
  laneMs: number;
  /** Each thread on its own: the Lead first. */
  threads: { threadId: string; title: string; ms: number }[];
}

/** The Lead's and its workers' running time. Archived workers count too: their turns still ran in this lane. */
export async function readActiveTime(bb: BbPluginApi, projectId: string, lead: LeadThread, now: number): Promise<ActiveTime> {
  const children: { id: string; title: string; running: boolean }[] = [];
  const seen = new Set<string>();
  for (const archived of [false, true]) {
    for (let offset = 0; ; offset += 200) {
      const page = await bb.sdk.threads.list({ projectId, parentThreadId: lead.thread.id, archived, includeHidden: true, limit: 200, offset });
      for (const thread of page) {
        if (thread.parentThreadId !== lead.thread.id || thread.projectId !== projectId || thread.deletedAt !== null || seen.has(thread.id)) continue;
        seen.add(thread.id);
        children.push({ id: thread.id, title: thread.title ?? thread.id, running: !archived && isRunningThread(thread) });
      }
      if (page.length < 200) break;
    }
  }
  const members = [{ id: lead.thread.id, title: "Lead", running: isRunningThread(lead.thread) }, ...children];
  const spans = await Promise.all(members.map(async (member) => turnIntervals(await readTurnEvents(bb, member.id), now, member.running)));
  return { laneMs: unionMs(spans.flat()), threads: members.map((member, index) => ({ threadId: member.id, title: member.title, ms: unionMs(spans[index]) })) };
}

/** "1 h 20 min", "45 min", "3 h". Under a minute reads "under 1 min". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return ms > 0 ? "under 1 min" : "0 min";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} h` : "", rest || !hours ? `${rest} min` : ""].filter(Boolean).join(" ");
}

/** What `bb squadron time` prints. */
export function formatActiveTime(identifier: string, time: ActiveTime, limitMs: number | undefined, limitName: "lane" | "worker"): string {
  const limit = limitMs === undefined ? "" : ` of its ${formatDuration(limitMs)} ${limitName} limit`;
  const left = limitMs === undefined ? "" : time.laneMs >= limitMs ? " The limit is reached." : ` ${formatDuration(limitMs - time.laneMs)} left.`;
  return [`${identifier} active time: ${formatDuration(time.laneMs)}${limit}.${left}`,
    "This is the time its Lead and workers spent running a turn. Overlap counts once. Waiting, stopped and idle time isn't counted.",
    ...time.threads.map((thread) => `  ${thread.title}: ${formatDuration(thread.ms)}`)].join("\n") + "\n";
}
