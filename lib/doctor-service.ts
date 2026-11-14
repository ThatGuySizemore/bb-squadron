import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { doctor } from "./doctor.js";
import { doctorContract, doctorHostContract } from "./doctor-contract.js";
import { selectProjectCheckout, squadronSettingsPath } from "./project-checkout.js";

function mattSkillName(skill: { name: string; pluginId: string | null; scope: string; filePath: string }): string | null {
  const prefix = "mattpocock-skills:";
  if (skill.scope === "plugin" && skill.pluginId === "mattpocock-skills" && skill.name.startsWith(prefix)) {
    return skill.name.slice(prefix.length);
  }
  // This repo also supports Matt's local .agents/skills installation aliases.
  const path = skill.filePath.replace(/\\/g, "/");
  if (skill.pluginId === null && /^(provider|shared)-(user|project)$/.test(skill.scope)
    && path.endsWith(`/.agents/skills/${skill.name}/SKILL.md`)) return skill.name;
  return null;
}

export function registerDoctor(bb: BbPluginApi, getLinearState: () => Promise<{ status: string }>) {
  const host = bb.hosts.experimental_client({ contract: doctorHostContract });
  async function check(projectId: string, environmentId?: string, signal?: AbortSignal) {
    const checkout = await selectProjectCheckout(bb, projectId, signal, environmentId);
    if (!checkout) {
      const linear = await getLinearState().catch(() => ({ status: "failed" }));
      const report = doctor({ skills: [], settingsMarkdown: null, linearConnected: linear.status === "connected", ghAuthenticated: false });
      for (const check of report.checks) {
        if (check.id !== "linear") check.message = "Choose a ready checkout for this project, then check again.";
      }
      return report;
    }
    const { path, hostId } = checkout;
    const settingsPath = squadronSettingsPath(path);
    if (!settingsPath) throw new Error("Choose a repo with an absolute checkout path.");
    const [skills, settings, linear, github] = await Promise.allSettled([
      bb.sdk.skills.list({ projectId, environmentId: environmentId ?? null, signal }),
      bb.sdk.files.read({ hostId, path: settingsPath, rootPath: path, signal }),
      getLinearState(),
      host.call("githubLogin", {}, { hostId, signal, timeoutMs: 15_000 }),
    ]);
    const report = doctor({
      skills: skills.status === "fulfilled" ? skills.value.skills.flatMap((skill) => {
        const name = mattSkillName(skill);
        return name === null ? [] : [name];
      }) : [],
      settingsMarkdown: settings.status === "fulfilled" && settings.value.contentEncoding === "utf8" ? settings.value.content : null,
      linearConnected: linear.status === "fulfilled" && linear.value.status === "connected",
      ghAuthenticated: github.status === "fulfilled" && github.value.authenticated,
    });
    if (skills.status === "rejected") report.checks[0].message = "Couldn't read this repo's skills. Make sure its machine is online, then check again.";
    if (settings.status === "rejected") report.checks[1].message = "Make sure docs/agents/squadron.md exists and this repo's machine is online, then check again.";
    return report;
  }
  bb.rpc.register(doctorContract, { doctor: async ({ projectId, environmentId }, context) =>
    check(projectId, environmentId, context.experimental_signal) });
  return { check };
}
