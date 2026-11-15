// The fly-past (SQD-227): when the last Ready spec lands, the whole formation
// flies past the banner once, then parks. One board view decides it from what
// it has seen, the same way it decides a landing: never from a first read, so a
// page load or a reload never plays it, and never twice for one empty queue.
import type { Landings } from "./board-model.js";

/** How long one pass of the formation takes, from off the left edge to off the right. */
export const FLYPAST_MS = 3400;

/**
 * What one board view remembers about the fly-past. `armed` is true once this
 * view has seen work in the queue (a Ready spec, or a lane on the Flying line)
 * since its last pass. `since` is when the latest pass starts, in Date.now()
 * milliseconds, or null before any.
 */
export interface FlyPast { armed: boolean; since: number | null }

export interface FlyPastRead {
  /** The landings this view knew before this update; null on its first read. */
  before: Landings | null;
  /** nextLandings() for this update. */
  landings: Landings;
  lanes: ReadonlyArray<{ specId: string; state: string }>;
  /** How many Ready rows this update shows, or null while the board can't read Ready. */
  ready: number | null;
}

/**
 * The fly-past after one board update. It plays when, in this update, a lane
 * this view saw flying lands, and the queue is now clear: nothing Ready, and
 * nothing left on the Flying line. It starts as that landing's glide ends.
 * After a pass the view stays disarmed until work enters the queue again.
 * While Ready is unread, the update teaches nothing: an unread queue is never
 * taken for an empty one.
 */
export function nextFlyPast(previous: FlyPast | null, read: FlyPastRead): FlyPast {
  if (read.ready === null) return previous ?? { armed: false, since: null };
  const clear = read.ready === 0 && read.lanes.every((lane) => lane.state === "landed");
  const since = previous?.since ?? null;
  if (!clear) return { armed: true, since };
  const known = read.before?.until ?? {};
  const landedNow = Object.entries(read.landings.until).filter(([id]) => known[id] === undefined).map(([, until]) => until);
  if (previous?.armed && landedNow.length) return { armed: false, since: Math.max(...landedNow) };
  return { armed: previous?.armed ?? false, since };
}
