// Clean up after landing: once a lane's PR has merged, archive each of its saved, idle worker threads so BB
// removes their worktrees after its own grace period. Squadron never removes a worktree itself. Leads, reviewers
// and planning threads are never archived. Anything not provably saved is kept and listed under Needs you.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Board } from "./board-model.js";
import { worktreeHostContract } from "./worktree-contract.js";
import { isRunningThread, type LeadThread, type WorkerThread } from "./lead-threads.js";

/** What the worker's worktree holds: no uncommitted changes, and every commit on a remote branch. */
export interface WorktreeState { clean: boolean; pushed: boolean }

export interface CleanupDeps {
  /** The worktree's state, or null when it can't be read. */
  inspect(worker: WorkerThread): Promise<WorktreeState | null>;
  archive(threadId: string): Promise<void>;
}

export interface KeptWorker { specId: string; threadId: string; text: string }
export interface CleanupResult { archived: string[]; kept: KeptWorker[] }

/** Launch-record roles that build a ticket. A reviewer or a thread without a record is never archived. */
const WORKER_ROLES: readonly string[] = ["Worker", "Worker (hard)", "Mechanical"];

export async function cleanUpLanes(board: Board, leads: readonly LeadThread[], deps: CleanupDeps): Promise<CleanupResult> {
  const result: CleanupResult = { archived: [], kept: [] };
  for (const lane of board.lanes) {
    // Only a merged PR proves the lane's work is on main.
    if (lane.outside || lane.state !== "landed" || lane.pr?.state !== "merged") continue;
    const lead = leads.find(({ thread, outside }) => !outside && thread.id === lane.leadThreadId);
    if (!lead) continue;
    for (const worker of lead.workers ?? []) {
      if (!worker.record || !WORKER_ROLES.includes(worker.record.role)) continue;
      const name = worker.record.tickets[0]?.identifier ?? lane.specId;
      const keep = (why: string) => result.kept.push({ specId: lane.specId, threadId: worker.id, text: `Unsaved work in ${name}'s worker. ${why}` });
      // A worker that shares the Lead's worktree would take it away with the Lead.
      if (!worker.environmentId || worker.environmentId === lead.thread.environmentId) continue;
      if (isRunningThread(worker) || worker.status !== "idle" || worker.hasPendingInteraction) { keep("The worker is still running."); continue; }
      let state: WorktreeState | null = null;
      try { state = await deps.inspect(worker); } catch { /* unreadable is unknown, never safe */ }
      if (!state) { keep("Its worktree couldn't be checked."); continue; }
      if (!state.clean) { keep("Its worktree has uncommitted changes."); continue; }
      if (!state.pushed) { keep("Its branch has commits that aren't on the remote."); continue; }
      try { await deps.archive(worker.id); result.archived.push(worker.id); }
      catch { keep("It couldn't be archived."); }
    }
  }
  return result;
}

/** The live wiring: read each worker's worktree on its host through Squadron's host entry, and archive through BB. */
export function liveCleanUp(bb: BbPluginApi): (projectId: string, board: Board, leads: LeadThread[]) => Promise<CleanupResult> {
  const host = bb.hosts.experimental_client({ contract: worktreeHostContract });
  return (_projectId, board, leads) => cleanUpLanes(board, leads, {
    inspect: async (worker) => {
      const environment = await bb.sdk.environments.get({ environmentId: worker.environmentId! });
      if (environment.status !== "ready" || !environment.path || !environment.hostId) return null;
      return host.call("readWorktreeState", { worktreePath: environment.path }, { hostId: environment.hostId, timeoutMs: 30_000 });
    },
    archive: async (threadId) => { await bb.sdk.threads.archive({ threadId }); },
  });
}
