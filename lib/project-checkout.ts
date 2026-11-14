// The selected BB project's default checkout and its Squadron settings.
// Everything here follows the project the owner chose, never the plugin's cwd.
import { experimental_joinHostPath as joinHostPath } from "@get-bb/plugin-sdk";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseSquadronSettings, type SettingsResult } from "./squadron-settings.js";

export interface ProjectCheckout {
  hostId: string;
  path: string;
  /** null when docs/agents/squadron.md couldn't be read. */
  settings: SettingsResult | null;
}

/** Doctor may explicitly select an environment. An unusable explicit choice
 * never falls back to the default source used by board and planning. */
export async function selectProjectCheckout(bb: BbPluginApi, projectId: string, signal?: AbortSignal, environmentId?: string): Promise<{ hostId: string; path: string } | null> {
  const found = await bb.sdk.projects.get({ projectId, signal });
  if (environmentId) {
    const environment = await bb.sdk.environments.get({ environmentId, signal });
    if (environment.projectId !== projectId) throw new Error("Choose an environment in this project.");
    return environment.status === "ready" && environment.path && environment.hostId
      ? { hostId: environment.hostId, path: environment.path } : null;
  }
  const source = found.sources.find((item) => item.isDefault);
  return source?.hostId && source.path ? { hostId: source.hostId, path: source.path } : null;
}

export function squadronSettingsPath(path: string): string | null {
  return joinHostPath({ rootPath: path, relativePath: "docs/agents/squadron.md" });
}

/** null when the project has no default source. */
export async function readProjectCheckout(bb: BbPluginApi, projectId: string, signal?: AbortSignal): Promise<ProjectCheckout | null> {
  const source = await selectProjectCheckout(bb, projectId, signal);
  if (!source) return null;
  let settings: SettingsResult | null = null;
  try {
    const path = squadronSettingsPath(source.path);
    if (path) {
      const file = await bb.sdk.files.read({ hostId: source.hostId, path, rootPath: source.path, signal });
      settings = file.contentEncoding === "utf8" ? parseSquadronSettings(file.content) : null;
    }
  } catch { settings = null; }
  return { hostId: source.hostId, path: source.path, settings };
}
