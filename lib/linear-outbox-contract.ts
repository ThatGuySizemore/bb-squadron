import { z } from "zod";

export const outboxBlockedReasonSchema = z.enum([
  "workspace_changed", "auth_mode_changed", "authentication", "configuration",
  "invalid_operation", "graphql", "conflict", "dependency_blocked",
]);
export const outboxReceiptSchema = z.object({
  id: z.string(), status: z.enum(["pending", "blocked", "delivered"]), attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.number(), lastError: z.string().nullable(),
});
export const outboxHealthSchema = z.object({
  bbProjectId: z.string(), pendingCount: z.number().int().nonnegative(), blockedCount: z.number().int().nonnegative(),
  blocked: z.array(z.object({ id: z.string(), threadId: z.string().nullable(), issueIds: z.array(z.string()), reason: outboxBlockedReasonSchema })),
  hasMore: z.boolean(),
});
export type OutboxHealth = z.infer<typeof outboxHealthSchema>;
export type OutboxBlockedReason = z.infer<typeof outboxBlockedReasonSchema>;
export const linearOutboxContract = {
  "linear.outboxHealth": { input: z.object({ bbProjectId: z.string().min(1).max(256) }).strict(), output: outboxHealthSchema },
  "linear.outboxResume": { input: z.object({ bbProjectId: z.string().min(1).max(256), id: z.uuid() }).strict(), output: outboxReceiptSchema },
} as const;
