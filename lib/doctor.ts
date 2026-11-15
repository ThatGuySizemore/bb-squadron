import { routeProblem, validateRouteCapabilities, type ProviderModels } from "./model-capabilities.js";
import { launchRoutes, type RouteViewRow } from "./launch-record.js";
import { parseSquadronSettings, markdownSection } from "./squadron-settings.js";
import type { Family } from "./board-model.js";
import { detectTracker, trackerName } from "./tracker-detection.js";

export interface ConfigurationFile {
  id: "repo-rules" | "project-settings" | "playbook" | "machine-profile";
  name: string;
  path: string;
  hostId: string;
  exists: boolean;
}
export interface DoctorCheck {
  id: "skills" | "setup" | "settings" | "linear" | "github" | "playbook" | "machine-profile" | "tracker";
  name: string;
  status: "pass" | "fix" | "warning";
  message: string;
}
export interface DoctorReport {
  ready: boolean; checks: DoctorCheck[]; configurationFiles: ConfigurationFile[];
  /** The route each role and ticket label exception launches on, from the same resolver Start and the board use. */
  routes?: RouteViewRow[];
}
export interface DoctorInput {
  /** Only installed plugin skills, with symlinked files excluded by the host. */
  skills: Partial<Record<Family, readonly string[]>>;
  setupFiles: readonly string[];
  settingsMarkdown: string | null;
  houseRulesMarkdown?: string | null;
  providerCatalog?: readonly ProviderModels[];
  issueTrackerMarkdown: string | null;
  linearConnected: boolean;
  /** A connection note, including a temporary wait for Linear's request budget. */
  linearMessage?: string;
  /** Why the Linear reader couldn't resolve the Scope, such as a name that matches nothing. */
  linearScopeProblem?: string | null;
  ghAuthenticated: boolean;
  ghHostname?: string;
  /** False only for a verified no-remote local tracker checkout. */
  ghRequired?: boolean;
  configurationFiles: ConfigurationFile[];
  /** The host found the legacy name as well as the selected House rules file. */
  legacyHouseRulesExists?: boolean;
}

export const requiredSkills = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];
export const setupFiles = ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"];

/** Public, secret-free output shared by the board and preflight callers. */
export function doctor(input: DoctorInput): DoctorReport {
  const tracker = detectTracker(input.issueTrackerMarkdown, input.settingsMarkdown);
  const parsed = input.settingsMarkdown === null ? null : parseSquadronSettings(input.settingsMarkdown, tracker.kind ?? "linear", input.houseRulesMarkdown);
  const routeProblems = parsed?.ok ? validateRouteCapabilities(parsed.settings, input.providerCatalog ?? []) : [];
  const sharedWarning = parsed?.ok && !parsed.settings.routeDefaults && markdownSection(input.houseRulesMarkdown ?? "", "Model routes") !== undefined;
  const families = new Set<Family>(parsed?.ok ? parsed.settings.routes.map((route) => route.family) : ["claude", "gpt"]);
  // An other-family final review also needs its provider's skills installed.
  if (parsed?.ok && parsed.settings.finalReviewFamily === "other") {
    for (const family of [...families]) families.add(family === "claude" ? "gpt" : "claude");
  }
  const missingSkills = [...families].flatMap((family) => {
    if (family === "unknown") return [];
    const missing = requiredSkills.filter((name) => !input.skills[family]?.includes(name));
    return missing.length ? [`${family === "claude" ? "Claude Code" : "Codex"}: ${missing.join(", ")}`] : [];
  });
  const missingSetup = setupFiles.filter((path) => !input.setupFiles.includes(path));
  const scopeProblem = tracker.kind === "linear" && parsed?.ok ? input.linearScopeProblem ?? null : null;
  const checks: DoctorCheck[] = [
    {
      id: "skills", name: "Matt's plugin", status: missingSkills.length ? "fix" : "pass",
      message: missingSkills.length
        ? `Install Matt Pocock's skills plugin in ${missingSkills.join("; ")}. Hand-copied or symlinked skills don't count.`
        : "Matt's plugin is installed in every required provider.",
    },
    {
      id: "setup", name: "Matt's setup files", status: missingSetup.length ? "fix" : "pass",
      message: missingSetup.length ? `Press Set up to create ${missingSetup.join(", ")} with Matt's setup in a thread.` : "Issue tracker, triage labels and domain docs are present.",
    },
    {
      id: "settings", name: "Project settings", status: parsed?.ok && !scopeProblem && !routeProblems.length ? (sharedWarning ? "warning" : "pass") : "fix",
      message: scopeProblem ?? (routeProblems.length ? routeProblems.map((issue) => issue.message).join(" ") : sharedWarning ? "House rules has Model routes, but this repo keeps its own routes. Add Defaults: House rules to opt in." : parsed?.ok ? `Quick check, stop list, time limits, routes and final review${tracker.kind === "linear" ? ", scope and Linear statuses" : ""} are ready.`
        : parsed ? parsed.issues.map((issue) => issue.message).join(" ")
        : `Create docs/agents/squadron.md with Quick check, Stop list, Time limits, Routes and Final review sections${tracker.kind === "linear" ? ", plus Scope and the Linear status each state uses" : ""}.`),
    },
    ...((tracker.kind === "linear" ? [{
      id: "linear", name: "Linear key", status: input.linearConnected ? "pass" : "fix",
      message: input.linearConnected ? input.linearMessage ?? "The Linear key works." : "Set a working Linear personal API key in BB's secret settings.",
    }] : []) as DoctorCheck[]),
    {
      id: "github", name: "GitHub login", status: input.ghRequired === false || input.ghAuthenticated ? "pass" : "fix",
      message: input.ghRequired === false ? "This local tracker checkout has no remote. GitHub login isn't needed."
        : input.ghAuthenticated ? `gh is signed in${input.ghHostname ? ` to ${input.ghHostname}` : ""} on this repo's machine.`
        : `Install GitHub CLI if needed, then run gh auth login${input.ghHostname ? ` --hostname ${input.ghHostname}` : ""} on this repo's machine.`,
    },
    ...(["playbook", "machine-profile"] as const).map((id): DoctorCheck => {
      const file = input.configurationFiles.find((file) => file.id === id);
      const name = id === "playbook" ? "House rules" : "This machine";
      if (id === "playbook" && file?.exists && /(?:^|[\\/])playbook\.md$/.test(file.path)) {
        return { id, name, status: "warning", message: "Rename playbook.md to house-rules.md" };
      }
      if (id === "playbook" && file?.exists && input.legacyHouseRulesExists) {
        return { id, name, status: "warning", message: "Both house-rules.md and playbook.md are present. Squadron reads house-rules.md." };
      }
      return { id, name, status: file?.exists ? "pass" : "warning",
        message: file?.exists ? `${name} is present.` : `Optional: create ${file?.path ?? (id === "playbook" ? "~/.bb-squadron/house-rules.md" : "~/.bb-squadron/machine.md")} from the bundled starter template. This file doesn't block Start.` };
    }),
    { id: "tracker", name: tracker.kind ? `Tracker: ${trackerName(tracker.kind)}` : "Tracker", status: tracker.kind ? "pass" : "fix", message: tracker.reason },
  ];
  const routes = parsed?.ok ? launchRoutes(parsed.settings).map((row) => {
    const problem = row.route?.providerId && row.route.model ? routeProblem({ providerId: row.route.providerId, model: row.route.model, effort: row.route.effort }, input.providerCatalog ?? []) : null;
    return problem && !row.problem ? { ...row, problem } : row;
  }) : undefined;
  return { ready: checks.every((check) => check.status !== "fix"), checks, configurationFiles: input.configurationFiles, ...(routes ? { routes } : {}) };
}
