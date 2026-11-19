// Clean up after landing: once a lane's PR has merged, archive each of its saved, idle worker threads so BB
// removes their worktrees after its own grace period. Squadron never removes a worktree itself. Once the spec is
// also Done, the Lead's review threads, the workers in its worktree and then the Lead itself go the same way,
// under the same saved-work checks. Planning threads and the Helper are never archived. Anything not provably
// saved is kept and listed under Needs you.
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
  /** The spec is Done on its tracker. Without it, or when false, the Lead and its review threads stay. */
  specDone?(specId: string): boolean;
}

/** A thread whose worktree is read: a worker, a review thread or a Lead. */
export type CleanupThread = Pick<WorkerThread, "id" | "environmentId">;

export interface CleanupDeps {
  /** The worktree's state, or null when it can't be read. */
  inspect(thread: CleanupThread): Promise<WorktreeState | null>;
  /** The worker as BB reports it now, or null when it is gone. Read just before archiving, after the slow worktree check. */
  current(worker: WorkerThread, lead: LeadThread): Promise<WorkerThread | null>;
  /** The Lead and its active children as BB reports them now, or null when the Lead is gone. Read just before archiving the Lead. */
  currentLead?(lead: LeadThread): Promise<{ lead: LeadThread["thread"]; children: WorkerThread[] } | null>;
  archive(threadId: string): Promise<void>;
}

const running = (worker: Parameters<typeof isRunningThread>[0] & { hasPendingInteraction?: boolean }) => isRunningThread(worker) || worker.status !== "idle" || worker.hasPendingInteraction === true;

export interface KeptWorker { specId: string; threadId: string; text: string }
export interface CleanupResult { archived: string[]; kept: KeptWorker[] }

/** Launch-record roles that build a ticket. A reviewer or a thread without a record is never archived. */
const WORKER_ROLES: readonly string[] = ["Worker", "Worker (hard)", "Mechanical"];
const isReviewer = (worker: WorkerThread) => worker.record?.role.startsWith("Review of") === true;

export async function cleanUpLanes(lanes: CleanupLanes, deps: CleanupDeps): Promise<CleanupResult> {
  const result: CleanupResult = { archived: [], kept: [] };
  /** Checks a child's worktree, then archives it. False means it was kept (and listed, when it holds unsaved work). */
  async function archiveChild(child: WorkerThread, lead: LeadThread, specId: string, name: string, label: string, readWorktree: boolean): Promise<boolean> {
    const keep = (why: string) => { result.kept.push({ specId, threadId: child.id, text: `Unsaved work in ${name}'s ${label}. ${why}` }); return false; };
    if (running(child)) return keep(`The ${label} is still running.`);
    if (readWorktree) {
      let state: WorktreeState | null = null;
      try { state = await deps.inspect(child); } catch { /* unreadable is unknown, never safe */ }
      if (!state) return keep("Its worktree couldn't be checked.");
      if (!state.clean) return keep("Its worktree has uncommitted changes.");
      if (!state.pushed) return keep("Its branch has commits that aren't on the remote.");
    }
    try {
      // The check took time. A thread the owner or Lead resumed meanwhile is running again, so it stays.
      const now = await deps.current(child, lead);
      if (!now || running(now)) return keep(`The ${label} is still running.`);
      await deps.archive(child.id);
      result.archived.push(child.id);
      return true;
    } catch { return keep("It couldn't be archived."); }
  }

  for (const lead of lanes.leads) {
    // Only a merged PR proves the lane's work is on main.
    if (lead.outside || !lanes.merged.has(lead.thread.id)) continue;
    const specId = lanes.identify(lead.specId);
    const openTickets = lanes.openTickets?.(lead.specId) ?? new Set<string>();
    const handled = new Set<string>();
    for (const worker of lead.workers ?? []) {
      if (!worker.record || !WORKER_ROLES.includes(worker.record.role)) continue;
      const name = worker.record.tickets[0]?.identifier ?? specId;
      // A lane still open keeps any worker on an open ticket, and one that names no ticket: it can't be shown finished.
      if (openTickets.size && (!worker.record.tickets.length || worker.record.tickets.some((ticket) => openTickets.has(ticket.identifier)))) continue;
      // A worker that shares the Lead's worktree goes with the Lead, below.
      if (!worker.environmentId || worker.environmentId === lead.thread.environmentId) continue;
      handled.add(worker.id);
      await archiveChild(worker, lead, specId, name, "worker", true);
    }
    if (lanes.specDone?.(lead.specId) === true) await cleanUpLead(lead, specId, handled);
  }

  /** The Lead's pass, once its spec is Done: its children first, then the Lead. Any child left keeps the Lead. */
  async function cleanUpLead(lead: LeadThread, specId: string, handled: ReadonlySet<string>): Promise<void> {
    const children = lead.workers ?? [];
    // A running Lead or child means the lane isn't finished. That is not unsaved work, so nothing is listed.
    if (running(lead.thread) || children.some(running)) return;
    const own = { id: lead.thread.id, environmentId: lead.thread.environmentId ?? undefined };
    let state: WorktreeState | null = null;
    try { state = own.environmentId ? await deps.inspect(own) : null; } catch { /* unreadable is unknown, never safe */ }
    const keepLead = (why: string) => { result.kept.push({ specId, threadId: lead.thread.id, text: `Unsaved work in ${specId}'s Lead. ${why}` }); };
    if (!state) return keepLead("Its worktree couldn't be checked.");
    if (!state.clean) return keepLead("Its worktree has uncommitted changes.");
    if (!state.pushed) return keepLead("Its branch has commits that aren't on the remote.");
    let left = 0;
    for (const child of children) {
      if (handled.has(child.id)) { if (!result.archived.includes(child.id)) left++; continue; }
      const shared = !child.environmentId || child.environmentId === lead.thread.environmentId;
      const worker = child.record && WORKER_ROLES.includes(child.record.role);
      // Review threads and workers in the Lead's worktree. Anything else, such as a thread without a launch record, stays.
      if (!child.record || !(worker || isReviewer(child))) { left++; continue; }
      const name = child.record.tickets[0]?.identifier ?? specId;
      if (!await archiveChild(child, lead, specId, name, isReviewer(child) ? "review thread" : "worker", !shared)) left++;
    }
    if (left) return;
    try {
      // The Lead is archived last. Re-read it, since the checks took time.
      const now = await deps.currentLead?.(lead);
      if (!now || running(now.lead) || now.children.length > 0) return;
      await deps.archive(lead.thread.id);
      result.archived.push(lead.thread.id);
    } catch { keepLead("It couldn't be archived."); }
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
    currentLead: async (lead) => {
      const thread = await bb.sdk.threads.get({ threadId: lead.thread.id }).catch(() => null);
      if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) return null;
      return { lead: thread, children: await readWorkers(bb, projectId, lead.thread.id) };
    },
    archive: async (threadId) => { await bb.sdk.threads.archive({ threadId }); },
  });
}
