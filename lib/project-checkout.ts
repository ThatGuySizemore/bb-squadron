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

/** null when the project has no default source. */
export async function readProjectCheckout(bb: BbPluginApi, projectId: string, signal?: AbortSignal): Promise<ProjectCheckout | null> {
  const found = await bb.sdk.projects.get({ projectId, signal });
  const source = found.sources.find((item) => item.isDefault);
  if (!source) return null;
  let settings: SettingsResult | null = null;
  try {
    const path = joinHostPath({ rootPath: source.path, relativePath: "docs/agents/squadron.md" });
    if (path) {
      const file = await bb.sdk.files.read({ hostId: source.hostId, path, rootPath: source.path, signal });
      settings = file.contentEncoding === "utf8" ? parseSquadronSettings(file.content) : null;
    }
  } catch { settings = null; }
  return { hostId: source.hostId, path: source.path, settings };
}
