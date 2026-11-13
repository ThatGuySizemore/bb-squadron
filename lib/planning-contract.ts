import { z } from "zod";

export const planningStartedSchema = z.object({
  threadId: z.string(),
  /** False when the thread opened without Squadron's Linear writes; `message` says why. */
  writes: z.boolean(),
  message: z.string().nullable(),
});
export type PlanningStarted = z.infer<typeof planningStartedSchema>;

/** The board's Plan buttons. Omit issueId for "Plan a spec". */
export const planningContract = {
  "planning.start": {
    input: z.object({ projectId: z.string().min(1).max(256), issueId: z.string().min(1).max(64).optional() }).strict(),
    output: planningStartedSchema,
  },
} as const;
