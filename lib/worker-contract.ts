import { firstPromptSchema } from "./bound-thread.js";
import { z } from "zod";
import { routeSchema, type Route } from "./board-model.js";
import { reviewStateSchema } from "./review-state.js";

export const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const findingSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(["in-spec", "smell", "question", "not-proven", "outside-spec"]),
  text: z.string().min(1).max(8_000),
  /** A dropped smell needs the reviewer's one-line reason in text. */
  disposition: z.enum(["fix", "drop"]).optional(),
}).strict().superRefine((finding, context) => {
  if (finding.disposition !== undefined && finding.kind !== "smell") {
    context.addIssue({ code: "custom", path: ["disposition"], message: "A disposition is valid only for a smell." });
  }
  if (finding.disposition === "drop" && (!finding.text.trim() || finding.text.length > 300 || /[\r\n\u2028\u2029]/.test(finding.text))) {
    context.addIssue({ code: "custom", path: ["text"], message: "A dropped smell needs a single-line reason of 1 to 300 characters." });
  }
});
export const reviewRunSchema = z.object({
  id: z.string(), route: routeSchema, threadId: z.string().nullable(), environmentId: z.string().nullable(),
  commit: commitSchema, originalCommit: commitSchema,
  state: reviewStateSchema,
  round: z.union([z.literal(0), z.literal(1)]),
  firstFindings: z.array(findingSchema).optional(),
  verdict: z.object({ commit: commitSchema, outcome: z.enum(["approve", "changes"]), findings: z.array(findingSchema),
    resolvedFindingIds: z.array(z.string()), at: z.number() }).optional(),
  firstPrompt: firstPromptSchema.optional(), failurePhase: z.enum(["spawn", "prompt"]).optional(),
  failure: z.string().optional(), notifiedVerdict: z.string().optional(),
  defects: z.record(z.string(), z.object({ key: z.string(), normalizedTitle: z.string().optional(), projectId: z.string().optional(),
    issueId: z.string(), receiptId: z.string().optional(), linkReceiptId: z.string().optional() })).optional(),
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
  firstPrompt: firstPromptSchema.optional(),
  failurePhase: z.enum(["spawn", "prompt", "lifecycle"]).optional(),
  review: reviewRunSchema.optional(),
  /** An open question for the owner. Only the owner's own message in the worker thread clears it. */
  question: z.object({ id: z.string(), text: z.string(), askedAt: z.number() }).optional(),
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
export const ticketIdSchema = z.object({ ticketId: z.string().min(1).max(256) }).strict();
export const spawnWorkerSchema = ticketIdSchema;
/** A ticket review, or with the lane's spec identifier and its verified
 * integration head, the one whole-branch review. */
export const spawnReviewerSchema = z.object({ ticketId: z.string().min(1).max(256), commit: commitSchema.optional() }).strict();
export const reportSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("done"), commit: commitSchema, summary: z.string().min(1).max(16_000) }).strict(),
  z.object({ type: z.literal("integrated"), ticketId: z.string().min(1), commit: commitSchema }).strict(),
  z.object({ type: z.literal("verdict"), commit: commitSchema, outcome: z.enum(["approve", "changes"]),
    findings: z.array(findingSchema).max(100), resolvedFindingIds: z.array(z.string().min(1).max(128)).max(100) }).strict(),
  z.object({ type: z.literal("fix"), ticketId: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal("defect"), ticketId: z.string().min(1).max(256), findingId: z.string().min(1).max(128),
    title: z.string().min(1).max(500), description: z.string().min(1).max(16_000), dedupeKey: z.string().min(1).max(128),
    dedupeEvidence: z.string().min(1).max(4_000), existingIssueId: z.string().min(1).max(256).optional() }).strict(),
  /** Lead: ask the Helper's merge check for this exact approved PR head. */
  z.object({ type: z.literal("merge"), commit: commitSchema }).strict(),
  /** Lead: the PR merged. The Helper reads BB's pull-request plugin; this report proves nothing itself. */
  z.object({ type: z.literal("landed") }).strict(),
  /** A worker asks the owner. It shows in Needs you; only the owner's own message in the worker thread clears it. */
  z.object({ type: z.literal("question"), text: z.string().trim().min(1).max(4_000) }).strict(),
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
  /** The integration branch's local head and its upstream's last known head. Reads no network. */
  pushedHead: {
    input: z.object({ path: z.string().min(1), branch: z.string().min(1) }).strict(),
    output: z.object({ head: commitSchema.nullable(), upstream: commitSchema.nullable() }),
    experimental_retryable: true,
  },
};
