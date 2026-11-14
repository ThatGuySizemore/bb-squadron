// The one merge rule for a lane's PR, shared by the board, the Lead's merge
// check and the owner's Merge click. It reads only trusted lane records:
// the saved whole-branch review and the last observation of BB's PR plugin.
import type { LaneRun } from "./lane-contract.js";

export type MergeGate =
  | { ready: true; number: number; commit: string }
  | { ready: false; reason: string; checks?: true };

/** True when the saved whole-branch approval is from the family opposite the
 * Lead and counts for exactly the commit it reviewed. */
export function hasSpecApproval(run: LaneRun): boolean {
  const review = run.specReview;
  return !!review?.threadId && review.route.family !== run.route.family && review.state === "approved" &&
    review.verdict?.outcome === "approve" && review.verdict.commit === review.commit;
}

export function mergeGate(run: LaneRun): MergeGate {
  if (run.prUnavailable) return { ready: false, reason: `PR status is unavailable: ${run.prUnavailable}` };
  const pr = run.pr;
  if (!pr) return { ready: false, reason: "No PR is open for the integration branch yet." };
  if (pr.headRefName !== run.branch) return { ready: false, reason: `PR #${pr.number} is for another branch than this lane's integration branch.` };
  if (pr.state !== "open") return { ready: false, reason: pr.state === "draft" ? `PR #${pr.number} is a draft.` : `PR #${pr.number} is ${pr.state}.` };
  if (!hasSpecApproval(run)) return { ready: false, reason: "The whole-branch review hasn't approved this branch." };
  if (!pr.head) return { ready: false, reason: "Squadron couldn't verify the pushed integration head." };
  if (pr.head !== run.specReview!.commit) return { ready: false, reason: "The branch moved after the whole-branch review. A later commit can't use its approval." };
  switch (pr.checks) {
    case "passing": return { ready: true, number: pr.number, commit: pr.head };
    case "failing": return { ready: false, reason: `PR #${pr.number} checks fail.`, checks: true };
    case "pending": return { ready: false, reason: `PR #${pr.number} checks are still running.`, checks: true };
    case "none": return { ready: false, reason: `PR #${pr.number} reports no checks. Squadron merges only after checks pass.` };
    case "unknown": return { ready: false, reason: `GitHub hasn't reported PR #${pr.number}'s checks.` };
  }
}

/** The owner's click counts only for the exact PR and commit it was given. */
export function ownerApproved(run: LaneRun, gate: MergeGate): boolean {
  return gate.ready && run.ownerMerge?.number === gate.number && run.ownerMerge.commit === gate.commit;
}
