import { z } from "zod";

const identity = z.object({ id: z.string(), name: z.string() });
export const linearConnectionSchema = z.object({
  status: z.enum(["connected", "disconnected", "failed"]),
  mode: z.enum(["app", "personal"]).nullable(),
  workspace: identity.nullable(),
  actor: identity.nullable(),
  message: z.string(),
});
export type LinearConnectionState = z.infer<typeof linearConnectionSchema>;

// Only connection controls are exposed to the page. GraphQL stays server-side.
export const linearContract = {
  "linear.connection": { input: z.null(), output: linearConnectionSchema },
  "linear.connect": { input: z.null(), output: z.object({ url: z.string().url() }) },
  "linear.disconnect": { input: z.null(), output: linearConnectionSchema },
  "linear.setup": { input: z.null(), output: z.object({ callbackUrl: z.string().url(), oauthConfigured: z.boolean() }) },
} as const;
