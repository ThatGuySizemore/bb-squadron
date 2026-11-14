import { z } from "zod";

const id = z.string().min(1);
export const mirrorLabelSchema = z.object({ id, name: z.string(), color: z.string() });
export const mirrorStateSchema = z.object({ id, name: z.string(), type: z.string() });
export const mirrorIssueSchema = z.object({
  id, identifier: z.string(), title: z.string(), description: z.string().nullable(), url: z.string(),
  sortOrder: z.number().optional(), priority: z.number().optional(), createdAt: z.string().optional(),
  updatedAt: z.string(), teamId: id, projectId: id.nullable(), parentId: id.nullable(),
  state: mirrorStateSchema, labels: z.array(mirrorLabelSchema),
  assignees: z.array(z.object({ id, name: z.string() })).optional(),
  // Matches the project's Scope, including closed issues. Relation endpoints
  // and lane tickets outside the Scope stay in issues with inProject:false.
  inProject: z.boolean(),
});
export const mirrorRelationSchema = z.object({ id, type: z.literal("blocks"), issueId: id, relatedIssueId: id });
export const mirrorSnapshotSchema = z.object({
  /** The Scope from docs/agents/squadron.md, by name. null while it is missing, invalid or not yet read. */
  scope: z.object({ name: z.string() }).nullable(),
  issues: z.array(mirrorIssueSchema),
  relations: z.array(mirrorRelationSchema), labels: z.array(mirrorLabelSchema), states: z.array(mirrorStateSchema),
  syncedAt: z.number().nullable(), error: z.string().nullable(),
});
export type MirrorIssue = z.infer<typeof mirrorIssueSchema>;
export type MirrorRelation = z.infer<typeof mirrorRelationSchema>;
export type MirrorSnapshot = z.infer<typeof mirrorSnapshotSchema>;
export const linearMirrorContract = {
  "linear.snapshot": { input: z.object({ bbProjectId: id }).strict(), output: mirrorSnapshotSchema },
} as const;
