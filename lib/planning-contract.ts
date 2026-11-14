import { z } from "zod";

export const planningStartedSchema = z.object({
  threadId: z.string(),
});
export type PlanningStarted = z.infer<typeof planningStartedSchema>;

/** The board's Plan buttons. Omit issueId for "Plan a spec". */
export const planningContract = {
  "planning.start": {
    input: z.object({ projectId: z.string().min(1).max(256), issueId: z.string().min(1).max(64).optional() }).strict(),
    output: planningStartedSchema,
  },
} as const;

/** The board's Set up button: Matt's setup when needed, then squadron.md with the owner. */
export const setupContract = {
  "planning.setup": {
    input: z.object({ projectId: z.string().min(1).max(256) }).strict(),
    output: planningStartedSchema,
  },
} as const;
