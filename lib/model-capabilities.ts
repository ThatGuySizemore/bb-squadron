import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Family } from "./board-model.js";
import type { SettingsIssue, SquadronSettings } from "./squadron-settings.js";

export interface ProviderModels {
  providerId: string;
  models: { id: string; efforts: string[]; /** BB's advertised native default effort; absent when BB doesn't report one. */ defaultEffort?: string }[];
  error?: string;
}

/** Exact capabilities on the checkout's host. An unavailable catalogue never supplies a substitute. */
export async function readRouteCapabilities(bb: BbPluginApi, hostId: string, settings: SquadronSettings, signal?: AbortSignal): Promise<ProviderModels[]> {
  const providers = [...new Set(settings.routes.flatMap((route) => capabilityProvider(route) ?? []))];
  if (!providers.length) return [];
  const installed = await bb.sdk.providers.list({ hostId, signal }).catch(() => null);
  if (!installed) return providers.map((providerId) => ({ providerId, models: [], error: `Couldn't check provider ${providerId} on this host.` }));
  return Promise.all(providers.map(async (providerId) => {
    if (!installed.some((provider) => provider.id === providerId)) return { providerId, models: [], error: `Unknown provider ${providerId}.` };
    try {
      const result = await bb.sdk.providers.models({ hostId, providerId, preferCached: true, signal });
      if (result.modelLoadError) return { providerId, models: [], error: `Couldn't read models for ${providerId}: ${result.modelLoadError.code}.` };
      return { providerId, models: result.models.map((model) => ({ id: model.id, efforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
        ...(typeof model.defaultReasoningEffort === "string" && model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}) })) };
    } catch { return { providerId, models: [], error: `Couldn't read models for ${providerId}.` }; }
  }));
}

/** Every configured row must be advertised by BB, including legacy Family aliases. */
export function validateRouteCapabilities(settings: SquadronSettings, catalog: readonly ProviderModels[]): SettingsIssue[] {
  return settings.routes.flatMap((route): SettingsIssue[] => {
    const problem = routeProblem(route, catalog);
    return problem ? [{ section: "Routes", message: `Route ${route.role ?? route.label ?? "Worker"}: ${problem}` }] : [];
  });
}

/** Normalize only for capability lookup; valid legacy resolution objects stay unchanged. */
function capabilityProvider(route: { providerId?: string; family?: Family }): string | null {
  return route.providerId ?? (route.family === "claude" ? "claude-code" : route.family === "gpt" ? "codex" : null);
}

/** Why BB can't run a route on the host, or null. A missing provider never grants a validation bypass. */
export function routeProblem(route: { providerId?: string; family?: Family; model: string; effort: string }, catalog: readonly ProviderModels[]): string | null {
  const providerId = capabilityProvider(route);
  if (!providerId) return `Missing provider or recognized Family alias for model ${route.model}.`;
  const provider = catalog.find((entry) => entry.providerId === providerId);
  const model = provider?.models.find((entry) => entry.id === route.model);
  return !provider ? `Unknown provider ${providerId}.`
    : provider.error ? provider.error
    : !model ? `Unknown model ${route.model} for provider ${providerId}.`
    : route.effort !== "default" && !model.efforts.includes(route.effort) ? `Unknown effort ${route.effort} for ${providerId}/${route.model}.` : null;
}

/**
 * The effort a `default` route runs at: BB's advertised native default for the model, or null when BB doesn't say.
 * Explicit efforts return themselves. Never a substitution; it only reads what BB reports.
 */
export function effectiveEffort(route: { providerId?: string; model: string | null; effort: string }, catalog: readonly ProviderModels[] | undefined): string | null {
  if (route.effort !== "default") return route.effort;
  if (!route.providerId || !route.model) return null;
  return catalog?.find((entry) => entry.providerId === route.providerId)?.models.find((entry) => entry.id === route.model)?.defaultEffort ?? null;
}

/** Said whenever a default-effort route's native default is unknown, so the low-effort limit is never claimed as proved. */
export const DEFAULT_EFFORT_UNPROVED = "BB doesn't report this model's default effort, so the low-effort limit isn't proved for it.";
