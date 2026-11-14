// Executes strike/time decisions through the existing per-lane queue and B4 stop.
import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { LaneRun } from "./lane-contract.js";
import type { LaneService } from "./lane-service.js";
import type { LaneLifecycle } from "./lane-lifecycle.js";
import { evaluateStrike, evaluateTimeLimits } from "./lane-safety-core.js";
import { strikeEventSchema, type StrikeEvent } from "./lane-safety-contract.js";
import { readProjectCheckout } from "./project-checkout.js";
import { diagnostic } from "./diagnostic.js";

export function registerLaneSafety(bb: BbPluginApi, lanes: LaneService,
  workers: { withLane<T>(laneId: string, action: () => Promise<T>): Promise<T> }, lifecycle: Pick<LaneLifecycle, "stopInLane">,
  options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());
  const current = (projectId: string, laneId: string) => {
    const run = lanes.list(projectId).find((item) => item.id === laneId);
    if (!run) throw new Error("This lane no longer exists.");
    return run;
  };
  /** Caller already holds workers.withLane. Never changes review/worker fields. */
  async function strikeInLane(run: LaneRun, event: StrikeEvent) {
    const latest = current(run.bbProjectId, run.id);
    const result = evaluateStrike(latest, strikeEventSchema.parse(event), now());
    lanes.save({ ...latest, safety: result.run.safety });
    if (result.stopReason) await lifecycle.stopInLane(current(run.bbProjectId, run.id), result.stopReason);
    return { count: result.count, stopped: !!result.stopReason };
  }
  const strike = (projectId: string, laneId: string, event: StrikeEvent) =>
    workers.withLane(laneId, () => strikeInLane(current(projectId, laneId), event));
  /** Caller already holds the lane queue. Only successful bound-agent actions
   * reach here. Helper sends, lifecycle saves and status reads never do. */
  function actionInLane(projectId: string, laneId: string, threadId: string) {
    const run = current(projectId, laneId);
    if (run.state !== "flying" && run.state !== "starting") return;
    if (threadId !== run.leadThreadId && !run.workers?.some((item) => item.threadId === threadId && item.state === "working")) return;
    const safety = run.safety ?? { strikes: [], actions: {}, nudges: {} };
    safety.actions[threadId] = (safety.actions[threadId] ?? 0) + 1;
    lanes.save({ ...run, safety });
  }
  async function check(projectId: string) {
    const checkout = await readProjectCheckout(bb, projectId, lifetime.signal);
    if (!checkout?.settings?.ok) return; // Invalid/missing settings grant no guessed limits.
    const limits = checkout.settings.settings.limits;
    for (const lane of lanes.list(projectId)) {
      await workers.withLane(lane.id, async () => {
        const run = current(projectId, lane.id);
        const result = evaluateTimeLimits(run, limits, now());
        if (!result.commands.length) return;
        for (const command of result.commands) {
          if (command.type === "stop") {
            await lifecycle.stopInLane(current(projectId, lane.id), command.text);
            return;
          }
          // The queue holds while sending. Save the checkpoint only when BB
          // accepts the nudge, so a failed send never becomes "ignored nudge".
          const delivery = await bb.sdk.threads.send({ threadId: command.threadId, mode: "steer-if-active",
            input: [{ type: "text", mentions: [], text: command.text }] });
          const latest = current(projectId, lane.id);
          const safety = latest.safety ?? { strikes: [], actions: {}, nudges: {} };
          safety.nudges[command.threadId] = { ...result.run.safety!.nudges[command.threadId],
            ...(delivery.delivery === "queued" ? { queuedMessageId: delivery.queuedMessage.id } : {}) };
          lanes.save({ ...latest, safety });
        }
      });
    }
  }
  async function queuedNudge(threadId: string, queueId: string, dispatched: boolean) {
    for (const projectId of lanes.projects()) for (const run of lanes.list(projectId)) {
      if (run.safety?.nudges[threadId]?.queuedMessageId !== queueId) continue;
      await workers.withLane(run.id, async () => {
        const latest = current(projectId, run.id);
        const checkpoint = latest.safety?.nudges[threadId];
        if (checkpoint?.queuedMessageId !== queueId) return;
        if (dispatched) { delete checkpoint.queuedMessageId; checkpoint.at = now(); checkpoint.actions = latest.safety!.actions[threadId] ?? 0; }
        else delete latest.safety!.nudges[threadId];
        lanes.save(latest);
      });
    }
  }
  bb.events.on("message.dispatched", ({ entry }) => queuedNudge(entry.threadId, entry.id, true));
  bb.events.on("message.cancelled", ({ entry }) => queuedNudge(entry.threadId, entry.id, false));
  bb.background.service("lane-safety", { start: async (signal) => {
    const stop = AbortSignal.any([signal, lifetime.signal]);
    while (!stop.aborted) {
      for (const projectId of lanes.projects()) {
        if (stop.aborted) return;
        try { await check(projectId); }
        catch (error) { if (!stop.aborted) bb.log.warn(`Lane safety ${projectId}: ${diagnostic(error)}`); }
      }
      try { await delay(60_000, undefined, { signal: stop }); } catch { return; }
    }
  } });
  return { strikeInLane, strike, actionInLane, check };
}
export type LaneSafety = ReturnType<typeof registerLaneSafety>;
