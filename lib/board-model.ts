// The board's view model. The prototype fills it from lib/fake-board.ts; the
// live Helper will fill the same shape from Linear, BB threads and GitHub.

export type Family = "claude" | "gpt";

export interface Route {
  family: Family;
  /** Short model name shown on chips, e.g. "Opus 5.5". */
  model: string;
  effort: "medium" | "high";
}

export type TicketState =
  | "blocked" // waits on an open blocker
  | "ready" // frontier: nobody on it yet
  | "working" // a worker thread is building it
  | "question" // the worker asked the owner something
  | "review" // a reviewer from the other family is reading it
  | "branch" // merged into the integration branch (Linear: In Review)
  | "failed" // two strikes; the lane stopped
  | "done"; // the spec's PR merged (Linear: Done)

export interface Ticket {
  id: string;
  title: string;
  blockedBy: string[];
  route: Route;
  state: TicketState;
  /** Minutes of agent time so far. */
  minutes: number;
  /** The worker thread, once one exists. */
  threadId?: string;
  question?: string;
  failure?: string;
}

export type LaneState =
  | "flying"
  | "stopped"
  | "spec-review"
  | "pr-open"
  | "merge-waits"
  | "landed";

export interface PullRequest {
  number: number;
  checks: "pending" | "passing" | "failing";
  url: string;
}

export interface Lane {
  specId: string;
  title: string;
  lead: Route;
  leadThreadId: string;
  branch: string;
  state: LaneState;
  minutes: number;
  /** `accept:owner`: the merge waits for the owner. */
  acceptOwner: boolean;
  tickets: Ticket[];
  pr?: PullRequest;
  stopReason?: string;
  /** When the PR merged (ms since epoch). */
  landedAt?: number;
}

export interface Blocker {
  id: string;
  title: string;
  url: string;
  /** In another Linear team or project than the bound one. */
  outside: boolean;
}

export interface ReadySpec {
  id: string;
  title: string;
  ticketCount: number;
  routes: Route[];
  blockedBy: string[];
  acceptOwner: boolean;
  /** The Linear issue, when the spec is real. */
  url?: string;
  /** Open blockers with their context, when the spec is real. */
  blockers?: Blocker[];
  /** Why Start is disabled, or null when it can start. Set by the Helper core. */
  startReason?: string | null;
}

export interface UnplannedIssue {
  id: string;
  title: string;
  /** Linear priority: 1 urgent … 4 low, 0 none. Absent when the mirror doesn't hold it. */
  priority?: 0 | 1 | 2 | 3 | 4;
  labels: string[];
  /** The Linear issue, when the row is real. */
  url?: string;
  /** Parent context for a sub-issue whose parent isn't a Ready spec. */
  under?: string;
}

export interface LinearStatus {
  state: "disconnected" | "unbound" | "catching-up" | "current" | "failed";
  message: string;
  /** When the copy on the board was read from Linear (ms since epoch). */
  syncedAt: number | null;
  /** "Team · Project" of the bound Linear project. */
  project: string | null;
}

/** A Linear write the outbox can't deliver until the owner acts. */
export interface BlockedWrite {
  /** The outbox receipt. */
  id: string;
  /** The thread that asked for the write, when one did. */
  threadId: string | null;
  /** Issue identifiers the write touches, when the mirror knows them. */
  issues: string[];
  /** Safe reason from the outbox. Never a body or a credential. */
  reason: string;
}

export interface Board {
  tick: number;
  laneCapacity: number;
  workersPerLane: number;
  autoStart: boolean;
  lanes: Lane[];
  ready: ReadySpec[];
  unplanned: UnplannedIssue[];
  /** Where the board's data stands with Linear. Absent on the synthetic demo. */
  linear?: LinearStatus;
  /** Linear writes from the outbox. Absent on the synthetic demo. */
  writes?: { pending: number; blocked: BlockedWrite[]; more: number };
}

export type NeedsYouKind = "setup" | "question" | "stopped" | "write" | "merge";

export interface NeedsYouItem {
  key: string;
  kind: NeedsYouKind;
  /** The spec or issue the item is about, or "" when none. */
  specId: string;
  ticketId?: string;
  text: string;
  threadId: string | null;
  /** The outbox receipt to retry, for a blocked write. */
  writeId?: string;
  /** The issue a blocked write touches. It may be a ticket, so it isn't set in pixel type. */
  issueId?: string;
}

/** What waits on the owner, derived from lane and ticket state, never stored. */
export function needsYou(board: Board): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  if (board.linear?.state === "disconnected" || board.linear?.state === "unbound") {
    items.push({ key: "setup", kind: "setup", specId: "", text: board.linear.message, threadId: null });
  }
  for (const write of board.writes?.blocked ?? []) {
    items.push({
      key: `write:${write.id}`, kind: "write", specId: "", writeId: write.id, threadId: write.threadId,
      ...(write.issues[0] ? { issueId: write.issues[0] } : {}),
      text: `A Linear write${write.issues.length ? ` for ${write.issues.join(", ")}` : ""} couldn't go through. ${write.reason}`,
    });
  }
  if (board.writes && board.writes.more > 0) {
    const more = board.writes.more;
    items.push({ key: "write:more", kind: "write", specId: "", threadId: null,
      text: `${more} more Linear ${more === 1 ? "write" : "writes"} couldn't go through. Retry the ones above first.` });
  }
  for (const lane of board.lanes) {
    if (lane.state === "merge-waits") {
      items.push({
        key: `merge:${lane.specId}`,
        kind: "merge",
        specId: lane.specId,
        text: `PR #${lane.pr?.number} passed checks and both reviews. accept:owner holds it for your merge.`,
        threadId: lane.leadThreadId,
      });
    }
    if (lane.state === "stopped") {
      items.push({
        key: `stopped:${lane.specId}`,
        kind: "stopped",
        specId: lane.specId,
        text: lane.stopReason ?? "The lane stopped.",
        threadId: lane.leadThreadId,
      });
    }
    for (const ticket of lane.tickets) {
      if (ticket.state === "question" && ticket.threadId) {
        items.push({
          key: `question:${ticket.id}`,
          kind: "question",
          specId: lane.specId,
          ticketId: ticket.id,
          text: ticket.question ?? "The worker asked a question.",
          threadId: ticket.threadId,
        });
      }
    }
  }
  const order: Record<NeedsYouKind, number> = { setup: 0, stopped: 1, question: 2, write: 3, merge: 4 };
  return items.sort((a, b) => order[a.kind] - order[b.kind]);
}

/** Tickets grouped into columns by dependency depth, blockers first. */
export function dependencyColumns(tickets: Ticket[]): Ticket[][] {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const ticket = byId.get(id);
    if (!ticket || seen.has(id)) return 0;
    seen.add(id);
    const inLane = ticket.blockedBy.filter((b) => byId.has(b));
    const d = inLane.length === 0 ? 0 : 1 + Math.max(...inLane.map((b) => visit(b, seen)));
    depth.set(id, d);
    return d;
  };
  for (const t of tickets) visit(t.id, new Set());
  const columns: Ticket[][] = [];
  for (const t of tickets) {
    const d = depth.get(t.id) ?? 0;
    (columns[d] ??= []).push(t);
  }
  return columns.filter(Boolean);
}

export function otherFamily(family: Family): Family {
  return family === "claude" ? "gpt" : "claude";
}

export function reviewerFor(route: Route): Route {
  return otherFamily(route.family) === "claude"
    ? { family: "claude", model: "Opus 5.5", effort: "high" }
    : { family: "gpt", model: "GPT-6.1 Sol", effort: "high" };
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
