import type { Route } from "./board-model.js";

export interface SquadronRoute extends Route {
  /** null is the required fallback row. */
  label: string | null;
}

export interface SquadronSettings {
  quickCheck: string;
  stopList: string[];
  limits: {
    lanesAtOnce: number;
    workersPerLane: number;
    laneTimeLimitMs: number;
    workerTimeLimitMs: number;
  };
  routes: SquadronRoute[];
}

export type SettingsSection = "Quick check" | "Stop list" | "Limits" | "Routes";
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

/** Read the repo-owned Markdown without executing its quick check. */
export function parseSquadronSettings(markdown: string): SettingsResult {
  const parts = sections(markdown);
  const issues: SettingsIssue[] = [];
  for (const section of ["Quick check", "Stop list", "Limits", "Routes"] as const) {
    if (!parts.has(section)) issues.push({ section, message: `Add the ${section} section to docs/agents/squadron.md.` });
  }
  if (issues.length) return { ok: false, issues };
  const quickCheck = /(?:```|~~~)[^\n]*\n([\s\S]*?)(?:```|~~~)/.exec(parts.get("Quick check") ?? "")?.[1].trim() ?? "";
  const stopList = (parts.get("Stop list") ?? "").split("\n")
    .filter((line) => /^\s*[-*+]\s+/.test(line)).map((line) => line.replace(/^\s*[-*+]\s+/, "").trim());
  const values = new Map(table(parts.get("Limits") ?? "").map(([key, value]) => [key, value]));
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
        lanesAtOnce: Number(values.get("Lanes at once")), workersPerLane: Number(values.get("Workers per lane")),
        laneTimeLimitMs: duration(values.get("Lane time limit")), workerTimeLimitMs: duration(values.get("Worker time limit")),
      },
      routes,
  };
  if (!quickCheck) issues.push({ section: "Quick check", message: "Put the quick check command in a fenced code block under Quick check." });
  if (!stopList.length) issues.push({ section: "Stop list", message: "List the problems that stop a merge under Stop list." });
  if (Object.values(settings.limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    issues.push({ section: "Limits", message: "Set positive whole numbers for Lanes at once and Workers per lane, and durations such as 8 h for both time limits." });
  }
  if (!routes.length || routes.filter((row) => row.label === null).length !== 1 ||
    routeRows.some((row) => row.length !== 4) ||
    routes.some((row) => row.label === "" || !["claude", "gpt"].includes(row.family) || !row.model || !["medium", "high"].includes(row.effort))) {
    issues.push({ section: "Routes", message: "Set each route's label, Claude or GPT family, model and medium or high effort. Include one (default) row." });
  }
  return issues.length ? { ok: false, issues } : { ok: true, settings };
}

/** The first matching row wins, including a default row at its written position. */
export function resolveRoute(settings: SquadronSettings, labels: readonly string[]): Route {
  const row = settings.routes.find((route) => route.label === null || labels.includes(route.label));
  if (!row) throw new Error("Add a default route to docs/agents/squadron.md.");
  return { family: row.family, model: row.model, effort: row.effort };
}
