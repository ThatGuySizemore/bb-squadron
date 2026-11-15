import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { MirrorSnapshot } from "./linear-mirror-contract.js";
import { readProjectCheckout } from "./project-checkout.js";
import { z } from "zod";
import { LINEAR_QUERIES } from "./linear-queries.js";
import { mirrorLabelSchema } from "./linear-mirror-contract.js";
import { LinearRequestError, type LinearAuth } from "./linear-auth.js";
import type { TrackerLabel, TrackerReader, TrackerSnapshot } from "./tracker-contract.js";
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
}, linear?: Pick<LinearAuth, "graphql">): TrackerReader & Required<Pick<TrackerReader, "refresh">> {
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
  const labelsPage = z.object({ issue: z.object({ labels: z.object({
    nodes: z.array(mirrorLabelSchema), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) }) }) });
  /** A Linear ticket's labels, read by ID. GitHub and local readers read fresh on every getSnapshot, so they have no separate read. */
  async function readTicketLabels(bbProjectId: string, ticket: { id: string }): Promise<TrackerLabel[]> {
    const found = await detect(bbProjectId);
    if (found.kind !== "linear") {
      // GitHub and local readers keep a 30 s reading and hold the old issues when a read fails: read again, and reject on any error.
      const reader = found.kind === "github" ? github : local;
      const snapshot = await (reader.refresh?.(bbProjectId) ?? reader.getSnapshot(bbProjectId));
      if (snapshot.error) throw new Error(snapshot.error);
      const issue = snapshot.issues.find((item) => item.id === ticket.id);
      if (!issue) throw new Error("The tracker no longer lists it.");
      return issue.labels;
    }
    if (!linear) throw new LinearRequestError("not_connected");
    const labels: TrackerLabel[] = [];
    const cursors = new Set<string>();
    let after: string | null = null;
    while (true) {
      const page: z.infer<typeof labelsPage> = labelsPage.parse(await linear.graphql(LINEAR_QUERIES.issueLabels, { id: ticket.id, after }));
      labels.push(...page.issue.labels.nodes);
      const cursor: string | null = page.issue.labels.pageInfo.endCursor;
      if (!page.issue.labels.pageInfo.hasNextPage) return labels;
      if (!cursor || cursors.has(cursor)) throw new LinearRequestError("invalid_response");
      cursors.add(cursor); after = cursor;
    }
  }
  return { getSnapshot, cachedSnapshot, refresh, readTicketLabels, onChange(listener) {
    const unsubscribes = [mirror.onChange(listener), github.onChange(listener), local.onChange(listener)];
    return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
  } };
}
