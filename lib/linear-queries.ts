// Every GraphQL document the Linear reader sends. Linear rejects a query whose
// complexity passes about 10,000 (each property 0.1, each object 1, and each
// connection multiplied by its `first`, default 50). tests/linear-complexity.test.ts
// keeps each one under a 2,500 budget; the reader's pagination walks fetch the rest.

/** Page sizes. Small first pages keep the issue walk cheap; follow-up walks read the rare overflow. */
export const PAGE = { issues: 15, labels: 10, relations: 3, children: 25, followUp: 50, members: 50, vocabulary: 50, scope: 2 } as const;

const pageInfo = "pageInfo { hasNextPage endCursor }";
const reference = "id identifier title description url updatedAt team { id } project { id } parent { id } state { id name type } assignee { id name }";
/** `relations` lists this issue as `issue`; `inverseRelations` lists it as `relatedIssue`. Only the other end needs its fields. */
const outgoing = `nodes { id type issue { id } relatedIssue { ${reference} } } ${pageInfo}`;
const incoming = `nodes { id type issue { ${reference} } relatedIssue { id } } ${pageInfo}`;
const issueFields = `${reference} labels(first: ${PAGE.labels}) { nodes { id name color } ${pageInfo} }`;
const graphFields = `${issueFields}
  relations(first: ${PAGE.relations}) { ${outgoing} } inverseRelations(first: ${PAGE.relations}) { ${incoming} }`;

export const LINEAR_QUERIES = {
  scope: `query SquadronScope($team: TeamFilter, $project: ProjectFilter, $initiative: InitiativeFilter, $label: IssueLabelFilter, $view: CustomViewFilter,
    $withTeam: Boolean!, $withProject: Boolean!, $withInitiative: Boolean!, $withLabel: Boolean!, $withView: Boolean!) {
    teams(first: ${PAGE.scope}, filter: $team) @include(if: $withTeam) { nodes { id name key } }
    projects(first: ${PAGE.scope}, filter: $project) @include(if: $withProject) { nodes { id name } }
    initiatives(first: ${PAGE.scope}, filter: $initiative) @include(if: $withInitiative) { nodes { id name } }
    issueLabels(first: ${PAGE.scope}, filter: $label) @include(if: $withLabel) { nodes { id name } }
    customViews(first: ${PAGE.scope}, filter: $view) @include(if: $withView) { nodes { id name } }
  }`,
  /** CustomViewFilter has no slugId, so a view URL is matched against listed views. */
  views: `query SquadronViews($after: String) {
    customViews(first: ${PAGE.followUp}, after: $after) { nodes { id name slugId } ${pageInfo} }
  }`,
  issues: `query SquadronIssues($filter: IssueFilter!, $after: String) {
    issues(first: ${PAGE.issues}, after: $after, filter: $filter) { nodes { ${graphFields} } ${pageInfo} }
  }`,
  /** A View scope: the view's own saved filter and scope, narrowed by the other keys through `filter`. */
  viewIssues: `query SquadronViewIssues($view: String!, $filter: IssueFilter!, $after: String) {
    customView(id: $view) { issues(first: ${PAGE.issues}, after: $after, filter: $filter) { nodes { ${graphFields} } ${pageInfo} } }
  }`,
  issueLabels: `query SquadronIssueLabels($id: String!, $after: String) {
    issue(id: $id) { labels(first: ${PAGE.followUp}, after: $after) { nodes { id name color } ${pageInfo} } }
  }`,
  relations: `query SquadronRelations($id: String!, $after: String) {
    issue(id: $id) { relations(first: ${PAGE.followUp}, after: $after) { ${outgoing} } }
  }`,
  inverseRelations: `query SquadronInverseRelations($id: String!, $after: String) {
    issue(id: $id) { inverseRelations(first: ${PAGE.followUp}, after: $after) { ${incoming} } }
  }`,
  laneSpec: `query SquadronLaneSpec($id: String!, $after: String) {
    issue(id: $id) { ${issueFields}
      children(first: ${PAGE.children}, after: $after, filter: { state: { type: { eq: "completed" } } }) { nodes { ${issueFields} } ${pageInfo} }
    }
  }`,
  /** Which of up to PAGE.members issues match the scope's filter. */
  scopeMembers: `query SquadronScopeMembers($filter: IssueFilter!) {
    issues(first: ${PAGE.members}, filter: $filter) { nodes { id } }
  }`,
  viewMembers: `query SquadronViewMembers($view: String!, $filter: IssueFilter!) {
    customView(id: $view) { issues(first: ${PAGE.members}, filter: $filter) { nodes { id } } }
  }`,
  /** Linear's `first` is 1 to 250, so a finished side is left out with @include rather than asked for with first: 0. */
  vocabulary: `query SquadronVocabulary($teamIds: [ID!]!, $statesAfter: String, $labelsAfter: String, $withStates: Boolean!, $withLabels: Boolean!) {
    workflowStates(first: ${PAGE.vocabulary}, after: $statesAfter, filter: { team: { id: { in: $teamIds } } }) @include(if: $withStates) {
      nodes { id name type } ${pageInfo}
    }
    issueLabels(first: ${PAGE.vocabulary}, after: $labelsAfter, filter: { or: [{ team: { id: { in: $teamIds } } }, { team: { null: true } }] }) @include(if: $withLabels) {
      nodes { id name color } ${pageInfo}
    }
  }`,
} as const;
