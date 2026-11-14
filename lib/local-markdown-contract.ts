import { z } from "zod";
import { trackerSnapshotSchema } from "./tracker-contract.js";

export const localMarkdownHostContract = {
  readLocalMarkdown: {
    input: z.object({ checkoutPath: z.string(), bbProjectId: z.string(), projectName: z.string(), branch: z.string().min(1).optional() }),
    output: trackerSnapshotSchema,
    experimental_retryable: true,
  },
};
