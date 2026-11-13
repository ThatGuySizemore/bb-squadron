import { z } from "zod";

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
  pr: z.object({ number: z.number(), checks: z.enum(["pending", "passing", "failing"]), url: z.string() }).optional(),
  stopReason: z.string().optional(), landedAt: z.number().optional(),
});
const blocker = z.object({ id: z.string(), title: z.string(), url: z.string(), outside: z.boolean() });
export const boardSchema = z.object({
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
  writes: z.object({
    pending: z.number(), more: z.number(),
    blocked: z.array(z.object({ id: z.string(), threadId: z.string().nullable(), issues: z.array(z.string()), reason: z.string() })),
  }).optional(),
});

/** The board page reads one BB project's board; `board-changed` says when to read again. */
export const boardContract = {
  board: { input: z.object({ projectId: z.string().min(1) }).strict(), output: boardSchema },
} as const;

export const BOARD_CHANGED = "board-changed";
export type BoardChanged = { projectId: string };
