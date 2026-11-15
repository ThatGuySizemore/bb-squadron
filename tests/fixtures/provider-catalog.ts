import type { ProviderModels } from "../../lib/model-capabilities.js";

/** BB capability responses for the models named by the shared test fixtures. Never a production model inventory. */
export const fixtureProviderCatalog: ProviderModels[] = [
  { providerId: "claude-code", models: [
    { id: "claude-opus-5-5", efforts: ["low", "medium", "high", "max"], defaultEffort: "medium" },
    { id: "claude-sonnet-5-5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  ] },
  { providerId: "codex", models: [{ id: "gpt-6.1-sol", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" }] },
];

/** Fake SDK responses at the BB boundary; tests can override either method to exercise refusals. */
export const fixtureProviders = {
  list: async () => fixtureProviderCatalog.map(({ providerId }) => ({ id: providerId })),
  models: async (args?: { providerId?: string }) => ({ modelLoadError: null,
    models: (fixtureProviderCatalog.find(({ providerId }) => providerId === args?.providerId)?.models ?? []).map((model) => ({
      id: model.id, defaultReasoningEffort: model.defaultEffort,
      supportedReasoningEfforts: model.efforts.map((reasoningEffort) => ({ reasoningEffort })),
    })),
  }),
};
