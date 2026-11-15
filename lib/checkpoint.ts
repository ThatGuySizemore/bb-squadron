// The optional evaluation checkpoint: once a project has completed its configured number
// of routine tickets under the shared policy, its Helper gets one plain notice. The count
// is derived each time; only the notifier's delivery receipt is stored. It never pauses launches.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readLaunchCohort } from "./launch-record.js";
import { oneLine } from "./project-observation.js";
import { checkpointCandidates } from "./run-report.js";
import type { TicketHistoryReader } from "./ticket-history.js";

/** The notifier's notice name: one checkpoint notice per project. */
export const CHECKPOINT_NOTICE = "checkpoint";
/** How often a project's progress is derived again while its notice is outstanding. */
export const CHECKPOINT_CHECK_MS = 10 * 60_000;

export interface CheckpointSources {
  notifier: { noticed(projectId: string, name: string): Promise<boolean>; notice(projectId: string, name: string, line: string): Promise<void> };
  history: TicketHistoryReader;
  /** The resolved House rules Checkpoint: a number, null when unset, or unknown when settings couldn't be read. */
  checkpoint(projectId: string, signal?: AbortSignal): Promise<number | null | "unknown">;
}

export function checkpointLine(projectName: string, counted: number, setting: number, startThreadId: string): string {
  return `${oneLine(projectName)} | Checkpoint | ${counted} routine tickets | ${counted} routine tickets are done since the first policy-resolved Worker launch, reaching your Checkpoint of ${setting}. Nothing needs you and lanes keep starting. To compare like categories with earlier runs, use bb squadron report. | @thread:${startThreadId}`;
}

export function registerCheckpoint(bb: BbPluginApi, sources: CheckpointSources) {
  const lifetime = new AbortController();
  const checkedAt = new Map<string, number>();
  const running = new Set<string>();
  /** Tickets already read as Done this session, so a repeated check reads only the rest. Not stored. */
  const completed = new Map<string, Set<string>>();
  let disposed = false;
  const work = new Set<Promise<void>>();
  bb.onDispose(async () => { disposed = true; lifetime.abort(); await Promise.allSettled([...work]); });

  async function check(projectId: string, projectName: string) {
    if (await sources.notifier.noticed(projectId, CHECKPOINT_NOTICE)) return;
    const setting = await sources.checkpoint(projectId, lifetime.signal);
    if (typeof setting !== "number") return;
    // Metadata and the cohort start only: usage, comments and other evidence belong to the on-demand report.
    const records = await readLaunchCohort(bb, projectId);
    const start = records.firstVerifiedPolicyWorker;
    const candidates = checkpointCandidates(records);
    // Fewer launched routine tickets than the setting can't reach it, so the tracker isn't read.
    if (!start || candidates.length < setting) return;
    const seen = completed.get(projectId) ?? new Set<string>();
    completed.set(projectId, seen);
    const unread = candidates.filter((ticket) => !seen.has(ticket.id));
    if (unread.length) {
      const history = await sources.history.read(projectId, unread, { comments: false, signal: lifetime.signal });
      for (const ticket of unread) if (history.tickets.get(ticket.id)?.outcome === "completed") seen.add(ticket.id);
    }
    const counted = candidates.filter((ticket) => seen.has(ticket.id)).length;
    if (counted < setting || disposed) return;
    await sources.notifier.notice(projectId, CHECKPOINT_NOTICE, checkpointLine(projectName, counted, setting, start.threadId));
  }

  /** Called from the board watcher's observation. Never waits on, or acts on, the board. */
  function observe(projectId: string, projectName: string) {
    if (disposed || running.has(projectId)) return;
    const last = checkedAt.get(projectId);
    if (last !== undefined && Date.now() - last < CHECKPOINT_CHECK_MS) return;
    checkedAt.set(projectId, Date.now());
    running.add(projectId);
    const task = check(projectId, projectName)
      .catch(() => { bb.log.warn("Checkpoint progress unavailable; will check again."); })
      .finally(() => { running.delete(projectId); work.delete(task); });
    work.add(task);
  }
  return { observe };
}
