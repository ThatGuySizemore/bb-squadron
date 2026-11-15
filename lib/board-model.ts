// The board runtime schema is also the source of its public TypeScript types.
import { autopilotStateSchema } from "./autopilot-contract.js";
import { liveStepSchema } from "./live-step.js";
import { z } from "zod";
import { doctorReportSchema } from "./doctor-contract.js";
import { trackerKindSchema } from "./tracker-contract.js";

const route = z.object({ family: z.enum(["claude", "gpt"]), model: z.string(), effort: z.enum(["medium", "high"]) });
const ticket = z.object({
  id: z.string(), title: z.string(), blockedBy: z.array(z.string()), route,
  state: z.enum(["blocked", "held", "ready", "working", "question", "review", "branch", "failed", "done"]),
  liveStep: liveStepSchema.optional(),
  minutes: z.number(), threadId: z.string().optional(), question: z.string().optional(), failure: z.string().optional(),
});
const lane = z.object({
  /** Absent on older/demo snapshots means spec; RPC field names stay shared. */
  kind: z.enum(["spec", "work-item"]).optional(),
  /** All associated tickets, including completed ones. */
  totalTicketCount: z.number().int().nonnegative().optional(),
  liveStep: liveStepSchema.optional(),
  specId: z.string(), title: z.string(), lead: route, leadThreadId: z.string(), branch: z.string(),
  state: z.enum(["flying", "stopped", "spec-review", "pr-open", "merge-waits", "landed"]),
  /** A confirmed stop or unavailable idle lifecycle, independent of the PR state. Derived only. */
  stopped: z.boolean().optional(),
  /** Running Lead and child threads, independent of tracker ticket statuses. */
  workingThreads: z.number().int().nonnegative().optional(),
  /** Open blockers outside this lane when every remaining ticket waits. */
  waitingOn: z.array(z.string()).optional(),
  /** A no-remote lane whose tickets are ready for the Lead's local merge. */
  localMerge: z.boolean().optional(),
  /** Started outside Squadron: read-only, with no Stop, Resume or Merge. leadThreadId is its thread. */
  outside: z.boolean().optional(),
  minutes: z.number(), acceptOwner: z.boolean(), tickets: z.array(ticket),
  pr: z.object({
    number: z.number(), checks: z.enum(["pending", "passing", "failing", "none", "unknown"]), url: z.string(),
    state: z.enum(["draft", "open", "merged", "closed"]).optional(),
  }).optional(),
  stopReason: z.string().optional(), landedAt: z.number().optional(),
  /** Latest thread update for a stop, or merge time for a landing; orders newly observed outcomes. */
  outcomeAt: z.number().optional(),
  /** Who runs the lane's final review, from the final-review family. */
  reviewer: route.optional(),
  /** The spec in its planning tracker. */
  url: z.string().optional(),
  /** Child threads of the Lead that match no ticket, so no thread is hidden. */
  unmatchedThreads: z.array(z.object({ threadId: z.string(), title: z.string() })).optional(),
  /** Lane threads that wait on the owner, failed or are blocked, read from BB thread states. */
  needs: z.array(z.object({
    threadId: z.string(), kind: z.enum(["waiting", "failed", "blocked"]), text: z.string(),
  })).optional(),
});
const blocker = z.object({ id: z.string(), title: z.string(), url: z.string(), outside: z.boolean() });
const boardSchema = z.object({
  autopilot: autopilotStateSchema.optional(),
  doctor: doctorReportSchema.optional(),
  tick: z.number(), laneCapacity: z.number(), workersPerLane: z.number(), autoStart: z.boolean(),
  lanes: z.array(lane),
  ready: z.array(z.object({
    planningThreadId: z.string().optional(),
    /** Total for the kind tag; ticketCount stays the open count for frontier math. */
    totalTicketCount: z.number().int().nonnegative().optional(),
    /** Absent on older/demo snapshots means spec. */
    kind: z.enum(["spec", "work-item"]).optional(),
    id: z.string(), title: z.string(), ticketCount: z.number(), routes: z.array(route), blockedBy: z.array(z.string()),
    acceptOwner: z.boolean(), url: z.string().optional(), blockers: z.array(blocker).optional(),
    startReason: z.string().nullable().optional(),
    /** Open blockers of the spec itself, distinct from tickets that can wait inside its lane. */
    waitingFor: z.array(blocker).optional(),
    /** Open tickets that wait on open blockers, so a partial frontier shows why the rest won't start. */
    waiting: z.array(z.object({ id: z.string(), title: z.string(), blockedBy: z.array(z.string()) })).optional(),
    /** Open tickets a hold label keeps from agents. The Lead skips them. */
    held: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
  })),
  /** Specs that aren't Ready: what's missing, and the one button that fixes it. */
  shaping: z.array(z.object({
    planningThreadId: z.string().optional(),
    totalTicketCount: z.number().int().nonnegative().optional(),
    id: z.string(), title: z.string(), url: z.string().optional(), ticketCount: z.number(), missing: z.string(),
    /** "resume" reopens the open planning thread; "tickets" plans the spec's tickets. */
    action: z.enum(["resume", "tickets"]), threadId: z.string().optional(),
  })),
  openIssues: z.array(z.object({
    planningThreadId: z.string().optional(),
    kind: z.enum(["spec", "ticket", "work-item"]).optional(),
    id: z.string(), title: z.string(), labels: z.array(z.string()), url: z.string().optional(), under: z.string().optional(),
    priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  })),
  tracker: z.object({
    kind: trackerKindSchema.nullable().optional(),
    state: z.enum(["disconnected", "unscoped", "catching-up", "current", "failed"]), message: z.string(),
    syncedAt: z.number().nullable(), project: z.string().nullable(),
  }).optional(),
});

export { boardSchema };
export type Route = z.infer<typeof route>;
export type Family = Route["family"];
export type Ticket = z.infer<typeof ticket>;
export type TicketState = Ticket["state"];
export type Lane = z.infer<typeof lane>;
export type LaneState = Lane["state"];
export type PullRequest = NonNullable<Lane["pr"]>;
export type Blocker = z.infer<typeof blocker>;
export type Board = z.infer<typeof boardSchema>;
export type ReadySpec = Board["ready"][number];
export type OpenIssue = Board["openIssues"][number];
export type ShapingSpec = Board["shaping"][number];
export type TrackerStatus = NonNullable<Board["tracker"]>;
export type NeedsYouKind = "setup" | "waiting" | "failed" | "blocked" | "stopped" | "merge" | "autopilot-paused" | "autopilot-check";

export interface NeedsYouItem {
  key: string;
  kind: NeedsYouKind;
  /** The spec or issue the item is about, or "" when none. */
  specId: string;
  ticketId?: string;
  text: string;
  threadId: string | null;
  localMerge?: boolean;
  log?: { hostId: string; path: string };
}

/** What waits on the owner, derived from lane and ticket state, never stored. */
export function needsYou(board: Board): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const [id, text] of Object.entries(board.autopilot?.skippedMainChecks ?? {})) {
    items.push({ key: `autopilot-check:${id}`, kind: "autopilot-check", specId: "", threadId: null, text });
  }
  if (board.autopilot?.status === "paused" && !board.autopilot.waitingForLinear) {
    items.push({ key: "autopilot-paused", kind: "autopilot-paused", specId: "", threadId: null,
      text: board.autopilot.pauseReason ?? "Autopilot is paused.",
      ...(board.autopilot.pauseLog ? { log: board.autopilot.pauseLog } : {}) });
  }
  const fixes = (board.doctor?.checks ?? []).filter((check) => check.status === "fix");
  const setupUnavailable = board.tracker?.state === "unscoped" && board.doctor?.checks.some((check) =>
    (check.id === "settings" || check.id === "tracker") && check.status === "warning");
  // A Scope problem Doctor already names needs one row, not two.
  if ((board.tracker?.state === "disconnected" || board.tracker?.state === "unscoped")
    && !setupUnavailable
    && !fixes.some((check) => check.message.includes(board.tracker!.message))) {
    items.push({ key: "setup", kind: "setup", specId: "", text: board.tracker.message, threadId: null });
  }
  for (const check of board.doctor?.checks ?? []) {
    if (check.status === "fix") {
      items.push({ key: `setup:${check.id}`, kind: "setup", specId: "", text: check.message, threadId: null });
    }
  }
  for (const lane of board.lanes) {
    if (lane.state === "merge-waits" && !lane.outside) {
      items.push({
        key: `merge:${lane.specId}`,
        kind: "merge",
        specId: lane.specId,
        text: lane.localMerge ? "The tickets are in the integration branch. accept:owner holds the local merge for you."
          : `PR #${lane.pr?.number} passed its checks. accept:owner holds it for your merge.`,
        threadId: lane.leadThreadId,
        ...(lane.localMerge ? { localMerge: true } : {}),
      });
    }
    for (const need of lane.needs ?? []) {
      items.push({ key: `${need.kind}:${need.threadId}`, kind: need.kind, specId: lane.specId, text: need.text, threadId: need.threadId });
    }
    // A failure or a question already says why the lane isn't moving.
    if (!lane.outside && (lane.stopped ?? lane.state === "stopped") && lane.state !== "landed" && lane.state !== "merge-waits" && !lane.needs?.length) {
      items.push({
        key: `stopped:${lane.specId}`,
        kind: "stopped",
        specId: lane.specId,
        text: lane.stopReason ?? "The lane stopped.",
        threadId: lane.leadThreadId,
      });
    }
    for (const ticket of lane.tickets) {
      if (ticket.state === "question" && ticket.threadId) {
        items.push({
          key: `question:${ticket.id}`,
          kind: "waiting",
          specId: lane.specId,
          ticketId: ticket.id,
          text: ticket.question ?? "The worker asked a question.",
          threadId: ticket.threadId,
        });
      }
    }
  }
  const order: Record<NeedsYouKind, number> = { "autopilot-paused": -1, "autopilot-check": -1, setup: 0, failed: 1, blocked: 2, stopped: 3, waiting: 4, merge: 5 };
  return items.sort((a, b) => order[a.kind] - order[b.kind]);
}

/** Tickets grouped into columns by dependency depth, blockers first. */
export function dependencyColumns(tickets: Ticket[]): Ticket[][] {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const ticket = byId.get(id);
    if (!ticket || seen.has(id)) return 0;
    seen.add(id);
    const inLane = ticket.blockedBy.filter((b) => byId.has(b));
    const d = inLane.length === 0 ? 0 : 1 + Math.max(...inLane.map((b) => visit(b, seen)));
    depth.set(id, d);
    return d;
  };
  for (const t of tickets) visit(t.id, new Set());
  const columns: Ticket[][] = [];
  for (const t of tickets) {
    const d = depth.get(t.id) ?? 0;
    (columns[d] ??= []).push(t);
  }
  return columns.filter(Boolean);
}

/** How long a landing's burst plays on the sortie line before the lane moves to Landed. */
export const LANDING_MS = 1600;

/** The lane states one board view has seen, and when each landing it saw plays until. */
export interface Landings { seen: Record<string, LaneState>; until: Record<string, number> }

/**
 * A landing plays once: only when this view saw the lane in another state and now sees it Landed.
 * A lane already Landed when the board opens is history, so a reload never replays it.
 */
export function nextLandings(previous: Landings | null, lanes: readonly Lane[], now: number): Landings {
  const until: Record<string, number> = {};
  for (const lane of lanes) {
    const playing = previous?.until[lane.specId];
    const before = previous?.seen[lane.specId];
    if (playing !== undefined && playing > now) until[lane.specId] = playing;
    else if (lane.state === "landed" && before !== undefined && before !== "landed") until[lane.specId] = now + LANDING_MS;
  }
  return { seen: Object.fromEntries(lanes.map((lane) => [lane.specId, lane.state])), until };
}

/** Merge shows, and the server merges, only for an open PR whose checks pass. The demo's PRs carry no state. */
export function canMerge(lane: { outside?: boolean; localMerge?: boolean; pr?: { state?: PullRequest["state"]; checks: PullRequest["checks"] } }): boolean {
  if (lane.outside) return false;
  if (lane.localMerge) return true;
  return (lane.pr?.state ?? "open") === "open" && lane.pr?.checks === "passing";
}

export function otherFamily(family: Family): Family {
  return family === "claude" ? "gpt" : "claude";
}

/** The final reviewer: the Lead's own route for "same", else the first route of the other family. */
export function reviewerFor(lead: Route, finalReviewFamily: "other" | "same", routes: readonly Route[]): Route {
  if (finalReviewFamily === "same") return lead;
  const family = otherFamily(lead.family);
  return routes.find((route) => route.family === family)
    ?? { family, model: family === "claude" ? "Claude" : "GPT", effort: lead.effort };
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
