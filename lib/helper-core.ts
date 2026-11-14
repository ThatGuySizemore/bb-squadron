// The Helper core: one deterministic function from the Linear mirror,
// settings and clock to the board view model and the commands the server
// should run. Spec B extends this function with lanes; Spec A only reads.
import type { Blocker, Board, LinearStatus, ReadySpec, Route, UnplannedIssue } from "./board-model.js";
import type { MirrorIssue, MirrorSnapshot } from "./linear-mirror-contract.js";
import type { OutboxBlockedReason, OutboxHealth } from "./linear-outbox-contract.js";
import { resolveRoute, type SettingsResult } from "./squadron-settings.js";
import { ACCEPT_OWNER, READY_FOR_AGENT, isOpenIssue } from "./linear-issues.js";

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

export type HelperCommand = { type: "sync"; reason: "catch-up" };

export interface HelperOutput {
  board: Board;
  commands: HelperCommand[];
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
  const ready: ReadySpec[] = specs.map((spec) => {
    const tickets = open.filter((issue) => issue.parentId === spec.id);
    const specBlockers = openBlockers(spec);
    const ticketBlockers = tickets.map(openBlockers);
    const blockers = [...new Map([...specBlockers, ...ticketBlockers.flat()].map((blocker) => [blocker.id, blocker])).values()]
      .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    let startReason: string;
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
      // Spec B starts lanes here, after the lane-capacity check.
      startReason = "Squadron can't start lanes yet. This version only reads Linear.";
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
      autoStart: false, lanes: [], ready, unplanned,
    },
    commands,
  };
}
