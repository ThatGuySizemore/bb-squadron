import { firstPromptSchema } from "./bound-thread.js";
import { z } from "zod";
import { routeSchema, type Route } from "./board-model.js";

export const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const workerRunSchema = z.object({
  id: z.string(), ticketIssueId: z.string(), ticketId: z.string(), route: routeSchema,
  state: z.enum(["spawning", "working", "reported", "integrated", "failed"]), startedAt: z.number(),
  threadId: z.string().nullable(), environmentId: z.string().nullable(), branch: z.string().nullable(),
  notifiedCommit: commitSchema.optional(),
  commit: commitSchema.optional(), summary: z.string().optional(), failure: z.string().optional(),
  integration: z.object({ commit: commitSchema, head: commitSchema, verifiedAt: z.number() }).optional(),
  writes: z.object({ started: z.string().optional(), integrated: z.string().optional(), comment: z.string().optional() }).optional(),
  writeError: z.string().optional(),
  firstPrompt: firstPromptSchema.optional(),
  failurePhase: z.enum(["spawn", "prompt", "lifecycle"]).optional(),
});
export type WorkerRun = z.infer<typeof workerRunSchema>;
export type SpawnWorkerCommand = { type: "spawn-worker"; laneId: string; ticketIssueId: string; ticketId: string; route: Route };
export const spawnWorkerSchema = z.object({ ticketId: z.string().min(1).max(256) }).strict();
export const reportSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("done"), commit: commitSchema, summary: z.string().min(1).max(16_000) }).strict(),
  z.object({ type: z.literal("integrated"), ticketId: z.string().min(1), commit: commitSchema }).strict(),
]);
export const workerContract = {
  "workers.route": {
    input: z.object({ projectId: z.string().min(1), specId: z.string().min(1), ticketId: z.string().min(1), route: routeSchema }).strict(),
    output: z.object({ route: routeSchema }),
  },
} as const;

/** Only the trusted server supplies checkout paths and refs to the host. */
export const workerHostContract = {
  verifyWorkerCommit: {
    input: z.object({ path: z.string().min(1), branch: z.string().min(1), commit: commitSchema,
      integrationBranch: z.string().min(1).optional() }).strict(),
    output: z.object({ verified: z.boolean(), head: commitSchema.nullable() }),
    experimental_retryable: true,
  },
};
