// Derives the board from a tracker snapshot and project settings.
import { canMerge, dependencyColumns, reviewerFor, type Blocker, type Board, type Lane, type LinearStatus, type ReadySpec, type Route, type Ticket, type OpenIssue } from "./board-model.js";
import type { TrackerIssue, TrackerSnapshot } from "./tracker-contract.js";
import { resolveRoute, type SettingsResult } from "./squadron-settings.js";
import { ACCEPT_OWNER, READY_FOR_AGENT, isOpenIssue } from "./linear-issues.js";
import type { DoctorReport } from "./doctor.js";
import type { LeadThread, WorkerThread } from "./lead-threads.js";
import type { PullRequestRow } from "./pull-requests.js";
import { isActiveProjectThread } from "./project-thread.js";
import { trackerName } from "./tracker-detection.js";

export interface BoardInput {
  snapshot: TrackerSnapshot;
  connection: { status: "connected" | "disconnected" | "failed"; message: string };
  settings: SettingsResult | null;
  doctor?: DoctorReport;
  leads?: LeadThread[];
  /** Rows from BB's pull-request plugin, keyed by environment id. */
  pullRequests?: Record<string, PullRequestRow>;
  /** The board clock for derived lane state. */
  now: number;
}

export interface DerivedBoard {
  board: Board;
}

function byIdentifier(a: TrackerIssue, b: TrackerIssue): number {
  return a.identifier.localeCompare(b.identifier, "en", { numeric: true });
}

function list(ids: string[]): string {
  return ids.length < 2 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
}

type LaneThread = Pick<WorkerThread, "id" | "status" | "runtime" | "hasPendingInteraction" | "queuedWork">;
/** BB statuses in which a thread is still doing, or about to do, work. */
const RUNNING = new Set(["active", "starting", "pending", "stopping"]);

/** Why a lane thread needs the owner, read only from its BB state. */
function threadNeed(thread: LaneThread, who: string): NonNullable<Lane["needs"]>[number] | null {
  if (thread.hasPendingInteraction) return { threadId: thread.id, kind: "waiting", text: `${who} is waiting on you.` };
  if (thread.status === "error") return { threadId: thread.id, kind: "failed", text: `${who} failed. Open it to see why.` };
  if (thread.queuedWork === "failed") return { threadId: thread.id, kind: "blocked", text: `${who} couldn't deliver a queued message.` };
  if (thread.runtime.displayStatus === "waiting-for-host") {
    return { threadId: thread.id, kind: "blocked", text: `${who} is waiting for its machine to come online.` };
  }
  return null;
}

function uniqueRoutes(routes: Route[]): Route[] {
  return [...new Map(routes.map((route) => [`${route.family}|${route.model}|${route.effort}`, route])).values()];
}

export function deriveBoard(input: BoardInput): DerivedBoard {
  const { snapshot } = input;
  const usesLinear = snapshot.kind === "linear";
  const tracker = snapshot.kind ? trackerName(snapshot.kind) : "the tracker";
  const settings = input.settings?.ok ? input.settings.settings : null;
  const open = snapshot.issues.filter((issue) => issue.inProject && isOpenIssue(issue)).sort(byIdentifier);
  const labels = (issue: TrackerIssue) => issue.labels.map((label) => label.name);
  const specs = open.filter((issue) => issue.parentId === null && labels(issue).includes(READY_FOR_AGENT));
  const specIds = new Set(specs.map((spec) => spec.id));
  const byId = new Map(snapshot.issues.map((issue) => [issue.id, issue]));
  const project = snapshot.project;
  const leads = new Map((input.leads ?? []).filter(({ thread }) =>
    project && isActiveProjectThread(thread, thread.id, snapshot.bbProjectId)).map((lead) => [lead.specId, lead]));
  // A spec its Lead closed after the merge keeps its lane, so the lane lands and stays Landed.
  const closedSpecs = snapshot.issues.filter((issue) => issue.parentId === null && issue.state.type === "completed" &&
    issue.inProject && labels(issue).includes(READY_FOR_AGENT));
  const lanes: Lane[] = [...specs, ...closedSpecs].sort(byIdentifier).flatMap((spec) => {
    const lead = leads.get(spec.id);
    return lead ? [lane(spec, lead)] : [];
  });
  /** Tracker ticket states; only Linear uses the configured status mapping. */
  function ticketState(issue: TrackerIssue): Ticket["state"] {
    if (snapshot.kind === "github") {
      if (issue.state.type === "completed") return "done";
      return issue.assignees.length > 0 || issue.state.type === "started" ? "working" : "blocked";
    }
    if (snapshot.kind === "local-markdown") {
      if (issue.state.type === "completed") return "done";
      return ["in-progress", "claimed"].includes(issue.state.name.toLowerCase()) ? "working" : "blocked";
    }
    const mapping = settings?.statusMapping.ticket;
    if (issue.state.type === "completed" || issue.state.name === mapping?.done) return "done";
    if (issue.state.name === mapping?.inBranch) return "branch";
    if (issue.state.name === mapping?.working) return "working";
    return "blocked";
  }
  function lane(spec: TrackerIssue, lead: LeadThread): Lane {
    const issues = snapshot.issues.filter((issue) => issue.parentId === spec.id && issue.state.type !== "canceled");
    const ids = new Set(issues.map((issue) => issue.id));
    const workers = lead.workers ?? [];
    const needs = [threadNeed(lead.thread, `The Lead for ${spec.identifier}`),
      ...workers.map((worker) => threadNeed(worker, worker.title ?? "A worker"))].filter((need) => need !== null);
    // Stopped is only the threads' status (ADR-0008): nothing in the lane is running.
    const stopped = [lead.thread, ...workers].every((thread) => !RUNNING.has(thread.status));
    const children = [...workers].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const matched = new Set<string>();
    const tickets: Ticket[] = issues.sort(byIdentifier).map((issue) => {
      // The newest child naming the ticket is its worker; FIX-1 never matches FIX-12.
      const pattern = new RegExp(`(?<![A-Za-z0-9])${issue.identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`, "i");
      const worker = children.find((child) => pattern.test(child.title ?? ""));
      if (worker) matched.add(worker.id);
      return {
        id: issue.identifier, title: issue.title,
        blockedBy: snapshot.relations.filter((relation) => relation.relatedIssueId === issue.id && ids.has(relation.issueId))
          .map((relation) => byId.get(relation.issueId)!.identifier),
        route: settings ? resolveRoute(settings, labels(issue)) : lead.route,
        state: ticketState(issue),
        minutes: worker ? Math.max(0, Math.floor((input.now - worker.createdAt) / 60_000)) : 0,
        ...(worker ? { threadId: worker.id } : {}),
      };
    });
    const row = lead.thread.environmentId ? input.pullRequests?.[lead.thread.environmentId] : undefined;
    const pr = row?.outcome === "available" ? row.pullRequest : undefined;
    const landedAt = pr?.state === "merged" ? Date.parse(pr.updatedAt) : undefined;
    const checks = pr?.checks.state === "no_checks" ? "none" as const : pr?.checks.state;
    const acceptOwner = labels(spec).includes(ACCEPT_OWNER);
    // accept:owner holds a mergeable PR for the owner's click; other Leads merge their own.
    const inReview = pr?.state === "open" ? (acceptOwner && checks && canMerge({ pr: { state: pr.state, checks } }) ? "merge-waits" : "pr-open") : null;
    return {
      specId: spec.identifier, title: spec.title, url: spec.url, lead: lead.route, leadThreadId: lead.thread.id,
      branch: lead.branch,
      state: landedAt !== undefined ? "landed" : inReview ?? (stopped ? "stopped" : "flying"),
      stopped,
      ...(needs.length ? { needs } : {}),
      minutes: Math.max(0, Math.floor(((landedAt ?? input.now) - lead.thread.createdAt) / 60_000)),
      ...(pr && checks ? { pr: { number: pr.number, state: pr.state, url: pr.url, checks } } : {}),
      ...(landedAt !== undefined ? { landedAt } : {}),
      ...(settings ? { reviewer: reviewerFor(lead.route, settings.finalReviewFamily,
        // The default row speaks for its family before label-specific rows.
        [...settings.routes].sort((a, b) => Number(b.label === null) - Number(a.label === null))
          .map(({ family, model, effort }) => ({ family, model, effort }))) } : {}),
      acceptOwner, tickets: dependencyColumns(tickets).flat(),
      unmatchedThreads: workers.filter((child) => !matched.has(child.id))
        .map((child) => ({ threadId: child.id, title: child.title ?? "" })),
    };
  }
  /** Open blockers of one issue, in identifier order. Unknown endpoints are skipped. */
  const openBlockers = (issue: TrackerIssue): Blocker[] => snapshot.relations
    .filter((relation) => relation.relatedIssueId === issue.id)
    .flatMap((relation) => {
      const blocker = byId.get(relation.issueId);
      return blocker && isOpenIssue(blocker) ? [blocker] : [];
    })
    .sort(byIdentifier)
    .map((blocker) => ({
      id: blocker.identifier, title: blocker.title, url: blocker.url,
      outside: !blocker.inProject,
    }));
  const ready: ReadySpec[] = specs.filter((spec) => !leads.has(spec.id)).map((spec) => {
    const tickets = open.filter((issue) => issue.parentId === spec.id);
    const specBlockers = openBlockers(spec);
    const ticketBlockers = tickets.map(openBlockers);
    const blockers = [...new Map([...specBlockers, ...ticketBlockers.flat()].map((blocker) => [blocker.id, blocker])).values()]
      .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    let startReason: string | null;
    const doctorFix = input.doctor?.checks.find((check) => check.status === "fix");
    if (usesLinear && input.connection.status !== "connected") {
      startReason = input.connection.message;
    } else if (usesLinear && !project) {
      startReason = "Choose this project's Linear team and project before Start.";
    } else if (snapshot.error || snapshot.syncedAt === null) {
      startReason = snapshot.error ?? `Wait for ${tracker} to finish reading this project's issues.`;
    } else if (doctorFix) {
      startReason = doctorFix.message;
    } else if (specBlockers.length) {
      startReason = `Waits on ${list(specBlockers.map((blocker) => blocker.outside ? `${blocker.id} (outside this project)` : blocker.id))}`;
    } else if (!tickets.length) {
      startReason = "Has no open tickets. Plan its tickets first.";
    } else if (ticketBlockers.every((found) => found.length > 0)) {
      startReason = `Every ticket waits on a blocker: ${[...new Set(ticketBlockers.flat().map((blocker) => blocker.id))].join(", ")}`;
    } else if (!settings) {
      const sections = input.settings && !input.settings.ok ? input.settings.issues.map((issue) => issue.section) : [];
      startReason = sections.length
        ? `Fix docs/agents/squadron.md first: ${[...new Set(sections)].join(", ")}. Open Doctor for details.`
        : "Couldn't read docs/agents/squadron.md. Open Doctor for details.";
    } else {
      startReason = input.doctor?.ready ? null : "Check Doctor before starting a lane.";
    }
    return {
      id: spec.identifier, title: spec.title, url: spec.url, ticketCount: tickets.length,
      routes: settings ? uniqueRoutes(tickets.map((ticket) => resolveRoute(settings, labels(ticket)))) : [],
      blockedBy: blockers.map((blocker) => blocker.id), blockers, startReason,
      acceptOwner: labels(spec).includes(ACCEPT_OWNER),
    };
  });
  // Anything open that isn't a Ready spec or one of its tickets waits here,
  // so no issue in the bound project drops off the board.
  const under = (issue: TrackerIssue): string | undefined => {
    if (issue.parentId === null) return undefined;
    const parent = byId.get(issue.parentId);
    if (!parent) return "Under an issue this board can't see";
    if (!parent.inProject) return `Under ${parent.identifier}, outside this project`;
    if (!isOpenIssue(parent)) return `Under ${parent.identifier}, which is closed`;
    return `Under ${parent.identifier}`;
  };
  const openIssues: OpenIssue[] = open
    .filter((issue) => !specIds.has(issue.id) && !(issue.parentId !== null && specIds.has(issue.parentId)))
    .map((issue) => {
      const parent = under(issue);
      return { id: issue.identifier, title: issue.title, url: issue.url, labels: labels(issue), ...(parent ? { under: parent } : {}) };
    });
  let linear: LinearStatus["state"];
  let message: string;
  if (usesLinear && input.connection.status !== "connected") {
    linear = "disconnected"; message = input.connection.message;
  } else if (usesLinear && !project) {
    linear = "unbound"; message = "Choose the Linear team and project for this BB project.";
  } else if (snapshot.error) {
    // The mirror's own poller retries; the last good copy stays on the board.
    linear = "failed"; message = snapshot.error;
  } else if (snapshot.syncedAt === null) {
    linear = "catching-up";
    message = `Reading this project's issues from ${tracker}.`;
  } else {
    linear = "current"; message = `Up to date with ${tracker}.`;
  }
  return {
    board: {
      ...(input.doctor ? { doctor: input.doctor } : {}),
      linear: { state: linear, message, syncedAt: snapshot.syncedAt,
        project: project?.name ?? null },
      tick: 0, laneCapacity: 0, workersPerLane: 0,
      autoStart: false, lanes, ready, openIssues,
    },
  };
}
