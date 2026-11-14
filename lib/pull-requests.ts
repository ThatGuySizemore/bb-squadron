// PR state and checks come only from BB's pull-request plugin, keyed by the
// Lead's environment. Squadron has no GitHub code of its own.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const PULL_REQUEST_PLUGIN = "bb--github-pr-status";

/** The fields Squadron reads from one `pullRequests` row; the plugin returns more. */
export const pullRequestRowSchema = z.union([
  z.object({ outcome: z.literal("available"), pullRequest: z.object({
    number: z.number(), state: z.enum(["draft", "open", "merged", "closed"]), url: z.string(), updatedAt: z.string(),
    checks: z.object({ state: z.enum(["passing", "failing", "pending", "no_checks", "unknown"]) }),
  }) }),
  z.object({ outcome: z.literal("absent") }),
  z.object({ outcome: z.literal("unavailable"), message: z.string() }),
]);
export type PullRequestRow = z.infer<typeof pullRequestRowSchema>;

/** One row per environment. A failed read leaves every lane without a PR until the next pass. */
export async function readPullRequests(bb: BbPluginApi, environmentIds: string[], signal?: AbortSignal): Promise<Record<string, PullRequestRow>> {
  const keys = [...new Set(environmentIds)];
  const rows: Record<string, PullRequestRow> = {};
  for (let i = 0; i < keys.length; i += 200) {
    try {
      Object.assign(rows, await bb.sdk.plugins.callRpc({ pluginId: PULL_REQUEST_PLUGIN, method: "pullRequests",
        input: { keys: keys.slice(i, i + 200) }, outputSchema: z.record(z.string(), pullRequestRowSchema), signal }));
    } catch (error) {
      bb.log.warn(`pull request read failed: ${error instanceof Error ? error.name : "unknown"}`);
    }
  }
  return rows;
}
