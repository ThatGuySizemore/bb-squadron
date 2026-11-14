import { z } from "zod";
import { boardSchema } from "./board-model.js";
import { trackerKindSchema } from "./tracker-contract.js";
export { boardSchema } from "./board-model.js";

export const pickerProjectsSchema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  /** The owner's last pick, while that project still exists. */
  lastPick: z.string().nullable(),
});
export const projectCountsSchema = z.object({
  projects: z.array(z.object({
    id: z.string(), tracker: trackerKindSchema.nullable(),
    /** null while the tracker can't be read; note then says why. */
    ready: z.number().int().nonnegative().nullable(), flying: z.number().int().nonnegative().nullable(),
    note: z.string().nullable(),
  })),
});
export type PickerProjects = z.infer<typeof pickerProjectsSchema>;
export type ProjectCounts = z.infer<typeof projectCountsSchema>;

/** The board page reads one BB project's board; `board-changed` says when to read again.
 * The picker lists every BB project; its counts load in one call when it opens. */
export const boardContract = {
  board: { input: z.object({ projectId: z.string().min(1), visibleLaneIds: z.array(z.string()).optional(), refreshLive: z.boolean().optional() }).strict(), output: boardSchema },
  "board.projects": { input: z.null(), output: pickerProjectsSchema },
  "board.projectCounts": { input: z.null(), output: projectCountsSchema },
  "board.pick": { input: z.object({ projectId: z.string().min(1).max(256) }).strict(), output: z.object({ projectId: z.string() }) },
} as const;

export { BOARD_CHANGED, type BoardChanged } from "./realtime-contract.js";
