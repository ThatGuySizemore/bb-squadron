/** Shared Linear issue rules. Closed endpoints remain available as references. */
export const CLOSED_ISSUE_STATE_TYPES = ["completed", "canceled", "duplicate"] as const;
/** Closed without being done: Canceled, or Duplicate of another issue. */
export const DECLINED_ISSUE_STATE_TYPES = ["canceled", "duplicate"] as const;
export const READY_FOR_AGENT = "ready-for-agent";
export const ACCEPT_OWNER = "accept:owner";

export function isOpenIssue(issue: { state: { type: string } }): boolean {
  return !CLOSED_ISSUE_STATE_TYPES.some((type) => issue.state.type === type);
}

export function isDeclinedIssue(issue: { state: { type: string } }): boolean {
  return DECLINED_ISSUE_STATE_TYPES.some((type) => issue.state.type === type);
}
