// A lane's PR, merge and landing. PR state and checks come only from BB's
// built-in pull-request plugin, read through its public RPC for the Lead's
// environment. The Lead opens and squash-merges the PR with gh; the Helper
// checks the merge, holds accept:owner specs for the owner's click, and moves
// the spec and its tickets to Done through the outbox once the PR has merged.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { laneMergeContract, type LaneRun, type PullRequestObservation } from "./lane-contract.js";
import type { LaneService, LaneSources } from "./lane-service.js";
import { workerHostContract } from "./worker-contract.js";
import { mergeGate, ownerApproved } from "./merge-gate.js";
import { modelDisplayName } from "./linear-outbox.js";
import { signedCommentAvatarUrl } from "./linear-avatar.js";
import { diagnostic } from "./diagnostic.js";
import type { SpecMergeSteps } from "./worker-service.js";

export const PULL_REQUEST_PLUGIN = "bb--github-pr-status";

const pullRequestSchema = z.object({
  number: z.number().int().positive(), title: z.string(), state: z.enum(["draft", "open", "merged", "closed"]), url: z.string(),
  baseRefName: z.string(), headRefName: z.string(),
  checks: z.object({ state: z.enum(["passing", "failing", "pending", "no_checks", "unknown"]) }),
});
const rowSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), pullRequest: pullRequestSchema }),
  z.object({ outcome: z.literal("absent") }),
  z.object({ outcome: z.literal("unavailable"), message: z.string().min(1) }),
]);
const pullRequestsSchema = z.record(z.string(), rowSchema);
export type PullRequestRow = z.infer<typeof rowSchema>;

/** One environment's row from BB's pull-request plugin. A missing plugin, a
 * failed call or a missing row is unavailable, never absent. */
export async function readPullRequest(bb: BbPluginApi, environmentId: string, signal?: AbortSignal): Promise<PullRequestRow> {
  try {
    const rows = await bb.sdk.plugins.callRpc({ pluginId: PULL_REQUEST_PLUGIN, method: "pullRequests", input: { keys: [environmentId] },
      outputSchema: pullRequestsSchema, ...(signal ? { signal } : {}) });
    return rows[environmentId] ?? { outcome: "unavailable", message: "BB's pull-request plugin returned no row for this environment." };
  } catch (error) {
    bb.log.warn(`Pull request read: ${diagnostic(error)}`);
    return { outcome: "unavailable", message: "BB's pull-request plugin couldn't be read." };
  }
}

const CHECKS = { passing: "passing", failing: "failing", pending: "pending", no_checks: "none", unknown: "unknown" } as const;
const MERGED_UNCHECKED = "The PR merged on GitHub without Squadron's merge check. Check it, then cancel the lane or move the spec in Linear.";

export function registerSpecMerge(bb: BbPluginApi, sources: Pick<LaneSources, "mirror" | "outbox">, lanes: LaneService,
  workers: { withLane<T>(laneId: string, action: () => Promise<T>): Promise<T>; setMerge(steps: SpecMergeSteps): void },
  lifecycle: { stopInLane(run: LaneRun, reason: string): Promise<LaneRun> }, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const host = bb.hosts.experimental_client({ contract: workerHostContract });
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());

  function latest(projectId: string, laneId: string): LaneRun {
    const run = lanes.list(projectId).find((item) => item.id === laneId);
    if (!run) throw new Error("This lane no longer exists.");
    return run;
  }
  /** Rebase only merge-owned fields onto the latest record. */
  function saveMerge(run: LaneRun, fields: Partial<LaneRun>, drop: Array<keyof LaneRun> = []): LaneRun {
    const value: LaneRun = { ...latest(run.bbProjectId, run.id), ...fields };
    for (const key of drop) delete value[key];
    if (JSON.stringify(value) !== JSON.stringify(latest(run.bbProjectId, run.id))) lanes.save(value);
    return value;
  }

  /** The integration head, when the local branch and its upstream agree. */
  async function pushedHead(run: LaneRun, signal: AbortSignal): Promise<string | null> {
    try {
      const env = await bb.sdk.environments.get({ environmentId: run.environmentId!, signal });
      if (env.projectId !== run.bbProjectId || (run.hostId && env.hostId !== run.hostId) || env.status !== "ready" || !env.path || env.branchName !== run.branch) return null;
      const heads = await host.call("pushedHead", { path: env.path, branch: run.branch! }, { hostId: env.hostId!, signal, timeoutMs: 15_000 });
      return heads.head && heads.head === heads.upstream ? heads.head : null;
    } catch (error) {
      bb.log.warn(`Lane ${run.id} pushed-head: ${diagnostic(error)}`);
      return null;
    }
  }

  /** Caller holds the lane queue. Saves the plugin's view; lands a merged PR
   * only after the Helper's merge check for that PR. */
  async function observeInLane(run: LaneRun, signal: AbortSignal, refresh = false): Promise<LaneRun> {
    run = latest(run.bbProjectId, run.id);
    if (run.recoveryOnly || run.state !== "flying" || !run.environmentId || !run.branch) return run;
    if (refresh) {
      try {
        await bb.sdk.plugins.callRpc({ pluginId: PULL_REQUEST_PLUGIN, method: "refresh", input: { environmentId: run.environmentId },
          outputSchema: z.object({ ok: z.literal(true) }), signal });
      } catch (error) { bb.log.warn(`Lane ${run.id} pull-request refresh: ${diagnostic(error)}`); }
    }
    const row = await readPullRequest(bb, run.environmentId, signal);
    if (row.outcome === "unavailable") return saveMerge(run, { prUnavailable: row.message });
    if (row.outcome === "absent") return saveMerge(run, {}, ["pr", "prUnavailable"]);
    const value = row.pullRequest;
    // The plugin reports no head commit. Squadron reads the pushed head itself;
    // gh's --match-head-commit makes GitHub refuse a different PR head at merge.
    const head = value.state === "open" && value.headRefName === run.branch && run.specReview?.state === "approved" ? await pushedHead(run, signal) : null;
    const pr: PullRequestObservation = { number: value.number, url: value.url, state: value.state, checks: CHECKS[value.checks.state],
      headRefName: value.headRefName, baseRefName: value.baseRefName, head, observedAt: run.pr?.observedAt ?? 0 };
    // An unchanged read keeps its first observation time, so the board doesn't churn.
    if (JSON.stringify(pr) !== JSON.stringify(run.pr)) pr.observedAt = now();
    run = saveMerge(run, { pr }, ["prUnavailable"]);
    if (value.state !== "merged" || value.headRefName !== run.branch) return run;
    if (run.merge?.number !== value.number || (run.acceptOwner && !(run.ownerMerge?.number === run.merge.number && run.ownerMerge.commit === run.merge.commit))) {
      return lifecycle.stopInLane(run, MERGED_UNCHECKED);
    }
    run = saveMerge(run, { state: "landed", landedAt: now() });
    return queueLandingWrites(run);
  }

  function doneState(run: LaneRun): string {
    const states = sources.mirror.getSnapshot(run.bbProjectId).states.filter((state) => state.type === "completed");
    const named = states.filter((state) => state.name.toLowerCase() === "done");
    const match = named.length === 1 ? named[0] : states.length === 1 ? states[0] : null;
    if (!match) throw new Error("This Linear team needs an unambiguous Done state.");
    return match.id;
  }
  /** Every open ticket and then the spec move to Done, then a signed Lead
   * comment. Stable keys reconcile a retry; receipts prove queuing only. */
  async function queueLandingWrites(run: LaneRun): Promise<LaneRun> {
    const snapshot = sources.mirror.getSnapshot(run.bbProjectId);
    const writes: Record<string, string> = { ...run.landWrites };
    try {
      if (!snapshot.binding || snapshot.binding.bbProjectId !== run.bbProjectId) throw new Error("binding");
      const stateId = doneState(run);
      const tickets = snapshot.issues.filter((issue) => issue.parentId === run.specIssueId && issue.inProject && issue.state.type !== "completed" && issue.state.type !== "canceled")
        .sort((a, b) => a.identifier.localeCompare(b.identifier, "en", { numeric: true }));
      for (const issueId of [...tickets.map((ticket) => ticket.id), run.specIssueId]) {
        if (writes[issueId]) continue;
        const receipt = await sources.outbox.enqueue({ bbProjectId: run.bbProjectId, expectedWorkspaceId: run.workspaceId,
          dedupeKey: `lane:${run.id}:done:${issueId}`, operation: { type: "status", issueId, stateId } });
        writes[issueId] = receipt.id;
        run = saveMerge(run, { landWrites: { ...writes } });
      }
      if (!writes.comment) {
        const avatar = signedCommentAvatarUrl(bb.server.experimental_appUrl, bb.pluginId, "Lead");
        const receipt = await sources.outbox.enqueue({ bbProjectId: run.bbProjectId, expectedWorkspaceId: run.workspaceId, dedupeKey: `lane:${run.id}:landed-comment`,
          operation: { type: "comment", issueId: run.specIssueId,
            body: `Landed PR #${run.pr?.number} at ${run.merge?.commit}. Squash-merged by the Lead after the whole-branch review approved that commit${run.acceptOwner ? " and the owner approved the merge" : ""}.`,
            author: { role: "Lead", model: modelDisplayName(run.route.model), ...(avatar ? { avatarUrl: avatar } : {}) } } });
        writes.comment = receipt.id;
      }
      return saveMerge(run, { landWrites: writes }, ["writeError"]);
    } catch (error) {
      bb.log.warn(`Lane ${run.id} landing-writes: ${diagnostic(error)}`);
      return saveMerge(run, { landWrites: writes, writeError: `${run.specId} landed, but the Helper couldn't queue its Done statuses or landing comment. Check the Linear connection; Squadron retries with the same keys.` });
    }
  }

  /** Caller holds the lane queue. Records the passed check the Lead merges with. */
  async function checkMerge(run: LaneRun, commit: string, signal: AbortSignal) {
    run = await observeInLane(run, signal, true);
    if (run.state !== "flying") throw new Error("This lane is no longer flying.");
    const gate = mergeGate(run);
    if (!gate.ready) throw new Error(gate.reason);
    if (gate.commit !== commit) throw new Error("This commit isn't the approved, pushed PR head. A later commit can't use the whole-branch approval.");
    if (run.acceptOwner && !ownerApproved(run, gate)) throw new Error("accept:owner: this merge waits for the owner's Merge on the board. Do not merge.");
    saveMerge(run, { merge: { number: gate.number, commit: gate.commit, at: now() } });
    return { allowed: true as const, number: gate.number, commit: gate.commit, command: `gh pr merge ${gate.number} --squash --match-head-commit ${gate.commit}` };
  }

  async function ownerMergeClick(projectId: string, specId: string, number: number, commit: string) {
    const found = lanes.list(projectId).filter((item) => item.specId === specId && item.state !== "landed" && item.state !== "canceled").at(-1);
    if (!found || found.recoveryOnly || !found.acceptOwner) throw new Error("This lane has no merge waiting on you. Refresh the board.");
    return workers.withLane(found.id, async () => {
      let run = await observeInLane(found, lifetime.signal, true);
      const gate = mergeGate(run);
      if (run.state !== "flying" || !gate.ready) throw new Error(gate.ready ? "This lane is no longer flying." : `${gate.reason} Nothing was approved.`);
      if (gate.number !== number || gate.commit !== commit) throw new Error("The PR changed since the board showed it. Nothing was approved; refresh the board.");
      if (!ownerApproved(run, gate)) run = saveMerge(run, { ownerMerge: { number, commit, at: now(), notified: false } });
      if (!run.ownerMerge!.notified) {
        try {
          await bb.sdk.threads.send({ threadId: run.leadThreadId!, mode: "steer-if-active", input: [{ type: "text", mentions: [], text:
            `Squadron: the owner approved merging PR #${number} at exactly ${commit}. Ask squadron_report type merge with that commit, then run its gh command. The approval covers only this PR head.` }] });
        } catch (error) {
          bb.log.warn(`Lane ${run.id} owner-merge notify: ${diagnostic(error)}`);
          throw new Error("Your approval is saved for this exact PR head, but the Lead couldn't be told. Click Merge again to retry.");
        }
        run = saveMerge(run, { ownerMerge: { ...run.ownerMerge!, notified: true } });
      }
      return { state: run.state };
    });
  }

  bb.rpc.register(laneMergeContract, {
    "lanes.merge": async ({ projectId, specId, number, commit }, context) => {
      if (context.experimental_caller.kind !== "client") throw new Error("Only the owner merges accept:owner specs, from the Squadron board.");
      return ownerMergeClick(projectId, specId, number, commit);
    },
  });

  /** Read PRs for lanes past their whole-branch review, and retry refused landing writes. */
  async function pass(signal: AbortSignal) {
    for (const projectId of lanes.projects()) {
      for (const run of lanes.list(projectId)) {
        if (signal.aborted) return;
        try {
          if (run.state === "flying" && run.specReview && !run.recoveryOnly) await workers.withLane(run.id, () => observeInLane(run, signal));
          else if (run.state === "landed" && run.writeError) await workers.withLane(run.id, () => queueLandingWrites(latest(projectId, run.id)));
        } catch (error) { if (!signal.aborted) bb.log.warn(`Lane ${run.id} pull-request pass: ${diagnostic(error)}`); }
      }
    }
  }
  bb.background.service("spec-merge", { start: async (signal) => {
    const stop = AbortSignal.any([signal, lifetime.signal]);
    while (!stop.aborted) {
      await pass(stop);
      try { await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 15_000); stop.addEventListener("abort", () => { clearTimeout(timer); reject(stop.reason); }, { once: true }); }); }
      catch { return; }
    }
  } });

  const steps: SpecMergeSteps = { checkMerge, observeInLane: (run, signal) => observeInLane(run, signal, true) };
  workers.setMerge(steps);
  return { ...steps, pass };
}
