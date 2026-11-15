import { z } from "zod";

export const autopilotStateSchema = z.object({
  status: z.enum(["off", "on", "paused"]),
  laneLimit: z.number().int().min(1).max(10),
  consecutiveStops: z.number().int().nonnegative(),
  pauseReason: z.string().nullable(),
  checkingMain: z.boolean().optional(),
  pauseLog: z.object({ hostId: z.string(), path: z.string() }).optional(),
  skippedMainChecks: z.record(z.string(), z.string()).optional(),
});
export type AutopilotState = z.infer<typeof autopilotStateSchema>;
const project = z.object({ projectId: z.string().min(1).max(256) }).strict();
export const autopilotContract = {
  "autopilot.get": { input: project, output: autopilotStateSchema },
  "autopilot.resume": { input: project, output: autopilotStateSchema },
  "autopilot.set": {
    input: project.extend({ status: z.enum(["off", "on"]).optional(), laneLimit: z.number().int().min(1).max(10).optional() }).strict(),
    output: autopilotStateSchema,
  },
} as const;
