// Read-only ticket completion and result evidence for the run report and checkpoint.
// Tickets are read by the IDs their launch records name, never by walking the board.
import { z } from "zod";
import type { LinearAuth } from "./linear-auth.js";
import { LINEAR_QUERIES } from "./linear-queries.js";
import { isDeclinedIssue } from "./linear-issues.js";
import { latestResult, type ResultEvidence } from "./ticket-result.js";
import type { TrackerReader } from "./tracker-contract.js";

export type TicketOutcome = "completed" | "declined" | "open" | "unknown";
export interface TicketHistory {
  id: string;
  identifier: string;
  title: string | null;
  url: string | null;
  /** completed is the tracker's Done; declined is Canceled or Duplicate; unknown means the tracker couldn't say. */
  outcome: TicketOutcome;
  /** The tracker's own completion time, ISO. null when it doesn't report one; never a last-updated time. */
  completedAt: string | null;
  /** The latest result block in the ticket's comments, null when there is none, or "unread" when comments weren't read. */
  result: ResultEvidence | null | "unread";
  problem?: string;
}
export interface HistoryRead {
  /** linear: read by ID from Linear. snapshot: the board's saved tracker reading, which has no dates or comments. */
  source: "linear" | "snapshot";
  tickets: Map<string, TicketHistory>;
}
export interface TicketHistoryReader {
  read(projectId: string, tickets: readonly { id: string; identifier: string }[], options: { comments: boolean; signal?: AbortSignal }): Promise<HistoryRead>;
}

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const response = z.object({ issue: z.object({
  id: z.string(), identifier: z.string(), title: z.string(), url: z.string(),
  completedAt: z.string().nullable(), state: z.object({ type: z.string() }),
  comments: z.object({ nodes: z.array(z.object({ id: z.string(), body: z.string(), createdAt: z.string() })), pageInfo }).optional(),
}).nullable() });

const unknown = (ticket: { id: string; identifier: string }, problem: string): TicketHistory =>
  ({ id: ticket.id, identifier: ticket.identifier, title: null, url: null, outcome: "unknown", completedAt: null, result: "unread", problem });
const outcomeOf = (type: string): TicketOutcome => type === "completed" ? "completed" : isDeclinedIssue({ state: { type } }) ? "declined" : "open";

/**
 * What a saved GitHub or Local markdown state proves. GitHub's saved CLOSED doesn't say whether the issue was
 * completed or closed as not planned, so it stays unknown. Local markdown counts only an explicit `Status: Done`.
 */
export function savedOutcome(kind: string | null, state: { name: string; type: string }): { outcome: TicketOutcome; problem?: string } {
  if (state.type !== "completed") return { outcome: isDeclinedIssue({ state }) ? "declined" : "open" };
  if (kind === "local-markdown" && state.name.trim().toLowerCase() === "done") return { outcome: "completed" };
  return { outcome: "unknown", problem: kind === "github"
    ? "GitHub's saved reading says CLOSED without saying whether the issue was completed or not planned."
    : `Status ${state.name} isn't an explicit Done.` };
}

export function createTicketHistoryReader(linear: Pick<LinearAuth, "graphql">, tracker: Pick<TrackerReader, "getSnapshot">): TicketHistoryReader {
  async function linearTicket(ticket: { id: string; identifier: string }, comments: boolean, signal?: AbortSignal): Promise<TicketHistory> {
    const found: { id: string; body: string; createdAt: string }[] = [];
    const cursors = new Set<string>();
    let after: string | null = null;
    while (true) {
      const parsed = response.safeParse(await linear.graphql(LINEAR_QUERIES.ticketHistory, { id: ticket.id, after, withComments: comments }, signal));
      if (!parsed.success) return unknown(ticket, "Linear's answer didn't match the expected shape.");
      const issue = parsed.data.issue;
      if (!issue) return unknown(ticket, "Linear has no issue with this ID.");
      found.push(...issue.comments?.nodes ?? []);
      const page = issue.comments?.pageInfo;
      if (comments && page?.hasNextPage) {
        if (!page.endCursor || cursors.has(page.endCursor) || cursors.size >= 100) return unknown(ticket, "Linear's comment pages didn't finish.");
        cursors.add(page.endCursor);
        after = page.endCursor;
        continue;
      }
      return { id: ticket.id, identifier: issue.identifier, title: issue.title, url: issue.url, outcome: outcomeOf(issue.state.type),
        completedAt: issue.state.type === "completed" ? issue.completedAt : null,
        result: comments ? latestResult(found.map((item) => ({ commentId: item.id, body: item.body, createdAt: item.createdAt }))) : "unread" };
    }
  }
  return {
    async read(projectId, tickets, options) {
      const snapshot = await tracker.getSnapshot(projectId);
      const result = new Map<string, TicketHistory>();
      if (snapshot.kind === "linear") {
        for (const ticket of tickets) {
          if (result.has(ticket.id)) continue;
          result.set(ticket.id, await linearTicket(ticket, options.comments, options.signal)
            .catch(() => unknown(ticket, "Couldn't read this ticket from Linear.")));
        }
        return { source: "linear", tickets: result };
      }
      // GitHub Issues and Local markdown: the saved reading gives state only, so dates and results stay unknown.
      for (const ticket of tickets) {
        const issue = snapshot.error === null && snapshot.syncedAt !== null ? snapshot.issues.find((item) => item.id === ticket.id) : undefined;
        if (!issue) { result.set(ticket.id, unknown(ticket, snapshot.error ?? "The tracker's saved reading doesn't include this ticket.")); continue; }
        const saved = savedOutcome(snapshot.kind, issue.state);
        result.set(ticket.id, { id: ticket.id, identifier: issue.identifier, title: issue.title, url: issue.url, outcome: saved.outcome, completedAt: null, result: "unread",
          problem: saved.problem ?? "This tracker's saved reading has no completion date or comments." });
      }
      return { source: "snapshot", tickets: result };
    },
  };
}
