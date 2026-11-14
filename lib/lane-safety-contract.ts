import { z } from "zod";
import { commitSchema } from "./worker-contract.js";

export const strikeEventSchema = z.object({
  ticketId: z.string().min(1).max(256), eventId: z.string().min(1).max(256),
  kind: z.enum(["quick-check", "review", "stuck"]), commit: commitSchema.optional(),
  summary: z.string().trim().min(1).max(16_000),
}).strict();
export type StrikeEvent = z.infer<typeof strikeEventSchema>;
export const laneSafetySchema = z.object({
  pendingStuck: z.array(z.object({ ticketId: z.string(), eventId: z.string(), summary: z.string(), at: z.number(), notified: z.boolean() })).optional(),
  strikes: z.array(strikeEventSchema.extend({ at: z.number() })).default([]),
  /** Monotonic action counts, never thread.updatedAt or Helper-origin messages. */
  actions: z.record(z.string(), z.number()).default({}),
  nudges: z.record(z.string(), z.object({ at: z.number(), actions: z.number(), stoppedAt: z.number().optional(), queuedMessageId: z.string().optional() })).default({}),
});
