import { z } from "zod";

export const trackerKindSchema = z.enum(["linear", "github", "local-markdown"]);
export const trackerLabelSchema = z.object({ id: z.string(), name: z.string(), color: z.string() });
export const trackerStateSchema = z.object({ id: z.string(), name: z.string(), type: z.string() });
export const trackerAssigneeSchema = z.object({ id: z.string(), name: z.string() });
export const trackerIssueSchema = z.object({
  id: z.string(), identifier: z.string(), title: z.string(), description: z.string().nullable(), url: z.string(),
  updatedAt: z.string(), parentId: z.string().nullable(),
  state: trackerStateSchema, labels: z.array(trackerLabelSchema), assignees: z.array(trackerAssigneeSchema),
  /** Membership, including closed issues. External blocker endpoints are false. */
  inProject: z.boolean(),
  /** Repository-relative path for local markdown; absent for hosted trackers. */
  path: z.string().optional(),
});
/** Directed edge: issueId blocks relatedIssueId. Endpoints use issue ids. */
export const trackerRelationSchema = z.object({
  id: z.string(), type: z.literal("blocks"), issueId: z.string(), relatedIssueId: z.string(),
});
export const trackerSnapshotSchema = z.object({
  kind: trackerKindSchema.nullable(),
  bbProjectId: z.string(),
  /** null while a Linear Scope is missing, invalid or not yet read. */
  project: z.object({ name: z.string() }).nullable(),
  issues: z.array(trackerIssueSchema), relations: z.array(trackerRelationSchema),
  labels: z.array(trackerLabelSchema), states: z.array(trackerStateSchema),
  syncedAt: z.number().nullable(), error: z.string().nullable(),
});
export type TrackerIssue = z.infer<typeof trackerIssueSchema>;
export type TrackerSnapshot = z.infer<typeof trackerSnapshotSchema>;
export type TrackerRelation = z.infer<typeof trackerRelationSchema>;

/** Reader implementations may load from a remote host. No write operations. */
export interface TrackerReader {
  getSnapshot(bbProjectId: string): TrackerSnapshot | Promise<TrackerSnapshot>;
  /** Optional fresh read for a project no poller keeps current, such as the
   * picker's counts or a board that starts showing a project. Readers that
   * read on every getSnapshot don't need it. */
  refresh?(bbProjectId: string): Promise<TrackerSnapshot>;
  onChange(listener: (bbProjectId: string) => void): () => void;
}
