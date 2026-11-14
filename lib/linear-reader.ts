// Pagination, complete-walk commits and polling adapted from bb-plugin-linear
// (MIT, Vedran Burojević). See THIRD_PARTY_NOTICES.md.
import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CLOSED_ISSUE_STATE_TYPES, isOpenIssue } from "./linear-issues.js";
import { linearMirrorChanged, publishSquadronSignal } from "./realtime-contract.js";
import { z } from "zod";
import { LinearRequestError, type LinearAuth } from "./linear-auth.js";
import { bindInputSchema, linearMirrorContract, mirrorLabelSchema, mirrorStateSchema,
  type LinearBinding, type MirrorCatalog, type MirrorIssue, type MirrorRelation, type MirrorSnapshot } from "./linear-mirror-contract.js";

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const connection = <T extends z.ZodType>(node: T) => z.object({ nodes: z.array(node), pageInfo });
const targetResponse = z.object({
  team: z.object({ id: z.string(), name: z.string(), key: z.string() }),
  project: z.object({ id: z.string(), name: z.string(), teams: connection(z.object({ id: z.string() })) }),
});
const issueNode = z.object({
  id: z.string(), identifier: z.string(), title: z.string(), description: z.string().nullable(), url: z.string(),
  updatedAt: z.string().datetime(), team: z.object({ id: z.string() }), project: z.object({ id: z.string() }).nullable(),
  parent: z.object({ id: z.string() }).nullable(), state: mirrorStateSchema, labels: connection(mirrorLabelSchema),
});
const relatedNode = issueNode.omit({ labels: true });
const relationNode = z.object({ id: z.string(), type: z.string(), issue: relatedNode, relatedIssue: relatedNode });
const graphNode = issueNode.extend({ relations: connection(relationNode), inverseRelations: connection(relationNode) });
const issuesResponse = z.object({ issues: connection(graphNode) });
const laneSpecResponse = z.object({ issue: issueNode.extend({ children: connection(issueNode) }).nullable() });
const referenceFields = `id identifier title description url updatedAt team { id } project { id } parent { id } state { id name type }`;
const relationFields = `nodes { id type issue { ${referenceFields} } relatedIssue { ${referenceFields} } } pageInfo { hasNextPage endCursor }`;
const issueFields = `id identifier title description url updatedAt team { id } project { id } parent { id }
  state { id name type } labels(first: 50) { nodes { id name color } pageInfo { hasNextPage endCursor } }`;

async function walk<T>(load: (after: string | null) => Promise<{ nodes: T[]; pageInfo: z.infer<typeof pageInfo> }>,
  initial?: { nodes: T[]; pageInfo: z.infer<typeof pageInfo> }): Promise<T[]> {
  const nodes: T[] = [];
  const cursors = new Set<string>();
  let page = initial ?? await load(null);
  while (true) {
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    const cursor = page.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor) || cursors.size >= 1_000) throw new LinearRequestError("invalid_response");
    cursors.add(cursor);
    page = await load(cursor);
  }
}

export function registerLinearReader(bb: BbPluginApi, linear: Pick<LinearAuth, "graphql">, options: {
  /** Linear ids of the specs Squadron's Leads fly, read from BB thread metadata. */
  laneSpecIds?: (bbProjectId: string) => Promise<string[]>;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
} = {}) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const lifetime = new AbortController();
  const running = new Set<Promise<unknown>>();
  const inFlight = new Map<string, { binding: string; task: Promise<MirrorSnapshot> }>();
  let wake = new AbortController();
  const polls = new Map<string, number>();
  // Server-side listeners (the board watcher) hear the same changes as pages.
  const listeners = new Set<(bbProjectId: string) => void>();
  function changed(bbProjectId: string) {
    publishSquadronSignal(bb.realtime, linearMirrorChanged, { bbProjectId });
    for (const listener of listeners) listener(bbProjectId);
  }
  function onChange(listener: (bbProjectId: string) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const result = await linear.graphql<T>(query, variables, lifetime.signal);
    if (lifetime.signal.aborted) throw new LinearRequestError("unavailable");
    return result;
  }
  bb.onDispose(async () => { lifetime.abort(); wake.abort(); await Promise.allSettled([...running]); });
  const snapshots = new Map<string, MirrorSnapshot>();
  const db = bb.storage.database();
  db.exec(`CREATE TABLE IF NOT EXISTS mirror_bindings (bb_project_id TEXT PRIMARY KEY, binding TEXT NOT NULL)`);
  function getSnapshot(bbProjectId: string): MirrorSnapshot {
    const row = db.prepare("SELECT binding FROM mirror_bindings WHERE bb_project_id = ?").get(bbProjectId) as { binding: string } | undefined;
    return snapshots.get(bbProjectId) ?? { binding: row ? JSON.parse(row.binding) as LinearBinding : null,
      issues: [], relations: [], labels: [], states: [], syncedAt: null, error: null };
  }
  async function projectTeams(id: string, initial: z.infer<typeof targetResponse>["project"]["teams"]) {
    return walk(async (after) => z.object({ project: z.object({ teams: connection(z.object({ id: z.string() })) }) }).parse(
      await graphql(`query SquadronProjectTeams($id: String!, $after: String) {
        project(id: $id) { teams(first: 50, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }
      }`, { id, after })).project.teams, initial);
  }
  async function catalog() {
    const teams = await walk(async (after) => z.object({ teams: connection(targetResponse.shape.team) }).parse(
      await graphql(`query SquadronTeams($after: String) {
        teams(first: 50, after: $after) { nodes { id name key } pageInfo { hasNextPage endCursor } }
      }`, { after })).teams);
    const projects = await walk(async (after) => z.object({ projects: connection(targetResponse.shape.project) }).parse(
      await graphql(`query SquadronProjects($after: String) {
        projects(first: 50, after: $after) { nodes { id name teams(first: 50) { nodes { id } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } }
      }`, { after })).projects);
    const catalogProjects: MirrorCatalog["projects"] = [];
    for (const project of projects) {
      catalogProjects.push({ id: project.id, name: project.name,
        teamIds: (await projectTeams(project.id, project.teams)).map((team) => team.id) });
    }
    return { teams, projects: catalogProjects };
  }
  async function bind(input: z.infer<typeof bindInputSchema>) {
    const value = bindInputSchema.parse(input);
    const result = targetResponse.parse(await graphql(`query SquadronBinding($teamId: String!, $projectId: String!) {
      team(id: $teamId) { id name key }
      project(id: $projectId) { id name teams(first: 50) { nodes { id } pageInfo { hasNextPage endCursor } } }
    }`, { teamId: value.teamId, projectId: value.projectId }));
    const members = await projectTeams(result.project.id, result.project.teams);
    if (result.team.id !== value.teamId || result.project.id !== value.projectId || !members.some((team) => team.id === result.team.id)) throw new Error("Choose a project in the selected Linear team.");
    const binding: LinearBinding = { bbProjectId: value.bbProjectId, team: result.team,
      project: { id: result.project.id, name: result.project.name } };
    if (lifetime.signal.aborted) throw new LinearRequestError("unavailable");
    db.prepare("INSERT INTO mirror_bindings VALUES (?, ?) ON CONFLICT(bb_project_id) DO UPDATE SET binding = excluded.binding")
      .run(value.bbProjectId, JSON.stringify(binding));
    snapshots.delete(value.bbProjectId);
    polls.delete(value.bbProjectId);
    wake.abort(); wake = new AbortController();
    changed(value.bbProjectId);
    return getSnapshot(value.bbProjectId);
  }
  function sync(bbProjectId: string, signal?: AbortSignal): Promise<MirrorSnapshot> {
    const binding = JSON.stringify(getSnapshot(bbProjectId).binding);
    const current = inFlight.get(bbProjectId);
    if (current?.binding === binding) return current.task;
    const task = syncOnce(bbProjectId, AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]));
    running.add(task);
    inFlight.set(bbProjectId, { binding, task });
    void task.finally(() => {
      running.delete(task);
      if (inFlight.get(bbProjectId)?.task === task) inFlight.delete(bbProjectId);
    }).catch(() => undefined);
    return task;
  }
  async function syncOnce(bbProjectId: string, signal: AbortSignal): Promise<MirrorSnapshot> {
    const expected = JSON.stringify(getSnapshot(bbProjectId).binding);
    try { return await readSnapshot(bbProjectId, signal); }
    catch (error) {
      const safe = error instanceof LinearRequestError ? error : new LinearRequestError("invalid_response");
      if (signal.aborted) throw safe;
      const snapshot = getSnapshot(bbProjectId);
      if (JSON.stringify(snapshot.binding) !== expected) return snapshot;
      if (snapshot.binding) snapshots.set(bbProjectId, { ...snapshot, error: safe.message });
      if (snapshot.error !== safe.message) changed(bbProjectId);
      throw safe;
    }
  }
  async function readSnapshot(bbProjectId: string, signal: AbortSignal): Promise<MirrorSnapshot> {
    async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      if (signal.aborted) throw new LinearRequestError("unavailable");
      const result = await linear.graphql<T>(query, variables, signal);
      if (signal.aborted) throw new LinearRequestError("unavailable");
      return result;
    }
    const previous = getSnapshot(bbProjectId);
    if (!previous.binding) return previous;
    const binding = previous.binding;
    const issues = new Map<string, MirrorIssue>();
    const relations = new Map<string, MirrorRelation>();
    function putIssue(node: z.infer<typeof relatedNode>, labels: MirrorIssue["labels"] = []) {
      const existing = issues.get(node.id);
      issues.set(node.id, {
        id: node.id, identifier: node.identifier, title: node.title, description: node.description, url: node.url,
        updatedAt: node.updatedAt, teamId: node.team.id, projectId: node.project?.id ?? null, parentId: node.parent?.id ?? null,
        state: node.state, labels: labels.length ? labels : existing?.labels ?? [],
        // Match the open-issue walk's board eligibility, including relation endpoints.
        inProject: node.team.id === binding.team.id && node.project?.id === binding.project.id &&
          isOpenIssue(node),
      });
    }
    function putRelations(nodes: z.infer<typeof relationNode>[]) {
      for (const relation of nodes) {
        if (relation.type !== "blocks") continue;
        putIssue(relation.issue); putIssue(relation.relatedIssue);
        relations.set(relation.id, { id: relation.id, type: "blocks", issueId: relation.issue.id, relatedIssueId: relation.relatedIssue.id });
      }
    }
    async function remainingRelations(id: string, field: "relations" | "inverseRelations", info: z.infer<typeof pageInfo>) {
      const cursors = new Set<string>();
      while (info.hasNextPage) {
        if (!info.endCursor || cursors.has(info.endCursor) || cursors.size >= 1_000) throw new LinearRequestError("invalid_response");
        cursors.add(info.endCursor);
        const name = field === "relations" ? "SquadronRelations" : "SquadronInverseRelations";
        const schema = z.object({ issue: z.object({ [field]: connection(relationNode) }) });
        const page = schema.parse(await graphql(`query ${name}($id: String!, $after: String) {
          issue(id: $id) { ${field}(first: 50, after: $after) { ${relationFields} } }
        }`, { id, after: info.endCursor })).issue[field];
        putRelations(page.nodes); info = page.pageInfo;
      }
    }
    const seen = new Set<string>();
    let after: string | null = null;
    do {
      const result = issuesResponse.parse(await graphql(`query SquadronIssues($filter: IssueFilter!, $after: String) {
        issues(first: 25, after: $after, filter: $filter) { nodes { ${issueFields}
          relations(first: 5) { ${relationFields} } inverseRelations(first: 5) { ${relationFields} }
        } pageInfo { hasNextPage endCursor } }
      }`, { filter: { team: { id: { eq: binding.team.id } }, project: { id: { eq: binding.project.id } },
        state: { type: { nin: [...CLOSED_ISSUE_STATE_TYPES] } } }, after }));
      for (const node of result.issues.nodes) {
        const labels = [...node.labels.nodes];
        let labelPage = node.labels.pageInfo;
        const labelCursors = new Set<string>();
        while (labelPage.hasNextPage) {
          if (!labelPage.endCursor || labelCursors.has(labelPage.endCursor) || labelCursors.size >= 1_000) throw new LinearRequestError("invalid_response");
          labelCursors.add(labelPage.endCursor);
          const page = z.object({ issue: z.object({ labels: connection(mirrorLabelSchema) }) }).parse(await graphql(
            `query SquadronIssueLabels($id: String!, $after: String) {
              issue(id: $id) { labels(first: 50, after: $after) { nodes { id name color } pageInfo { hasNextPage endCursor } } }
            }`, { id: node.id, after: labelPage.endCursor })).issue.labels;
          labels.push(...page.nodes); labelPage = page.pageInfo;
        }
        putIssue(node, labels);
        putRelations(node.relations.nodes); putRelations(node.inverseRelations.nodes);
        await remainingRelations(node.id, "relations", node.relations.pageInfo);
        await remainingRelations(node.id, "inverseRelations", node.inverseRelations.pageInfo);
      }
      if (!result.issues.pageInfo.hasNextPage) break;
      const next = result.issues.pageInfo.endCursor;
      if (!next || seen.has(next) || seen.size >= 1_000) throw new LinearRequestError("invalid_response");
      seen.add(next);
      after = next;
    } while (true);
    // The open walk misses a lane's done tickets and a spec its Lead closed after the merge.
    // Read each Lead's spec and its completed sub-issues so the lane can land and stay Landed.
    let laneSpecIds: string[] = [];
    try { laneSpecIds = await options.laneSpecIds?.(bbProjectId) ?? []; }
    catch (error) { bb.log.warn(`lane spec ids unavailable: ${error instanceof Error ? error.name : "unknown"}`); }
    for (const id of new Set(laneSpecIds)) {
      let childrenAfter: string | null = null;
      const childCursors = new Set<string>();
      do {
        let issue: z.infer<typeof laneSpecResponse>["issue"];
        try {
          issue = laneSpecResponse.parse(await graphql(`query SquadronLaneSpec($id: String!, $after: String) {
            issue(id: $id) { ${issueFields}
              children(first: 50, after: $after, filter: { state: { type: { eq: "completed" } } }) { nodes { ${issueFields} } pageInfo { hasNextPage endCursor } }
            }
          }`, { id, after: childrenAfter })).issue;
        } catch (error) {
          // A deleted spec must not stop the whole read.
          if (error instanceof LinearRequestError && error.code === "graphql") break;
          throw error;
        }
        if (!issue) break;
        putIssue(issue, issue.labels.nodes);
        for (const child of issue.children.nodes) putIssue(child, child.labels.nodes);
        if (!issue.children.pageInfo.hasNextPage) break;
        const cursor: string | null = issue.children.pageInfo.endCursor;
        if (!cursor || childCursors.has(cursor) || childCursors.size >= 1_000) throw new LinearRequestError("invalid_response");
        childCursors.add(cursor); childrenAfter = cursor;
      } while (true);
    }
    const teamLabels: MirrorSnapshot["labels"] = [];
    const teamStates: MirrorSnapshot["states"] = [];
    const stateCursors = new Set<string>();
    const vocabularyLabelCursors = new Set<string>();
    let statesAfter: string | null = null;
    let labelsAfter: string | null = null;
    let statesDone = false;
    let labelsDone = false;
    do {
      const result = z.object({ workflowStates: connection(mirrorStateSchema), issueLabels: connection(mirrorLabelSchema) }).parse(
        await graphql(`query SquadronVocabulary($teamId: ID!, $statesAfter: String, $labelsAfter: String, $statesFirst: Int!, $labelsFirst: Int!) {
          workflowStates(first: $statesFirst, after: $statesAfter, filter: { team: { id: { eq: $teamId } } }) {
            nodes { id name type } pageInfo { hasNextPage endCursor }
          }
          issueLabels(first: $labelsFirst, after: $labelsAfter, filter: { or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }) {
            nodes { id name color } pageInfo { hasNextPage endCursor }
          }
        }`, { teamId: binding.team.id, statesAfter, labelsAfter, statesFirst: statesDone ? 0 : 50, labelsFirst: labelsDone ? 0 : 50 }));
      if (!statesDone) {
        teamStates.push(...result.workflowStates.nodes);
        statesDone = !result.workflowStates.pageInfo.hasNextPage;
        if (!statesDone) {
          const cursor = result.workflowStates.pageInfo.endCursor;
          if (!cursor || stateCursors.has(cursor) || stateCursors.size >= 1_000) throw new LinearRequestError("invalid_response");
          stateCursors.add(cursor); statesAfter = cursor;
        }
      }
      if (!labelsDone) {
        teamLabels.push(...result.issueLabels.nodes);
        labelsDone = !result.issueLabels.pageInfo.hasNextPage;
        if (!labelsDone) {
          const cursor = result.issueLabels.pageInfo.endCursor;
          if (!cursor || vocabularyLabelCursors.has(cursor) || vocabularyLabelCursors.size >= 1_000) throw new LinearRequestError("invalid_response");
          vocabularyLabelCursors.add(cursor); labelsAfter = cursor;
        }
      }
    } while (!statesDone || !labelsDone);
    const allIssues = [...issues.values()];
    const snapshot: MirrorSnapshot = { binding, issues: allIssues, relations: [...relations.values()],
      labels: [...new Map([...allIssues.flatMap((issue) => issue.labels), ...teamLabels].map((label) => [label.id, label])).values()],
      states: [...new Map([...allIssues.map((issue) => issue.state), ...teamStates].map((state) => [state.id, state])).values()],
      syncedAt: now(), error: null };
    const current = getSnapshot(bbProjectId);
    if (JSON.stringify(current.binding) !== JSON.stringify(binding)) return current;
    snapshots.set(bbProjectId, snapshot);
    if (previous.error || JSON.stringify([previous.issues, previous.relations, previous.labels, previous.states]) !== JSON.stringify([snapshot.issues, snapshot.relations, snapshot.labels, snapshot.states])) {
      changed(bbProjectId);
    }
    return snapshot;
  }
  bb.background.service("linear-reader", { start: async (signal) => {
    polls.clear(); // Every service start rebuilds the in-memory snapshot.
    let budgetAt = 0;
    while (!signal.aborted && !lifetime.signal.aborted) {
      const rows = db.prepare("SELECT bb_project_id FROM mirror_bindings ORDER BY bb_project_id").all() as { bb_project_id: string }[];
      for (const { bb_project_id: id } of rows) {
        if (signal.aborted || lifetime.signal.aborted || now() < budgetAt) break;
        const at = polls.get(id) ?? 0;
        if (at > now()) continue;
        try {
          await sync(id, signal);
          polls.set(id, now() + 30_000);
        } catch (error) {
          if (signal.aborted || lifetime.signal.aborted) return;
          const retry = error instanceof LinearRequestError && error.code === "rate_limited" ? error.retryAfterMs ?? 60_000 : 30_000;
          if (error instanceof LinearRequestError && error.code === "rate_limited") budgetAt = now() + retry;
          polls.set(id, now() + Math.max(1_000, retry));
        }
      }
      if (signal.aborted || lifetime.signal.aborted) return;
      const next = rows.length ? Math.min(...rows.map(({ bb_project_id: id }) => polls.get(id) ?? now())) : now() + 60_000;
      const sleepFor = Math.max(1, Math.max(next, budgetAt) - now());
      try { await wait(sleepFor, AbortSignal.any([signal, lifetime.signal, wake.signal])); }
      catch { if (signal.aborted || lifetime.signal.aborted) return; }
    }
  } });
  bb.rpc.register(linearMirrorContract, {
    "linear.catalog": catalog,
    "linear.bind": async (input) => { await bind(input); return sync(input.bbProjectId); },
    "linear.snapshot": ({ bbProjectId }) => getSnapshot(bbProjectId),
  });
  return { bind, getSnapshot, sync, catalog, onChange };
}
