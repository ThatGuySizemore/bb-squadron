import { MODEL_ROLES } from "./squadron-settings.js";
import { launchRouteSchema } from "./launch-route.js";
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
  /** Doctor's route view: what each role and label exception launches on. */
  routes: z.array(z.object({
    role: z.enum(MODEL_ROLES), category: z.string().nullable(),
    route: launchRouteSchema.nullable(), problem: z.string().optional(), note: z.string().optional(),
  })).optional(),
  /** The resolved Squadron policy: each setting, its value and where it came from. */
  policy: z.array(z.object({ setting: z.string(), value: z.string(), source: z.enum(["House rules", "default"]) })).optional(),
});

export const doctorContract = {
  doctor: {
    input: z.object({ projectId: z.string().min(1), environmentId: z.string().min(1).optional() }),
    output: doctorReportSchema,
  },
};

export const doctorHostContract = {
  readModelRoutes: {
    input: z.object({}),
    /** markdown is the Model routes section; policy is the Squadron policy section. Models and effort prose never leaves the host. */
    output: z.object({ markdown: z.string().nullable(), policy: z.string().nullable().optional() }),
    experimental_retryable: true,
  },
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
    output: z.object({ authenticated: z.boolean().nullable(), hostname: z.string().optional() }),
    experimental_retryable: true,
  },
};
