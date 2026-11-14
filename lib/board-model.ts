// The board runtime schema is also the source of its public TypeScript types.
import { z } from "zod";
import { outboxHealthSchema } from "./linear-outbox-contract.js";

export const routeSchema = z.object({ family: z.enum(["claude", "gpt"]), model: z.string(), effort: z.enum(["medium", "high"]) });
const route = routeSchema;
const ticket = z.object({
  id: z.string(), title: z.string(), blockedBy: z.array(z.string()), route,
  state: z.enum(["blocked", "ready", "working", "question", "review", "branch", "failed", "done"]),
  routeChoices: z.array(routeSchema).optional(), reportPending: z.boolean().optional(), writeError: z.string().optional(),
  minutes: z.number(), threadId: z.string().optional(), question: z.string().optional(), questionId: z.string().optional(), failure: z.string().optional(),
});
const lane = z.object({
  specId: z.string(), title: z.string(), lead: route, leadThreadId: z.string().nullable(), branch: z.string(),
  state: z.enum(["flying", "stopped", "spec-review", "pr-open", "merge-waits", "landed"]),
  minutes: z.number(), acceptOwner: z.boolean(), tickets: z.array(ticket),
  pr: z.object({ number: z.number(), checks: z.enum(["pending", "passing", "failing"]), url: z.string() }).optional(),
  stopReason: z.string().optional(), stoppedAt: z.number().optional(), landedAt: z.number().optional(),
  writeError: z.string().optional(),
});
const blocker = z.object({ id: z.string(), title: z.string(), url: z.string(), outside: z.boolean() });
const boardSchema = z.object({
  tick: z.number(), laneCapacity: z.number(), workersPerLane: z.number(), autoStart: z.boolean(),
  lanes: z.array(lane),
  ready: z.array(z.object({
    id: z.string(), title: z.string(), ticketCount: z.number(), routes: z.array(route), blockedBy: z.array(z.string()),
    acceptOwner: z.boolean(), url: z.string().optional(), blockers: z.array(blocker).optional(),
    startReason: z.string().nullable().optional(),
    /** The integration branch kept from a lane the owner canceled. */
    keptBranch: z.string().optional(),
    /** A Linear write the Helper couldn't queue when the owner canceled its lane. */
    writeError: z.string().optional(),
  })),
  unplanned: z.array(z.object({
    id: z.string(), title: z.string(), labels: z.array(z.string()), url: z.string().optional(), under: z.string().optional(),
    priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  })),
  linear: z.object({
    state: z.enum(["disconnected", "unbound", "catching-up", "current", "failed"]), message: z.string(),
    syncedAt: z.number().nullable(), project: z.string().nullable(),
  }).optional(),
  writes: outboxHealthSchema.extend({
    blocked: z.array(outboxHealthSchema.shape.blocked.element.extend({ issueIdentifiers: z.array(z.string()), reasonText: z.string() })),
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
export type BoardBlockedWrite = NonNullable<Board["writes"]>["blocked"][number];
/** Public type retained; delivery failures are WriteDeliveryBlocked errors. */
export type BlockedWrite = BoardBlockedWrite;

export type NeedsYouKind = "setup" | "question" | "stopped" | "write" | "merge";

export interface NeedsYouItem {
  key: string;
  /** Identity for its one push: a recurrence of the same key after it cleared gets a new one. */
  notifyKey: string;
  kind: NeedsYouKind;
  /** The spec or issue the item is about, or "" when none. */
  specId: string;
  ticketId?: string;
  text: string;
  threadId: string | null;
  /** The outbox receipt to retry, for a blocked write. */
  writeId?: string;
  /** The issue a blocked write touches. It may be a ticket, so it isn't set in pixel type. */
  issueId?: string;
}

/** What waits on the owner, derived from lane and ticket state, never stored. */
export function needsYou(board: Board): NeedsYouItem[] {
  const items: Array<Omit<NeedsYouItem, "notifyKey"> & { notifyKey?: string }> = [];
  if (board.linear?.state === "disconnected" || board.linear?.state === "unbound") {
    items.push({ key: "setup", notifyKey: `setup:${board.linear.state}`, kind: "setup", specId: "", text: board.linear.message, threadId: null });
  }
  for (const write of board.writes?.blocked ?? []) {
    items.push({
      key: `write:${write.id}`, kind: "write", specId: "", writeId: write.id, threadId: write.threadId,
      ...(write.issueIdentifiers[0] ? { issueId: write.issueIdentifiers[0] } : {}),
      text: `A Linear write${write.issueIdentifiers.length ? ` for ${write.issueIdentifiers.join(", ")}` : ""} couldn't go through. ${write.reasonText}`,
    });
  }
  if (board.writes?.hasMore) {
    const more = Math.max(0, board.writes.blockedCount - board.writes.blocked.length);
    items.push({ key: "write:more", kind: "write", specId: "", threadId: null,
      text: more > 0 ? `${more} more Linear ${more === 1 ? "write" : "writes"} couldn't go through. Retry the ones above first.`
        : "More Linear writes couldn't go through. Retry the ones above first." });
  }
  for (const spec of board.ready) {
    if (spec.writeError) items.push({ key: `lane-write:${spec.id}`, kind: "write", specId: spec.id, threadId: null, text: spec.writeError });
  }
  for (const lane of board.lanes) {
    if (lane.writeError) items.push({ key: `lane-write:${lane.specId}`, kind: "write", specId: lane.specId,
      threadId: lane.leadThreadId, text: lane.writeError });
    if (lane.state === "merge-waits") {
      items.push({
        key: `merge:${lane.specId}`,
        kind: "merge",
        specId: lane.specId,
        text: `PR #${lane.pr?.number} passed checks and both reviews. accept:owner holds it for your merge.`,
        threadId: lane.leadThreadId,
      });
    }
    if (lane.state === "stopped") {
      items.push({
        key: `stopped:${lane.specId}`,
        notifyKey: `stopped:${lane.specId}:${lane.stoppedAt ?? 0}`,
        kind: "stopped",
        specId: lane.specId,
        text: lane.stopReason ?? "The lane stopped.",
        threadId: lane.leadThreadId,
      });
    }
    for (const ticket of lane.tickets) {
      if (ticket.writeError) items.push({ key: `worker-write:${ticket.id}`, kind: "write", specId: lane.specId,
        ticketId: ticket.id, threadId: lane.leadThreadId, text: ticket.writeError });
      if (ticket.state === "question" && ticket.threadId) {
        items.push({
          key: `question:${ticket.id}`,
          notifyKey: `question:${ticket.id}:${ticket.questionId ?? ""}`,
          kind: "question",
          specId: lane.specId,
          ticketId: ticket.id,
          text: ticket.question ?? "The worker asked a question.",
          threadId: ticket.threadId,
        });
      }
    }
  }
  const order: Record<NeedsYouKind, number> = { setup: 0, stopped: 1, question: 2, write: 3, merge: 4 };
  return items.map((item) => ({ ...item, notifyKey: item.notifyKey ?? item.key })).sort((a, b) => order[a.kind] - order[b.kind]);
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

export function reviewerFor(route: Route): Route {
  return otherFamily(route.family) === "claude"
    ? { family: "claude", model: "Opus 5.5", effort: "high" }
    : { family: "gpt", model: "GPT-6.1 Sol", effort: "high" };
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
