import { z } from "zod";
import { trackerSnapshotSchema } from "./tracker-contract.js";

export const localMarkdownHostContract = {
  readLocalMarkdown: {
    input: z.object({ checkoutPath: z.string(), bbProjectId: z.string(), projectName: z.string() }),
    output: trackerSnapshotSchema,
    experimental_retryable: true,
  },
};
