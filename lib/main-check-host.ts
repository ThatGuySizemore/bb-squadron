import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, open, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { GithubCommand } from "./github-host.js";

const exec = promisify(execFile);
const oid = z.string().regex(/^[a-f0-9]{40,64}$/);

/** Only read the source checkout. Fetches and worktree metadata belong to our own scratch repository. */
export async function runMainQuickCheck(input: { checkoutPath: string; prNumber: number; quickCheck: string; checkSetup?: string }, signal: AbortSignal, commands: GithubCommand) {
  const root = await mkdtemp(join(tmpdir(), "squadron-main-check-"));
  const repository = join(root, "repository.git");
  const worktree = join(root, "worktree");
  const logPath = join(root, "quick-check.log");
  await appendFile(logPath, "Main quick check\n", { mode: 0o600 });
  let mergedCommit: string | null = null;
  let baseCommit: string | null = null;
  let passed = false;
  const git = async (cwd: string, args: string[], abort = signal) => (await exec("git", args, {
    cwd, signal: abort, timeout: 120_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" },
  })).stdout.trim();
  let added = false;
  try {
    const response = await commands("gh", ["pr", "view", String(input.prNumber), "--json", "mergeCommit,baseRefName,state"], { cwd: input.checkoutPath, signal });
    if (response.code) throw new Error("merge unavailable");
    const pr = z.object({ state: z.literal("MERGED"), baseRefName: z.literal("main"), mergeCommit: z.object({ oid }) }).parse(JSON.parse(response.stdout));
    mergedCommit = pr.mergeCommit.oid;
    const remote = await git(input.checkoutPath, ["remote", "get-url", "origin"]);
    await git(root, ["init", "--bare", repository]);
    await git(repository, ["fetch", "--no-tags", "--", remote, "refs/heads/main:refs/heads/main"]);
    await git(repository, ["merge-base", "--is-ancestor", mergedCommit, "refs/heads/main"]);
    baseCommit = oid.parse(await git(repository, ["rev-parse", `${mergedCommit}^1`]));
    await git(repository, ["worktree", "add", "--detach", worktree, mergedCommit]);
    added = true;
    await appendFile(logPath, `Merged main: ${mergedCommit}\nSQUADRON_BASE: ${baseCommit}\n`);
    const log = await open(logPath, "a");
    try {
      const deadline = Date.now() + 30 * 60_000;
      const run = (command: string) => new Promise<boolean>((resolve) => {
        const child = spawn("/bin/sh", ["-c", command], { cwd: worktree, signal, timeout: Math.max(1, deadline - Date.now()),
          env: { ...process.env, SQUADRON_BASE: baseCommit! }, stdio: ["ignore", log.fd, log.fd] });
        let failed = false;
        child.once("error", () => { failed = true; });
        child.once("close", (code) => resolve(!failed && code === 0));
      });
      if (input.checkSetup) await appendFile(logPath, "Check setup\n");
      const prepared = !input.checkSetup || await run(input.checkSetup);
      if (prepared && Date.now() < deadline) {
        await appendFile(logPath, "Quick check\n");
        passed = await run(input.quickCheck);
      }
    } finally { await log.close(); }
  } catch {
    // Setup errors can include remote URLs or authentication output. Keep them on the host.
    await appendFile(logPath, "Couldn't prepare or run the merged main quick check. Check the project's remote main and quick check setup.\n");
  } finally {
    let removed = !added;
    if (added) {
      try { await git(repository, ["worktree", "remove", "--force", worktree], new AbortController().signal); removed = true; }
      catch { passed = false; await appendFile(logPath, "Couldn't remove the scratch worktree.\n"); }
    }
    // This repository was made inside our mkdtemp root; it never shares owner metadata.
    if (removed) {
      await rm(repository, { recursive: true, force: true });
    }
    await appendFile(logPath, passed ? "PASS\n" : "FAIL\n");
  }
  return { passed, logPath, mergedCommit, baseCommit };
}
