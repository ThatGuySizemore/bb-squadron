// SQD-224: each Flying lane's progress is a dithered contrail with a small
// plane at its head, filling as tickets reach the branch. The lane's wind
// moves right to left, like the header, at the same working-agent pace the
// banner clouds use.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Lane, Route, Ticket } from "../lib/board-model.js";
import { windSpeed, workingAgents } from "../lib/working-agents.js";

const route: Route = { family: "claude", model: "claude-opus-5-5", effort: "high" };
const ticket = (id: string, state: Ticket["state"]): Ticket => ({ id, title: `Ticket ${id}`, blockedBy: [], route, state, minutes: 0 });
const lane = (specId: string, extra: Partial<Lane> = {}): Lane => ({
  specId, title: `Spec ${specId}`, lead: route, leadThreadId: `thr_lead_${specId}`, branch: `bb/lead-${specId.toLowerCase()}-thr_x`,
  state: "flying", minutes: 12, acceptOwner: false, workingThreads: 2,
  tickets: [ticket(`${specId}-A`, "done"), ticket(`${specId}-B`, "working"), ticket(`${specId}-C`, "blocked")],
  ...extra,
});

test("the working-agent count adds every flying lane's running threads, leaving out stopped and landed lanes", () => {
  assert.equal(workingAgents([]), 0);
  assert.equal(workingAgents([
    lane("A", { workingThreads: 3 }),
    lane("B", { workingThreads: undefined }),
    lane("C", { state: "pr-open", workingThreads: 1 }),
    lane("D", { state: "stopped", stopped: true, workingThreads: 2 }),
    lane("E", { state: "merge-waits", stopped: true, workingThreads: 1 }),
    lane("F", { state: "landed", workingThreads: 4 }),
  ]), 4);
});

test("wind speed is still with nobody working, quickens per agent and tops out at six", () => {
  assert.equal(windSpeed(0), 0);
  const speeds = [1, 2, 3, 4, 5, 6].map(windSpeed);
  assert.ok(speeds.every((speed, i) => speed > 0 && (i === 0 || speed > speeds[i - 1]!)), `rises per agent: ${speeds}`);
  assert.equal(windSpeed(9), windSpeed(6), "six and over share the top pace");
});
