// The owner's lane controls: Stop, Resume and Cancel. Each runs in the lane's
// command queue, so a worker spawn, report or later review never interleaves.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { laneLifecycleContract, type LaneRun } from "./lane-contract.js";
import type { LaneService, LaneSources } from "./lane-service.js";
import type { MirrorSnapshot } from "./linear-mirror-contract.js";
import { modelDisplayName } from "./linear-outbox.js";
import { signedCommentAvatarUrl } from "./linear-avatar.js";
import { diagnostic } from "./diagnostic.js";

export const OWNER_STOP = "You stopped this lane. Its threads, worktrees and branch are kept. Resume, re-plan or cancel it.";
const RESUMED_LEAD = "Squadron: the owner resumed this lane. Check squadron_status and continue the spec where it stopped. Resuming grants no other approval.";
const RESUMED_WORKER = "Squadron: the owner resumed this lane. Check squadron_status and continue your ticket where it stopped. Resuming grants no other approval.";
const RESUMED_REVIEWER = "Squadron: the owner resumed this lane. Check squadron_status and continue your saved review at its bound commit and round. A second look stays limited to the first findings. Resuming grants no other approval.";

type LifecycleFields = Partial<Pick<LaneRun, "state" | "stopReason" | "stoppedAt" | "canceledAt" | "writeError">>;

export function registerLifecycle(bb: BbPluginApi, sources: Pick<LaneSources, "mirror" | "outbox">, lanes: LaneService,
  workers: { withLane<T>(laneId: string, action: () => Promise<T>): Promise<T> }, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;

  function latest(projectId: string, laneId: string): LaneRun {
    const run = lanes.list(projectId).find((item) => item.id === laneId);
    if (!run) throw new Error("This lane no longer exists.");
    return run;
  }
  /** Rebase only lifecycle fields onto the latest record, so worker, review,
   * recovery and start fields written elsewhere survive. */
  function saveLifecycle(run: LaneRun, fields: LifecycleFields, drop: Array<keyof LifecycleFields> = []): LaneRun {
    const value: LaneRun = { ...latest(run.bbProjectId, run.id), ...fields };
    for (const key of drop) delete value[key];
    lanes.save(value);
    return value;
  }
  /** Stops turns only. Threads, worktrees and branches stay for the owner. */
  async function stopThreads(run: LaneRun) {
    const ids = [run.leadThreadId, run.specReview?.threadId,
      ...(run.workers ?? []).filter((worker) => worker.state !== "integrated").flatMap((worker) => [worker.threadId, worker.review?.threadId])];
    for (const threadId of new Set(ids)) {
      if (!threadId) continue;
      try { await bb.sdk.threads.stop({ threadId }); }
      catch (error) { bb.log.warn(`Lane ${run.id} stop-thread: ${diagnostic(error)}`); }
    }
  }
  /** Release a still-queued first prompt, or send a notice to an idle thread. */
  async function wake(threadId: string, text: string) {
    const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
    if (rows.length) {
      for (const row of rows) await bb.sdk.threads.queuedMessages.send({ threadId, queuedMessageId: row.id, mode: "auto" });
      return;
    }
    await bb.sdk.threads.send({ threadId, mode: "steer-if-active", input: [{ type: "text", mentions: [], text }] });
  }

  /** For callers already inside the lane queue, such as strikes and time limits. */
  async function stopInLane(run: LaneRun, reason: string): Promise<LaneRun> {
    const current = latest(run.bbProjectId, run.id);
    if (current.state !== "flying" && current.state !== "starting") throw new Error("Only a flying lane can stop.");
    // Persist first: the dispatch hook then refuses anything Squadron sends.
    const stopped = saveLifecycle(current, { state: "stopped", stopReason: reason, stoppedAt: now() });
    await stopThreads(stopped);
    return stopped;
  }
  function stop(projectId: string, laneId: string, reason: string): Promise<LaneRun> {
    return workers.withLane(laneId, () => stopInLane(latest(projectId, laneId), reason));
  }

  function resume(projectId: string, laneId: string): Promise<LaneRun> {
    return workers.withLane(laneId, async () => {
      const current = latest(projectId, laneId);
      if (current.state !== "stopped") throw new Error("Only a stopped lane can resume.");
      if (!current.leadThreadId) throw new Error("This lane's Lead was never confirmed. Check BB threads; Cancel returns the spec to Ready.");
      const resumed = saveLifecycle(current, { state: current.branch ? "flying" : "starting" }, ["stopReason"]);
      try { await wake(current.leadThreadId, RESUMED_LEAD); }
      catch (error) {
        bb.log.warn(`Lane ${current.id} resume-lead: ${diagnostic(error)}`);
        saveLifecycle(resumed, { state: "stopped", stoppedAt: now(), stopReason: "Resume couldn't reach the Lead. Open its thread, then resume again." });
        throw new Error("Resume couldn't reach the Lead. The lane stays stopped; open its thread, then resume again.");
      }
      // Only working workers resume. Failed records stay reserved for recovery;
      // reported and integrated workers restart only through review's cap reservation.
      for (const worker of resumed.workers ?? []) {
        if (!worker.threadId || worker.state !== "working") continue;
        try { await wake(worker.threadId, RESUMED_WORKER); }
        catch (error) { bb.log.warn(`Lane ${current.id} worker ${worker.id} resume: ${diagnostic(error)}`); }
      }
      for (const worker of resumed.workers ?? []) {
        const review = worker.review;
        if (!review?.threadId || !["reviewing", "second-look"].includes(review.state)) continue;
        try { await wake(review.threadId, RESUMED_REVIEWER); }
        catch (error) { bb.log.warn(`Lane ${current.id} review ${review.id} resume: ${diagnostic(error)}`); }
      }
      const spec = resumed.specReview;
      if (spec?.threadId && ["reviewing", "second-look"].includes(spec.state)) {
        try { await wake(spec.threadId, RESUMED_REVIEWER); }
        catch (error) { bb.log.warn(`Lane ${current.id} spec review ${spec.id} resume: ${diagnostic(error)}`); }
      }
      if (resumed.state === "starting") void lanes.reconcileStart(resumed.id).catch((error) => { bb.log.warn(`Lane ${resumed.id} resume-start: ${diagnostic(error)}`); });
      return resumed;
    });
  }

  function unstartedState(snapshot: MirrorSnapshot): string {
    const states = snapshot.states.filter((state) => state.type === "unstarted");
    const named = states.filter((state) => ["todo", "ready"].includes(state.name.toLowerCase()));
    const match = states.length === 1 ? states[0] : named.length === 1 ? named[0] : null;
    if (!match) throw new Error("This Linear team needs an unambiguous unstarted state, such as Todo.");
    return match.id;
  }
  async function queueCancelWrites(run: LaneRun) {
    let phase = "spec status";
    try {
      // Only a spec this lane moved goes back; a never-started lane changes nothing in Linear.
      if (run.startWrites?.status) {
        const stateId = unstartedState(sources.mirror.getSnapshot(run.bbProjectId));
        await sources.outbox.enqueue({ bbProjectId: run.bbProjectId, expectedWorkspaceId: run.workspaceId, dedupeKey: `lane:${run.id}:canceled`,
          operation: { type: "status", issueId: run.specIssueId, stateId } });
      }
      if (!run.leadThreadId) return;
      phase = "signed Lead comment";
      const avatar = signedCommentAvatarUrl(bb.server.experimental_appUrl, bb.pluginId, "Lead");
      await sources.outbox.enqueue({ bbProjectId: run.bbProjectId, expectedWorkspaceId: run.workspaceId, dedupeKey: `lane:${run.id}:canceled-comment`,
        operation: { type: "comment", issueId: run.specIssueId,
          body: `Lane canceled by the owner. ${run.branch ? `Integration branch kept: ${run.branch}.` : "No integration branch was ready."} Lead thread: ${run.leadThreadId}.`,
          author: { role: "Lead", model: modelDisplayName(run.route.model), ...(avatar ? { avatarUrl: avatar } : {}) } } });
    } catch (error) {
      bb.log.warn(`Lane ${run.id} cancel-writes: ${diagnostic(error)}`);
      saveLifecycle(run, { writeError: `The lane is canceled and its branch kept, but the Helper couldn't queue the ${phase} for ${run.specId}. Check the Linear connection, then update the spec in Linear.` });
    }
  }
  function cancel(projectId: string, laneId: string): Promise<LaneRun> {
    return workers.withLane(laneId, async () => {
      const current = latest(projectId, laneId);
      if (current.state === "landed" || current.state === "canceled") throw new Error("This lane is no longer flying. Refresh the board.");
      const canceled = saveLifecycle(current, { state: "canceled", canceledAt: now() }, ["stopReason", "writeError"]);
      await stopThreads(canceled);
      // A start status already being queued finishes first; no new start write
      // begins once the lane reads canceled. Then the move back follows it.
      await lanes.settleStartWrites(canceled.id);
      await queueCancelWrites(latest(projectId, laneId));
      return latest(projectId, laneId);
    });
  }

  function find(projectId: string, specId: string): LaneRun {
    const run = lanes.list(projectId).filter((item) => item.specId === specId && item.state !== "landed" && item.state !== "canceled").at(-1);
    if (!run) throw new Error("This lane is no longer flying. Refresh the board.");
    return run;
  }
  bb.rpc.register(laneLifecycleContract, {
    "lanes.stop": async ({ projectId, specId }, context) => {
      if (context.experimental_caller.kind !== "client") throw new Error("Stop lanes from the Squadron board.");
      return { state: (await stop(projectId, find(projectId, specId).id, OWNER_STOP)).state };
    },
    "lanes.resume": async ({ projectId, specId }, context) => {
      if (context.experimental_caller.kind !== "client") throw new Error("Resume lanes from the Squadron board.");
      return { state: (await resume(projectId, find(projectId, specId).id)).state };
    },
    "lanes.cancel": async ({ projectId, specId }, context) => {
      if (context.experimental_caller.kind !== "client") throw new Error("Cancel lanes from the Squadron board.");
      return { state: (await cancel(projectId, find(projectId, specId).id)).state };
    },
  });
  return { stop, stopInLane, resume, cancel };
}
export type LaneLifecycle = ReturnType<typeof registerLifecycle>;
