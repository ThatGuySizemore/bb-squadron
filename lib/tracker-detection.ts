export type TrackerKind = "linear" | "github" | "local-markdown";
export interface TrackerDetection { kind: TrackerKind | null; reason: string }

/** Level-two sections, excluding examples inside fenced code. */
export function markdownSections(markdown: string): Map<string, string> {
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

export const trackerName = (kind: TrackerKind) => ({ linear: "Linear", github: "GitHub", "local-markdown": "Local markdown" })[kind];

/** Repo text is data. Detection never executes a command or writes a tracker. */
export function detectTracker(issueTrackerMarkdown: string | null, settingsMarkdown: string | null = null): TrackerDetection {
  const override = markdownSections(settingsMarkdown ?? "").get("Tracker");
  if (override !== undefined) {
    const names: Record<string, TrackerKind> = { linear: "linear", github: "github", "local markdown": "local-markdown", "local-markdown": "local-markdown" };
    const kind = names[override.trim().toLowerCase()] ?? null;
    return { kind, reason: kind ? `docs/agents/squadron.md overrides the tracker to ${trackerName(kind)}.`
      : "Set ## Tracker in docs/agents/squadron.md to Linear, GitHub or Local markdown." };
  }
  const text = issueTrackerMarkdown ?? "";
  const declarations: [TrackerKind, RegExp][] = [
    ["local-markdown", /^#\s+Issue tracker:\s*Local Markdown\s*$|\bIssues[^\n.]*live as markdown files in\s+`?\.scratch\//im],
    ["github", /^#\s+Issue tracker:\s*GitHub\s*$|\bIssues[^\n.]*live as GitHub issues\b/im],
    ["linear", /^#\s+Issue tracker:\s*Linear\s*$|\bIssues[^\n.]*live in Linear\b|\bLinear owns[^\n.]*\b(?:planning|issues|work state)\b/im],
  ];
  const candidates = declarations.filter(([, declaration]) => declaration.test(text)).map(([kind]) => kind);
  if (candidates.length === 1) return { kind: candidates[0], reason: `docs/agents/issue-tracker.md declares ${trackerName(candidates[0])} as the issue tracker.` };
  return { kind: null, reason: "Couldn't determine the tracker from docs/agents/issue-tracker.md. Set ## Tracker in docs/agents/squadron.md to Linear, GitHub or Local markdown." };
}
