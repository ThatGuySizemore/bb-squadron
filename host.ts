import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { doctorHostContract } from "./lib/doctor-contract.js";
import { setupFiles } from "./lib/doctor.js";
import { localMarkdownHostContract } from "./lib/local-markdown-contract.js";
import { readLocalMarkdown } from "./lib/local-markdown-host.js";
import { githubHostContract } from "./lib/github-contract.js";
import { githubLogin, readGithub, runGithubCommand, type GithubCommand } from "./lib/github-host.js";
import { repositoryHostContract } from "./lib/repository-contract.js";
import { readRepositoryState } from "./lib/repository-host.js";
import { codexPluginEnabled, MATT_CODEX_PLUGIN, newestVersion } from "./lib/codex-skills.js";

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

/** Directories directly inside `path`, never through a symlink. */
async function directories(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch { return []; }
}

/** Matt's skills enabled in Codex's config.toml, found as regular `<name>/SKILL.md` files in the newest cached version. */
export async function findCodexMattSkills(codexHome: string, names: readonly string[]): Promise<string[]> {
  let config: string;
  try { config = await readFile(join(codexHome, "config.toml"), "utf8"); } catch { return []; }
  if (!codexPluginEnabled(config)) return [];
  const cache = join(codexHome, "plugins/cache", MATT_CODEX_PLUGIN.marketplace, MATT_CODEX_PLUGIN.name);
  const version = newestVersion(await directories(cache));
  if (!version) return [];
  const found = new Set<string>();
  // Skills sit in category folders, such as skills/engineering/tdd/SKILL.md.
  async function visit(dir: string, depth: number): Promise<void> {
    for (const name of await directories(dir)) {
      const path = join(dir, name);
      if (names.includes(name) && await regularSkillFile(join(path, "SKILL.md"))) found.add(name);
      else if (depth < 3) await visit(path, depth + 1);
    }
  }
  await visit(join(cache, version, "skills"), 1);
  return names.filter((name) => found.has(name));
}

export function createDoctorHost(checkLogin: ((signal: AbortSignal, checkoutPath?: string) => Promise<{ authenticated: boolean; hostname?: string }>) | undefined = undefined, home: () => string = homedir, commands: GithubCommand = runGithubCommand,
  codexHome: () => string = () => process.env.CODEX_HOME || join(home(), ".codex")) {
  return experimental_defineHostEntry({
    contract: { ...doctorHostContract, ...githubHostContract, ...localMarkdownHostContract, ...repositoryHostContract },
    handlers: {
      readRepositoryState: (input, { signal }) => readRepositoryState(input, signal),
      readLocalMarkdown: (input, { signal }) => readLocalMarkdown(input, signal),
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
      codexMattSkills: async ({ names }) => ({ skills: await findCodexMattSkills(codexHome(), names) }),
      githubRead: (input, { signal }) => readGithub(input, signal, commands),
      githubLogin: async ({ checkoutPath }, { signal }) => {
        try {
          return await (checkLogin ? checkLogin(signal, checkoutPath) : githubLogin(signal, checkoutPath, commands));
        }
        catch { return { authenticated: false }; }
      },
    },
  });
}

export default createDoctorHost();
