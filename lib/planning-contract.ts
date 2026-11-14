import { z } from "zod";

export const planningStartedSchema = z.object({
  threadId: z.string(),
});
export type PlanningStarted = z.infer<typeof planningStartedSchema>;

/**
 * The board's planning buttons. Omit issueId for New spec. With an issueId, Plan and
 * Resume planning reopen the issue's open planning thread or start one; `step: "tickets"`
 * (Plan tickets) seeds a new thread to plan an existing spec's tickets.
 */
export const planningContract = {
  "planning.start": {
    input: z.object({
      projectId: z.string().min(1).max(256), issueId: z.string().min(1).max(64).optional(),
      step: z.literal("tickets").optional(),
    }).strict(),
    output: planningStartedSchema,
  },
} as const;
