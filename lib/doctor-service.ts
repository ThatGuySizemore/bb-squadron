import { experimental_joinHostPath as joinHostPath } from "@get-bb/plugin-sdk";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { doctor, requiredSkills, type ConfigurationFile } from "./doctor.js";
import { doctorContract, doctorHostContract } from "./doctor-contract.js";
import { readTrackerConfiguration, readResolvedSettings, selectProjectCheckout, squadronSettingsPath } from "./project-checkout.js";
import type { Family } from "./board-model.js";
import { repositoryHostContract } from "./repository-contract.js";
import { HOUSE_RULES_UNREADABLE, SETTINGS_UNREADABLE } from "./squadron-settings.js";
import { LINEAR_BUDGET_WAIT_MESSAGE } from "./linear-auth.js";

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

export function registerDoctor(bb: BbPluginApi, getLinearState: (projectId: string) => Promise<{ status: string; message?: string }>,
  /** The Linear reader's last Scope problem for a project, if any. */
  linearScopeProblem: (projectId: string) => string | null = () => null) {
  const host = bb.hosts.experimental_client({ contract: doctorHostContract });
  const repository = bb.hosts.experimental_client({ contract: repositoryHostContract });
  async function read(projectId: string, signal?: AbortSignal, environmentId?: string) {
    let checkoutUnavailable = false;
    const checkout = await selectProjectCheckout(bb, projectId, signal, environmentId).catch(() => { checkoutUnavailable = true; return null; });
    if (!checkout) {
      const report = doctor({ skills: {}, setupFiles: [], configurationFiles: [], settingsMarkdown: null, issueTrackerMarkdown: null, linearConnected: false, ghAuthenticated: false });
      for (const check of report.checks) {
        if (checkoutUnavailable) {
          check.status = "warning";
          check.message = "Couldn't check this project's checkout just now; checking again on the next check.";
          continue;
        }
        if (check.status === "fix" && check.id !== "linear") check.message = "Choose a ready checkout for this project, then check again.";
      }
      return report;
    }
    const { path, hostId } = checkout;
    const settingsPath = squadronSettingsPath(path);
    if (!settingsPath) throw new Error("Choose a repo with an absolute checkout path.");
    const config = await readTrackerConfiguration(bb, checkout, signal);
    const resolved = await readResolvedSettings(bb, checkout, config, signal);
    const localOnly = config.tracker.kind === "local-markdown" && await repository.call("readRepositoryState",
      { checkoutPath: path, branches: [] }, { hostId, signal, timeoutMs: 15_000 }).then((state) => !state.hasRemote).catch(() => false);
    const [skills, linear, github] = await Promise.allSettled([
      bb.sdk.skills.list({ projectId, environmentId: environmentId ?? null, signal }),
      config.tracker.kind === "linear" ? getLinearState(projectId) : Promise.resolve({ status: "not-needed", message: undefined }),
      localOnly ? Promise.resolve({ authenticated: false, hostname: undefined })
        : host.call("githubLogin", { checkoutPath: path }, { hostId, signal, timeoutMs: 15_000 }),
    ]);
    const candidates = skills.status === "fulfilled" ? skills.value.skills.flatMap((skill) => {
      const found = mattSkill(skill);
      return found ? [found] : [];
    }) : [];
    const inspection = await host.call("inspectFiles", { checkoutPath: path, skillPaths: candidates.map((skill) => skill.path) }, { hostId, signal, timeoutMs: 15_000 }).catch(() => null);
    const installed: Partial<Record<Family, string[]>> = {};
    let skillsUnavailable = skills.status === "rejected" || !inspection;
    for (const skill of candidates) {
      if (inspection?.regularSkillFiles.includes(skill.path)) (installed[skill.family] ??= []).push(skill.name);
    }
    // BB's catalogue omits Codex's Matt plugin (it ships no .codex-plugin/); ask Codex's own config and cache.
    if (skills.status === "fulfilled" && !candidates.some((skill) => skill.family === "gpt")) {
      const codex = await host.call("codexMattSkills", { names: requiredSkills }, { hostId, signal, timeoutMs: 15_000 }).catch(() => null);
      if (!codex) skillsUnavailable = true;
      if (codex?.skills.length) installed.gpt = codex.skills;
    }
    const configurationFiles: ConfigurationFile[] = [
      { id: "repo-rules", name: "Repo rules", path: joinHostPath({ rootPath: path, relativePath: "AGENTS.md" })!, hostId, exists: inspection?.repoRulesExists ?? false },
      { id: "project-settings", name: "Project settings", path: settingsPath, hostId, exists: config.settingsMarkdown !== null },
    ];
    if (inspection) {
      configurationFiles.push(
        { id: "playbook", name: "House rules", path: joinHostPath({ rootPath: inspection.homePath,
          relativePath: inspection.houseRulesExists || !inspection.playbookExists ? ".bb-squadron/house-rules.md" : ".bb-squadron/playbook.md" })!,
          hostId, exists: inspection.houseRulesExists || inspection.playbookExists },
        { id: "machine-profile", name: "This machine", path: joinHostPath({ rootPath: inspection.homePath, relativePath: ".bb-squadron/machine.md" })!, hostId, exists: inspection.machineProfileExists },
      );
    }
    const report = doctor({
      houseRulesMarkdown: resolved.houseRulesMarkdown, providerCatalog: resolved.providerCatalog,
      skills: installed, setupFiles: inspection?.setupFiles ?? [], configurationFiles,
      legacyHouseRulesExists: inspection?.playbookExists,
      settingsMarkdown: config.settingsMarkdown, issueTrackerMarkdown: config.issueTrackerMarkdown,
      linearConnected: linear.status === "fulfilled" && linear.value.status === "connected",
      linearMessage: linear.status === "fulfilled" && linear.value.message === LINEAR_BUDGET_WAIT_MESSAGE ? linear.value.message : undefined,
      linearScopeProblem: config.tracker.kind === "linear" ? linearScopeProblem(projectId) : null,
      ghAuthenticated: github.status === "fulfilled" && github.value.authenticated === true,
      ghHostname: github.status === "fulfilled" ? github.value.hostname : undefined,
      ghRequired: !localOnly,
    });
    function warn(id: string, message: string) {
      const check = report.checks.find((check) => check.id === id);
      if (check) { check.status = "warning"; check.message = message; report.ready = false; }
    }
    if (skillsUnavailable) warn("skills", "Couldn't check this repo's installed plugins just now; checking again on the next check.");
    if (!inspection) {
      warn("setup", "Couldn't check this repo's setup files just now; checking again on the next check.");
      for (const id of ["playbook", "machine-profile"]) warn(id, "Couldn't check this machine's optional setup files just now; checking again on the next check.");
    }
    if (!localOnly && (github.status === "rejected" || github.value.authenticated === null)) warn("github", "Couldn't reach GitHub just now; checking again on the next check.");
    if (linear.status === "rejected") warn("linear", "Couldn't check Linear just now; checking again on the next check.");
    if (config.settingsMarkdown === null) report.checks[2].message = SETTINGS_UNREADABLE;
    else if (resolved.houseRulesUnreadable) {
      // Unreadable House rules must not pass for absent ones; show no defaulted routes or policy.
      const check = report.checks.find((check) => check.id === "settings");
      if (check) { check.status = "fix"; check.message = HOUSE_RULES_UNREADABLE; }
      report.ready = false;
      delete report.routes;
      delete report.policy;
    }
    if (config.unavailableFiles.includes("docs/agents/squadron.md")) warn("settings", "Couldn't check this repo's project settings just now; checking again on the next check.");
    if (config.unavailableFiles.length && !config.tracker.kind) warn("tracker", "Couldn't check this repo's issue tracker setup just now; checking again on the next check.");
    return report;
  }
  bb.rpc.register(doctorContract, { doctor: ({ projectId, environmentId }, context) => read(projectId, context.experimental_signal, environmentId) });
  return { read };
}
