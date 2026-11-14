import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { MirrorSnapshot } from "./linear-mirror-contract.js";
import { readProjectCheckout } from "./project-checkout.js";
import { trackerContract, type TrackerReader, type TrackerSnapshot } from "./tracker-contract.js";
import { linearTrackerSnapshot } from "./tracker-snapshot.js";

/** Reader selection. GitHub and local readers plug into the same snapshot contract. */
export function registerTracker(bb: BbPluginApi, mirror: {
  getSnapshot(bbProjectId: string): MirrorSnapshot;
  sync?(bbProjectId: string): Promise<MirrorSnapshot>;
  onChange(listener: (bbProjectId: string) => void): () => void;
}): TrackerReader & Required<Pick<TrackerReader, "refresh">> {
  async function detect(bbProjectId: string) {
    return (await readProjectCheckout(bb, bbProjectId))?.tracker ?? {
      kind: null, reason: "Choose a checkout with docs/agents/issue-tracker.md for this project.",
    };
  }
  async function getSnapshot(bbProjectId: string): Promise<TrackerSnapshot> {
    const found = await detect(bbProjectId);
    if (found.kind === "linear") return linearTrackerSnapshot(bbProjectId, mirror.getSnapshot(bbProjectId));
    // The remaining readers are supplied by the next Connect tickets. No Linear
    // connection or binding is requested for a different or unknown tracker.
    return { kind: found.kind, bbProjectId, project: null, issues: [], relations: [], labels: [], states: [],
      syncedAt: null, error: found.kind ? `${found.kind} reader is not available yet.` : found.reason };
  }
  /** A fresh read: a bound Linear project syncs once; other readers read on getSnapshot. */
  async function refresh(bbProjectId: string): Promise<TrackerSnapshot> {
    const found = await detect(bbProjectId);
    if (found.kind === "linear" && mirror.sync && mirror.getSnapshot(bbProjectId).binding) {
      await mirror.sync(bbProjectId).catch(() => undefined); // The snapshot carries the safe error.
    }
    return getSnapshot(bbProjectId);
  }
  bb.rpc.register(trackerContract, {
    "tracker.detect": ({ bbProjectId }) => detect(bbProjectId),
    "tracker.snapshot": ({ bbProjectId }) => getSnapshot(bbProjectId),
  });
  return { getSnapshot, refresh, onChange: mirror.onChange };
}
