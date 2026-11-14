// Pagination, complete-walk commits and polling adapted from bb-plugin-linear
// (MIT, Vedran Burojević). See THIRD_PARTY_NOTICES.md.
import { waitFor } from "./watch-clock.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CLOSED_ISSUE_STATE_TYPES, isOpenIssue } from "./linear-issues.js";
import { linearMirrorChanged, publishSquadronSignal } from "./realtime-contract.js";
import { z } from "zod";
import { LinearRequestError, type LinearAuth } from "./linear-auth.js";
import { linearMirrorContract, mirrorLabelSchema, mirrorStateSchema,
  type MirrorIssue, type MirrorRelation, type MirrorSnapshot } from "./linear-mirror-contract.js";
import { readProjectCheckout } from "./project-checkout.js";
import { LINEAR_QUERIES, PAGE } from "./linear-queries.js";
import { resolveScope, scopeDisplayName, scopeIssueFilter, scopeLookup, viewSlugId, type ResolvedScope } from "./linear-scope.js";
import { parseLinearScope, SETTINGS_UNREADABLE, type LinearScope } from "./squadron-settings.js";

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const connection = <T extends z.ZodType>(node: T) => z.object({ nodes: z.array(node), pageInfo });
const reference = z.object({
  id: z.string(), identifier: z.string(), title: z.string(), description: z.string().nullable(), url: z.string(),
  sortOrder: z.number().optional(), priority: z.number().optional(), createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(), team: z.object({ id: z.string() }), project: z.object({ id: z.string() }).nullable(),
  parent: z.object({ id: z.string() }).nullable(), state: mirrorStateSchema,
  assignee: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
});
const issueNode = reference.extend({ labels: connection(mirrorLabelSchema) });
const self = z.object({ id: z.string() });
/** `relations` name this issue as `issue`; `inverseRelations` name it as `relatedIssue`. */
const outgoingNode = z.object({ id: z.string(), type: z.string(), issue: self, relatedIssue: reference });
const incomingNode = z.object({ id: z.string(), type: z.string(), issue: reference, relatedIssue: self });
const graphNode = issueNode.extend({ relations: connection(outgoingNode), inverseRelations: connection(incomingNode) });
const issuesPage = connection(graphNode);
const laneSpecResponse = z.object({ issue: issueNode.extend({ children: connection(issueNode) }).nullable() });
const refs = <T extends z.ZodType>(node: T) => z.object({ nodes: z.array(node) }).nullish();
const scopeResponse = z.object({
  teams: refs(z.object({ id: z.string(), name: z.string(), key: z.string() })),
  projects: refs(z.object({ id: z.string(), name: z.string() })), initiatives: refs(z.object({ id: z.string(), name: z.string() })),
  issueLabels: refs(z.object({ id: z.string(), name: z.string() })), customViews: refs(z.object({ id: z.string(), name: z.string() })),
});
const membersResponse = z.object({ nodes: z.array(z.object({ id: z.string() })) });

/** A Scope Linear can't resolve. Its message is safe to show and names the key. */
class ScopeError extends Error {}

/** The project's Scope as written, or why there isn't a usable one. */
export type ScopeSource = { ok: true; scope: LinearScope } | { ok: false; message: string };

/** Resolved names and ids are reused this long; a rename or deletion shows on the next resolve. */
const RESOLVE_MS = 5 * 60_000;

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

const empty = (scope: MirrorSnapshot["scope"] = null, error: string | null = null): MirrorSnapshot =>
  ({ scope, issues: [], relations: [], labels: [], states: [], syncedAt: null, error });

export function registerLinearReader(bb: BbPluginApi, linear: Pick<LinearAuth, "graphql">, options: {
  /** Linear ids of the specs Squadron's Leads fly, read from BB thread metadata. */
  laneSpecIds?: (bbProjectId: string) => Promise<string[]>;
  /** Optional poller selection. Squadron watches every project discovered by the board watcher. */
  shouldPoll?: (bbProjectId: string) => boolean;
  /** The project's Scope. Default: the Scope section of its checkout's docs/agents/squadron.md. */
  scope?: (bbProjectId: string, signal: AbortSignal) => Promise<ScopeSource>;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
} = {}) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  const lifetime = new AbortController();
  const running = new Set<Promise<unknown>>();
  const inFlight = new Map<string, { key: string; task: Promise<MirrorSnapshot> }>();
  const polls = new Map<string, number>();
  /** Projects read at least once since start: the poller's candidates. */
  const known = new Set<string>();
  const snapshots = new Map<string, { key: string; snapshot: MirrorSnapshot }>();
  const resolved = new Map<string, { key: string; at: number; scope: ResolvedScope }>();
  /** The latest sync started per project. An older one finishing later never overwrites it. */
  const latest = new Map<string, number>();
  let sequence = 0;
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
  bb.onDispose(async () => { lifetime.abort(); await Promise.allSettled([...running]); });

  function getSnapshot(bbProjectId: string): MirrorSnapshot {
    return snapshots.get(bbProjectId)?.snapshot ?? empty();
  }
  function commit(bbProjectId: string, key: string, snapshot: MirrorSnapshot) {
    const previous = getSnapshot(bbProjectId);
    snapshots.set(bbProjectId, { key, snapshot });
    const content = (value: MirrorSnapshot) => JSON.stringify([value.scope, value.issues, value.relations, value.labels, value.states, value.error]);
    if (content(previous) !== content(snapshot)) changed(bbProjectId);
    return snapshot;
  }
  /** The Scope problem Doctor reports, if the last read found one. */
  function scopeProblem(bbProjectId: string): string | null {
    const snapshot = getSnapshot(bbProjectId);
    return snapshot.scope === null && snapshot.error ? snapshot.error : null;
  }

  async function readScope(bbProjectId: string, signal: AbortSignal): Promise<ScopeSource> {
    if (options.scope) return options.scope(bbProjectId, signal);
    const checkout = await readProjectCheckout(bb, bbProjectId, signal).catch(() => null);
    if (!checkout) return { ok: false, message: "Choose a ready checkout for this project, then check again." };
    if (checkout.settingsMarkdown === null) return { ok: false, message: SETTINGS_UNREADABLE };
    return parseLinearScope(checkout.settingsMarkdown);
  }

  async function sync(bbProjectId: string, signal?: AbortSignal): Promise<MirrorSnapshot> {
    known.add(bbProjectId);
    const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    let source: ScopeSource;
    try { source = await readScope(bbProjectId, combined); }
    catch { throw new LinearRequestError("unavailable"); }
    const key = JSON.stringify(source);
    const current = inFlight.get(bbProjectId);
    if (current?.key === key) return current.task;
    const turn = ++sequence;
    latest.set(bbProjectId, turn);
    const task = syncOnce(bbProjectId, source, key, turn, combined);
    running.add(task);
    inFlight.set(bbProjectId, { key, task });
    void task.finally(() => {
      running.delete(task);
      if (inFlight.get(bbProjectId)?.task === task) inFlight.delete(bbProjectId);
    }).catch(() => undefined);
    return task;
  }

  async function syncOnce(bbProjectId: string, source: ScopeSource, key: string, turn: number, signal: AbortSignal): Promise<MirrorSnapshot> {
    const superseded = () => latest.get(bbProjectId) !== turn;
    // A missing or invalid Scope shows no issues: data read for another scope would mislead.
    if (!source.ok) return commit(bbProjectId, key, empty(null, source.message));
    try {
      const scope = await resolve(bbProjectId, source.scope, key, signal);
      const snapshot = await readSnapshot(bbProjectId, scope, signal);
      return superseded() ? getSnapshot(bbProjectId) : commit(bbProjectId, key, snapshot);
    } catch (error) {
      if (error instanceof ScopeError) resolved.delete(bbProjectId);
      if (error instanceof ScopeError) return superseded() ? getSnapshot(bbProjectId) : commit(bbProjectId, key, empty(null, error.message));
      if (!(error instanceof LinearRequestError)) bb.log.warn(`linear read failed: ${error instanceof Error ? error.name : "unknown"}`);
      const safe = error instanceof LinearRequestError ? error : new LinearRequestError("invalid_response");
      if (signal.aborted) throw safe;
      if (superseded()) return getSnapshot(bbProjectId);
      // The last complete read of this Scope stays visible with the error.
      const kept = snapshots.get(bbProjectId);
      const base = kept?.key === key ? kept.snapshot : empty({ name: scopeDisplayName(source.scope) });
      commit(bbProjectId, key, { ...base, error: safe.message });
      throw safe;
    }
  }

  async function resolve(bbProjectId: string, scope: LinearScope, key: string, signal: AbortSignal): Promise<ResolvedScope> {
    const cached = resolved.get(bbProjectId);
    if (cached?.key === key && now() - cached.at < RESOLVE_MS) return cached.scope;
    if (signal.aborted) throw new LinearRequestError("unavailable");
    const found = scopeResponse.parse(await linear.graphql(LINEAR_QUERIES.scope, scopeLookup(scope), signal));
    const slugId = viewSlugId(scope);
    if (slugId) {
      // CustomViewFilter has no slugId: list views, stopping at the page that holds the slug.
      const views = connection(z.object({ id: z.string(), name: z.string(), slugId: z.string() }));
      const matches: { id: string; name: string }[] = [];
      await walk(async (after) => {
        if (signal.aborted) throw new LinearRequestError("unavailable");
        const page = z.object({ customViews: views }).parse(await linear.graphql(LINEAR_QUERIES.views, { after }, signal)).customViews;
        matches.push(...page.nodes.filter((view) => view.slugId === slugId).map(({ id, name }) => ({ id, name })));
        return matches.length ? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } : page;
      });
      found.customViews = { nodes: matches };
    }
    const result = resolveScope(scope, found);
    if (signal.aborted) throw new LinearRequestError("unavailable");
    if (!result.ok) { resolved.delete(bbProjectId); throw new ScopeError(result.message); }
    resolved.set(bbProjectId, { key, at: now(), scope: result.scope });
    return result.scope;
  }

  async function readSnapshot(bbProjectId: string, scope: ResolvedScope, signal: AbortSignal): Promise<MirrorSnapshot> {
    async function graphql(query: string, variables?: Record<string, unknown>): Promise<unknown> {
      if (signal.aborted) throw new LinearRequestError("unavailable");
      const result = await linear.graphql<unknown>(query, variables, signal);
      if (signal.aborted) throw new LinearRequestError("unavailable");
      return result;
    }
    const issues = new Map<string, MirrorIssue>();
    const relations = new Map<string, MirrorRelation>();
    /** The open walk returns every open issue in scope; only closed ones need asking. */
    const walked = new Set<string>();
    function putIssue(node: z.infer<typeof reference>, labels: MirrorIssue["labels"] = []) {
      const existing = issues.get(node.id);
      issues.set(node.id, {
        id: node.id, identifier: node.identifier, title: node.title, description: node.description, url: node.url,
        ...(node.sortOrder !== undefined ? { sortOrder: node.sortOrder } : {}),
        ...(node.priority !== undefined ? { priority: node.priority } : {}),
        ...(node.createdAt !== undefined ? { createdAt: node.createdAt } : {}),
        updatedAt: node.updatedAt, teamId: node.team.id, projectId: node.project?.id ?? null, parentId: node.parent?.id ?? null,
        state: node.state, labels: labels.length ? labels : existing?.labels ?? [],
        assignees: node.assignee === undefined ? existing?.assignees ?? [] : node.assignee ? [node.assignee] : [],
        inProject: walked.has(node.id),
      });
    }
    function putRelation(relation: { id: string; type: string; issue: { id: string }; relatedIssue: { id: string } }, other: z.infer<typeof reference>) {
      if (relation.type !== "blocks") return;
      putIssue(other);
      relations.set(relation.id, { id: relation.id, type: "blocks", issueId: relation.issue.id, relatedIssueId: relation.relatedIssue.id });
    }
    async function remainingRelations(id: string, info: z.infer<typeof pageInfo>) {
      if (!info.hasNextPage) return;
      const rest = await walk(async (after) => z.object({ issue: z.object({ relations: connection(outgoingNode) }) })
        .parse(await graphql(LINEAR_QUERIES.relations, { id, after })).issue.relations, { nodes: [], pageInfo: info });
      for (const relation of rest) putRelation(relation, relation.relatedIssue);
    }
    async function remainingInverseRelations(id: string, info: z.infer<typeof pageInfo>) {
      if (!info.hasNextPage) return;
      const rest = await walk(async (after) => z.object({ issue: z.object({ inverseRelations: connection(incomingNode) }) })
        .parse(await graphql(LINEAR_QUERIES.inverseRelations, { id, after })).issue.inverseRelations, { nodes: [], pageInfo: info });
      for (const relation of rest) putRelation(relation, relation.issue);
    }
    async function allLabels(node: z.infer<typeof issueNode>) {
      return walk(async (after) => z.object({ issue: z.object({ labels: connection(mirrorLabelSchema) }) }).parse(
        await graphql(LINEAR_QUERIES.issueLabels, { id: node.id, after })).issue.labels, node.labels);
    }

    const filter = { ...scopeIssueFilter(scope), state: { type: { nin: [...CLOSED_ISSUE_STATE_TYPES] } } };
    const nodes = await walk(async (after) => {
      if (!scope.view) return z.object({ issues: issuesPage }).parse(await graphql(LINEAR_QUERIES.issues, { filter, after })).issues;
      const view = z.object({ customView: z.object({ issues: issuesPage }).nullable() }).parse(
        await graphql(LINEAR_QUERIES.viewIssues, { view: scope.view.id, filter, after })).customView;
      if (!view) throw new ScopeError(`Scope View "${scope.view.name}" is no longer readable in Linear. Fix it in docs/agents/squadron.md.`);
      return view.issues;
    });
    for (const node of nodes) walked.add(node.id);
    for (const node of nodes) {
      putIssue(node, await allLabels(node));
      for (const relation of node.relations.nodes) putRelation(relation, relation.relatedIssue);
      for (const relation of node.inverseRelations.nodes) putRelation(relation, relation.issue);
      await remainingRelations(node.id, node.relations.pageInfo);
      await remainingInverseRelations(node.id, node.inverseRelations.pageInfo);
    }

    // The open walk misses a lane's done tickets and a spec its Lead closed after the merge.
    // Read each Lead's spec and its completed sub-issues so the lane can land and stay Landed.
    let laneSpecIds: string[] = [];
    try { laneSpecIds = await options.laneSpecIds?.(bbProjectId) ?? []; }
    catch (error) { bb.log.warn(`lane spec ids unavailable: ${error instanceof Error ? error.name : "unknown"}`); }
    for (const id of new Set(laneSpecIds)) {
      try {
        await walk(async (after) => {
          const issue = laneSpecResponse.parse(await graphql(LINEAR_QUERIES.laneSpec, { id, after })).issue;
          if (!issue) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
          putIssue(issue, issue.labels.nodes);
          for (const child of issue.children.nodes) putIssue(child, child.labels.nodes);
          return issue.children;
        });
      } catch (error) {
        // A deleted spec must not stop the whole read. Linear's own errors are logged by linear-auth.
        if (error instanceof LinearRequestError && error.code === "graphql") { bb.log.warn(`lane spec ${id} unreadable: graphql`); continue; }
        throw error;
      }
    }

    // Closed relation endpoints and lane tickets are in scope only if Linear says they match it.
    const unknown = [...issues.values()].filter((issue) => !walked.has(issue.id) && !isOpenIssue(issue)).map((issue) => issue.id);
    for (let start = 0; start < unknown.length; start += PAGE.members) {
      const batch = { ...scopeIssueFilter(scope), id: { in: unknown.slice(start, start + PAGE.members) } };
      const members = scope.view
        ? z.object({ customView: z.object({ issues: membersResponse }).nullable() }).parse(
          await graphql(LINEAR_QUERIES.viewMembers, { view: scope.view.id, filter: batch })).customView?.issues.nodes ?? []
        : z.object({ issues: membersResponse }).parse(await graphql(LINEAR_QUERIES.scopeMembers, { filter: batch })).issues.nodes;
      for (const { id } of members) {
        const issue = issues.get(id);
        if (issue) issue.inProject = true;
      }
    }

    // States and labels come from the teams of the issues in scope, and the named team.
    const teamIds = [...new Set([...(scope.team ? [scope.team.id] : []),
      ...[...issues.values()].filter((issue) => issue.inProject).map((issue) => issue.teamId)])];
    const teamStates: MirrorSnapshot["states"] = [];
    const teamLabels: MirrorSnapshot["labels"] = [];
    if (teamIds.length) {
      const stateCursors = new Set<string>();
      const labelCursors = new Set<string>();
      let statesAfter: string | null = null;
      let labelsAfter: string | null = null;
      let statesDone = false;
      let labelsDone = false;
      do {
        // A finished side is left out with @include; Linear's `first` must be 1 to 250.
        const result = z.object({ workflowStates: connection(mirrorStateSchema).optional(), issueLabels: connection(mirrorLabelSchema).optional() }).parse(
          await graphql(LINEAR_QUERIES.vocabulary, { teamIds, statesAfter, labelsAfter, withStates: !statesDone, withLabels: !labelsDone }));
        if (!statesDone && !result.workflowStates || !labelsDone && !result.issueLabels) throw new LinearRequestError("invalid_response");
        if (!statesDone && result.workflowStates) {
          teamStates.push(...result.workflowStates.nodes);
          statesDone = !result.workflowStates.pageInfo.hasNextPage;
          if (!statesDone) {
            const cursor = result.workflowStates.pageInfo.endCursor;
            if (!cursor || stateCursors.has(cursor) || stateCursors.size >= 1_000) throw new LinearRequestError("invalid_response");
            stateCursors.add(cursor); statesAfter = cursor;
          }
        }
        if (!labelsDone && result.issueLabels) {
          teamLabels.push(...result.issueLabels.nodes);
          labelsDone = !result.issueLabels.pageInfo.hasNextPage;
          if (!labelsDone) {
            const cursor = result.issueLabels.pageInfo.endCursor;
            if (!cursor || labelCursors.has(cursor) || labelCursors.size >= 1_000) throw new LinearRequestError("invalid_response");
            labelCursors.add(cursor); labelsAfter = cursor;
          }
        }
      } while (!statesDone || !labelsDone);
    }
    const allIssues = [...issues.values()];
    return { scope: { name: scope.name }, issues: allIssues, relations: [...relations.values()],
      labels: [...new Map([...allIssues.flatMap((issue) => issue.labels), ...teamLabels].map((label) => [label.id, label])).values()],
      states: [...new Map([...allIssues.map((issue) => issue.state), ...teamStates].map((state) => [state.id, state])).values()],
      syncedAt: now(), error: null };
  }

  bb.background.service("linear-reader", { start: async (signal) => {
    polls.clear(); // Every service start catches up in full.
    let budgetAt = 0;
    while (!signal.aborted && !lifetime.signal.aborted) {
      const ids = [...known].sort().filter((id) => options.shouldPoll?.(id) ?? true);
      for (const id of ids) {
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
      const next = ids.length ? Math.min(...ids.map((id) => polls.get(id) ?? now())) : now() + 60_000;
      const sleepFor = Math.max(1, Math.max(next, budgetAt) - now());
      try { await wait(sleepFor, AbortSignal.any([signal, lifetime.signal])); }
      catch { if (signal.aborted || lifetime.signal.aborted) return; }
    }
  } });
  bb.rpc.register(linearMirrorContract, {
    "linear.snapshot": ({ bbProjectId }) => getSnapshot(bbProjectId),
  });
  return { getSnapshot, sync, onChange, scopeProblem };
}
