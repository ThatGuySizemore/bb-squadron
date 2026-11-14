import { parseSquadronSettings } from "./squadron-settings.js";
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
export interface DoctorReport { ready: boolean; checks: DoctorCheck[]; configurationFiles: ConfigurationFile[] }
export interface DoctorInput {
  /** Only installed plugin skills, with symlinked files excluded by the host. */
  skills: Partial<Record<Family, readonly string[]>>;
  setupFiles: readonly string[];
  settingsMarkdown: string | null;
  issueTrackerMarkdown: string | null;
  linearConnected: boolean;
  ghAuthenticated: boolean;
  configurationFiles: ConfigurationFile[];
}

export const requiredSkills = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];
export const setupFiles = ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"];

/** Public, secret-free output shared by the board and preflight callers. */
export function doctor(input: DoctorInput): DoctorReport {
  const tracker = detectTracker(input.issueTrackerMarkdown, input.settingsMarkdown);
  const parsed = input.settingsMarkdown === null ? null : parseSquadronSettings(input.settingsMarkdown, tracker.kind ?? "linear");
  const families = new Set<Family>(parsed?.ok ? parsed.settings.routes.map((route) => route.family) : ["claude", "gpt"]);
  // An other-family final review also needs its provider's skills installed.
  if (parsed?.ok && parsed.settings.finalReviewFamily === "other") {
    for (const family of [...families]) families.add(family === "claude" ? "gpt" : "claude");
  }
  const missingSkills = [...families].flatMap((family) => {
    const missing = requiredSkills.filter((name) => !input.skills[family]?.includes(name));
    return missing.length ? [`${family === "claude" ? "Claude Code" : "Codex"}: ${missing.join(", ")}`] : [];
  });
  const missingSetup = setupFiles.filter((path) => !input.setupFiles.includes(path));
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
      id: "settings", name: "Project settings", status: parsed?.ok ? "pass" : "fix",
      message: parsed?.ok ? `Quick check, stop list, time limits, routes and final review${tracker.kind === "linear" ? " and status mapping" : ""} are ready.`
        : parsed ? parsed.issues.map((issue) => issue.message).join(" ")
        : `Create docs/agents/squadron.md with Quick check, Stop list, Time limits, Routes, Final review${tracker.kind === "linear" ? " and Status mapping" : ""} sections.`,
    },
    ...((tracker.kind === "linear" ? [{
      id: "linear", name: "Linear key", status: input.linearConnected ? "pass" : "fix",
      message: input.linearConnected ? "The Linear key works." : "Set a working Linear personal API key in BB's secret settings.",
    }] : []) as DoctorCheck[]),
    {
      id: "github", name: "GitHub login", status: input.ghAuthenticated ? "pass" : "fix",
      message: input.ghAuthenticated ? "gh is signed in on this repo's machine."
        : "Install GitHub CLI if needed, then run gh auth login on this repo's machine.",
    },
    ...(["playbook", "machine-profile"] as const).map((id): DoctorCheck => {
      const file = input.configurationFiles.find((file) => file.id === id);
      const name = id === "playbook" ? "Playbook" : "Machine profile";
      return { id, name, status: file?.exists ? "pass" : "warning",
        message: file?.exists ? `${name} is present.` : `Optional: create ${file?.path ?? (id === "playbook" ? "~/.bb-squadron/playbook.md" : "~/.bb-squadron/machine.md")} from the bundled starter template. This file doesn't block Start.` };
    }),
    { id: "tracker", name: tracker.kind ? `Tracker: ${trackerName(tracker.kind)}` : "Tracker", status: tracker.kind ? "pass" : "fix", message: tracker.reason },
  ];
  return { ready: checks.every((check) => check.status !== "fix"), checks, configurationFiles: input.configurationFiles };
}
