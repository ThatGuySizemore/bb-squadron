// The Helper core: one deterministic function from the Linear mirror,
// settings and clock to the board view model and the commands the server
// should run. Reading a board never starts work without an explicit action.
import type { Blocker, Board, LinearStatus, ReadySpec, Route, UnplannedIssue } from "./board-model.js";
import type { MirrorIssue, MirrorSnapshot } from "./linear-mirror-contract.js";
import type { OutboxBlockedReason, OutboxHealth } from "./linear-outbox-contract.js";
import { resolveRoute, type SettingsResult } from "./squadron-settings.js";
import { ACCEPT_OWNER, READY_FOR_AGENT, isOpenIssue } from "./linear-issues.js";
import type { SpawnWorkerCommand } from "./worker-contract.js";
import type { LaneRun, StartDecision, StartLeadCommand } from "./lane-contract.js";

export interface HelperInput {
  snapshot: MirrorSnapshot;
  connection: { status: "connected" | "disconnected" | "failed"; message: string };
  settings: SettingsResult | null;
  /** The outbox's health for this BB project, or null when it couldn't be read. */
  writes: OutboxHealth | null;
  /** Spec B reads the clock for lane time limits. */
  now: number;
  /** When this run of the plugin started; older snapshots predate it. */
  startedAt: number;
  lanes?: readonly LaneRun[];
  action?: { type: "start"; specId: string } | { type: "spawn-worker"; laneId: string; ticketId: string };
}

/** What the owner reads for each reason the outbox parks a write. */
const BLOCKED_WRITE_TEXT: Record<OutboxBlockedReason, string> = {
  workspace_changed: "Linear is now connected to another workspace. Reconnect the original workspace, then retry.",
  auth_mode_changed: "The Linear connection changed between app and personal. Retry to send it with the current connection.",
  authentication: "Linear rejected the credential. Reconnect Linear in Squadron settings, then retry.",
  configuration: "The Squadron app setup is incomplete. Finish it in Squadron settings, then retry.",
  invalid_operation: "The queued write is invalid, so Linear can't take it. Open its thread to ask for it again.",
  graphql: "Linear refused the write. Check the issue in Linear, then retry.",
  conflict: "The issue changed in Linear since the write was queued. Check it, then retry. Squadron won't overwrite it.",
  dependency_blocked: "It waits on an earlier write that couldn't go through. Retry that one first.",
};

export type HelperCommand = { type: "sync"; reason: "catch-up" } | StartLeadCommand | SpawnWorkerCommand;

export interface HelperOutput {
  board: Board;
  commands: HelperCommand[];
  start?: StartDecision;
  worker?: StartDecision;
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

export function helperCore(input: HelperInput): HelperOutput {
  const { snapshot } = input;
  const settings = input.settings?.ok ? input.settings.settings : null;
  const open = snapshot.issues.filter((issue) => issue.inProject && isOpenIssue(issue)).sort(byIdentifier);
  const labels = (issue: MirrorIssue) => issue.labels.map((label) => label.name);
  const specs = open.filter((issue) => issue.parentId === null && labels(issue).includes(READY_FOR_AGENT));
  const specIds = new Set(specs.map((spec) => spec.id));
  const byId = new Map(snapshot.issues.map((issue) => [issue.id, issue]));
  const binding = snapshot.binding;
  const runs = input.lanes ?? [];
  const active = runs.filter((run) => run.state !== "landed");
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
  const ready: ReadySpec[] = specs.filter((spec) => !runs.some((run) => run.specIssueId === spec.id)).map((spec) => {
    const tickets = open.filter((issue) => issue.parentId === spec.id);
    const specBlockers = openBlockers(spec);
    const ticketBlockers = tickets.map(openBlockers);
    const externalTicketBlockers = ticketBlockers.flat().filter((blocker) => !tickets.some((ticket) => ticket.identifier === blocker.id));
    const blockers = [...new Map([...specBlockers, ...externalTicketBlockers].map((blocker) => [blocker.id, blocker])).values()]
      .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    let startReason: string | null;
    if (specBlockers.length) {
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
      startReason = active.length >= settings.limits.lanesAtOnce ? "All lane slots are full." : null;
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
  const commands: HelperCommand[] = [];
  let linear: LinearStatus["state"];
  let message: string;
  if (input.connection.status !== "connected") {
    linear = "disconnected"; message = input.connection.message;
  } else if (!binding) {
    linear = "unbound"; message = "Choose the Linear team and project for this BB project.";
  } else if (snapshot.error) {
    // The mirror's own poller retries; the last good copy stays on the board.
    linear = "failed"; message = snapshot.error;
  } else if (snapshot.syncedAt === null || snapshot.syncedAt < input.startedAt) {
    // BB doesn't replay what changed while the plugin was down, so every
    // start reads the whole project again before the board counts as current.
    linear = "catching-up"; commands.push({ type: "sync", reason: "catch-up" });
    message = snapshot.syncedAt === null ? "Reading this project's issues from Linear."
      : "Catching up with Linear after a restart. Showing the copy from before.";
  } else {
    linear = "current"; message = "Up to date with Linear.";
  }
  // Starting work requires a current mirror. A stale copy is still readable.
  if (linear !== "current") for (const spec of ready) {
    spec.startReason = linear === "catching-up" ? "Wait for Linear to catch up before starting a lane." : message;
  }
  let start: StartDecision | undefined;
  const action = input.action;
  if (action?.type === "start") {
    const row = ready.find((spec) => spec.id === action.specId);
    const spec = specs.find((spec) => spec.identifier === action.specId);
    const reason = row?.startReason ?? (!row ? "This spec isn't ready to start in this project's current board." : null);
    if (reason || !spec || !settings) start = { allowed: false, reason: reason ?? "Fix Squadron settings first." };
    else {
      start = { allowed: true };
      commands.push({ type: "start-lead", specIssueId: spec.id, specId: spec.identifier, route: resolveRoute(settings, labels(spec)) });
    }
  }
  // A verified in-lane merge advances the lane before its final PR marks
  // tickets Done. Other lanes and external blockers still require Linear Done.
  const workerBlockers = (run: LaneRun, issue: MirrorIssue): Blocker[] => snapshot.relations
    .filter((relation) => relation.relatedIssueId === issue.id)
    .flatMap((relation) => {
      const blocker = byId.get(relation.issueId);
      if (!blocker) return [{ id: relation.issueId, title: "Unknown blocker", url: "", outside: true }];
      const integrated = blocker.parentId === run.specIssueId && blocker.teamId === binding?.team.id && blocker.projectId === binding?.project.id &&
        run.workers?.some((worker) => worker.ticketIssueId === blocker.id && worker.state === "integrated" && worker.integration?.commit === worker.commit);
      return blocker.state.type === "completed" || integrated ? [] : [{ id: blocker.identifier, title: blocker.title, url: blocker.url,
        outside: blocker.teamId !== binding?.team.id || blocker.projectId !== binding?.project.id }];
    }).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  let worker: StartDecision | undefined;
  if (action?.type === "spawn-worker") {
    const run = runs.find((item) => item.id === action.laneId);
    const spec = run ? byId.get(run.specIssueId) : undefined;
    const ticket = snapshot.issues.find((item) => item.identifier === action.ticketId && item.parentId === run?.specIssueId && item.inProject);
    let reason: string | null = null;
    if (!run || run.state !== "flying" || !run.branch || !run.leadThreadId) reason = "This lane isn't ready for workers.";
    else if (linear !== "current") reason = message;
    else if (!settings) reason = "Fix Squadron settings before starting workers.";
    else if (!spec?.inProject || !isOpenIssue(spec)) reason = "This spec isn't active in this project's current board.";
    else if (workerBlockers(run, spec).length) reason = `Waits on ${list(workerBlockers(run, spec).map((blocker) => blocker.id))}`;
    else if (!ticket || !isOpenIssue(ticket)) reason = "This ticket isn't open in this lane.";
    else if (run.workers?.some((item) => item.ticketIssueId === ticket.id)) reason = "Work has already started on this ticket.";
    else if (workerBlockers(run, ticket).length) reason = `Waits on ${list(workerBlockers(run, ticket).map((blocker) => blocker.id))}`;
    else if ((run.workers ?? []).filter((item) => item.state !== "reported" && item.state !== "integrated").length >= settings.limits.workersPerLane) reason = "All worker slots are full.";
    worker = reason ? { allowed: false, reason } : { allowed: true };
    if (worker.allowed && run && ticket && settings) commands.push({ type: "spawn-worker", laneId: run.id,
      ticketIssueId: ticket.id, ticketId: ticket.identifier, route: run.routeOverrides?.[ticket.id] ?? resolveRoute(settings, labels(ticket)) });
  }
  const lanes: Board["lanes"] = runs.flatMap((run) => {
    return [{ specId: run.specId, title: run.title, lead: run.route, leadThreadId: run.leadThreadId,
      branch: run.branch ?? "Preparing integration branch", state: run.state === "starting" ? "flying" : run.state,
      minutes: Math.max(0, Math.floor((input.now - run.startedAt) / 60_000)), acceptOwner: run.acceptOwner,
      ...(run.stopReason ? { stopReason: run.stopReason } : {}),
      ...(run.writeError ? { writeError: run.writeError } : {}),
      tickets: snapshot.issues.filter((issue) => issue.parentId === run.specIssueId &&
        (issue.inProject || run.workers?.some((worker) => worker.ticketIssueId === issue.id))).sort(byIdentifier).map((issue) => {
        const work = run.workers?.find((worker) => worker.ticketIssueId === issue.id);
        const blockers = workerBlockers(run, issue);
        return { id: issue.identifier, title: issue.title, blockedBy: blockers.map((blocker) => blocker.id),
          route: work?.route ?? run.routeOverrides?.[issue.id] ?? (settings ? resolveRoute(settings, labels(issue)) : run.route),
          ...(!work && settings && run.state === "flying" ? { routeChoices: uniqueRoutes(settings.routes) } : {}),
          state: issue.state.type === "completed" ? "done" as const : work?.state === "integrated" ? "branch" as const
            : work?.state === "reported" ? "review" as const : work?.state === "failed" ? "failed" as const
            : work ? "working" as const : blockers.length ? "blocked" as const : "ready" as const,
          ...(work?.state === "reported" ? { reportPending: true } : {}),
          ...(work?.failure ? { failure: work.failure } : {}),
          ...(work?.writeError ? { writeError: work.writeError } : {}),
          ...(work?.threadId ? { threadId: work.threadId } : {}),
          minutes: work ? Math.max(0, Math.floor((input.now - work.startedAt) / 60_000)) : 0,
        };
      }),
    }];
  });
  return {
    board: {
      linear: { state: linear, message, syncedAt: snapshot.syncedAt,
        project: binding ? `${binding.team.name} · ${binding.project.name}` : null },
      ...(input.writes ? { writes: {
        ...input.writes,
        blocked: input.writes.blocked.map((write) => ({
          ...write, reasonText: BLOCKED_WRITE_TEXT[write.reason],
          issueIdentifiers: write.issueIds.flatMap((id) => byId.get(id)?.identifier ?? []),
        })),
      } } : {}),
      tick: 0, laneCapacity: settings?.limits.lanesAtOnce ?? 0, workersPerLane: settings?.limits.workersPerLane ?? 0,
      autoStart: false, lanes, ready, unplanned,
    },
    commands,
    ...(start ? { start } : {}),
    ...(worker ? { worker } : {}),
  };
}
