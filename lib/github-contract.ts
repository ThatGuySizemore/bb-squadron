import { z } from "zod";
import { trackerSnapshotSchema } from "./tracker-contract.js";

export const githubHostContract = {
  githubRead: {
    input: z.object({ checkoutPath: z.string().min(1), bbProjectId: z.string().min(1) }),
    output: trackerSnapshotSchema,
    experimental_retryable: true,
  },
};
