// Deterministic Helper decisions. The service supplies trusted reports and time.
import type { LaneRun } from "./lane-contract.js";
import type { SquadronSettings } from "./squadron-settings.js";
import type { StrikeEvent } from "./lane-safety-contract.js";

export function evaluateStrike(lane: LaneRun, event: StrikeEvent, now: number): { run: LaneRun; count: number; stopReason?: string } {
  const run = structuredClone(lane);
  const worker = run.workers?.find((item) => item.ticketId === event.ticketId);
  if (!worker) throw new Error("This ticket has no worker in the lane.");
  const safety = run.safety ??= { strikes: [], actions: {}, nudges: {} };
  const count = () => safety.strikes.filter((item) => item.ticketId === event.ticketId).length;
  const duplicate = safety.strikes.some((item) => item.ticketId === event.ticketId && item.eventId === event.eventId);
  // Working red tests and compilation errors have no reported deliverable.
  const eligible = event.kind === "stuck" ? ["working", "spawning", "failed"].includes(worker.state)
    : !!event.commit && worker.commit === event.commit && worker.state === "reported";
  if (run.recoveryOnly || run.state !== "flying" || duplicate || !eligible) return { run, count: count() };
  safety.strikes.push({ ...event, at: now });
  return { run, count: count(), ...(count() >= 2 ? { stopReason: `${event.ticketId} has two strikes. ${event.summary}` } : {}) };
}

export type TimeCommand = { type: "nudge" | "stop"; threadId: string; text: string };
export function evaluateTimeLimits(lane: LaneRun, limits: SquadronSettings["limits"], now: number): { run: LaneRun; commands: TimeCommand[] } {
  const run = structuredClone(lane);
  const commands: TimeCommand[] = [];
  if (run.recoveryOnly || (run.state !== "flying" && run.state !== "starting")) return { run, commands };
  const safety = run.safety ??= { strikes: [], actions: {}, nudges: {} };
  const targets = [
    { threadId: run.leadThreadId, label: run.specId, startedAt: run.startedAt, limit: limits.laneTimeLimitMs },
    ...(run.workers ?? []).filter((item) => item.state === "working" || item.state === "spawning").map((item) =>
      ({ threadId: item.threadId, label: item.ticketId, startedAt: item.startedAt, limit: limits.workerTimeLimitMs })),
  ];
  for (const target of targets) {
    if (!target.threadId || now - target.startedAt <= target.limit) continue;
    const checkpoint = safety.nudges[target.threadId];
    if (checkpoint?.queuedMessageId && checkpoint.stoppedAt === run.stoppedAt) continue;
    const actions = safety.actions[target.threadId] ?? 0;
    if (checkpoint && checkpoint.stoppedAt === run.stoppedAt && checkpoint.actions === actions && now > checkpoint.at) {
      return { run, commands: [{ type: "stop", threadId: target.threadId, text: `${target.label} exceeded its time limit and took no action after the nudge. The lane is stopped; its work and branch are kept.` }] };
    }
    if (checkpoint && checkpoint.at === now) continue;
    safety.nudges[target.threadId] = { at: now, actions, ...(run.stoppedAt !== undefined ? { stoppedAt: run.stoppedAt } : {}) };
    commands.push({ type: "nudge", threadId: target.threadId, text: `${target.label} is over its time limit from docs/agents/squadron.md. Act at once: preserve your work and report done, a question, stuck with no way forward, or progress with your decision through squadron_report. If you take no action by the next check, the Helper stops this lane. A status read alone is not action.` });
  }
  return { run, commands };
}
