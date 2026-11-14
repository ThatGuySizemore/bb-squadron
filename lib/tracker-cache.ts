import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TrackerReader, TrackerSnapshot } from "./tracker-contract.js";

/** Shared request cache for host readers. Tracker parsing stays in each host implementation. */
export function cachedTrackerReader(bb: BbPluginApi, options: {
  kind: "github" | "local-markdown";
  now?: () => number;
  unavailable: string;
  read(input: { hostId: string; checkoutPath: string; bbProjectId: string; projectName: string }, signal: AbortSignal): Promise<TrackerSnapshot>;
}): TrackerReader {
  const now = options.now ?? Date.now;
  const lifetime = new AbortController();
  const listeners = new Set<(projectId: string) => void>();
  const cache = new Map<string, { key: string; at: number; value: TrackerSnapshot; pending?: Promise<TrackerSnapshot> }>();
  bb.onDispose(() => { lifetime.abort(); listeners.clear(); });
  return {
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async getSnapshot(bbProjectId) {
      const empty: TrackerSnapshot = { kind: options.kind, bbProjectId, project: null,
        issues: [], relations: [], labels: [], states: [], syncedAt: null, error: null };
      // Both host readers use exactly the project's default checkout, never the plugin's cwd.
      const project = await bb.sdk.projects.get({ projectId: bbProjectId, signal: lifetime.signal }).catch(() => null);
      const source = project?.sources.find((item) => item.isDefault);
      if (!source?.hostId || !source.path) return { ...(cache.get(bbProjectId)?.value ?? empty), error: options.unavailable };
      const key = JSON.stringify([source.hostId, source.path, project!.name]);
      let entry = cache.get(bbProjectId);
      if (entry?.key !== key) {
        entry = { key, at: -Infinity, value: empty };
        cache.set(bbProjectId, entry);
      }
      if (entry.pending) return entry.pending;
      if (now() - entry.at < 30_000) return entry.value;
      const selected = entry;
      selected.pending = (async () => {
        try {
          const value = await options.read({ hostId: source.hostId!, checkoutPath: source.path!, bbProjectId, projectName: project!.name }, lifetime.signal);
          selected.value = value.error ? { ...selected.value, error: value.error } : value;
        } catch { selected.value = { ...selected.value, error: options.unavailable }; }
        selected.at = now();
        for (const listener of listeners) listener(bbProjectId);
        return selected.value;
      })().finally(() => { selected.pending = undefined; });
      return selected.pending;
    },
  };
}
