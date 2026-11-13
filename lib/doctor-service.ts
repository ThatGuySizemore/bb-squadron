import { experimental_joinHostPath as joinHostPath } from "@get-bb/plugin-sdk";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { doctor } from "./doctor.js";
import { doctorContract, doctorHostContract } from "./doctor-contract.js";

export function registerDoctor(bb: BbPluginApi, getLinearState: () => Promise<{ status: string }>) {
  const host = bb.hosts.experimental_client({ contract: doctorHostContract });
  bb.rpc.register(doctorContract, {
    doctor: async ({ projectId, environmentId }, context) => {
      const signal = context.experimental_signal;
      const project = await bb.sdk.projects.get({ projectId, signal });
      const source = project.sources.find((source) => source.isDefault);
      const environment = environmentId ? await bb.sdk.environments.get({ environmentId, signal }) : null;
      if (environment && environment.projectId !== projectId) throw new Error("Choose an environment in this project.");
      const path = environment ? environment.path : source?.path;
      const hostId = environment ? environment.hostId : source?.hostId;
      if (!path || !hostId || (environment && environment.status !== "ready")) {
        const linear = await getLinearState().catch(() => ({ status: "failed" }));
        const report = doctor({ skills: [], settingsMarkdown: null, linearConnected: linear.status === "connected", ghAuthenticated: false });
        for (const check of report.checks) {
          if (check.id !== "linear") check.message = "Choose a ready checkout for this project, then check again.";
        }
        return report;
      }
      const settingsPath = joinHostPath({ rootPath: path, relativePath: "docs/agents/squadron.md" });
      if (!settingsPath) throw new Error("Choose a repo with an absolute checkout path.");
      const [skills, settings, linear, github] = await Promise.allSettled([
        bb.sdk.skills.list({ projectId, environmentId: environmentId ?? null, signal }),
        bb.sdk.files.read({ hostId, path: settingsPath, rootPath: path, signal }),
        getLinearState(),
        host.call("githubLogin", {}, { hostId, signal, timeoutMs: 15_000 }),
      ]);
      const report = doctor({
        skills: skills.status === "fulfilled" ? skills.value.skills.map((skill) => skill.name.split(":").at(-1)!) : [],
        settingsMarkdown: settings.status === "fulfilled" && settings.value.contentEncoding === "utf8" ? settings.value.content : null,
        linearConnected: linear.status === "fulfilled" && linear.value.status === "connected",
        ghAuthenticated: github.status === "fulfilled" && github.value.authenticated,
      });
      if (skills.status === "rejected") report.checks[0].message = "Couldn't read this repo's skills. Make sure its machine is online, then check again.";
      if (settings.status === "rejected") report.checks[1].message = "Make sure docs/agents/squadron.md exists and this repo's machine is online, then check again.";
      return report;
    },
  });
}
