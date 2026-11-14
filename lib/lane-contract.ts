import { z } from "zod";
import type { Route } from "./board-model.js";
import { commitSchema, reviewRunSchema, workerRunSchema } from "./worker-contract.js";
import { routeSchema } from "./board-model.js";

/** One read of BB's pull-request plugin, plus the integration head Squadron
 * verified locally and at its upstream when it read it. The plugin reports no
 * head commit, so `head` is null until that Git check passes. */
export const pullRequestObservationSchema = z.object({
  number: z.number().int().positive(), url: z.string(), state: z.enum(["draft", "open", "merged", "closed"]),
  checks: z.enum(["passing", "failing", "pending", "none", "unknown"]),
  headRefName: z.string(), baseRefName: z.string(), head: commitSchema.nullable(), observedAt: z.number(),
});
export type PullRequestObservation = z.infer<typeof pullRequestObservationSchema>;

/** Durable links and execution state. Linear remains authoritative for issues. */
export const laneRunSchema = z.object({
  id: z.string(), bbProjectId: z.string(), workspaceId: z.string(),
  specIssueId: z.string(), specId: z.string(), title: z.string(),
  route: routeSchema,
  state: z.enum(["starting", "flying", "stopped", "landed", "canceled"]), startedAt: z.number(),
  /** Each stop is its own Needs-you item; canceled lanes keep their branch and records. */
  stoppedAt: z.number().optional(), canceledAt: z.number().optional(),
  leadThreadId: z.string().nullable(), environmentId: z.string().nullable(), branch: z.string().nullable(),
  acceptOwner: z.boolean(), stopReason: z.string().optional(),
  hostId: z.string().optional(), startStateId: z.string().optional(),
  /** Receipt IDs prove queuing only; current delivery state belongs to outbox. */
  startWrites: z.object({ status: z.string().optional(), comment: z.string().optional() }).optional(),
  writeError: z.string().optional(),
  workers: z.array(workerRunSchema).optional(),
  routeOverrides: z.record(z.string(), routeSchema).optional(),
  /** Metadata-derived links may be displayed but never grant role authority. */
  recoveryOnly: z.boolean().optional(),
  /** The whole-branch review, from the family opposite the Lead, bound to the integration head it reviewed. */
  specReview: reviewRunSchema.optional(),
  /** The last pull request BB's pull-request plugin reported for the Lead's environment. */
  pr: pullRequestObservationSchema.optional(),
  /** Why the latest PR read failed. The last observation stays, but grants nothing. */
  prUnavailable: z.string().optional(),
  /** The Helper's passed merge check: the Lead may squash-merge this exact PR head. */
  merge: z.object({ number: z.number().int().positive(), commit: commitSchema, at: z.number() }).optional(),
  /** The owner's board click for one exact merge context of an accept:owner spec. */
  ownerMerge: z.object({ number: z.number().int().positive(), commit: commitSchema, at: z.number(), notified: z.boolean() }).optional(),
  landedAt: z.number().optional(),
  /** Receipt IDs for the Done statuses and landing comment. They prove queuing only. */
  landWrites: z.record(z.string(), z.string()).optional(),
});
export type LaneRun = z.infer<typeof laneRunSchema>;
export type StartLeadCommand = { type: "start-lead"; specIssueId: string; specId: string; route: Route };
export type StartDecision = { allowed: true } | { allowed: false; reason: string };

export const laneStartedSchema = z.object({
  laneId: z.string(), threadId: z.string(), branch: z.string().nullable(),
  /** Provisioning can continue after the request returns. */
  message: z.string().optional(),
});
export type LaneStarted = z.infer<typeof laneStartedSchema>;

export const laneContract = {
  "lanes.setAutoStart": {
    input: z.object({ projectId: z.string().min(1).max(256), enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
  "lanes.start": {
    input: z.object({ projectId: z.string().min(1).max(256), specId: z.string().min(1).max(256) }).strict(),
    output: laneStartedSchema,
  },
} as const;

const laneControl = { input: z.object({ projectId: z.string().min(1).max(256), specId: z.string().min(1).max(256) }).strict(),
  output: z.object({ state: laneRunSchema.shape.state }) };
/** The owner's Merge for an accept:owner spec, for the exact PR head the board showed. Client-only. */
export const laneMergeContract = {
  "lanes.merge": {
    input: z.object({ projectId: z.string().min(1).max(256), specId: z.string().min(1).max(256),
      number: z.number().int().positive(), commit: commitSchema }).strict(),
    output: z.object({ state: laneRunSchema.shape.state }),
  },
} as const;

/** The owner's lane controls. Client-only, like Start. */
export const laneLifecycleContract = {
  "lanes.stop": laneControl,
  "lanes.resume": laneControl,
  "lanes.cancel": laneControl,
} as const;
