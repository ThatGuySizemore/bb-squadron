import type { Route } from "./board-model.js";
import { detectTracker, type TrackerKind } from "./tracker-detection.js";

export interface SquadronRoute extends Route {
  /** null is the required fallback row; Lead is reserved for the coordinator. */
  label: string | null;
}

export const MODEL_ROLES = ["Lead", "Worker", "Worker (hard)", "Planning", "Planning (hard)", "Review of claude-code", "Review of codex", "Mechanical"] as const;
export type ModelRole = typeof MODEL_ROLES[number];

/** The owner's Squadron policy from House rules. The two-strike stop and carrying counts and budgets over are fixed, not settings. */
export interface SquadronPolicy {
  escalation: "diagnose first" | "retry";
  lowEffort: "mechanical only" | "off";
  /** Completed routine tickets between observation reports; null means none. */
  checkpoint: number | null;
}
export const DEFAULT_POLICY: SquadronPolicy = { escalation: "retry", lowEffort: "off", checkpoint: null };
export const POLICY_SETTINGS = [
  { key: "escalation", name: "Escalation", values: ["diagnose first", "retry"] },
  { key: "lowEffort", name: "Low effort", values: ["mechanical only", "off"] },
  { key: "checkpoint", name: "Checkpoint", values: [] },
] as const;
export type PolicySource = "House rules" | "default";

export interface SquadronSettings {
  /** Resolved Squadron policy; every unset setting holds its default. */
  policy: SquadronPolicy;
  policySource: Record<keyof SquadronPolicy, PolicySource>;
  modelRoutes?: Partial<Record<ModelRole, Route>>;
  routeDefaults?: "house-rules";
  quickCheck: string;
  /** Optional preparation command for the isolated merged-main check only. */
  checkSetup?: string;
  stopList: string[];
  limits: {
    laneTimeLimitMs: number;
    workerTimeLimitMs: number;
  };
  routes: SquadronRoute[];
  finalReviewFamily: "other" | "same";
  statusMapping: {
    lane: { ready: string; flying: string; inReview: string; landed: string };
    ticket: { waiting: string; working: string; inBranch: string; done: string };
  };
  /** Which Linear issues the board reads. null for GitHub and Local markdown. */
  scope: LinearScope | null;
  /** Lowercase labels that hold a ticket: the defaults, then the repo's additions. A trailing `*` matches a prefix. */
  holdLabels: string[];
}

/** Matt's triage roles that mean "not for an agent", plus hold. A repo's Hold labels section adds to these. */
export const DEFAULT_HOLD_LABELS: readonly string[] = ["hold", "needs-triage", "needs-info", "ready-for-human", "wontfix"];
const HOLD_LABELS_MALFORMED = "List one hold label per bullet under Hold labels, such as - hold or - wayfinder:*. A * may only end a label.";

/** Whether a label holds a ticket, ignoring case. */
export function isHoldLabel(holdLabels: readonly string[], name: string): boolean {
  const label = name.trim().toLowerCase();
  return holdLabels.some((hold) => hold.endsWith("*") ? label.startsWith(hold.slice(0, -1)) : label === hold);
}

/**
 * The optional Hold labels section: one label per bullet, other lines are prose. Absent or prose-only means the defaults alone.
 * A bare one-word line looks like a label that would otherwise be dropped, so it is malformed.
 */
function parseHoldLabels(body: string | undefined): string[] | null {
  if (body === undefined) return [...DEFAULT_HOLD_LABELS];
  const lines = body.split("\n").filter((line) => line.trim());
  const bullet = (line: string) => /^\s*[-*+]\s/.test(line);
  if (lines.some((line) => !bullet(line) && !/\s/.test(line.trim()))) return null;
  const added = lines.filter(bullet)
    .map((line) => line.replace(/^\s*[-*+]\s+/, "").trim().replace(/^`(.*)`$/, "$1").trim().toLowerCase());
  if (added.some((label) => !label || label === "*" || label.includes(",") || label.slice(0, -1).includes("*"))) return null;
  return [...new Set([...DEFAULT_HOLD_LABELS, ...added])];
}

/** A Linear Scope as written: names, keys, URLs or ids, resolved through Linear at read time. */
export interface LinearScope { team?: string; project?: string; initiative?: string; label?: string; view?: string }
export const SCOPE_KEYS = ["Team", "Project", "Initiative", "Label", "View"] as const;
export type ScopeKey = typeof SCOPE_KEYS[number];
export const SETTINGS_UNREADABLE = "docs/agents/squadron.md is missing or unreadable. Press Set up to write it with a thread, or make sure this repo's machine is online, then check again.";
export const HOUSE_RULES_UNREADABLE = "Couldn't read House rules (~/.bb-squadron/house-rules.md). Squadron won't use default routes or policy in its place. Make sure this repo's machine is online and the file is readable, then check again.";
export const SCOPE_MISSING = "Add the Scope section to docs/agents/squadron.md, naming at least one of Team, Project, Initiative, Label or View.";

export type SettingsSection = "Quick check" | "Check setup" | "Stop list" | "Time limits" | "Routes" | "Final review" | "Status mapping" | "Scope" | "Hold labels" | "Squadron policy";
export interface SettingsIssue { section: SettingsSection; message: string }
export type SettingsResult =
  | { ok: true; settings: SquadronSettings }
  | { ok: false; issues: SettingsIssue[] };

function sections(markdown: string): Map<string, string> {
  const result = new Map<string, string>();
  let name = "";
  let fence = "";
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) fence = fence ? (marker[0] === fence[0] && marker.length >= fence.length ? "" : fence) : marker;
    const heading = !fence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { name = heading[1]; result.set(name, ""); }
    else if (name) result.set(name, `${result.get(name)}${line}\n`);
  }
  return result;
}

export function markdownSection(markdown: string, heading: string): string | undefined { return sections(markdown).get(heading); }

function table(body: string): string[][] {
  return body.split("\n").filter((line) => line.trim().startsWith("|"))
    .map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()))
    .slice(2);
}

/** The Linear Scope section: one `Key: value` per line. Other prose lines are ignored. */
export function parseLinearScope(markdown: string): { ok: true; scope: LinearScope } | { ok: false; message: string } {
  const body = sections(markdown).get("Scope");
  if (body === undefined) return { ok: false, message: SCOPE_MISSING };
  const scope: LinearScope = {};
  for (const line of body.split("\n")) {
    const match = /^\s*(?:[-*+]\s+)?([A-Za-z]+)\s*:(.*)$/.exec(line);
    if (!match) continue;
    const key = SCOPE_KEYS.find((name) => name.toLowerCase() === match[1].toLowerCase());
    if (!key) return { ok: false, message: `Scope has an unknown key, ${match[1]}. Use Team, Project, Initiative, Label or View in docs/agents/squadron.md.` };
    const field = key.toLowerCase() as keyof LinearScope;
    if (scope[field] !== undefined) return { ok: false, message: `Scope sets ${key} twice. Set each key once in docs/agents/squadron.md.` };
    const value = match[2].trim().replace(/^`(.*)`$/, "$1").trim();
    if (!value) return { ok: false, message: `Scope ${key} has no value. Name it in docs/agents/squadron.md.` };
    scope[field] = value;
  }
  return Object.keys(scope).length ? { ok: true, scope } : { ok: false, message: SCOPE_MISSING };
}

/**
 * House rules `## Squadron policy`, a Setting / Value table read like Model routes. A missing file, section or row keeps its default;
 * an unknown setting or value is an issue that names it, so Doctor and Start refuse rather than guess.
 */
export function parseSquadronPolicy(houseRulesMarkdown?: string | null): {
  ok: true; policy: SquadronPolicy; source: Record<keyof SquadronPolicy, PolicySource>;
} | { ok: false; issues: SettingsIssue[] } {
  const policy: SquadronPolicy = { ...DEFAULT_POLICY };
  const source: Record<keyof SquadronPolicy, PolicySource> = { escalation: "default", lowEffort: "default", checkpoint: "default" };
  const issues: SettingsIssue[] = [];
  const fail = (message: string) => issues.push({ section: "Squadron policy", message: `House rules Squadron policy: ${message}` });
  const body = sections(houseRulesMarkdown ?? "").get("Squadron policy");
  const seen = new Set<string>();
  for (const [rawName = "", rawValue = "", ...extra] of table(body ?? "")) {
    const unquote = (cell: string) => cell.replace(/^`(.*)`$/, "$1").trim();
    const name = unquote(rawName);
    const value = unquote(rawValue).toLowerCase();
    const setting = POLICY_SETTINGS.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (!setting) { fail(`unknown setting ${name || "(empty)"}. Use Escalation, Low effort or Checkpoint.`); continue; }
    if (seen.has(setting.key) || extra.length) { fail(`${setting.name} is malformed or set twice. Set it once, with one value.`); continue; }
    seen.add(setting.key);
    if (setting.key === "checkpoint") {
      if (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) { policy.checkpoint = Number(value); source.checkpoint = "House rules"; }
      else fail(`Checkpoint ${value ? `"${unquote(rawValue)}"` : "has no value"}; use a positive whole number, or remove the row for none.`);
      continue;
    }
    const allowed: readonly string[] = setting.values;
    if (allowed.includes(value)) { (policy as unknown as Record<string, string>)[setting.key] = value; source[setting.key] = "House rules"; }
    else fail(`${setting.name} ${value ? `"${unquote(rawValue)}"` : "has no value"}; use ${allowed.join(" or ")}, or remove the row for the default.`);
  }
  return issues.length ? { ok: false, issues } : { ok: true, policy, source };
}

/** Read the repo-owned Markdown without executing its quick check. */
export function parseSquadronSettings(markdown: string, trackerKind: TrackerKind = detectTracker(null, markdown).kind ?? "linear", houseRulesMarkdown?: string | null): SettingsResult {
  const parts = sections(markdown);
  const issues: SettingsIssue[] = [];
  for (const section of ["Quick check", "Stop list", "Time limits", "Routes", "Final review", "Status mapping", "Scope"] as const) {
    if ((section === "Status mapping" || section === "Scope") && trackerKind !== "linear") continue;
    if (!parts.has(section)) issues.push({ section, message: section === "Scope" ? SCOPE_MISSING
      : section === "Status mapping" ? "Add the Linear status each state uses to docs/agents/squadron.md, as in Squadron's settings template."
      : `Add the ${section} section to docs/agents/squadron.md.` });
  }
  if (issues.length) return { ok: false, issues };
  const quickCheck = /(?:```|~~~)[^\n]*\n([\s\S]*?)(?:```|~~~)/.exec(parts.get("Quick check") ?? "")?.[1].trim() ?? "";
  const checkSetup = /(?:```|~~~)[^\n]*\n([\s\S]*?)(?:```|~~~)/.exec(parts.get("Check setup") ?? "")?.[1].trim();
  const stopList = (parts.get("Stop list") ?? "").split("\n")
    .filter((line) => /^\s*[-*+]\s+/.test(line)).map((line) => line.replace(/^\s*[-*+]\s+/, "").trim());
  const values = new Map(table(parts.get("Time limits") ?? "").map(([key, value]) => [key, value]));
  const duration = (value: string | undefined) => {
    const match = /^(\d+)\s*(h|m|s)$/.exec(value ?? "");
    return match ? Number(match[1]) * ({ h: 3_600_000, m: 60_000, s: 1_000 }[match[2]] ?? 0) : 0;
  };
  const routing = parseRoutes(parts.get("Routes") ?? "", houseRulesMarkdown);
  issues.push(...routing.issues);
  const policy = parseSquadronPolicy(houseRulesMarkdown);
  if (!policy.ok) issues.push(...policy.issues);
  const routes = routing.routes;
  const settings: SquadronSettings = {
      policy: policy.ok ? policy.policy : { ...DEFAULT_POLICY }, policySource: policy.ok ? policy.source : { escalation: "default", lowEffort: "default", checkpoint: "default" },
      quickCheck, stopList,
      ...(checkSetup ? { checkSetup } : {}),
      limits: {
        laneTimeLimitMs: duration(values.get("Lane time limit")), workerTimeLimitMs: duration(values.get("Worker time limit")),
      },
      routes,
      ...(routing.modelRoutes ? { modelRoutes: routing.modelRoutes, routeDefaults: "house-rules" as const } : {}),
      finalReviewFamily: "other",
      statusMapping: {
        lane: { ready: "Todo", flying: "In Progress", inReview: "In Review", landed: "Done" },
        ticket: { waiting: "Todo", working: "In Progress", inBranch: "In Review", done: "Done" },
      },
      scope: null,
      holdLabels: [...DEFAULT_HOLD_LABELS],
  };
  if (!quickCheck) issues.push({ section: "Quick check", message: "Put the quick check command in a fenced code block under Quick check." });
  if (parts.has("Check setup") && !checkSetup) issues.push({ section: "Check setup", message: "Put the check setup command in a fenced code block under Check setup, or omit the section." });
  if (!stopList.length) issues.push({ section: "Stop list", message: "List the problems that stop a merge under Stop list." });
  if (Object.values(settings.limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    issues.push({ section: "Time limits", message: "Set positive durations such as 8 h for both lane and worker time limits." });
  }
  const finalReview = (parts.get("Final review") ?? "").trim().toLowerCase();
  if (finalReview === "other" || finalReview === "same") settings.finalReviewFamily = finalReview;
  else issues.push({ section: "Final review", message: "Set Final review to other or same." });

  const mapping = (parts.get("Status mapping") ?? "").trim();
  if (trackerKind === "linear" && !/^default\.?$/i.test(mapping)) {
    const rows = table(mapping);
    const expected = ["Ready", "Flying", "In review", "Landed", "Waiting", "Working", "In branch", "Done"];
    if (rows.length !== expected.length || expected.some((state) => rows.filter(([name, status]) => name === state && status).length !== 1)
      || rows.some((row) => row.length !== 2)) {
      issues.push({ section: "Status mapping", message: "Use Default, or a State / Linear status table with one nonempty status for Ready, Flying, In review, Landed, Waiting, Working, In branch and Done." });
    } else {
      const names = new Map(rows.map(([name, status]) => [name, status]));
      settings.statusMapping = {
        lane: { ready: names.get("Ready")!, flying: names.get("Flying")!, inReview: names.get("In review")!, landed: names.get("Landed")! },
        ticket: { waiting: names.get("Waiting")!, working: names.get("Working")!, inBranch: names.get("In branch")!, done: names.get("Done")! },
      };
    }
  }
  if (trackerKind === "linear") {
    const scope = parseLinearScope(markdown);
    if (scope.ok) settings.scope = scope.scope;
    else issues.push({ section: "Scope", message: scope.message });
  }
  const holdLabels = parseHoldLabels(parts.get("Hold labels"));
  if (holdLabels) settings.holdLabels = holdLabels;
  else issues.push({ section: "Hold labels", message: HOLD_LABELS_MALFORMED });
  return issues.length ? { ok: false, issues } : { ok: true, settings };
}

/** Matching labels keep file order and ignore case; the default is used only when none match. */
export function resolveRoute(settings: SquadronSettings, labels: readonly string[]): Route {
  return routeValue(matchRoute(settings, labels));
}

/** The route row a ticket's labels select, keeping its label: null for the default (Worker) row. */
export function matchRoute(settings: SquadronSettings, labels: readonly string[]): SquadronRoute {
  const names = new Set(labels.map((label) => label.toLowerCase()));
  const row = settings.routes.find((route) => route.label !== null && route.role === undefined && route.label.toLowerCase() !== "lead" && names.has(route.label.toLowerCase()))
    ?? settings.routes.find((route) => route.label === null);
  if (!row) throw new Error("Add a default route to docs/agents/squadron.md.");
  return row;
}

/** An explicit Lead row overrides spec labels; older settings keep their label-based routing. */
export function resolveLeadRoute(settings: SquadronSettings, labels: readonly string[]): Route {
  const row = settings.routes.find((route) => route.label?.toLowerCase() === "lead");
  return row ? routeValue(row) : resolveRoute(settings, labels);
}

/** Keep policy role identity for launch recording without conflating it with ticket labels. */
export function resolveRoleRoute(settings: SquadronSettings, role: ModelRole): Route {
  const route = settings.modelRoutes?.[role] ?? settings.routes.find((row) => row.role === role);
  if (!route) throw new Error(`Add the ${role} row to House rules Model routes.`);
  return "label" in route ? routeValue(route as SquadronRoute) : { ...route };
}

function routeValue({ label: _label, ...route }: SquadronRoute): Route { return route; }
export const providerFor = (route: Route): string => route.providerId ?? (route.family === "claude" ? "claude-code" : "codex");
export const familyForProvider = (provider: string): Route["family"] => provider === "claude-code" ? "claude" : provider === "codex" ? "gpt" : "unknown";

function parseRoutes(body: string, houseRulesMarkdown?: string | null): {
  routes: SquadronRoute[]; modelRoutes?: Partial<Record<ModelRole, Route>>; issues: SettingsIssue[];
} {
  const issues: SettingsIssue[] = [];
  const fail = (message: string) => issues.push({ section: "Routes", message });
  const shared = /^Defaults: House rules\s*$/m.test(body);
  const rows = table(body);
  const header = body.split("\n").find((line) => line.trim().startsWith("|")) ?? "";
  const providerColumn = /\|\s*Provider\s*\|/i.test(header);
  const noteColumn = /\|\s*Note\s*\|/i.test(header);
  const routes: SquadronRoute[] = [];
  const overrides = new Set<ModelRole>();
  const modelRoutes: Partial<Record<ModelRole, Route>> = {};
  function readRoute(name: string, provider: string, model: string, effort: string, legacy: boolean): Route {
    if (legacy && !["medium", "high"].includes(effort)) fail(`Route ${name}: legacy Family tables use medium or high effort; use Provider for other advertised levels.`);
    if (legacy) provider = provider.toLowerCase() === "claude" ? "claude-code" : provider.toLowerCase() === "gpt" ? "codex" : "";
    if (!name || !provider || !model || !effort) fail(`Route ${name || "(empty)"}: name a provider, model and effort.`);
    if (effort === "low" && name !== "Mechanical") fail(`Route ${name}: low effort is allowed only for Mechanical.`);
    if (name.startsWith("Review") && familyForProvider(provider) === "unknown") fail(`Route ${name}: provider ${provider} has no known review family.`);
    return { family: familyForProvider(provider), model, effort, ...(!legacy || shared ? { providerId: provider } : {}) };
  }
  if (shared) {
    const policy = sections(houseRulesMarkdown ?? "").get("Model routes");
    if (policy === undefined) fail("Defaults: House rules requires a Model routes table in House rules.");
    else {
      const policyRows = table(policy);
      if (!/\|\s*Role\s*\|\s*Provider\s*\|\s*Model\s*\|\s*Effort\s*\|/.test(policy)) fail("House rules Model routes needs Role, Provider, Model and Effort columns.");
      for (const [name = "", provider = "", model = "", effort = "", ...extra] of policyRows) {
        if (!MODEL_ROLES.includes(name as ModelRole)) { fail(`House rules Model routes: unknown role ${name}.`); continue; }
        if (extra.length || modelRoutes[name as ModelRole]) fail(`House rules Model routes: malformed or duplicate ${name} row.`);
        modelRoutes[name as ModelRole] = { ...readRoute(name, provider, model, effort, false), role: name };
      }
      for (const role of MODEL_ROLES) if (!modelRoutes[role]) fail(`House rules Model routes: add the ${role} row.`);
    }
  } else if (/^Defaults:/m.test(body)) fail("Set Routes Defaults to House rules, or omit the Defaults line.");
  for (const cells of rows) {
    const [raw = "", provider = "", model = "", effort = "", note = ""] = cells;
    const name = raw.replace(/^`|`$/g, "");
    if (cells.length !== (noteColumn ? 5 : 4)) fail(`Route ${name}: use the table's columns.`);
    const role = MODEL_ROLES.find((role) => role.toLowerCase() === name.toLowerCase()) ?? (name === "(default)" ? "Worker" : undefined);
    const value = readRoute(role ?? name, provider, model, effort, !providerColumn);
    if (shared && (role || name.toLowerCase() === "review")) {
      if (!/^override:\s*[^,]+\S\s*,\s*\S.+$/i.test(note)) fail(`Route ${name}: Note must say override: <task category or ticket>, <approval source>.`);
      if (!role) fail(`Route ${name}: name Review of claude-code or Review of codex.`);
      else {
        if (overrides.has(role)) fail(`Route ${name}: duplicate override row.`);
        overrides.add(role);
        modelRoutes[role] = { ...value, role, overrideNote: note };
      }
      continue;
    }
    if (routes.some((row) => row.label === (name === "(default)" ? null : name))) fail(`Route ${name}: duplicate row.`);
    routes.push({ label: name === "(default)" ? null : name, ...value, ...(providerColumn && role && name !== "(default)" ? { role } : {}) });
  }
  if (shared) {
    for (const role of MODEL_ROLES) {
      const value = modelRoutes[role];
      if (value) routes.push({ label: role === "Worker" ? null : role, ...value });
    }
  } else if (routes.filter((row) => row.label === null).length !== 1) fail("Include one (default) route row.");
  return { routes, issues, ...(shared ? { modelRoutes } : {}) };
}

/** The resolved policy as the owner reads it: one row per setting with where its value came from. */
export function policyRows(settings: Pick<SquadronSettings, "policy" | "policySource">): { setting: string; value: string; source: PolicySource }[] {
  return POLICY_SETTINGS.map(({ key, name }) => ({ setting: name, value: String(settings.policy[key] ?? "none"), source: settings.policySource[key] }));
}
