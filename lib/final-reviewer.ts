// Who runs a lane's one fresh whole-branch final review. The reviewer comes from
// the family that built the branch, read from recorded launches, never from the
// Lead's family or the order of route rows. One resolver serves the board, the
// Lead and work-item briefs, and `bb squadron launch final-review`.
import type { Family, Route } from "./board-model.js";
import { resolveLaunch, routeText, requestedRoute, type LaunchRecord } from "./launch-record.js";
import type { ProviderModels } from "./model-capabilities.js";
import { familyForProvider, resolveRoute, type ModelRole, type SquadronSettings } from "./squadron-settings.js";

/** Launch roles whose accepted attempt is a ticket's builder. Mechanical, review and planning threads never are. */
const BUILDER_ROLES: readonly ModelRole[] = ["Worker", "Worker (hard)"];
type KnownFamily = Exclude<Family, "unknown">;
/** Fixed tie order, independent of settings: Claude builders first. */
const FAMILIES: readonly KnownFamily[] = ["claude", "gpt"];
const REVIEW_ROLE: Record<KnownFamily, ModelRole> = { claude: "Review of claude-code", gpt: "Review of codex" };
const BUILT_BY: Record<KnownFamily, string> = { claude: "Claude", gpt: "GPT" };

/** One thread in a lane: a Lead's child, active or archived, or a work item's own thread. */
export interface LaneLaunch {
  threadId: string;
  createdAt: number;
  /** The provider BB reports the thread runs on; null when BB doesn't say. */
  providerId: string | null;
  /** Its launch record; null for a thread launched outside squadron launch. Never synthesised. */
  record: LaunchRecord | null;
}

/** One open, unheld ticket of the lane, or a work item standing for itself. */
export interface LaneTicket {
  /** Stable tracker ID, matched against launch records. */
  id: string;
  identifier: string;
  labels: readonly string[];
  /** The tracker shows it in the integration branch or done. */
  integrated: boolean;
}

export interface FinalReviewer {
  /** The reviewer's route; null when no reviewer can be chosen from the evidence. */
  route: Route | null;
  /** The role the reviewer launches and is recorded under. */
  role: ModelRole | null;
  /**
   * integrated: only tickets in the integration branch decide, by their accepted builder.
   * lane: nothing is integrated yet, so every ticket decides, by its accepted builder or its own route.
   * same: Final review is same, so the reviewer is in the Lead's family, as before.
   */
  basis: "integrated" | "lane" | "same";
  /** Tickets counted for each builder family. */
  counts: Record<KnownFamily, number>;
  /** Tickets the reviewer is independent of: every recorded attempt ran on another known family. */
  independentOf: string[];
  /** Tickets whose accepted builder ran on the reviewer's own family. */
  sameFamily: string[];
  /** Tickets whose builder is unrecorded or unknown, or where another attempt may share the reviewer's family. */
  unknown: string[];
  /** Threads in the lane with no launch record: their contribution and family are unknown. */
  unrecorded: number;
  /** Why no reviewer could be chosen. Never a substitute route. */
  problem?: string;
  /** Owner words for the review and the PR body. */
  statement: string;
}

interface TicketEvidence {
  ticket: LaneTicket;
  /** The family that built it: the accepted attempt's, or for an unlaunched ticket in lane basis, its route's. */
  family: Family | null;
  planned: boolean;
  /** Families of every other recorded attempt on the ticket, including replaced ones. */
  others: Family[];
}

const familyOf = (launch: LaneLaunch): Family => familyForProvider(launch.providerId ?? launch.record?.requested.providerId ?? "");

/**
 * The accepted attempt is the latest recorded Worker or Worker (hard) launch for the ticket that no
 * later launch replaces. Replaced, abandoned and non-builder attempts never decide the reviewer;
 * they only limit what the reviewer can claim to be independent of.
 */
function evidenceFor(ticket: LaneTicket, launches: readonly LaneLaunch[], project: boolean, settings: SquadronSettings): TicketEvidence {
  const replaced = new Set(launches.flatMap((launch) => launch.record?.replacesThreadId ? [launch.record.replacesThreadId] : []));
  const attempts = launches.filter((launch) => launch.record?.tickets.some((item) => item.id === ticket.id))
    .sort((a, b) => a.createdAt - b.createdAt || a.threadId.localeCompare(b.threadId));
  const accepted = attempts.filter((launch) => BUILDER_ROLES.includes(launch.record!.role) && !replaced.has(launch.threadId)).at(-1);
  const others = attempts.filter((launch) => launch !== accepted).map(familyOf);
  if (accepted) return { ticket, family: familyOf(accepted), planned: false, others };
  if (project && !attempts.length) return { ticket, family: resolveRoute(settings, ticket.labels).family, planned: true, others };
  return { ticket, family: null, planned: false, others };
}

export function chooseFinalReviewer(settings: SquadronSettings, lane: {
  /** The Lead's route as BB reports it; only its family counts, and only when Final review is same. */
  lead: Route;
  tickets: readonly LaneTicket[];
  launches: readonly LaneLaunch[];
  /**
   * The board may project unlaunched tickets from their own routes before anything is integrated,
   * while every thread in the lane is recorded. The final review itself never does: only recorded builders choose it.
   */
  projectRoutes?: boolean;
  /** BB's advertised capabilities, so review routes meet the same policy checks as every launch. */
  catalog?: readonly ProviderModels[];
}): FinalReviewer {
  const unrecorded = lane.launches.filter((launch) => !launch.record).length;
  const basis = lane.tickets.some((ticket) => ticket.integrated) ? "integrated" as const : "lane" as const;
  const evidence = lane.tickets.filter((ticket) => basis === "lane" || ticket.integrated)
    // An unrecorded thread may be a ticket's real builder, so nothing is projected past one.
    .map((ticket) => evidenceFor(ticket, lane.launches, basis === "lane" && lane.projectRoutes === true && !unrecorded, settings));
  const counts: Record<KnownFamily, number> = { claude: 0, gpt: 0 };
  for (const item of evidence) if (item.family === "claude" || item.family === "gpt") counts[item.family]++;

  let route: Route | null = null;
  let role: ModelRole | null = null;
  let problem: string | undefined;
  let chosenBy = "";
  if (settings.finalReviewFamily === "same") {
    // The review row whose reviewer is in the Lead's family, so it launches and is recorded like any review.
    const family = lane.lead.family;
    if (family === "unknown") problem = "Final review is set to same, but the Lead runs on a provider with no known family, so no review route matches it.";
    else {
      role = REVIEW_ROLE[family === "claude" ? "gpt" : "claude"];
      try { route = resolveLaunch(settings, { role }, lane.catalog).route; }
      catch (error) { problem = error instanceof Error ? error.message : String(error); role = null; }
      chosenBy = `Final review is set to same, so a ${BUILT_BY[family]} reviewer, in the Lead's family, reviews.`;
    }
  } else {
    const built = FAMILIES.filter((family) => counts[family] > 0).sort((a, b) => counts[b] - counts[a]);
    const total = counts.claude + counts.gpt;
    if (!built.length) {
      problem = unrecorded
        ? `No ticket has a recorded builder, and ${threads(unrecorded)} in this lane ${unrecorded === 1 ? "has" : "have"} no launch record. Choose the reviewer from the builders you observed and say which work it is independent of.`
        : "No ticket has a builder on Claude Code or Codex yet, so no reviewer family can be chosen.";
    } else {
      const family = built[0];
      role = REVIEW_ROLE[family];
      try { route = resolveLaunch(settings, { role }, lane.catalog).route; }
      catch (error) { problem = error instanceof Error ? error.message : String(error); role = null; }
      const tie = built.length > 1 && counts.claude === counts.gpt;
      const tickets = `${total} ${basis === "integrated" ? "integrated " : ""}${total === 1 ? "ticket" : "tickets"}`;
      chosenBy = `${BUILT_BY[family]} ${basis === "integrated" ? `built ${counts[family]} of ${tickets}` : `builds ${counts[family]} of ${tickets} so far`}${tie ? ", a tie that Squadron settles toward Claude-built work" : ""}, so the ${role ?? REVIEW_ROLE[family]} route reviews.`;
    }
  }

  const reviewer = route?.family ?? null;
  const independentOf: string[] = [];
  const sameFamily: string[] = [];
  const unknown: string[] = [];
  for (const item of evidence) {
    const id = item.ticket.identifier;
    const known = (family: Family | null) => family === "claude" || family === "gpt";
    if (!reviewer || reviewer === "unknown" || !known(item.family)) unknown.push(id);
    else if (item.family === reviewer) sameFamily.push(id);
    else if (item.others.every((family) => known(family) && family !== reviewer)) independentOf.push(id);
    else unknown.push(id);
  }
  const result = { route, role, basis: settings.finalReviewFamily === "same" ? "same" as const : basis, counts,
    independentOf, sameFamily, unknown, unrecorded, ...(problem ? { problem } : {}) };
  return { ...result, statement: statement(result, chosenBy, evidence) };
}

const threads = (count: number) => `${count} ${count === 1 ? "thread" : "threads"}`;
const list = (ids: readonly string[]) => ids.join(", ");

function statement(choice: Omit<FinalReviewer, "statement">, chosenBy: string, evidence: readonly TicketEvidence[]): string {
  if (choice.problem && !choice.route) return `Final review: no reviewer chosen. ${choice.problem}`;
  const lines = [`Final review: ${routeText(requestedRoute(choice.route))}. ${chosenBy}`.trim()];
  const planned = new Set(evidence.filter((item) => item.planned).map((item) => item.ticket.identifier));
  const named = (ids: string[]) => list(ids.map((id) => planned.has(id) ? `${id} (not launched yet)` : id));
  if (choice.independentOf.length) lines.push(`Independent of ${named(choice.independentOf)}.`);
  if (choice.sameFamily.length) lines.push(`Not independent of ${named(choice.sameFamily)}: ${choice.sameFamily.length === 1 ? "its builder is" : "their builders are"} in the reviewer's family.`);
  if (choice.unknown.length) lines.push(`Independence unknown for ${list(choice.unknown)}: no recorded builder on a known family, or an earlier attempt may share the reviewer's family.`);
  if (choice.unrecorded) lines.push(`${threads(choice.unrecorded)} in this lane ${choice.unrecorded === 1 ? "has" : "have"} no launch record, so independence from ${choice.unrecorded === 1 ? "its" : "their"} work is unknown.`);
  return lines.join(" ");
}
