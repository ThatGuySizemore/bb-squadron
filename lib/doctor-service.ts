import { experimental_joinHostPath as joinHostPath } from "@get-bb/plugin-sdk";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { doctor, requiredSkills, type ConfigurationFile } from "./doctor.js";
import { doctorContract, doctorHostContract } from "./doctor-contract.js";
import { readTrackerConfiguration, selectProjectCheckout, squadronSettingsPath } from "./project-checkout.js";
import type { Family } from "./board-model.js";
import { repositoryHostContract } from "./repository-contract.js";
import { SETTINGS_UNREADABLE } from "./squadron-settings.js";

function mattSkill(skill: { name: string; pluginId: string | null; scope: string; filePath: string; provider: string | null }): { name: string; family: Family; path: string } | null {
  const prefix = "mattpocock-skills:";
  if (skill.scope !== "plugin" || skill.pluginId !== "mattpocock-skills" || !skill.name.startsWith(prefix)) return null;
  // The catalogue deduplicates shared paths across providers. A native plugin
  // path still identifies its harness even when an ACP provider listed it first.
  const path = skill.filePath.replace(/\\/g, "/");
  const family = path.includes("/.claude/plugins/") ? "claude" : path.includes("/.codex/plugins/") ? "gpt"
    : skill.provider === "claude-code" ? "claude" : skill.provider === "codex" ? "gpt" : null;
  return family ? { name: skill.name.slice(prefix.length), family, path: skill.filePath } : null;
}

export function registerDoctor(bb: BbPluginApi, getLinearState: () => Promise<{ status: string }>,
  /** The Linear reader's last Scope problem for a project, if any. */
  linearScopeProblem: (projectId: string) => string | null = () => null) {
  const host = bb.hosts.experimental_client({ contract: doctorHostContract });
  const repository = bb.hosts.experimental_client({ contract: repositoryHostContract });
  async function read(projectId: string, signal?: AbortSignal, environmentId?: string) {
    const checkout = await selectProjectCheckout(bb, projectId, signal, environmentId).catch(() => null);
    if (!checkout) {
      const report = doctor({ skills: {}, setupFiles: [], configurationFiles: [], settingsMarkdown: null, issueTrackerMarkdown: null, linearConnected: false, ghAuthenticated: false });
      for (const check of report.checks) {
        if (check.status === "fix" && check.id !== "linear") check.message = "Choose a ready checkout for this project, then check again.";
      }
      return report;
    }
    const { path, hostId } = checkout;
    const settingsPath = squadronSettingsPath(path);
    if (!settingsPath) throw new Error("Choose a repo with an absolute checkout path.");
    const config = await readTrackerConfiguration(bb, checkout, signal);
    const localOnly = config.tracker.kind === "local-markdown" && await repository.call("readRepositoryState",
      { checkoutPath: path, branches: [] }, { hostId, signal, timeoutMs: 15_000 }).then((state) => !state.hasRemote).catch(() => false);
    const [skills, linear, github] = await Promise.allSettled([
      bb.sdk.skills.list({ projectId, environmentId: environmentId ?? null, signal }),
      config.tracker.kind === "linear" ? getLinearState() : Promise.resolve({ status: "not-needed" }),
      localOnly ? Promise.resolve({ authenticated: false, hostname: undefined })
        : host.call("githubLogin", { checkoutPath: path }, { hostId, signal, timeoutMs: 15_000 }),
    ]);
    const candidates = skills.status === "fulfilled" ? skills.value.skills.flatMap((skill) => {
      const found = mattSkill(skill);
      return found ? [found] : [];
    }) : [];
    const inspection = await host.call("inspectFiles", { checkoutPath: path, skillPaths: candidates.map((skill) => skill.path) }, { hostId, signal, timeoutMs: 15_000 }).catch(() => null);
    const installed: Partial<Record<Family, string[]>> = {};
    for (const skill of candidates) {
      if (inspection?.regularSkillFiles.includes(skill.path)) (installed[skill.family] ??= []).push(skill.name);
    }
    // BB's catalogue omits Codex's Matt plugin (it ships no .codex-plugin/); ask Codex's own config and cache.
    if (skills.status === "fulfilled" && !candidates.some((skill) => skill.family === "gpt")) {
      const codex = await host.call("codexMattSkills", { names: requiredSkills }, { hostId, signal, timeoutMs: 15_000 }).catch(() => null);
      if (codex?.skills.length) installed.gpt = codex.skills;
    }
    const configurationFiles: ConfigurationFile[] = [
      { id: "repo-rules", name: "Repo rules", path: joinHostPath({ rootPath: path, relativePath: "AGENTS.md" })!, hostId, exists: inspection?.repoRulesExists ?? false },
      { id: "project-settings", name: "Project settings", path: settingsPath, hostId, exists: config.settingsMarkdown !== null },
    ];
    if (inspection) {
      configurationFiles.push(
        { id: "playbook", name: "House rules", path: joinHostPath({ rootPath: inspection.homePath, relativePath: ".bb-squadron/playbook.md" })!, hostId, exists: inspection.playbookExists },
        { id: "machine-profile", name: "This machine", path: joinHostPath({ rootPath: inspection.homePath, relativePath: ".bb-squadron/machine.md" })!, hostId, exists: inspection.machineProfileExists },
      );
    }
    const report = doctor({
      skills: installed, setupFiles: inspection?.setupFiles ?? [], configurationFiles,
      settingsMarkdown: config.settingsMarkdown, issueTrackerMarkdown: config.issueTrackerMarkdown,
      linearConnected: linear.status === "fulfilled" && linear.value.status === "connected",
      linearScopeProblem: config.tracker.kind === "linear" ? linearScopeProblem(projectId) : null,
      ghAuthenticated: github.status === "fulfilled" && github.value.authenticated,
      ghHostname: github.status === "fulfilled" ? github.value.hostname : undefined,
      ghRequired: !localOnly,
    });
    if (skills.status === "rejected" || !inspection) report.checks[0].message = "Couldn't check this repo's installed plugins. Make sure its machine is online, then check again.";
    if (config.settingsMarkdown === null) report.checks[2].message = SETTINGS_UNREADABLE;
    return report;
  }
  bb.rpc.register(doctorContract, { doctor: ({ projectId, environmentId }, context) => read(projectId, context.experimental_signal, environmentId) });
  return { read };
}
