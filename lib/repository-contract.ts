import { z } from "zod";

export const repositoryStateSchema = z.object({
  hasRemote: z.boolean(),
  mainUpdatedAt: z.number().nullable(),
  mergedBranches: z.array(z.string()),
});
export type RepositoryState = z.infer<typeof repositoryStateSchema>;

/** Read-only Git facts from the selected checkout. Remote URLs never leave the host. */
export const repositoryHostContract = {
  readRepositoryState: {
    input: z.object({ checkoutPath: z.string(), branches: z.array(z.string()).default([]) }),
    output: repositoryStateSchema,
    experimental_retryable: true,
  },
};
