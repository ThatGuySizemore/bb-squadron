// Synthetic GraphQL response recordings. Shapes follow bb-plugin-linear's
// public documents at 62d2401baf920301c37bc60744d60dc092eb8500.
// No live workspace data or credentials. See SIZE-890 for live recordings.
export const end = { hasNextPage: false, endCursor: null };
export const ready = { id: "state-ready", name: "Ready", type: "unstarted" };
export const done = { id: "state-done", name: "Done", type: "completed" };
export const label = { id: "label-ready", name: "ready-for-agent", color: "#00aa00" };
export const specIssue = {
  id: "spec-one", identifier: "FIX-1", title: "A fixture spec", description: "A spec description",
  url: "https://linear.app/fixture/issue/FIX-1", updatedAt: "2026-11-13T20:00:00.000Z",
  team: { id: "team-one" }, project: { id: "linear-one" }, parent: null, state: ready,
  labels: { nodes: [label], pageInfo: end },
  relations: { nodes: [], pageInfo: end }, inverseRelations: { nodes: [], pageInfo: end },
};
export const ticketIssue = {
  ...specIssue, id: "ticket-one", identifier: "FIX-2", title: "A fixture ticket", parent: { id: "spec-one" },
  labels: { nodes: [], pageInfo: end },
};
export const issuePageOne = { data: { issues: {
  nodes: [specIssue], pageInfo: { hasNextPage: true, endCursor: "issues-page-two" },
} } };
export const issuePageTwo = { data: { issues: { nodes: [ticketIssue], pageInfo: end } } };

export const externalBlocker = {
  id: "outside-one", identifier: "OUT-9", title: "External blocker", description: null,
  url: "https://linear.app/fixture/issue/OUT-9", updatedAt: "2026-11-13T20:00:00.000Z",
  team: { id: "team-other" }, project: { id: "project-other" }, parent: null, state: done,
};
export const openExternalBlocker = { ...externalBlocker, id: "outside-two", identifier: "OUT-10", state: ready };
export const blockedSpec = {
  ...specIssue,
  relations: { nodes: [{ id: "blocks-ticket", type: "blocks", issue: specIssue, relatedIssue: ticketIssue }], pageInfo: end },
  inverseRelations: {
    nodes: [{ id: "external-block", type: "blocks", issue: externalBlocker, relatedIssue: specIssue }],
    pageInfo: { hasNextPage: true, endCursor: "inverse-two" },
  },
};
export const remainingBlockers = { data: { issue: {
  inverseRelations: { nodes: [
    { id: "external-block-two", type: "blocks", issue: openExternalBlocker, relatedIssue: specIssue },
    { id: "not-a-block", type: "related", issue: externalBlocker, relatedIssue: specIssue },
  ], pageInfo: end },
} } };

export const vocabularyResponse = { data: {
  workflowStates: { nodes: [ready], pageInfo: end }, issueLabels: { nodes: [label], pageInfo: end },
} };
