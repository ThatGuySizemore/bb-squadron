import { lstat, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { doctorHostContract } from "./lib/doctor-contract.js";
import { setupFiles } from "./lib/doctor.js";
import { localMarkdownHostContract } from "./lib/local-markdown-contract.js";
import { readLocalMarkdown } from "./lib/local-markdown-host.js";
import { githubHostContract } from "./lib/github-contract.js";
import { githubLogin, readGithub, runGithubCommand, type GithubCommand } from "./lib/github-host.js";

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

export function createDoctorHost(checkLogin: ((signal: AbortSignal, checkoutPath?: string) => Promise<boolean | { authenticated: boolean; hostname?: string }>) | undefined = undefined, home: () => string = homedir, commands: GithubCommand = runGithubCommand) {
  return experimental_defineHostEntry({
    contract: { ...doctorHostContract, ...githubHostContract, ...localMarkdownHostContract },
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
      githubRead: (input, { signal }) => readGithub(input, signal, commands),
      githubLogin: async ({ checkoutPath }, { signal }) => {
        try {
          const result = await (checkLogin ? checkLogin(signal, checkoutPath) : githubLogin(signal, checkoutPath, commands));
          return typeof result === "boolean" ? { authenticated: result } : result;
        }
        catch { return { authenticated: false }; }
      },
    },
  });
}

export default createDoctorHost();
