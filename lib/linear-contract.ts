import { z } from "zod";

const identity = z.object({ id: z.string(), name: z.string() });
export const linearConnectionSchema = z.object({
  status: z.enum(["connected", "disconnected", "failed"]),
  mode: z.literal("personal").nullable(),
  workspace: identity.nullable(),
  actor: identity.nullable(),
  message: z.string(),
});
export type LinearConnectionState = z.infer<typeof linearConnectionSchema>;

// Only connection controls are exposed to the page. GraphQL stays server-side.
export const linearContract = {
  "linear.connection": { input: z.null(), output: linearConnectionSchema },
} as const;
