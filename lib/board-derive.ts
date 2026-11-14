// Derives the board from a tracker snapshot and project settings.
import { canMerge, dependencyColumns, reviewerFor, type Blocker, type Board, type Lane, type TrackerStatus, type ReadySpec, type Route, type Ticket, type OpenIssue, type ShapingSpec } from "./board-model.js";
import type { TrackerIssue, TrackerSnapshot } from "./tracker-contract.js";
import { DEFAULT_HOLD_LABELS, isHoldLabel, resolveRoute, type SettingsResult } from "./squadron-settings.js";
import { ACCEPT_OWNER, READY_FOR_AGENT, isDeclinedIssue, isOpenIssue } from "./linear-issues.js";
import type { DoctorReport } from "./doctor.js";
import { latestLeads, isRunningThread, type LeadThread, type WorkerThread } from "./lead-threads.js";
import type { PullRequestRow } from "./pull-requests.js";
import { isActiveProjectThread } from "./project-thread.js";
import { trackerName } from "./tracker-detection.js";
import type { LaneProgress } from "./lane-progress.js";
import { escapeRegExp } from "./issue-text.js";

/** A planning thread open in BB for one tracker issue, read from its plugin metadata. */
export interface PlanningThread { issueId: string; threadId: string }

export interface BoardInput extends LaneProgress {
  snapshot: TrackerSnapshot;
  /** Open (not archived) planning threads in this BB project. */
  planning?: PlanningThread[];
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

const labelNames = (issue: TrackerIssue) => issue.labels.map((label) => label.name);
/** The `ready-for-agent` label, or a `Status: ready-for-agent` line in trackers without labels. */
const readyMarked = (issue: TrackerIssue) => labelNames(issue).includes(READY_FOR_AGENT)
  || issue.state.name.trim().toLowerCase() === READY_FOR_AGENT;

/** An open ticket a hold label keeps from agents, or a matching `Status:` line in trackers without labels. */
const heldBy = (holdLabels: readonly string[]) => (issue: TrackerIssue) => isOpenIssue(issue) &&
  [...labelNames(issue), issue.state.name].some((name) => isHoldLabel(holdLabels, name));

/** Open specs: top-level open issues that are marked ready, have open tickets, or are being planned. */
export function openSpecs(snapshot: TrackerSnapshot, planningIssueIds: ReadonlySet<string>): TrackerIssue[] {
  const open = snapshot.issues.filter((issue) => issue.inProject && isOpenIssue(issue)).sort(byIdentifier);
  return open.filter((issue) => issue.parentId === null &&
    (readyMarked(issue) || planningIssueIds.has(issue.id) || open.some((ticket) => ticket.parentId === issue.id)));
}

function createdTime(issue: TrackerIssue): number {
  const time = Date.parse(issue.createdAt ?? "");
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

/** Ready order is shared by the board and Autopilot. Snapshot order breaks remaining ties. */
export function sortQueue(issues: readonly TrackerIssue[], snapshot: TrackerSnapshot): TrackerIssue[] {
  const position = new Map(snapshot.issues.map((issue, index) => [issue.id, index]));
  return [...issues].sort((a, b) => {
    if (snapshot.kind === "linear") {
      const order = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      const priority = (a.priority || 5) - (b.priority || 5);
      const age = createdTime(a) - createdTime(b);
      return order || priority || age || (position.get(a.id)! - position.get(b.id)!);
    }
    return ((a.trackerOrder ?? position.get(a.id)!) - (b.trackerOrder ?? position.get(b.id)!))
      || createdTime(a) - createdTime(b);
  });
}

export function deriveBoard(input: BoardInput): DerivedBoard {
  const { snapshot } = input;
  const usesLinear = snapshot.kind === "linear";
  const tracker = snapshot.kind ? trackerName(snapshot.kind) : "the tracker";
  const settings = input.settings?.ok ? input.settings.settings : null;
  const open = snapshot.issues.filter((issue) => issue.inProject && isOpenIssue(issue)).sort(byIdentifier);
  const labels = labelNames;
  const held = heldBy(settings?.holdLabels ?? DEFAULT_HOLD_LABELS);
  const planning = new Map((input.planning ?? []).map((thread) => [thread.issueId, thread.threadId]));
  const ticketsOf = (spec: TrackerIssue) => open.filter((issue) => issue.parentId === spec.id);
  const specs = openSpecs(snapshot, new Set(planning.keys()));
  const specIds = new Set(specs.map((spec) => spec.id));
  const byId = new Map(snapshot.issues.map((issue) => [issue.id, issue]));
  const project = snapshot.project;
  const leads = new Map(latestLeads((input.leads ?? []).filter(({ thread }) =>
    project && isActiveProjectThread(thread, thread.id, snapshot.bbProjectId))).map((lead) => [lead.specId, lead]));
  // A spec its Lead closed after the merge keeps its lane, so the lane lands and stays Landed.
  const closedSpecs = snapshot.issues.filter((issue) => issue.parentId === null && issue.state.type === "completed" &&
    issue.inProject && (readyMarked(issue) || leads.has(issue.id)));
  const lanes: Lane[] = [...specs.filter((spec) => readyMarked(spec) || leads.has(spec.id)), ...closedSpecs].sort(byIdentifier).flatMap((spec) => {
    const lead = leads.get(spec.id);
    return lead ? [lane(spec, lead)] : [];
  });
  /** Tracker ticket states; only Linear uses the configured status mapping. */
  function ticketState(issue: TrackerIssue): Ticket["state"] {
    if (!usesLinear) {
      if (issue.state.type === "completed") return "done";
      return issue.state.type === "started" ? "working" : "blocked";
    }
    const mapping = settings?.statusMapping.ticket;
    if (issue.state.type === "completed" || issue.state.name === mapping?.done) return "done";
    if (issue.state.name === mapping?.inBranch) return "branch";
    if (issue.state.name === mapping?.working) return "working";
    return "blocked";
  }
  function lane(spec: TrackerIssue, lead: LeadThread): Lane {
    const noRemote = input.repository?.hasRemote === false;
    // An outside lane's branch is the first of its candidates that could be read.
    const branch = input.branches?.[spec.id] ?? lead.branch;
    // A fresh branch at main has no lane work. Ancestry alone cannot prove a landing.
    const mergedLaneWork = input.repository?.mergedBranches.includes(branch) &&
      (input.repository.mergedBranchUpdatedAt[branch] ?? 0) > lead.thread.createdAt;
    const localLanded = noRemote && (mergedLaneWork || spec.state.type === "completed");
    const laneSnapshot = input.laneSnapshots?.[spec.id] ?? snapshot;
    const issues = laneSnapshot.issues.filter((issue) => issue.parentId === spec.id && !isDeclinedIssue(issue));
    const laneById = new Map(laneSnapshot.issues.map((issue) => [issue.id, issue]));
    const ids = new Set(issues.map((issue) => issue.id));
    const workers = lead.workers ?? [];
    const needs = [threadNeed(lead.thread, `The Lead for ${spec.identifier}`),
      ...workers.map((worker) => threadNeed(worker, worker.title ?? "A worker"))].filter((need) => need !== null);
    // A normal completed turn can be a plain-text question. An interrupted,
    // failed or unreadable turn keeps the Stopped fallback (ADR-0011).
    const noRunningThreads = [lead.thread, ...workers].every((thread) => !isRunningThread(thread));
    const stopped = noRunningThreads && (lead.idleSince === undefined || needs.some((need) => need.kind !== "waiting"));
    const children = [...workers].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const matched = new Set<string>();
    const tickets: Ticket[] = issues.sort(byIdentifier).map((issue) => {
      // The newest child naming the ticket is its worker; FIX-1 never matches FIX-12.
      const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(issue.identifier)}(?![0-9])`, "i");
      const worker = children.find((child) => pattern.test(child.title ?? ""));
      if (worker) matched.add(worker.id);
      return {
        id: issue.identifier, title: issue.title,
        blockedBy: laneSnapshot.relations.filter((relation) => relation.relatedIssueId === issue.id && ids.has(relation.issueId))
          .map((relation) => laneById.get(relation.issueId)!.identifier),
        route: settings ? resolveRoute(settings, labels(issue)) : lead.route,
        state: held(issue) ? "held" : snapshot.kind === "local-markdown" && laneSnapshot !== snapshot && issue.state.type === "completed" &&
          byId.get(issue.id)?.state.type !== "completed" && !localLanded ? "branch" : ticketState(issue),
        minutes: worker ? Math.max(0, Math.floor((input.now - worker.createdAt) / 60_000)) : 0,
        ...(worker ? { threadId: worker.id } : {}),
      };
    });
    const row = lead.thread.environmentId ? input.pullRequests?.[lead.thread.environmentId] : undefined;
    const pr = row?.outcome === "available" ? row.pullRequest : undefined;
    const landedAt = pr?.state === "merged" ? Date.parse(pr.updatedAt)
      : spec.state.type === "completed" ? Date.parse(spec.updatedAt)
      : localLanded ? (spec.state.type === "completed" ? Date.parse(spec.updatedAt) : input.repository!.mainUpdatedAt ?? Date.parse(spec.updatedAt)) : undefined;
    const checks = pr?.checks.state === "no_checks" ? "none" as const : pr?.checks.state;
    const acceptOwner = labels(spec).includes(ACCEPT_OWNER);
    const outside = lead.outside === true;
    const localMerge = !outside && noRemote && !localLanded && tickets.length > 0 && tickets.every((ticket) => ["branch", "done"].includes(ticket.state));
    // accept:owner holds a mergeable PR for the owner's click; other Leads merge their own.
    // Squadron holds nothing for an outside lane: it never merges, stops or resumes one.
    const inReview = acceptOwner && localMerge ? "merge-waits"
      : pr?.state === "open" ? (!outside && acceptOwner && checks && canMerge({ pr: { state: pr.state, checks } }) ? "merge-waits" : "pr-open") : null;
    if (!lead.outside && landedAt === undefined && spec.state.type !== "completed" && inReview !== "merge-waits" && !stopped && noRunningThreads &&
      !needs.length && lead.idleSince !== undefined && input.now - lead.idleSince >= 300_000) {
      needs.push({ threadId: lead.thread.id, kind: "waiting", text: "The Lead is waiting on you" });
    }
    return {
      specId: spec.identifier, title: spec.title, url: spec.url, lead: lead.route, leadThreadId: lead.thread.id,
      branch,
      state: landedAt !== undefined ? "landed" : inReview ?? (stopped && !outside ? "stopped" : "flying"),
      stopped,
      ...(landedAt !== undefined ? { outcomeAt: landedAt } : stopped ? {
        outcomeAt: Math.max(...[lead.thread, ...workers].map((thread) => thread.updatedAt ?? thread.createdAt)),
      } : {}),
      workingThreads: [lead.thread, ...workers].filter((thread) => isRunningThread(thread)).length,
      ...(outside ? { outside } : {}),
      ...(noRemote && !outside ? { localMerge } : {}),
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
  const ready: ReadySpec[] = [];
  const shaping: ShapingSpec[] = [];
  // The landed lane stays visible until another Lead starts. Read remaining work
  // from today's tracker, never from the landed integration branch.
  const returning = new Set(lanes.filter((lane) => lane.state === "landed" && !lane.outside)
    .map((lane) => lane.specId));
  const queueSpecs = [...specs, ...closedSpecs.filter((spec) => returning.has(spec.identifier))];
  for (const spec of queueSpecs.filter((spec) => !leads.has(spec.id) ||
    (returning.has(spec.identifier) && ticketsOf(spec).some((ticket) => !held(ticket))))) {
    const tickets = ticketsOf(spec);
    const marked = readyMarked(spec);
    const heldTickets = tickets.filter(held);
    const ticketBlockers = tickets.filter((ticket) => !held(ticket)).map(openBlockers);
    const row = { id: spec.identifier, title: spec.title, url: spec.url, ticketCount: tickets.length };
    // An open planning thread keeps a spec Shaping; Ready needs an open, unblocked ticket.
    if (planning.has(spec.id)) {
      shaping.push({ ...row, missing: "Planning is still open in its thread.", action: "resume", threadId: planning.get(spec.id)! });
    } else if (held(spec)) {
      shaping.push({ ...row, missing: "This spec is held. Clear its hold before Start.", action: "tickets" });
    } else if (!tickets.length) {
      shaping.push({ ...row, missing: "Has the ready-for-agent label but no open tickets.", action: "tickets" });
    } else if (!marked) {
      shaping.push({ ...row, missing: `Has ${tickets.length} ${tickets.length === 1 ? "ticket" : "tickets"} but no ready-for-agent label.`, action: "tickets" });
    } else if (heldTickets.length === tickets.length) {
      shaping.push({ ...row, missing: `Every open ticket is held: ${list(heldTickets.map((ticket) => ticket.identifier))}.`, action: "tickets" });
    } else if (ticketBlockers.every((found) => found.length > 0)) {
      const ids = [...new Set(ticketBlockers.flat().map((blocker) => blocker.id))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      const which = heldTickets.length ? "Every ticket that isn't held" : "Every ticket";
      shaping.push({ ...row, missing: `${which} waits on a blocker: ${ids.join(", ")}`, action: "tickets" });
    } else ready.push(readyRow(spec, tickets));
  }
  function readyRow(spec: TrackerIssue, open: TrackerIssue[]): ReadySpec {
    // Held tickets don't run, so their routes and blockers don't hold the lane.
    const tickets = open.filter((ticket) => !held(ticket));
    const specBlockers = openBlockers(spec);
    const ticketBlockers = tickets.map(openBlockers);
    const blockers = [...new Map([...specBlockers, ...ticketBlockers.flat()].map((blocker) => [blocker.id, blocker])).values()]
      .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    let startReason: string | null;
    const doctorFix = input.doctor?.checks.find((check) => check.status === "fix");
    if (usesLinear && input.connection.status !== "connected") {
      startReason = input.connection.message;
    } else if (usesLinear && !project) {
      startReason = snapshot.error ?? "Wait for Linear to read this project's Scope.";
    } else if (snapshot.error || snapshot.syncedAt === null) {
      startReason = snapshot.error ?? `Wait for ${tracker} to finish reading this project's issues.`;
    } else if (doctorFix) {
      startReason = doctorFix.message;
    } else if (specBlockers.length) {
      startReason = `Waits on ${list(specBlockers.map((blocker) => blocker.outside ? `${blocker.id} (outside this project)` : blocker.id))}`;
    } else if (!settings) {
      const sections = input.settings && !input.settings.ok ? input.settings.issues.map((issue) => issue.section) : [];
      startReason = sections.length
        ? `Fix docs/agents/squadron.md first: ${[...new Set(sections)].join(", ")}. Open Doctor for details.`
        : "Couldn't read docs/agents/squadron.md. Open Doctor for details.";
    } else {
      startReason = input.doctor?.ready ? null : "Check Doctor before starting a lane.";
    }
    return {
      id: spec.identifier, title: spec.title, url: spec.url, ticketCount: open.length,
      routes: settings ? uniqueRoutes(tickets.map((ticket) => resolveRoute(settings, labels(ticket)))) : [],
      blockedBy: blockers.map((blocker) => blocker.id), blockers, startReason,
      ...(specBlockers.length ? { waitingFor: specBlockers } : {}),
      acceptOwner: labels(spec).includes(ACCEPT_OWNER),
      waiting: tickets.flatMap((ticket, i) => ticketBlockers[i].length
        ? [{ id: ticket.identifier, title: ticket.title, blockedBy: ticketBlockers[i].map((blocker) => blocker.id) }] : []),
      held: open.filter(held).map((ticket) => ({ id: ticket.identifier, title: ticket.title })),
    };
  }
  const queueOrder = new Map(sortQueue(queueSpecs, snapshot).map((spec, index) => [spec.identifier, index]));
  ready.sort((a, b) => queueOrder.get(a.id)! - queueOrder.get(b.id)!);
  // Anything open that isn't a spec or one of its tickets waits here,
  // so no issue in the project's scope drops off the board.
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
  let status: TrackerStatus["state"];
  let message: string;
  if (usesLinear && input.connection.status !== "connected") {
    status = "disconnected"; message = input.connection.message;
  } else if (usesLinear && !project && snapshot.error) {
    // The Scope in docs/agents/squadron.md is missing or matches nothing; the error says which key.
    status = "unscoped"; message = snapshot.error;
  } else if (snapshot.error) {
    // The mirror's own poller retries; the last good copy stays on the board.
    status = "failed"; message = snapshot.error;
  } else if (snapshot.syncedAt === null) {
    status = "catching-up";
    message = `Reading this project's issues from ${tracker}.`;
  } else {
    status = "current"; message = `Up to date with ${tracker}.`;
  }
  return {
    board: {
      ...(input.doctor ? { doctor: input.doctor } : {}),
      tracker: { kind: snapshot.kind, state: status, message, syncedAt: snapshot.syncedAt,
        project: project?.name ?? null },
      tick: 0, laneCapacity: 0, workersPerLane: 0,
      autoStart: false, lanes, ready, shaping, openIssues,
    },
  };
}
