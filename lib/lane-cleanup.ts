// Clean up after landing: once a lane's PR has merged, archive each of its saved, idle worker threads so BB
// removes their worktrees after its own grace period. Squadron never removes a worktree itself. Leads, reviewers
// and planning threads are never archived. Anything not provably saved is kept and listed under Needs you.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { worktreeHostContract } from "./worktree-contract.js";
import { isRunningThread, readWorkers, type LeadThread, type WorkerThread } from "./lead-threads.js";

/** What the worker's worktree holds: no uncommitted changes, and every commit on a remote branch. */
export interface WorktreeState { clean: boolean; pushed: boolean }

export interface CleanupLanes {
  leads: readonly LeadThread[];
  /** Thread ids of the Leads whose PR has merged. Every Lead counts, including older ones a returning lane hides. */
  merged: ReadonlySet<string>;
  /** The spec's identifier as the owner reads it. */
  identify(specId: string): string;
  /** Identifiers of the spec's tickets still open, held ones aside. A lane with any is not Landed, so its workers on them stay. */
  openTickets?(specId: string): ReadonlySet<string>;
}

export interface CleanupDeps {
  /** The worktree's state, or null when it can't be read. */
  inspect(worker: WorkerThread): Promise<WorktreeState | null>;
  /** The worker as BB reports it now, or null when it is gone. Read just before archiving, after the slow worktree check. */
  current(worker: WorkerThread, lead: LeadThread): Promise<WorkerThread | null>;
  archive(threadId: string): Promise<void>;
}

const running = (worker: WorkerThread) => isRunningThread(worker) || worker.status !== "idle" || worker.hasPendingInteraction === true;

export interface KeptWorker { specId: string; threadId: string; text: string }
export interface CleanupResult { archived: string[]; kept: KeptWorker[] }

/** Launch-record roles that build a ticket. A reviewer or a thread without a record is never archived. */
const WORKER_ROLES: readonly string[] = ["Worker", "Worker (hard)", "Mechanical"];

export async function cleanUpLanes(lanes: CleanupLanes, deps: CleanupDeps): Promise<CleanupResult> {
  const result: CleanupResult = { archived: [], kept: [] };
  for (const lead of lanes.leads) {
    // Only a merged PR proves the lane's work is on main.
    if (lead.outside || !lanes.merged.has(lead.thread.id)) continue;
    const specId = lanes.identify(lead.specId);
    const openTickets = lanes.openTickets?.(lead.specId) ?? new Set<string>();
    for (const worker of lead.workers ?? []) {
      if (!worker.record || !WORKER_ROLES.includes(worker.record.role)) continue;
      const name = worker.record.tickets[0]?.identifier ?? specId;
      // A lane still open keeps any worker on an open ticket, and one that names no ticket: it can't be shown finished.
      if (openTickets.size && (!worker.record.tickets.length || worker.record.tickets.some((ticket) => openTickets.has(ticket.identifier)))) continue;
      const keep = (why: string) => result.kept.push({ specId, threadId: worker.id, text: `Unsaved work in ${name}'s worker. ${why}` });
      // A worker that shares the Lead's worktree would take it away with the Lead.
      if (!worker.environmentId || worker.environmentId === lead.thread.environmentId) continue;
      if (running(worker)) { keep("The worker is still running."); continue; }
      let state: WorktreeState | null = null;
      try { state = await deps.inspect(worker); } catch { /* unreadable is unknown, never safe */ }
      if (!state) { keep("Its worktree couldn't be checked."); continue; }
      if (!state.clean) { keep("Its worktree has uncommitted changes."); continue; }
      if (!state.pushed) { keep("Its branch has commits that aren't on the remote."); continue; }
      try {
        // The check took time. A worker the owner or Lead resumed meanwhile is running again, so it stays.
        const now = await deps.current(worker, lead);
        if (!now || running(now)) { keep("The worker is still running."); continue; }
        await deps.archive(worker.id);
        result.archived.push(worker.id);
      } catch { keep("It couldn't be archived."); }
    }
  }
  return result;
}

/** The live wiring: read each worker's worktree on its host through Squadron's host entry, and archive through BB. */
export function liveCleanUp(bb: BbPluginApi): (projectId: string, lanes: CleanupLanes) => Promise<CleanupResult> {
  const host = bb.hosts.experimental_client({ contract: worktreeHostContract });
  return (projectId, lanes) => cleanUpLanes(lanes, {
    current: async (worker, lead) => (await readWorkers(bb, projectId, lead.thread.id)).find(({ id }) => id === worker.id) ?? null,
    inspect: async (worker) => {
      const environment = await bb.sdk.environments.get({ environmentId: worker.environmentId! });
      if (environment.status !== "ready" || !environment.path || !environment.hostId) return null;
      return host.call("readWorktreeState", { worktreePath: environment.path }, { hostId: environment.hostId, timeoutMs: 30_000 });
    },
    archive: async (threadId) => { await bb.sdk.threads.archive({ threadId }); },
  });
}
