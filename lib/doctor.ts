export interface DoctorCheck {
  id: "skills" | "settings" | "linear" | "github";
  name: string;
  status: "pass" | "fix";
  message: string;
}
export interface DoctorReport { ready: boolean; checks: DoctorCheck[] }
export interface DoctorInput {
  skills: readonly string[];
  settingsMarkdown: string | null;
  linearConnected: boolean;
  ghAuthenticated: boolean;
}

/** Public, secret-free output shared by the board and preflight callers. */
export function doctor(input: DoctorInput): DoctorReport {
  const requiredSkills = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];
  const missingSkills = requiredSkills.filter((name) => !input.skills.includes(name));
  const parsed = input.settingsMarkdown === null ? null : parseSquadronSettings(input.settingsMarkdown);
  const checks: DoctorCheck[] = [
    {
      id: "skills", name: "Matt's setup", status: missingSkills.length ? "fix" : "pass",
      message: missingSkills.length
        ? `Install Matt Pocock's skills for this repo: ${missingSkills.join(", ")}.`
        : "All six planning, build and review skills are available.",
    },
    {
      id: "settings", name: "Squadron settings", status: parsed?.ok ? "pass" : "fix",
      message: parsed?.ok ? "Quick check, stop list, limits and routes are ready."
        : parsed ? parsed.issues.map((issue) => issue.message).join(" ")
        : "Create docs/agents/squadron.md with Quick check, Stop list, Limits and Routes sections.",
    },
    {
      id: "linear", name: "Linear connection", status: input.linearConnected ? "pass" : "fix",
      message: input.linearConnected ? "Linear is connected." : "Connect Linear in Squadron settings, or reconnect if the connection failed.",
    },
    {
      id: "github", name: "GitHub login", status: input.ghAuthenticated ? "pass" : "fix",
      message: input.ghAuthenticated ? "gh is signed in on this repo's machine."
        : "Install GitHub CLI if needed, then run gh auth login on this repo's machine.",
    },
  ];
  return {
    ready: checks.every((check) => check.status === "pass"), checks,
  };
}
import { parseSquadronSettings } from "./squadron-settings.js";

