import { z } from "zod";

export const doctorReportSchema = z.object({
  ready: z.boolean(),
  checks: z.array(z.object({
    id: z.enum(["skills", "setup", "settings", "linear", "github", "playbook", "machine-profile", "tracker"]), name: z.string(),
    status: z.enum(["pass", "fix", "warning"]), message: z.string(),
  })),
  configurationFiles: z.array(z.object({
    id: z.enum(["repo-rules", "project-settings", "playbook", "machine-profile"]),
    name: z.string(), path: z.string(), hostId: z.string(), exists: z.boolean(),
  })),
});

export const doctorContract = {
  doctor: {
    input: z.object({ projectId: z.string().min(1), environmentId: z.string().min(1).optional() }),
    output: doctorReportSchema,
  },
};

export const doctorHostContract = {
  inspectFiles: {
    input: z.object({ checkoutPath: z.string(), skillPaths: z.array(z.string()) }),
    output: z.object({
      homePath: z.string(), repoRulesExists: z.boolean(), houseRulesExists: z.boolean().default(false), playbookExists: z.boolean(), machineProfileExists: z.boolean(),
      setupFiles: z.array(z.string()), regularSkillFiles: z.array(z.string()),
    }),
    experimental_retryable: true,
  },
  /** Matt's skills Codex has enabled as a plugin, found as regular files in Codex's plugin cache. */
  codexMattSkills: {
    input: z.object({ names: z.array(z.string()) }),
    output: z.object({ skills: z.array(z.string()) }),
    experimental_retryable: true,
  },
  githubLogin: {
    input: z.object({ checkoutPath: z.string().optional() }),
    output: z.object({ authenticated: z.boolean(), hostname: z.string().optional() }),
    experimental_retryable: true,
  },
};
