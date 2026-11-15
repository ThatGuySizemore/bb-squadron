import { z } from "zod";

/** Read-only Git facts about one worker's worktree, for Clean up after landing. */
export const worktreeStateSchema = z.object({
  /** No uncommitted changes, untracked files included. */
  clean: z.boolean(),
  /** HEAD is contained in a remote-tracking branch. */
  pushed: z.boolean(),
});
export const worktreeHostContract = {
  readWorktreeState: {
    input: z.object({ worktreePath: z.string().min(1) }),
    output: worktreeStateSchema,
    experimental_retryable: true,
  },
};
