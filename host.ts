import { spawn } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { doctorHostContract } from "./lib/doctor-contract.js";
import { setupFiles } from "./lib/doctor.js";
import { localMarkdownHostContract } from "./lib/local-markdown-contract.js";
import { readLocalMarkdown } from "./lib/local-markdown-host.js";

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

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function regularSkillFile(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  try {
    if (!(await lstat(path)).isFile()) return false;
    let part = resolve(path);
    while (true) {
      if ((await lstat(part)).isSymbolicLink()) return false;
      const parent = dirname(part);
      if (parent === part) return true;
      part = parent;
    }
  } catch { return false; }
}

export function createDoctorHost(checkLogin: (signal: AbortSignal) => Promise<boolean> = githubLogin, home: () => string = homedir) {
  return experimental_defineHostEntry({
    contract: { ...doctorHostContract, ...localMarkdownHostContract },
    handlers: {
      readLocalMarkdown: (input) => readLocalMarkdown(input),
      inspectFiles: async ({ checkoutPath, skillPaths }) => {
        const homePath = home();
        const [repoRulesExists, playbookExists, machineProfileExists, setup, skills] = await Promise.all([
          exists(join(checkoutPath, "AGENTS.md")), exists(join(homePath, ".bb-squadron/playbook.md")),
          exists(join(homePath, ".bb-squadron/machine.md")),
          Promise.all(setupFiles.map(async (path) => await exists(join(checkoutPath, path)) ? [path] : [])),
          Promise.all(skillPaths.map(async (path) => await regularSkillFile(path) ? [path] : [])),
        ]);
        return { homePath, repoRulesExists, playbookExists, machineProfileExists, setupFiles: setup.flat(), regularSkillFiles: skills.flat() };
      },
      githubLogin: async (_input, { signal }) => {
        try { return { authenticated: await checkLogin(signal) }; }
        catch { return { authenticated: false }; }
      },
    },
  });
}

export default createDoctorHost();
