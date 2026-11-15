import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { MirrorSnapshot } from "./linear-mirror-contract.js";
import { readProjectCheckout } from "./project-checkout.js";
import type { TrackerReader, TrackerSnapshot } from "./tracker-contract.js";
import { registerGithubReader } from "./github-reader.js";
import { linearTrackerSnapshot } from "./tracker-snapshot.js";
import { registerLocalMarkdownReader } from "./local-markdown-reader.js";
import { recentLinearReading } from "./linear-reading.js";

/** Reader selection. GitHub and local readers plug into the same snapshot contract. */
export function registerTracker(bb: BbPluginApi, mirror: {
  getSnapshot(bbProjectId: string): MirrorSnapshot;
  load?(bbProjectId: string): Promise<void>;
  sync?(bbProjectId: string): Promise<MirrorSnapshot>;
  onChange(listener: (bbProjectId: string) => void): () => void;
}): TrackerReader & Required<Pick<TrackerReader, "refresh">> {
  const github = registerGithubReader(bb);
  const local = registerLocalMarkdownReader(bb);
  async function detect(bbProjectId: string) {
    return (await readProjectCheckout(bb, bbProjectId))?.tracker ?? {
      kind: null, reason: "Choose a checkout with docs/agents/issue-tracker.md for this project.",
    };
  }
  /** Linear projects read at least once by this plugin run. */
  const read = new Set<string>();
  const attemptedAt = new Map<string, number>();
  async function cachedSnapshot(bbProjectId: string): Promise<TrackerSnapshot | null> {
    if ((await detect(bbProjectId)).kind !== "linear") return null;
    await mirror.load?.(bbProjectId);
    const snapshot = mirror.getSnapshot(bbProjectId);
    return snapshot.syncedAt === null ? null : linearTrackerSnapshot(bbProjectId, snapshot);
  }
  async function getSnapshot(bbProjectId: string): Promise<TrackerSnapshot> {
    const found = await detect(bbProjectId);
    if (found.kind === "linear") {
      await mirror.load?.(bbProjectId);
      // A project nothing has read yet (Plan or Start before any board) reads once first.
      const cached = mirror.getSnapshot(bbProjectId);
      const expired = cached.syncedAt !== null && !recentLinearReading(cached.syncedAt, Date.now());
      if (mirror.sync && (!read.has(bbProjectId) || expired && Date.now() - (attemptedAt.get(bbProjectId) ?? -Infinity) >= 30_000)) {
        const pending = syncLinear(bbProjectId);
        if (mirror.getSnapshot(bbProjectId).syncedAt === null) await pending;
      }
      return linearTrackerSnapshot(bbProjectId, mirror.getSnapshot(bbProjectId));
    }
    if (found.kind === "github") return github.getSnapshot(bbProjectId);
    if (found.kind === "local-markdown") return local.getSnapshot(bbProjectId);
    // Unknown trackers expose a configuration error without requesting Linear setup.
    return { kind: found.kind, bbProjectId, project: null, issues: [], relations: [], labels: [], states: [],
      syncedAt: null, error: found.reason };
  }
  /** A fresh read: a Linear project syncs once with its Scope; other readers read on getSnapshot. */
  async function refresh(bbProjectId: string): Promise<TrackerSnapshot> {
    const found = await detect(bbProjectId);
    if (found.kind === "linear" && mirror.sync) await syncLinear(bbProjectId);
    return getSnapshot(bbProjectId);
  }
  async function syncLinear(bbProjectId: string) {
    read.add(bbProjectId);
    attemptedAt.set(bbProjectId, Date.now());
    await mirror.sync!(bbProjectId).catch(() => undefined); // The snapshot carries the safe error.
  }
  return { getSnapshot, cachedSnapshot, refresh, onChange(listener) {
    const unsubscribes = [mirror.onChange(listener), github.onChange(listener), local.onChange(listener)];
    return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
  } };
}
