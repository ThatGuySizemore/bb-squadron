// The board's one measure of pace: how many agents are working right now.
// The banner's clouds and every Flying lane's wind read this same count and
// move at the same speed for it, so the page's weather never disagrees.
import type { Lane } from "./board-model.js";

/** Running Lead and worker threads across the lanes still flying; stopped and landed lanes add none. */
export function workingAgents(lanes: readonly Lane[]): number {
  return lanes.reduce((n, lane) => lane.state === "landed" || lane.state === "stopped" || lane.stopped ? n : n + (lane.workingThreads ?? 0), 0);
}

/** Agents beyond this many don't blow any harder. */
export const WIND_TOP = 6;

/**
 * The wind, in CSS pixels a second, right to left: still with nobody working,
 * then faster per working agent up to six. Clouds and lane wind both use it.
 */
export function windSpeed(agents: number): number {
  const n = Math.max(0, Math.min(Math.floor(agents), WIND_TOP));
  return n === 0 ? 0 : 8 + 6 * n;
}
