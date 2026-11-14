import { execFile, spawn } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { workerHostContract } from "./lib/worker-contract.js";
import { doctorHostContract } from "./lib/doctor-contract.js";

/** Discard command output. Neither tokens nor gh diagnostics cross the host boundary. */
async function githubLogin(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("gh", ["auth", "status"], {
      shell: false, stdio: "ignore", signal, timeout: 10_000,
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

/** Git output is restricted to commit IDs. Raw diagnostics never cross the host. */
async function verifyWorkerCommit(input: { path: string; branch: string; commit: string; integrationBranch?: string }, signal: AbortSignal) {
  const git = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
    execFile("git", ["-C", input.path, ...args], { signal, timeout: 10_000, maxBuffer: 4096, encoding: "utf8" },
      (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  });
  const ref = (branch: string) => `refs/heads/${branch}`;
  try {
    await git(["check-ref-format", ref(input.branch)]);
    const workerHead = await git(["rev-parse", "--verify", `${ref(input.branch)}^{commit}`]);
    if (workerHead !== input.commit) return { verified: false, head: null };
    let head = workerHead;
    if (input.integrationBranch) {
      await git(["check-ref-format", ref(input.integrationBranch)]);
      head = await git(["rev-parse", "--verify", `${ref(input.integrationBranch)}^{commit}`]);
      await git(["merge-base", "--is-ancestor", input.commit, head]);
      if (await git(["rev-parse", "--verify", `${ref(input.integrationBranch)}^{commit}`]) !== head) return { verified: false, head: null };
    }
    if (await git(["rev-parse", "--verify", `${ref(input.branch)}^{commit}`]) !== workerHead) return { verified: false, head: null };
    return { verified: true, head };
  } catch { return { verified: false, head: null }; }
}

export function createDoctorHost(checkLogin: (signal: AbortSignal) => Promise<boolean> = githubLogin) {
  return experimental_defineHostEntry({
    contract: { ...doctorHostContract, ...workerHostContract },
    handlers: {
      verifyWorkerCommit: async (input, { signal }) => verifyWorkerCommit(input, signal),
      githubLogin: async (_input, { signal }) => {
        try { return { authenticated: await checkLogin(signal) }; }
        catch { return { authenticated: false }; }
      },
    },
  });
}

export default createDoctorHost();
