// Outside lanes: lanes started outside Squadron, found from BB's threads and shown read-only.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TrackerIssue, TrackerSnapshot } from "./tracker-contract.js";
import { readWorkers, threadRoute, type LeadThread } from "./lead-threads.js";
import { escapeRegExp } from "./issue-text.js";
import { isActiveProjectThread } from "./project-thread.js";
import { openLaneCandidates, type PlanningThread } from "./board-derive.js";

/** One non-archived thread in a BB project, as outside-lane matching sees it. */
export interface ProjectThread {
  id: string;
  title: string | null;
  parentThreadId: string | null;
  createdAt: number;
  /** Squadron started it: its origin is this plugin, or it carries Squadron's metadata. */
  squadron: boolean;
  firstMessage: string | null;
}

/** Whether the text names the spec by identifier, repository path or title, as a whole word. */
export function namesSpec(text: string | null, spec: Pick<TrackerIssue, "identifier" | "title" | "path">): boolean {
  if (!text) return false;
  return [spec.identifier, spec.path, spec.title].some((name) => name?.trim() &&
    // SIZE-94 never matches SIZE-947, and bb-bot never matches bb-bots-sidebar.
    new RegExp(`(?<![\\w-])${escapeRegExp(name.trim())}(?!\\w|-\\w)`, "i").test(text));
}

/**
 * Each spec's outside lane thread, by spec id. A thread under a Squadron thread is Squadron's.
 * A thread under another thread naming the same spec is that lane's worker, not a lane of its own.
 * A thread naming the spec in its title wins over one naming it only in its first message, then the oldest.
 */
export function matchOutsideLanes(specs: readonly TrackerIssue[], threads: readonly ProjectThread[]): Map<string, string> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const ancestors = (thread: ProjectThread) => {
    const found: string[] = [];
    for (let id = thread.parentThreadId; id && !found.includes(id) && id !== thread.id; id = byId.get(id)?.parentThreadId ?? null) found.push(id);
    return found;
  };
  const candidates = threads.filter((thread) => !thread.squadron && !ancestors(thread).some((id) => byId.get(id)?.squadron));
  const lanes = new Map<string, string>();
  for (const spec of specs) {
    const byTitle = new Set(candidates.filter((thread) => namesSpec(thread.title, spec)).map((thread) => thread.id));
    const named = candidates.filter((thread) => byTitle.has(thread.id) || namesSpec(thread.firstMessage, spec));
    const ids = new Set(named.map((thread) => thread.id));
    const [lane] = named.filter((thread) => !ancestors(thread).some((id) => ids.has(id)))
      .sort((a, b) => Number(byTitle.has(b.id)) - Number(byTitle.has(a.id)) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    if (lane) lanes.set(spec.id, lane.id);
  }
  return lanes;
}

/** Branches a first message names as the integration branch, such as "Integration branch: `integration/bb-bot`". */
export function namedIntegrationBranches(text: string | null): string[] {
  return [...(text ?? "").matchAll(/integration branch[^`\n]{0,40}`([^`\s]+)`/gi)].map((match) => match[1]);
}

/** Top-level work an outside lane may fly: open, not being planned, and without a Squadron Lead. */
export function outsideLaneSpecs(snapshot: TrackerSnapshot, leads: readonly LeadThread[], planning: readonly PlanningThread[] = []): TrackerIssue[] {
  const taken = new Set([...leads.map((lead) => lead.specId), ...planning.map((thread) => thread.issueId)]);
  return openLaneCandidates(snapshot, new Set()).filter((spec) => !taken.has(spec.id));
}

export type OutsideLaneReader = (projectId: string, specs: readonly TrackerIssue[]) => Promise<LeadThread[]>;

/**
 * Reads outside lanes from BB's threads. Nothing is stored or sent: a thread's origin, Squadron metadata
 * and first message never change, so they are remembered for this process only.
 */
export function createOutsideLaneReader(bb: BbPluginApi): OutsideLaneReader {
  const known = new Map<string, { squadron: boolean; firstMessage: string | null }>();
  async function firstMessage(threadId: string): Promise<string | null> {
    try {
      const [row] = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "asc", limit: "1" });
      if (row?.type !== "client/turn/requested") return null;
      return row.data.input.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") || null;
    } catch { return null; }
  }
  async function describe(thread: { id: string; originPluginId: string | null }) {
    const cached = known.get(thread.id);
    if (cached) return cached;
    let squadron = thread.originPluginId === bb.pluginId;
    if (!squadron) {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id }).catch(() => ({}));
      squadron = Object.keys(metadata).length > 0;
    }
    const entry = { squadron, firstMessage: squadron ? null : await firstMessage(thread.id) };
    // A thread too new to have its first message is read again next time.
    if (squadron || entry.firstMessage !== null) known.set(thread.id, entry);
    return entry;
  }
  return async (projectId, specs) => {
    if (!specs.length) return [];
    type Row = Awaited<ReturnType<typeof bb.sdk.threads.list>>[number];
    const rows: Row[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await bb.sdk.threads.list({ projectId, archived: false, includeHidden: true, limit: 200, offset });
      rows.push(...page.filter((thread) => isActiveProjectThread(thread, thread.id, projectId)));
      if (page.length < 200) break;
    }
    const threads: ProjectThread[] = [];
    for (let i = 0; i < rows.length; i += 16) {
      threads.push(...await Promise.all(rows.slice(i, i + 16).map(async (row) => ({
        id: row.id, title: row.title, parentThreadId: row.parentThreadId, createdAt: row.createdAt, ...await describe(row) }))));
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    const lanes: LeadThread[] = [];
    for (const [specId, threadId] of matchOutsideLanes(specs, threads)) {
      const thread = byId.get(threadId)!;
      const execution = await bb.sdk.threads.defaultExecutionOptions({ threadId }).catch(() => null);
      const own = thread.environmentBranchName;
      const branchCandidates = [...new Set([...namedIntegrationBranches(known.get(threadId)?.firstMessage ?? null), ...(own ? [own] : [])])];
      lanes.push({ specId, thread, outside: true, branch: branchCandidates[0] ?? "", branchCandidates,
        workers: await readWorkers(bb, projectId, threadId),
        route: threadRoute(thread.providerId, execution) });
    }
    return lanes;
  };
}
