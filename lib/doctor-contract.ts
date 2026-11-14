import { z } from "zod";

export const doctorContract = {
  doctor: {
    input: z.object({ projectId: z.string().min(1), environmentId: z.string().min(1).optional() }),
    output: z.object({
      ready: z.boolean(),
      checks: z.array(z.object({
        id: z.enum(["skills", "settings", "linear", "github"]), name: z.string(),
        status: z.enum(["pass", "fix"]), message: z.string(),
      })),
    }),
  },
};

export const doctorHostContract = {
  githubLogin: {
    input: z.object({}),
    output: z.object({ authenticated: z.boolean() }),
    experimental_retryable: true,
  },
};
