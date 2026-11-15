import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { providerFor, type SettingsIssue, type SquadronSettings } from "./squadron-settings.js";

export interface ProviderModels {
  providerId: string;
  models: { id: string; efforts: string[] }[];
  error?: string;
}

/** Exact capabilities on the checkout's host. An unavailable catalogue never supplies a substitute. */
export async function readRouteCapabilities(bb: BbPluginApi, hostId: string, settings: SquadronSettings, signal?: AbortSignal): Promise<ProviderModels[]> {
  const providers = [...new Set(settings.routes.filter((route) => route.providerId).map(providerFor))];
  if (!providers.length) return [];
  const installed = await bb.sdk.providers.list({ hostId, signal }).catch(() => null);
  if (!installed) return providers.map((providerId) => ({ providerId, models: [], error: `Couldn't check provider ${providerId} on this host.` }));
  return Promise.all(providers.map(async (providerId) => {
    if (!installed.some((provider) => provider.id === providerId)) return { providerId, models: [], error: `Unknown provider ${providerId}.` };
    try {
      const result = await bb.sdk.providers.models({ hostId, providerId, preferCached: true, signal });
      if (result.modelLoadError) return { providerId, models: [], error: `Couldn't read models for ${providerId}: ${result.modelLoadError.code}.` };
      return { providerId, models: result.models.map((model) => ({ id: model.id, efforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort) })) };
    } catch { return { providerId, models: [], error: `Couldn't read models for ${providerId}.` }; }
  }));
}

/** Legacy family tables keep their existing behavior; provider routes must be advertised by BB. */
export function validateRouteCapabilities(settings: SquadronSettings, catalog: readonly ProviderModels[]): SettingsIssue[] {
  return settings.routes.flatMap((route): SettingsIssue[] => {
    if (!route.providerId) return [];
    const name = route.role ?? route.label ?? "Worker";
    const provider = catalog.find((entry) => entry.providerId === route.providerId);
    const model = provider?.models.find((entry) => entry.id === route.model);
    const problem = !provider ? `Unknown provider ${route.providerId}.`
      : provider.error ? provider.error
      : !model ? `Unknown model ${route.model} for provider ${route.providerId}.`
      : route.effort !== "default" && !model.efforts.includes(route.effort) ? `Unknown effort ${route.effort} for ${route.providerId}/${route.model}.` : null;
    return problem ? [{ section: "Routes", message: `Route ${name}: ${problem}` }] : [];
  });
}
