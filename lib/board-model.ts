// The board runtime schema is also the source of its public TypeScript types.
import { z } from "zod";
import { doctorReportSchema } from "./doctor-contract.js";

const route = z.object({ family: z.enum(["claude", "gpt"]), model: z.string(), effort: z.enum(["medium", "high"]) });
const ticket = z.object({
  id: z.string(), title: z.string(), blockedBy: z.array(z.string()), route,
  state: z.enum(["blocked", "ready", "working", "question", "review", "branch", "failed", "done"]),
  minutes: z.number(), threadId: z.string().optional(), question: z.string().optional(), failure: z.string().optional(),
});
const lane = z.object({
  specId: z.string(), title: z.string(), lead: route, leadThreadId: z.string(), branch: z.string(),
  state: z.enum(["flying", "stopped", "spec-review", "pr-open", "merge-waits", "landed"]),
  minutes: z.number(), acceptOwner: z.boolean(), tickets: z.array(ticket),
  pr: z.object({
    number: z.number(), checks: z.enum(["pending", "passing", "failing", "none", "unknown"]), url: z.string(),
    state: z.enum(["draft", "open", "merged", "closed"]).optional(),
  }).optional(),
  stopReason: z.string().optional(), landedAt: z.number().optional(),
  /** Who runs the lane's final review, from the final-review family. */
  reviewer: route.optional(),
  /** The spec in Linear. */
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
  doctor: doctorReportSchema.optional(),
  tick: z.number(), laneCapacity: z.number(), workersPerLane: z.number(), autoStart: z.boolean(),
  lanes: z.array(lane),
  ready: z.array(z.object({
    id: z.string(), title: z.string(), ticketCount: z.number(), routes: z.array(route), blockedBy: z.array(z.string()),
    acceptOwner: z.boolean(), url: z.string().optional(), blockers: z.array(blocker).optional(),
    startReason: z.string().nullable().optional(),
  })),
  unplanned: z.array(z.object({
    id: z.string(), title: z.string(), labels: z.array(z.string()), url: z.string().optional(), under: z.string().optional(),
    priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  })),
  linear: z.object({
    state: z.enum(["disconnected", "unbound", "catching-up", "current", "failed"]), message: z.string(),
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
export type UnplannedIssue = Board["unplanned"][number];
export type LinearStatus = NonNullable<Board["linear"]>;
export type NeedsYouKind = "setup" | "waiting" | "failed" | "blocked" | "stopped" | "merge";

export interface NeedsYouItem {
  key: string;
  kind: NeedsYouKind;
  /** The spec or issue the item is about, or "" when none. */
  specId: string;
  ticketId?: string;
  text: string;
  threadId: string | null;
}

/** What waits on the owner, derived from lane and ticket state, never stored. */
export function needsYou(board: Board): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  if (board.linear?.state === "disconnected" || board.linear?.state === "unbound") {
    items.push({ key: "setup", kind: "setup", specId: "", text: board.linear.message, threadId: null });
  }
  for (const check of board.doctor?.checks ?? []) {
    if (check.status === "fix") {
      items.push({ key: `setup:${check.id}`, kind: "setup", specId: "", text: check.message, threadId: null });
    }
  }
  for (const lane of board.lanes) {
    if (lane.state === "merge-waits") {
      items.push({
        key: `merge:${lane.specId}`,
        kind: "merge",
        specId: lane.specId,
        text: `PR #${lane.pr?.number} passed checks and both reviews. accept:owner holds it for your merge.`,
        threadId: lane.leadThreadId,
      });
    }
    for (const need of lane.needs ?? []) {
      items.push({ key: `${need.kind}:${need.threadId}`, kind: need.kind, specId: lane.specId, text: need.text, threadId: need.threadId });
    }
    // A failure or a question already says why the lane isn't moving.
    if (lane.state === "stopped" && !lane.needs?.length) {
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
  const order: Record<NeedsYouKind, number> = { setup: 0, failed: 1, blocked: 2, stopped: 3, waiting: 4, merge: 5 };
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
