import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { MirrorSnapshot } from "./linear-mirror-contract.js";
import { readProjectCheckout } from "./project-checkout.js";
import type { TrackerReader, TrackerSnapshot } from "./tracker-contract.js";
import { registerGithubReader } from "./github-reader.js";
import { linearTrackerSnapshot } from "./tracker-snapshot.js";
import { registerLocalMarkdownReader } from "./local-markdown-reader.js";

/** Reader selection. GitHub and local readers plug into the same snapshot contract. */
export function registerTracker(bb: BbPluginApi, mirror: {
  getSnapshot(bbProjectId: string): MirrorSnapshot;
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
  async function getSnapshot(bbProjectId: string): Promise<TrackerSnapshot> {
    const found = await detect(bbProjectId);
    if (found.kind === "linear") return linearTrackerSnapshot(bbProjectId, mirror.getSnapshot(bbProjectId));
    if (found.kind === "github") return github.getSnapshot(bbProjectId);
    if (found.kind === "local-markdown") return local.getSnapshot(bbProjectId);
    // Unknown trackers expose a configuration error without requesting Linear setup.
    return { kind: found.kind, bbProjectId, project: null, issues: [], relations: [], labels: [], states: [],
      syncedAt: null, error: found.reason };
  }
  /** A fresh read: a bound Linear project syncs once; other readers read on getSnapshot. */
  async function refresh(bbProjectId: string): Promise<TrackerSnapshot> {
    const found = await detect(bbProjectId);
    if (found.kind === "linear" && mirror.sync && mirror.getSnapshot(bbProjectId).binding) {
      await mirror.sync(bbProjectId).catch(() => undefined); // The snapshot carries the safe error.
    }
    return getSnapshot(bbProjectId);
  }
  return { getSnapshot, refresh, onChange(listener) {
    const unsubscribes = [mirror.onChange(listener), github.onChange(listener), local.onChange(listener)];
    return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
  } };
}
