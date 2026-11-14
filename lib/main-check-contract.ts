import { z } from "zod";

export const mainCheckResultSchema = z.object({
  passed: z.boolean(), logPath: z.string(), mergedCommit: z.string().nullable(), baseCommit: z.string().nullable(),
});
export const mainCheckHostContract = {
  runMainQuickCheck: {
    input: z.object({ checkoutPath: z.string(), prNumber: z.number().int().positive(), quickCheck: z.string().min(1), checkSetup: z.string().min(1).optional() }),
    output: mainCheckResultSchema,
  },
};
