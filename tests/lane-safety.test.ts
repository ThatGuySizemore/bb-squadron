import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateStrike } from "../lib/lane-safety-core.js";
import type { LaneRun } from "../lib/lane-contract.js";
const commit = "a".repeat(40);
const route = { family: "gpt" as const, model: "gpt-6.1-sol", effort: "high" as const };
function lane(): LaneRun {
  return { id: "lane", bbProjectId: "project", workspaceId: "workspace", specIssueId: "spec", specId: "FIX-1", title: "Spec", route,
    state: "flying", startedAt: 0, leadThreadId: "lead", environmentId: "env", branch: "integration", acceptOwner: true,
    workers: [{ id: "worker", ticketIssueId: "ticket", ticketId: "FIX-2", route, state: "working", startedAt: 0, threadId: "worker", environmentId: "env-worker", branch: "worker" }] };
}
test("red tests and compile errors before done never count; done failures do and duplicate events do not", () => {
  const run = lane();
  const event = { ticketId: "FIX-2", eventId: "check-1", kind: "quick-check" as const, commit, summary: "Lead: quick check failed." };
  assert.equal(evaluateStrike(run, event, 10).count, 0, "a red test or compiler failure during building is not a strike");
  run.workers![0].state = "reported"; run.workers![0].commit = commit;
  const first = evaluateStrike(run, event, 20);
  assert.equal(first.count, 1); assert.equal(first.stopReason, undefined);
  const retry = evaluateStrike(first.run, event, 30);
  assert.equal(retry.count, 1);
  const stale = evaluateStrike(first.run, { ...event, eventId: "stale", commit: "b".repeat(40) }, 40);
  assert.equal(stale.count, 1);
  const fixed = structuredClone(first.run); fixed.workers![0].commit = "c".repeat(40);
  const second = evaluateStrike(fixed, { ...event, eventId: "review-2", kind: "review", commit: "c".repeat(40), summary: "Lead: fixed deliverable still fails review." }, 50);
  assert.equal(second.count, 2); assert.match(second.stopReason!, /FIX-2.*two strikes.*Lead: fixed deliverable still fails review/);
});
test("a worker with no way forward is a strike; separate tickets never share a count and Resume keeps counts", () => {
  const first = evaluateStrike(lane(), { ticketId: "FIX-2", eventId: "stuck-1", kind: "stuck", summary: "Lead: no way forward, required source is unavailable." }, 10);
  assert.equal(first.count, 1);
  const resumed = { ...first.run, state: "flying" as const };
  const second = evaluateStrike(resumed, { ticketId: "FIX-2", eventId: "stuck-2", kind: "stuck", summary: "Lead: still no way forward after Resume." }, 20);
  assert.equal(second.count, 2); assert.ok(second.stopReason);
  assert.throws(() => evaluateStrike(first.run, { ticketId: "FIX-99", eventId: "unknown", kind: "stuck", summary: "Unknown worker." }, 20), /ticket/);
});

import { evaluateTimeLimits } from "../lib/lane-safety-core.js";
import { parseSquadronSettings } from "../lib/squadron-settings.js";
import { readFileSync } from "node:fs";
const parsed = parseSquadronSettings(readFileSync("docs/agents/squadron.md", "utf8"));
assert.ok(parsed.ok);
const limits = parsed.settings.limits;
test("project limits nudge first, then stop only at the next check without a bound-agent action", () => {
  const run = lane();
  assert.deepEqual(evaluateTimeLimits(run, limits, 10_800_000).commands, [], "at the worker limit is not over it");
  const overdue = evaluateTimeLimits(run, limits, 10_800_001);
  assert.deepEqual(overdue.commands.map((item) => [item.type, item.threadId]), [["nudge", "worker"]]);
  const noAction = evaluateTimeLimits(overdue.run, limits, 10_860_001);
  assert.equal(noAction.commands[0].type, "stop");
  assert.match(noAction.commands[0].text, /FIX-2.*no action/);
  const acted = structuredClone(overdue.run); acted.safety!.actions.worker = 1;
  assert.deepEqual(evaluateTimeLimits(acted, limits, 10_860_001).commands.map((item) => item.type), ["nudge"]);
  assert.equal(evaluateTimeLimits({ ...overdue.run, state: "stopped" }, limits, 10_860_001).commands.length, 0);
  const resumed = { ...overdue.run, stoppedAt: 10_850_000 };
  assert.equal(evaluateTimeLimits(resumed, limits, 10_860_001).commands[0].type, "nudge", "Resume preserves elapsed time but gets a new nudge checkpoint");
});
test("lane clock addresses Lead, completed workers leave the worker clock, settings supply all thresholds", () => {
  const run = lane(); run.workers![0].state = "reported";
  const first = evaluateTimeLimits(run, limits, 28_800_001);
  assert.deepEqual(first.commands.map((item) => [item.type, item.threadId]), [["nudge", "lead"]]);
  const second = evaluateTimeLimits(first.run, limits, 28_860_001);
  assert.deepEqual(second.commands.map((item) => item.type), ["stop"]);
  const custom = evaluateTimeLimits(lane(), { ...limits, laneTimeLimitMs: 100, workerTimeLimitMs: 200 }, 101);
  assert.deepEqual(custom.commands.map((item) => [item.type, item.threadId]), [["nudge", "lead"]]);
});
test("a red failure during the fix round is not another failed done deliverable", () => {
  const run = lane();
  run.workers![0].commit = commit; // Last done report retained during the fix.
  assert.equal(evaluateStrike(run, { ticketId: "FIX-2", eventId: "fix-red", kind: "quick-check", commit, summary: "Compile error while fixing." }, 10).count, 0);
});
test("another failed deliverable after the owner resumes a two-strike ticket stops again without resetting its count", () => {
  let run = lane(); run.workers![0].state = "reported"; run.workers![0].commit = commit;
  for (const eventId of ["first", "second"]) run = evaluateStrike(run, { ticketId: "FIX-2", eventId, kind: "review", commit, summary: "Lead: review failed." }, 10).run;
  run.workers![0].state = "working";
  const result = evaluateStrike({ ...run, stoppedAt: 20 }, { ticketId: "FIX-2", eventId: "after-resume", kind: "stuck", summary: "Lead: resumed ticket has no way forward." }, 30);
  assert.equal(result.count, 3); assert.ok(result.stopReason);
});
test("integrated work is never a stuck worker, and stale stopped reports do not consume strikes", () => {
  const run = lane(); run.workers![0].state = "integrated";
  const event = { ticketId: "FIX-2", eventId: "late-stuck", kind: "stuck" as const, summary: "Stale worker message." };
  assert.equal(evaluateStrike(run, event, 10).count, 0);
  run.workers![0].state = "working"; run.state = "stopped";
  assert.equal(evaluateStrike(run, event, 20).count, 0);
});
test("metadata-only recovery rows grant neither time nudges nor strike authority", () => {
  const run = { ...lane(), recoveryOnly: true };
  assert.deepEqual(evaluateTimeLimits(run, limits, 28_800_001).commands, []);
  assert.equal(evaluateStrike(run, { ticketId: "FIX-2", eventId: "metadata", kind: "stuck", summary: "Untrusted metadata." }, 10).count, 0);
});
