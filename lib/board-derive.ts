// Derives the board from the in-memory Linear snapshot and project settings.
import type { Blocker, Board, Lane, LinearStatus, ReadySpec, Route, UnplannedIssue } from "./board-model.js";
import type { MirrorIssue, MirrorSnapshot } from "./linear-mirror-contract.js";
import { resolveRoute, type SettingsResult } from "./squadron-settings.js";
import { ACCEPT_OWNER, READY_FOR_AGENT, isOpenIssue } from "./linear-issues.js";
import type { DoctorReport } from "./doctor.js";
import type { LeadThread } from "./lead-threads.js";
import { isActiveProjectThread } from "./project-thread.js";

export interface BoardInput {
  snapshot: MirrorSnapshot;
  connection: { status: "connected" | "disconnected" | "failed"; message: string };
  settings: SettingsResult | null;
  doctor?: DoctorReport;
  leads?: LeadThread[];
  /** The board clock for derived lane state. */
  now: number;
}

export interface DerivedBoard {
  board: Board;
}

function byIdentifier(a: MirrorIssue, b: MirrorIssue): number {
  return a.identifier.localeCompare(b.identifier, "en", { numeric: true });
}

function list(ids: string[]): string {
  return ids.length < 2 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
}

function uniqueRoutes(routes: Route[]): Route[] {
  return [...new Map(routes.map((route) => [`${route.family}|${route.model}|${route.effort}`, route])).values()];
}

export function deriveBoard(input: BoardInput): DerivedBoard {
  const { snapshot } = input;
  const settings = input.settings?.ok ? input.settings.settings : null;
  const open = snapshot.issues.filter((issue) => issue.inProject && isOpenIssue(issue)).sort(byIdentifier);
  const labels = (issue: MirrorIssue) => issue.labels.map((label) => label.name);
  const specs = open.filter((issue) => issue.parentId === null && labels(issue).includes(READY_FOR_AGENT));
  const specIds = new Set(specs.map((spec) => spec.id));
  const byId = new Map(snapshot.issues.map((issue) => [issue.id, issue]));
  const binding = snapshot.binding;
  const leads = new Map((input.leads ?? []).filter(({ thread }) =>
    binding && isActiveProjectThread(thread, thread.id, binding.bbProjectId)).map((lead) => [lead.specId, lead]));
  const lanes: Lane[] = specs.flatMap((spec) => {
    const lead = leads.get(spec.id);
    return lead ? [{
      specId: spec.identifier, title: spec.title, lead: lead.route, leadThreadId: lead.thread.id,
      branch: lead.branch, state: "flying" as const,
      minutes: Math.max(0, Math.floor((input.now - lead.thread.createdAt) / 60_000)),
      acceptOwner: labels(spec).includes(ACCEPT_OWNER), tickets: [],
    }] : [];
  });
  /** Open blockers of one issue, in identifier order. Unknown endpoints are skipped. */
  const openBlockers = (issue: MirrorIssue): Blocker[] => snapshot.relations
    .filter((relation) => relation.relatedIssueId === issue.id)
    .flatMap((relation) => {
      const blocker = byId.get(relation.issueId);
      return blocker && isOpenIssue(blocker) ? [blocker] : [];
    })
    .sort(byIdentifier)
    .map((blocker) => ({
      id: blocker.identifier, title: blocker.title, url: blocker.url,
      outside: blocker.teamId !== binding?.team.id || blocker.projectId !== binding?.project.id,
    }));
  const ready: ReadySpec[] = specs.filter((spec) => !leads.has(spec.id)).map((spec) => {
    const tickets = open.filter((issue) => issue.parentId === spec.id);
    const specBlockers = openBlockers(spec);
    const ticketBlockers = tickets.map(openBlockers);
    const blockers = [...new Map([...specBlockers, ...ticketBlockers.flat()].map((blocker) => [blocker.id, blocker])).values()]
      .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    let startReason: string | null;
    const doctorFix = input.doctor?.checks.find((check) => check.status === "fix");
    if (input.connection.status !== "connected") {
      startReason = input.connection.message;
    } else if (!binding) {
      startReason = "Choose this project's Linear team and project before Start.";
    } else if (snapshot.error || snapshot.syncedAt === null) {
      startReason = snapshot.error ?? "Wait for Linear to finish reading this project's issues.";
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
  const under = (issue: MirrorIssue): string | undefined => {
    if (issue.parentId === null) return undefined;
    const parent = byId.get(issue.parentId);
    if (!parent) return "Under an issue this board can't see";
    if (parent.teamId !== binding?.team.id || parent.projectId !== binding?.project.id) return `Under ${parent.identifier}, outside this project`;
    if (!isOpenIssue(parent)) return `Under ${parent.identifier}, which is closed`;
    return `Under ${parent.identifier}`;
  };
  const unplanned: UnplannedIssue[] = open
    .filter((issue) => !specIds.has(issue.id) && !(issue.parentId !== null && specIds.has(issue.parentId)))
    .map((issue) => {
      const parent = under(issue);
      return { id: issue.identifier, title: issue.title, url: issue.url, labels: labels(issue), ...(parent ? { under: parent } : {}) };
    });
  let linear: LinearStatus["state"];
  let message: string;
  if (input.connection.status !== "connected") {
    linear = "disconnected"; message = input.connection.message;
  } else if (!binding) {
    linear = "unbound"; message = "Choose the Linear team and project for this BB project.";
  } else if (snapshot.error) {
    // The mirror's own poller retries; the last good copy stays on the board.
    linear = "failed"; message = snapshot.error;
  } else if (snapshot.syncedAt === null) {
    linear = "catching-up";
    message = "Reading this project's issues from Linear.";
  } else {
    linear = "current"; message = "Up to date with Linear.";
  }
  return {
    board: {
      ...(input.doctor ? { doctor: input.doctor } : {}),
      linear: { state: linear, message, syncedAt: snapshot.syncedAt,
        project: binding ? `${binding.team.name} · ${binding.project.name}` : null },
      tick: 0, laneCapacity: 0, workersPerLane: 0,
      autoStart: false, lanes, ready, unplanned,
    },
  };
}
