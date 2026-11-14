import { z } from "zod";
import type { Route } from "./board-model.js";
import { routeSchema } from "./board-model.js";

/** Durable links and execution state. Linear remains authoritative for issues. */
export const laneRunSchema = z.object({
  id: z.string(), bbProjectId: z.string(), workspaceId: z.string(),
  specIssueId: z.string(), specId: z.string(), title: z.string(),
  route: routeSchema,
  state: z.enum(["starting", "flying", "stopped", "landed"]), startedAt: z.number(),
  leadThreadId: z.string().nullable(), environmentId: z.string().nullable(), branch: z.string().nullable(),
  acceptOwner: z.boolean(), stopReason: z.string().optional(),
  hostId: z.string().optional(), startStateId: z.string().optional(),
  /** Receipt IDs prove queuing only; current delivery state belongs to outbox. */
  startWrites: z.object({ status: z.string().optional(), comment: z.string().optional() }).optional(),
  writeError: z.string().optional(),
});
export type LaneRun = z.infer<typeof laneRunSchema>;
export type StartLeadCommand = { type: "start-lead"; specIssueId: string; specId: string; route: Route };
export type StartDecision = { allowed: true } | { allowed: false; reason: string };

export const laneStartedSchema = z.object({
  laneId: z.string(), threadId: z.string(), branch: z.string().nullable(),
  /** Provisioning can continue after the request returns. */
  message: z.string().optional(),
});
export type LaneStarted = z.infer<typeof laneStartedSchema>;

export const laneContract = {
  "lanes.setAutoStart": {
    input: z.object({ projectId: z.string().min(1).max(256), enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
  "lanes.start": {
    input: z.object({ projectId: z.string().min(1).max(256), specId: z.string().min(1).max(256) }).strict(),
    output: laneStartedSchema,
  },
} as const;
