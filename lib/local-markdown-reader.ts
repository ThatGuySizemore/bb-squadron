import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { localMarkdownHostContract } from "./local-markdown-contract.js";
import type { TrackerReader, TrackerSnapshot } from "./tracker-contract.js";

/** The board watcher asks for the selected project's files; reads reuse a 30 s snapshot. */
export function registerLocalMarkdownReader(bb: BbPluginApi, options: { now?: () => number } = {}): TrackerReader {
  const now = options.now ?? Date.now;
  const host = bb.hosts.experimental_client({ contract: localMarkdownHostContract });
  const listeners = new Set<(projectId: string) => void>();
  const projects = new Map<string, { key: string; at: number; snapshot: TrackerSnapshot; reading?: Promise<TrackerSnapshot> }>();
  const lifetime = new AbortController();
  bb.onDispose(() => { lifetime.abort(); listeners.clear(); });
  return {
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async getSnapshot(bbProjectId) {
      const project = await bb.sdk.projects.get({ projectId: bbProjectId, signal: lifetime.signal });
      const source = project.sources.find((item) => item.isDefault);
      const key = `${source?.hostId}|${source?.path}|${project.name}`;
      let entry = projects.get(bbProjectId);
      if (!entry || entry.key !== key) {
        entry = { key, at: -Infinity, snapshot: { kind: "local-markdown", bbProjectId, project: { name: project.name },
          issues: [], relations: [], labels: [], states: [], syncedAt: null, error: null } };
        projects.set(bbProjectId, entry);
      }
      if (entry.reading) return entry.reading;
      if (now() - entry.at < 30_000) return entry.snapshot;
      const current = entry;
      current.at = now();
      current.reading = (async () => {
        try {
          if (!source?.hostId || !source.path) throw new Error("No default checkout");
          const snapshot = await host.call("readLocalMarkdown", { checkoutPath: source.path, bbProjectId, projectName: project.name },
            { hostId: source.hostId, signal: lifetime.signal, timeoutMs: 15_000 });
          current.snapshot = { ...snapshot, syncedAt: now() };
        } catch {
          current.snapshot = { ...current.snapshot,
            error: "Couldn't read this project's local markdown tracker. Make sure its machine and checkout are available." };
        }
        for (const listener of listeners) listener(bbProjectId);
        return current.snapshot;
      })().finally(() => { current.reading = undefined; });
      return current.reading;
    },
  };
}
