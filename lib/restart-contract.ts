import { z } from "zod";
import { routeSchema } from "./board-model.js";

/** Observations are hints only, never service bindings or owner choices. */
export const restartThreadSchema = z.object({
  threadId: z.string(), projectId: z.string(), laneId: z.string(), specIssueId: z.string(), specId: z.string(),
  role: z.enum(["Lead", "Worker", "Reviewer"]), route: routeSchema, startedAt: z.number(),
  parentThreadId: z.string().nullable(), environmentId: z.string().nullable(), branch: z.string().nullable(),
  ticketIssueId: z.string().optional(), ticketId: z.string().optional(), workerId: z.string().optional(), reviewId: z.string().optional(),
});
export type RestartThread = z.infer<typeof restartThreadSchema>;
