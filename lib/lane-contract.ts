import { z } from "zod";
import type { Route } from "./board-model.js";

/** Durable links and execution state. Linear remains authoritative for issues. */
export const laneRunSchema = z.object({
  id: z.string(), bbProjectId: z.string(), workspaceId: z.string(),
  specIssueId: z.string(), specId: z.string(), title: z.string(),
  route: z.object({ family: z.enum(["claude", "gpt"]), model: z.string(), effort: z.enum(["medium", "high"]) }),
  state: z.enum(["starting", "flying", "stopped", "landed"]), startedAt: z.number(),
  leadThreadId: z.string().nullable(), environmentId: z.string().nullable(), branch: z.string().nullable(),
  acceptOwner: z.boolean(), stopReason: z.string().optional(),
});
export type LaneRun = z.infer<typeof laneRunSchema>;
export type StartLeadCommand = { type: "start-lead"; specIssueId: string; specId: string; route: Route };
export type StartDecision = { allowed: true } | { allowed: false; reason: string };

export const laneContract = {
  "lanes.start": {
    input: z.object({ projectId: z.string().min(1).max(256), specId: z.string().min(1).max(256) }).strict(),
    output: z.object({ laneId: z.string(), threadId: z.string(), branch: z.string() }),
  },
} as const;
