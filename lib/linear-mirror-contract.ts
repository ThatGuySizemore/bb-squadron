import { z } from "zod";

const id = z.string().min(1);
export const mirrorLabelSchema = z.object({ id, name: z.string(), color: z.string() });
export const mirrorStateSchema = z.object({ id, name: z.string(), type: z.string() });
export const linearBindingSchema = z.object({
  bbProjectId: id,
  team: z.object({ id, name: z.string(), key: z.string() }),
  project: z.object({ id, name: z.string() }),
});
export const mirrorIssueSchema = z.object({
  id, identifier: z.string(), title: z.string(), description: z.string().nullable(), url: z.string(),
  updatedAt: z.string(), teamId: id, projectId: id.nullable(), parentId: id.nullable(),
  state: mirrorStateSchema, labels: z.array(mirrorLabelSchema), inProject: z.boolean(),
});
export const mirrorRelationSchema = z.object({ id, type: z.literal("blocks"), issueId: id, relatedIssueId: id });
export const mirrorSnapshotSchema = z.object({
  binding: linearBindingSchema.nullable(), issues: z.array(mirrorIssueSchema),
  relations: z.array(mirrorRelationSchema), labels: z.array(mirrorLabelSchema), states: z.array(mirrorStateSchema),
  syncedAt: z.number().nullable(), error: z.string().nullable(),
});
export type LinearBinding = z.infer<typeof linearBindingSchema>;
export type MirrorIssue = z.infer<typeof mirrorIssueSchema>;
export type MirrorRelation = z.infer<typeof mirrorRelationSchema>;
export type MirrorSnapshot = z.infer<typeof mirrorSnapshotSchema>;
export const bindInputSchema = z.object({ bbProjectId: id, teamId: id, projectId: id }).strict();
export const mirrorCatalogSchema = z.object({
  teams: z.array(z.object({ id, name: z.string(), key: z.string() })),
  projects: z.array(z.object({ id, name: z.string(), teamIds: z.array(id) })),
});
export type MirrorCatalog = z.infer<typeof mirrorCatalogSchema>;
export const linearMirrorContract = {
  "linear.catalog": { input: z.null(), output: mirrorCatalogSchema },
  "linear.bind": { input: bindInputSchema, output: mirrorSnapshotSchema },
  "linear.snapshot": { input: z.object({ bbProjectId: id }).strict(), output: mirrorSnapshotSchema },
} as const;
