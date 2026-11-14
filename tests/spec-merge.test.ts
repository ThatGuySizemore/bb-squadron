import { test } from "node:test";
import assert from "node:assert/strict";
import { helperCore } from "../lib/helper-core.js";
import { needsYou } from "../lib/board-model.js";
import { input, snapshot, issue } from "./fixtures/board-snapshots.js";
import type { LaneRun } from "../lib/lane-contract.js";

const route = { family: "gpt" as const, model: "gpt-6.1-sol", effort: "high" as const };
const reviewer = { family: "claude" as const, model: "claude-opus-5-5", effort: "high" as const };
const approved = "c".repeat(40);
const moved = "d".repeat(40);
const lane: LaneRun = { id: "lane", bbProjectId: "proj-one", workspaceId: "workspace", specId: "FIX-1", specIssueId: "fix-1",
  title: "A spec", route, state: "flying", startedAt: 0, leadThreadId: "lead", environmentId: "env", branch: "spec/fix-1", acceptOwner: true };
const specReview = { id: "review", route: reviewer, threadId: "spec-reviewer", environmentId: "env", commit: approved, originalCommit: approved,
  state: "approved" as const, round: 0 as const, firstFindings: [], verdict: { commit: approved, outcome: "approve" as const, findings: [], resolvedFindingIds: [], at: 1 } };
const pr = (overrides: Record<string, unknown> = {}) => ({ number: 12, url: "https://github.com/fixture/repo/pull/12",
  state: "open" as const, checks: "passing" as const, headRefName: "spec/fix-1", baseRefName: "main", head: approved, observedAt: 5, ...overrides });
const snap = () => snapshot([issue("FIX-1", { labels: ["ready-for-agent", "accept:owner"] }), issue("FIX-2", { parent: "FIX-1" })]);
const view = (run: LaneRun) => helperCore({ ...input(snap()), lanes: [run] }).board;

test("the whole-branch review, PR, owner merge and landing show as lane states derived from saved PR observations", () => {
  assert.equal(view({ ...lane, specReview: { ...specReview, state: "reviewing", verdict: undefined } }).lanes[0].state, "spec-review");
  const pending = view({ ...lane, specReview, pr: pr({ checks: "pending" }) }).lanes[0];
  assert.equal(pending.state, "pr-open");
  assert.deepEqual(pending.pr, { number: 12, checks: "pending", url: "https://github.com/fixture/repo/pull/12" });
  const waits = view({ ...lane, specReview, pr: pr() });
  assert.equal(waits.lanes[0].state, "merge-waits");
  assert.equal(waits.lanes[0].mergeCommit, approved);
  assert.deepEqual(needsYou(waits).map(({ kind, specId, notifyKey, threadId }) => ({ kind, specId, notifyKey, threadId })),
    [{ kind: "merge", specId: "FIX-1", notifyKey: `merge:FIX-1:12:${approved}`, threadId: "lead" }]);
  const landed = view({ ...lane, state: "landed", landedAt: 900, specReview, pr: pr({ state: "merged" }) }).lanes[0];
  assert.equal(landed.state, "landed"); assert.equal(landed.landedAt, 900); assert.equal(landed.pr?.number, 12);
});

test("a changed head, failing or unknown checks, a moved branch and missing PR data never offer the owner's merge", () => {
  for (const run of [
    { ...lane, specReview, pr: pr({ head: moved }) },
    { ...lane, specReview, pr: pr({ head: null }) },
    { ...lane, specReview, pr: pr({ checks: "failing" }) },
    { ...lane, specReview, pr: pr({ checks: "none" }) },
    { ...lane, specReview, pr: pr({ headRefName: "other" }) },
    { ...lane, specReview, pr: pr({ state: "draft" }) },
    { ...lane, specReview: { ...specReview, commit: moved }, pr: pr({ head: moved }) },
    { ...lane, specReview, pr: pr(), prUnavailable: "The machine is offline." },
    { ...lane, specReview },
  ] as LaneRun[]) {
    const board = view(run);
    assert.notEqual(board.lanes[0].state, "merge-waits", JSON.stringify(run.pr ?? null));
    assert.equal(board.lanes[0].mergeCommit, undefined);
    assert.deepEqual(needsYou(board), []);
  }
  const offline = view({ ...lane, specReview, pr: pr(), prUnavailable: "The machine is offline." }).lanes[0];
  assert.equal(offline.prNote, "PR status is unavailable: The machine is offline.");
  assert.match(view({ ...lane, specReview, pr: pr({ head: moved }) }).lanes[0].prNote ?? "", /moved after the whole-branch review/);
});

test("the owner's merge counts for its exact PR and commit only, and lanes without accept:owner never wait on the owner", () => {
  const clicked = view({ ...lane, specReview, pr: pr(), ownerMerge: { number: 12, commit: approved, at: 7, notified: true } });
  assert.equal(clicked.lanes[0].state, "pr-open");
  assert.match(clicked.lanes[0].prNote ?? "", /You approved this merge/);
  assert.deepEqual(needsYou(clicked), []);
  // A later commit after a fresh approval is a new merge context and waits for a new click.
  const later = view({ ...lane, specReview: { ...specReview, commit: moved, verdict: { ...specReview.verdict, commit: moved } }, pr: pr({ head: moved }),
    ownerMerge: { number: 12, commit: approved, at: 7, notified: true } });
  assert.equal(later.lanes[0].state, "merge-waits");
  assert.equal(needsYou(later)[0].notifyKey, `merge:FIX-1:12:${moved}`);
  const own = view({ ...lane, acceptOwner: false, specReview, pr: pr() });
  assert.equal(own.lanes[0].state, "pr-open");
  assert.deepEqual(needsYou(own), []);
});
