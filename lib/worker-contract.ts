import { z } from "zod";
import { routeSchema, type Route } from "./board-model.js";

export const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const findingSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(["in-spec", "smell", "question", "not-proven", "outside-spec"]),
  text: z.string().min(1).max(8_000),
  /** A dropped smell needs the reviewer's one-line reason in text. */
  disposition: z.enum(["fix", "drop"]).optional(),
}).strict();
export const reviewRunSchema = z.object({
  id: z.string(), route: routeSchema, threadId: z.string().nullable(), environmentId: z.string().nullable(),
  commit: commitSchema, originalCommit: commitSchema,
  state: z.enum(["spawning", "reviewing", "changes", "fixing", "second-look", "approved", "failed"]),
  round: z.union([z.literal(0), z.literal(1)]),
  firstFindings: z.array(findingSchema).optional(),
  verdict: z.object({ commit: commitSchema, outcome: z.enum(["approve", "changes"]), findings: z.array(findingSchema),
    resolvedFindingIds: z.array(z.string()), at: z.number() }).optional(),
  failure: z.string().optional(), notifiedVerdict: z.string().optional(),
  defects: z.record(z.string(), z.object({ key: z.string(), issueId: z.string(), receiptId: z.string().optional(), linkReceiptId: z.string().optional() })).optional(),
});
export const workerRunSchema = z.object({
  id: z.string(), ticketIssueId: z.string(), ticketId: z.string(), route: routeSchema,
  state: z.enum(["spawning", "working", "reported", "integrated", "failed"]), startedAt: z.number(),
  threadId: z.string().nullable(), environmentId: z.string().nullable(), branch: z.string().nullable(),
  notifiedCommit: commitSchema.optional(),
  commit: commitSchema.optional(), summary: z.string().optional(), failure: z.string().optional(),
  integration: z.object({ commit: commitSchema, head: commitSchema, verifiedAt: z.number() }).optional(),
  writes: z.object({ started: z.string().optional(), integrated: z.string().optional(), comment: z.string().optional() }).optional(),
  writeError: z.string().optional(),
  review: reviewRunSchema.optional(),
});
export type WorkerRun = z.infer<typeof workerRunSchema>;
export type ReviewRun = z.infer<typeof reviewRunSchema>;
export type ReviewFinding = z.infer<typeof findingSchema>;
export function requiresFix(finding: ReviewFinding): boolean {
  return finding.kind === "in-spec" || (finding.kind === "smell" && finding.disposition !== "drop");
}
/** Durable service bindings, never editable thread metadata, supply this record. */
export function hasCurrentApproval(worker: WorkerRun): boolean {
  const review = worker.review;
  return !!review?.threadId && review.route.family !== worker.route.family && review.state === "approved" &&
    !!worker.commit && review.commit === worker.commit && review.verdict?.commit === worker.commit && review.verdict.outcome === "approve";
}
export type SpawnWorkerCommand = { type: "spawn-worker"; laneId: string; ticketIssueId: string; ticketId: string; route: Route };
export const spawnWorkerSchema = z.object({ ticketId: z.string().min(1).max(256) }).strict();
export const reportSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("done"), commit: commitSchema, summary: z.string().min(1).max(16_000) }).strict(),
  z.object({ type: z.literal("integrated"), ticketId: z.string().min(1), commit: commitSchema }).strict(),
  z.object({ type: z.literal("verdict"), commit: commitSchema, outcome: z.enum(["approve", "changes"]),
    findings: z.array(findingSchema).max(100), resolvedFindingIds: z.array(z.string().min(1).max(128)).max(100) }).strict(),
  z.object({ type: z.literal("fix"), ticketId: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal("defect"), ticketId: z.string().min(1).max(256), findingId: z.string().min(1).max(128),
    title: z.string().min(1).max(500), description: z.string().min(1).max(16_000), dedupeKey: z.string().min(1).max(128),
    dedupeEvidence: z.string().min(1).max(4_000), existingIssueId: z.string().min(1).max(256).optional() }).strict(),
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
