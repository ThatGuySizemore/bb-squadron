import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { githubHostContract } from "./github-contract.js";
import { readProjectCheckout } from "./project-checkout.js";
import type { TrackerReader, TrackerSnapshot } from "./tracker-contract.js";

/** No background poller: reads follow requests from the board's watcher. */
export function registerGithubReader(bb: BbPluginApi, options: { now?: () => number } = {}): TrackerReader {
  const host = bb.hosts.experimental_client({ contract: githubHostContract });
  const now = options.now ?? Date.now;
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());
  const cache = new Map<string, { key: string; at: number; value: TrackerSnapshot; pending?: Promise<TrackerSnapshot> }>();
  async function getSnapshot(bbProjectId: string): Promise<TrackerSnapshot> {
    const empty: TrackerSnapshot = { kind: "github", bbProjectId, project: null, issues: [], relations: [], labels: [], states: [], syncedAt: null, error: null };
    const checkout = await readProjectCheckout(bb, bbProjectId).catch(() => null);
    if (!checkout) return { ...(cache.get(bbProjectId)?.value ?? empty), error: "Choose a checkout for this project's GitHub issues." };
    const key = `${checkout.hostId}\n${checkout.path}`;
    let entry = cache.get(bbProjectId);
    if (entry?.key !== key) { entry = { key, at: -Infinity, value: empty }; cache.set(bbProjectId, entry); }
    if (entry.pending) return entry.pending;
    if (now() - entry.at < 30_000) return entry.value;
    const selected = entry;
    selected.pending = (async () => {
      let value: TrackerSnapshot;
      try { value = await host.call("githubRead", { checkoutPath: checkout.path, bbProjectId },
        { hostId: checkout.hostId, signal: lifetime.signal, timeoutMs: 90_000 }); }
      catch { value = { ...empty, error: "Couldn't read GitHub issues. Check this repo's machine and gh login, then try again." }; }
      selected.at = now();
      selected.value = value.error ? { ...selected.value, error: value.error } : value;
      return selected.value;
    })().finally(() => { selected.pending = undefined; });
    return selected.pending;
  }
  return { getSnapshot, onChange: () => () => {} };
}
