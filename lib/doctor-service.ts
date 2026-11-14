import { experimental_joinHostPath as joinHostPath } from "@get-bb/plugin-sdk";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { doctor, type ConfigurationFile } from "./doctor.js";
import { doctorContract, doctorHostContract } from "./doctor-contract.js";
import { readTrackerConfiguration, selectProjectCheckout, squadronSettingsPath } from "./project-checkout.js";
import type { Family } from "./board-model.js";

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

export function registerDoctor(bb: BbPluginApi, getLinearState: () => Promise<{ status: string }>) {
  const host = bb.hosts.experimental_client({ contract: doctorHostContract });
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
    const [skills, linear, github] = await Promise.allSettled([
      bb.sdk.skills.list({ projectId, environmentId: environmentId ?? null, signal }),
      config.tracker.kind === "linear" ? getLinearState() : Promise.resolve({ status: "not-needed" }),
      host.call("githubLogin", {}, { hostId, signal, timeoutMs: 15_000 }),
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
    const configurationFiles: ConfigurationFile[] = [
      { id: "repo-rules", name: "Repo rules", path: joinHostPath({ rootPath: path, relativePath: "AGENTS.md" })!, hostId, exists: inspection?.repoRulesExists ?? false },
      { id: "project-settings", name: "Project settings", path: settingsPath, hostId, exists: config.settingsMarkdown !== null },
    ];
    if (inspection) {
      configurationFiles.push(
        { id: "playbook", name: "Playbook", path: joinHostPath({ rootPath: inspection.homePath, relativePath: ".bb-squadron/playbook.md" })!, hostId, exists: inspection.playbookExists },
        { id: "machine-profile", name: "Machine profile", path: joinHostPath({ rootPath: inspection.homePath, relativePath: ".bb-squadron/machine.md" })!, hostId, exists: inspection.machineProfileExists },
      );
    }
    const report = doctor({
      skills: installed, setupFiles: inspection?.setupFiles ?? [], configurationFiles,
      settingsMarkdown: config.settingsMarkdown, issueTrackerMarkdown: config.issueTrackerMarkdown,
      linearConnected: linear.status === "fulfilled" && linear.value.status === "connected",
      ghAuthenticated: github.status === "fulfilled" && github.value.authenticated,
    });
    if (skills.status === "rejected" || !inspection) report.checks[0].message = "Couldn't check this repo's installed plugins. Make sure its machine is online, then check again.";
    if (config.settingsMarkdown === null) report.checks[2].message = "docs/agents/squadron.md is missing or unreadable. Press Set up to write it with a thread, or make sure this repo's machine is online, then check again.";
    return report;
  }
  bb.rpc.register(doctorContract, { doctor: ({ projectId, environmentId }, context) => read(projectId, context.experimental_signal, environmentId) });
  return { read };
}
