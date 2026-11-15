// The selected BB project's default checkout and its Squadron settings.
// Everything here follows the project the owner chose, never the plugin's cwd.
import { experimental_joinHostPath as joinHostPath } from "@get-bb/plugin-sdk";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseSquadronSettings, type SettingsResult } from "./squadron-settings.js";
import { doctorHostContract } from "./doctor-contract.js";
import { readRouteCapabilities, validateRouteCapabilities, type ProviderModels } from "./model-capabilities.js";
import { detectTracker, type TrackerDetection } from "./tracker-detection.js";

export interface ProjectCheckout {
  hostId: string;
  path: string;
  /** null when docs/agents/squadron.md couldn't be read. */
  settings: SettingsResult | null;
  tracker: TrackerDetection;
  issueTrackerMarkdown: string | null;
  settingsMarkdown: string | null;
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

export async function readTrackerConfiguration(bb: BbPluginApi, source: { hostId: string; path: string }, signal?: AbortSignal) {
  const unavailableFiles: string[] = [];
  const read = async (relativePath: string) => {
    const path = joinHostPath({ rootPath: source.path, relativePath });
    if (!path) return null;
    try {
      const file = await bb.sdk.files.read({ hostId: source.hostId, path, rootPath: source.path, signal });
      return file.contentEncoding === "utf8" ? file.content : null;
    } catch (error) {
      if ((error as { code?: string })?.code !== "ENOENT") unavailableFiles.push(relativePath);
      return null;
    }
  };
  const [issueTrackerMarkdown, settingsMarkdown] = await Promise.all([
    read("docs/agents/issue-tracker.md"), read("docs/agents/squadron.md"),
  ]);
  return { issueTrackerMarkdown, settingsMarkdown, unavailableFiles, tracker: detectTracker(issueTrackerMarkdown, settingsMarkdown) };
}

/** Shared read path for board, Doctor and Start. Only machine-readable Model routes leave the host. */
export async function readResolvedSettings(bb: BbPluginApi, source: { hostId: string; path: string }, config: Awaited<ReturnType<typeof readTrackerConfiguration>>, signal?: AbortSignal) {
  const host = bb.hosts.experimental_client({ contract: doctorHostContract });
  const house = await host.call("readModelRoutes", {}, { hostId: source.hostId, signal, timeoutMs: 15_000 }).catch(() => null);
  const houseRulesMarkdown = house?.markdown ?? null;
  let settings = config.settingsMarkdown === null ? null : parseSquadronSettings(config.settingsMarkdown, config.tracker.kind ?? "linear", houseRulesMarkdown);
  let providerCatalog: ProviderModels[] = [];
  if (settings?.ok) {
    providerCatalog = await readRouteCapabilities(bb, source.hostId, settings.settings, signal).catch(() => []);
    const issues = validateRouteCapabilities(settings.settings, providerCatalog);
    if (issues.length) settings = { ok: false, issues };
  }
  return { settings, houseRulesMarkdown, providerCatalog };
}

/** null when the project has no default source. */
export async function readProjectCheckout(bb: BbPluginApi, projectId: string, signal?: AbortSignal): Promise<ProjectCheckout | null> {
  const source = await selectProjectCheckout(bb, projectId, signal);
  if (!source) return null;
  const config = await readTrackerConfiguration(bb, source, signal);
  const { settings } = await readResolvedSettings(bb, source, config, signal);
  return { hostId: source.hostId, path: source.path, settings, ...config };
}
