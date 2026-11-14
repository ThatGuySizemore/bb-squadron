// Synthetic snapshots for board derivation tests. Invented issues only.
import type { MirrorIssue, MirrorSnapshot } from "../../lib/linear-mirror-contract.js";
import { parseSquadronSettings } from "../../lib/squadron-settings.js";
import { readFileSync } from "node:fs";

const open = { id: "state-todo", name: "Todo", type: "unstarted" };
const closed = { id: "state-done", name: "Done", type: "completed" };
const labelIds: Record<string, string> = {};
const label = (name: string) => ({ id: (labelIds[name] ??= `label-${name}`), name, color: "#888888" });

export function issue(identifier: string, options: {
  title?: string; parent?: string; labels?: string[]; done?: boolean; outside?: boolean; updatedAt?: string;
} = {}): MirrorIssue {
  const outside = options.outside ?? false;
  const done = options.done ?? false;
  return {
    id: identifier.toLowerCase(), identifier, title: options.title ?? `Issue ${identifier}`, description: null,
    url: `https://linear.app/fixture/issue/${identifier}`, updatedAt: options.updatedAt ?? "2026-11-13T20:00:00.000Z",
    teamId: outside ? "team-other" : "team-one", projectId: outside ? "project-other" : "linear-one",
    parentId: options.parent ? options.parent.toLowerCase() : null,
    state: done ? closed : open, labels: (options.labels ?? []).map(label),
    inProject: !outside && !done,
  };
}

export function blocks(blocker: string, blocked: string) {
  return { id: `${blocker}-blocks-${blocked}`.toLowerCase(), type: "blocks" as const,
    issueId: blocker.toLowerCase(), relatedIssueId: blocked.toLowerCase() };
}

export const SYNCED_AT = Date.parse("2026-11-13T20:00:00.000Z");

export function snapshot(issues: MirrorIssue[], relations: ReturnType<typeof blocks>[] = [],
  overrides: Partial<MirrorSnapshot> = {}): MirrorSnapshot {
  return {
    binding: { bbProjectId: "proj-one", team: { id: "team-one", name: "Fixture team", key: "FIX" },
      project: { id: "linear-one", name: "Fixture project" } },
    issues, relations, labels: [], states: [open, closed], syncedAt: SYNCED_AT, error: null, ...overrides,
  };
}

const parsed = parseSquadronSettings(readFileSync("tests/fixtures/squadron.md", "utf8"));
if (!parsed.ok) throw new Error("The settings fixture must parse.");
export const settings = parsed;

export const connected = { status: "connected" as const, message: "Connected to Fixture workspace." };

/** Board input after a sync during this run of the plugin. */
export function input(snap: MirrorSnapshot, overrides: Record<string, unknown> = {}) {
  return { snapshot: snap, connection: connected, settings,
    now: SYNCED_AT + 5_000, ...overrides };
}
