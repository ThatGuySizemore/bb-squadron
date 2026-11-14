import type { Route } from "./board-model.js";
import { detectTracker, type TrackerKind } from "./tracker-detection.js";

export interface SquadronRoute extends Route {
  /** null is the required fallback row. */
  label: string | null;
}

export interface SquadronSettings {
  quickCheck: string;
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
export const SCOPE_MISSING = "Add the Scope section to docs/agents/squadron.md, naming at least one of Team, Project, Initiative, Label or View.";

export type SettingsSection = "Quick check" | "Stop list" | "Time limits" | "Routes" | "Final review" | "Status mapping" | "Scope" | "Hold labels";
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

/** Read the repo-owned Markdown without executing its quick check. */
export function parseSquadronSettings(markdown: string, trackerKind: TrackerKind = detectTracker(null, markdown).kind ?? "linear"): SettingsResult {
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
  const stopList = (parts.get("Stop list") ?? "").split("\n")
    .filter((line) => /^\s*[-*+]\s+/.test(line)).map((line) => line.replace(/^\s*[-*+]\s+/, "").trim());
  const values = new Map(table(parts.get("Time limits") ?? "").map(([key, value]) => [key, value]));
  const duration = (value: string | undefined) => {
    const match = /^(\d+)\s*(h|m|s)$/.exec(value ?? "");
    return match ? Number(match[1]) * ({ h: 3_600_000, m: 60_000, s: 1_000 }[match[2]] ?? 0) : 0;
  };
  const routeRows = table(parts.get("Routes") ?? "");
  const routes = routeRows.map(([label = "", family = "", model = "", effort = ""]) => ({
    label: label === "(default)" ? null : label.replace(/^`|`$/g, ""),
    family: family.toLowerCase() as Route["family"], model, effort: effort as Route["effort"],
  }));
  const settings: SquadronSettings = {
      quickCheck, stopList,
      limits: {
        laneTimeLimitMs: duration(values.get("Lane time limit")), workerTimeLimitMs: duration(values.get("Worker time limit")),
      },
      routes,
      finalReviewFamily: "other",
      statusMapping: {
        lane: { ready: "Todo", flying: "In Progress", inReview: "In Review", landed: "Done" },
        ticket: { waiting: "Todo", working: "In Progress", inBranch: "In Review", done: "Done" },
      },
      scope: null,
      holdLabels: [...DEFAULT_HOLD_LABELS],
  };
  if (!quickCheck) issues.push({ section: "Quick check", message: "Put the quick check command in a fenced code block under Quick check." });
  if (!stopList.length) issues.push({ section: "Stop list", message: "List the problems that stop a merge under Stop list." });
  if (Object.values(settings.limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    issues.push({ section: "Time limits", message: "Set positive durations such as 8 h for both lane and worker time limits." });
  }
  if (!routes.length || routes.filter((row) => row.label === null).length !== 1 ||
    routeRows.some((row) => row.length !== 4) ||
    routes.some((row) => row.label === "" || !["claude", "gpt"].includes(row.family) || !row.model || !["medium", "high"].includes(row.effort))) {
    issues.push({ section: "Routes", message: "Set each route's label, Claude or GPT family, model and medium or high effort. Include one (default) row." });
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
  const names = new Set(labels.map((label) => label.toLowerCase()));
  const row = settings.routes.find((route) => route.label !== null && names.has(route.label.toLowerCase()))
    ?? settings.routes.find((route) => route.label === null);
  if (!row) throw new Error("Add a default route to docs/agents/squadron.md.");
  return { family: row.family, model: row.model, effort: row.effort };
}
