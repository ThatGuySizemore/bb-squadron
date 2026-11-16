// A lane checks its own result block right after posting it, with the same parser `bb squadron report` uses.
import type { TicketHistoryReader } from "./ticket-history.js";
import type { TicketResult } from "./ticket-result.js";

export type ResultCheck = { ok: true; text: string } | { ok: false; problem: string };

const unknown = "unknown";
const field = <T>(value: T | undefined, show: (value: T) => string) => value === undefined ? unknown : show(value);

/** What the report will show for one block: each field, or unknown. Same wording as the report's ticket lines. */
export function formatResult(identifier: string, result: TicketResult): string {
  return [`${identifier} result block parses.`,
    `Checks: ${field(result.checks, (checks) => checks.length ? checks.map((check) => `${check.command} ${check.result}`).join("; ") : "none required")}`,
    `First pass: ${field(result.firstPass, (value) => value ? "yes" : "no")} | Review defects: ${field(result.reviewDefects, String)} | Repair rounds: ${field(result.repairRounds, String)} | Strikes: ${field(result.strikes, (strikes) => strikes.length ? `${strikes.length} (${strikes.map((strike) => strike.reason).join("; ")})` : "0")} | Owner interventions: ${field(result.ownerInterventions, String)}`,
  ].join("\n") + "\n";
}

/** Reads the ticket's latest result block. A missing or invalid block fails with the parser's own message. */
export async function checkTicketResult(history: TicketHistoryReader, projectId: string, ticket: string): Promise<ResultCheck> {
  const read = await history.read(projectId, [{ id: ticket, identifier: ticket }], { comments: true });
  const found = read.tickets.get(ticket);
  if (!found) return { ok: false, problem: `${ticket} wasn't read.` };
  const { result } = found;
  if (result === "unread") return { ok: false, problem: `${ticket}'s comments weren't read. ${found.problem ?? ""}`.trim() };
  if (result === null) return { ok: false, problem: `${ticket} has no result block in its comments.` };
  if (result.state === "invalid") return { ok: false, problem: `${ticket}: ${result.problem}` };
  return { ok: true, text: formatResult(found.identifier, result.result) };
}
