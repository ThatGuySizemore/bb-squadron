// Resolving a repo's Linear Scope (docs/agents/squadron.md) to Linear ids, and
// the issue filter it implies. Pure; lib/linear-reader.ts runs the queries.
import type { LinearScope, ScopeKey } from "./squadron-settings.js";

type Filter = Record<string, unknown>;
export interface ScopeRef { id: string; name: string }
/** A Scope whose keys each matched exactly one Linear record. */
export interface ResolvedScope {
  team?: ScopeRef; project?: ScopeRef; initiative?: ScopeRef; label?: ScopeRef; view?: ScopeRef;
  /** Display name: the matched names, in Team, Initiative, Project, Label, View order. */
  name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_PATH = /^https?:\/\/linear\.app\/[^/]+\/(team|project|initiative|view)\/([^/?#]+)/i;

/** A name, key, URL or id as a Linear filter for one record kind. */
function match(value: string, kind: "team" | "project" | "initiative" | "view"): Filter {
  if (UUID.test(value)) return { id: { eq: value } };
  const url = URL_PATH.exec(value);
  if (url && url[1].toLowerCase() === kind) {
    if (kind === "team") return { key: { eqIgnoreCase: url[2] } };
    // Project, initiative and view URLs end their slug with the record's slugId.
    return { slugId: { eq: url[2].split("-").at(-1) } };
  }
  if (kind === "team") return { or: [{ key: { eqIgnoreCase: value } }, { name: { eqIgnoreCase: value } }] };
  return { name: { eqIgnoreCase: value } };
}

function labelMatch(value: string, team: Filter | null): Filter {
  const names: Filter[] = UUID.test(value) ? [{ id: { eq: value } }] : [{ name: { eqIgnoreCase: value } }];
  const slash = value.indexOf("/");
  // "group/name" also finds the label "name" in the label group "group".
  if (!UUID.test(value) && slash > 0 && slash < value.length - 1) {
    names.push({ name: { eqIgnoreCase: value.slice(slash + 1) }, parent: { name: { eqIgnoreCase: value.slice(0, slash) } } });
  }
  const byName = names.length === 1 ? names[0] : { or: names };
  return team ? { and: [byName, { or: [{ team }, { team: { null: true } }] }] } : byName;
}

/** Variables for SquadronScope: one lookup per key set, skipped otherwise. */
export function scopeLookup(scope: LinearScope) {
  const team = scope.team === undefined ? null : match(scope.team, "team");
  const lookup = <T>(value: string | undefined, filter: (value: string) => T) => value === undefined ? null : filter(value);
  return {
    withTeam: team !== null, team,
    withProject: scope.project !== undefined, project: lookup(scope.project, (value) => match(value, "project")),
    withInitiative: scope.initiative !== undefined, initiative: lookup(scope.initiative, (value) => match(value, "initiative")),
    withLabel: scope.label !== undefined, label: lookup(scope.label, (value) => labelMatch(value, team)),
    withView: scope.view !== undefined, view: lookup(scope.view, (value) => match(value, "view")),
  };
}

export interface ScopeLookupResult {
  teams?: { nodes: (ScopeRef & { key?: string })[] } | null; projects?: { nodes: ScopeRef[] } | null;
  initiatives?: { nodes: ScopeRef[] } | null; issueLabels?: { nodes: ScopeRef[] } | null;
  customViews?: { nodes: ScopeRef[] } | null;
}

const FIELDS: [ScopeKey, keyof LinearScope, keyof ScopeLookupResult, string][] = [
  ["Team", "team", "teams", "team"], ["Initiative", "initiative", "initiatives", "initiative"],
  ["Project", "project", "projects", "project"], ["Label", "label", "issueLabels", "label"], ["View", "view", "customViews", "view"],
];

/** Each key set must match exactly one record. The error names the key and value. */
export function resolveScope(scope: LinearScope, result: ScopeLookupResult): { ok: true; scope: ResolvedScope } | { ok: false; message: string } {
  const resolved: ResolvedScope = { name: "" };
  const names: string[] = [];
  for (const [key, field, list, noun] of FIELDS) {
    const value = scope[field];
    if (value === undefined) continue;
    const nodes = result[list]?.nodes ?? [];
    if (!nodes.length) return { ok: false, message: `Scope ${key} "${value}" matches no Linear ${noun}. Fix it in docs/agents/squadron.md.` };
    if (nodes.length > 1) {
      const hint = key !== "Label" ? "Use its URL or id" : scope.team ? "Use its id" : "Add a Team, or use its id,";
      return { ok: false, message: `Scope ${key} "${value}" matches more than one Linear ${noun}. ${hint} in docs/agents/squadron.md.` };
    }
    resolved[field] = { id: nodes[0].id, name: nodes[0].name };
    names.push(nodes[0].name);
  }
  resolved.name = names.join(" · ");
  return { ok: true, scope: resolved };
}

/** The IssueFilter for every key but View, which applies its own saved filter. */
export function scopeIssueFilter(scope: ResolvedScope): Filter {
  const filter: Filter = {};
  if (scope.team) filter.team = { id: { eq: scope.team.id } };
  if (scope.project || scope.initiative) {
    filter.project = {
      ...(scope.project ? { id: { eq: scope.project.id } } : {}),
      ...(scope.initiative ? { initiatives: { some: { id: { eq: scope.initiative.id } } } } : {}),
    };
  }
  if (scope.label) filter.labels = { some: { id: { eq: scope.label.id } } };
  return filter;
}

/** What the board calls a scope before Linear has resolved it: the values as written. */
export function scopeDisplayName(scope: LinearScope): string {
  return FIELDS.flatMap(([, field]) => scope[field] === undefined ? [] : [scope[field]!]).join(" · ");
}
