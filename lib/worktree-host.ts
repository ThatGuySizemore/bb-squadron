import type { z } from "zod";
import { readGit } from "./repository-host.js";
import type { worktreeStateSchema } from "./worktree-contract.js";

/**
 * Whether a worktree holds anything that exists nowhere else. Read-only Git, no network: a commit counts as pushed
 * only when a remote-tracking branch already contains it. A failed read rejects, and never reads as safe.
 */
export async function readWorktreeState(input: { worktreePath: string }, signal?: AbortSignal): Promise<z.infer<typeof worktreeStateSchema>> {
  const git = (args: string[]) => readGit(input.worktreePath, args, signal);
  const status = await git(["status", "--porcelain", "--untracked-files=all"]);
  const head = (await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const remote = await git(["for-each-ref", "--contains", head, "--format=%(refname)", "refs/remotes/"]);
  return { clean: status.trim() === "", pushed: remote.split("\n").some((ref) => ref.trim() && !ref.endsWith("/HEAD")) };
}
