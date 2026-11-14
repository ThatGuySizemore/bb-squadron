import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepositoryState } from "./repository-contract.js";

const exec = promisify(execFile);
/** Arguments are passed directly to Git. No shell or remote operation is used. */
export async function readGit(checkoutPath: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await exec("git", args, { cwd: checkoutPath, signal, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}

export async function readRepositoryState(input: { checkoutPath: string; branches: string[] }, signal?: AbortSignal): Promise<RepositoryState> {
  const git = (args: string[]) => readGit(input.checkoutPath, args, signal);
  // A failed repository read is unknown, never evidence that there is no remote.
  const hasRemote = (await git(["remote"])).trim().length > 0;
  const main = await git(["rev-parse", "--verify", "refs/heads/main^{commit}"]).then((s) => s.trim()).catch(() => null);
  if (!main) return { hasRemote, mainUpdatedAt: null, mergedBranches: [] };
  const mainUpdatedAt = Number((await git(["show", "-s", "--format=%ct", main])).trim()) * 1000;
  const mergedBranches: string[] = [];
  for (const branch of [...new Set(input.branches)].filter(Boolean)) {
    const tip = await git(["rev-parse", "--verify", "--end-of-options", `${branch}^{commit}`]).then((s) => s.trim()).catch(() => null);
    if (tip && await git(["merge-base", "--is-ancestor", tip, main]).then(() => true).catch(() => false)) mergedBranches.push(branch);
  }
  return { hasRemote, mainUpdatedAt, mergedBranches };
}
