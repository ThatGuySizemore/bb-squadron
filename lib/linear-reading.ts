import type { TrackerSnapshot } from "./tracker-contract.js";

export const LINEAR_READING_MS = 15 * 60_000;

export function recentLinearReading(at: number | null | undefined, now: number): boolean {
  return at !== null && at !== undefined && at <= now && now - at <= LINEAR_READING_MS;
}

/** Read errors don't prevent work from a recent, complete Linear reading. */
export function readingProblem(snapshot: TrackerSnapshot, now: number): string | null {
  if (snapshot.kind === "linear" && snapshot.syncedAt !== null && snapshot.project) {
    if (recentLinearReading(snapshot.syncedAt, now)) return null;
    return `Waiting for Linear; last read ${Math.floor(Math.max(0, now - snapshot.syncedAt) / 60_000)} min ago`;
  }
  return snapshot.error ?? (snapshot.syncedAt === null ? "Wait for the tracker to finish reading this project's issues." : null);
}
