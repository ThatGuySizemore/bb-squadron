// The small structured result a Lead adds to a ticket's usual completion comment.
// It is ticket evidence, read on demand; Squadron stores no second outcome record.
import { z } from "zod";

/** The fence language that marks the block. Anything else in the comment is prose and never parsed. */
export const RESULT_FENCE = "squadron-result";

const count = z.number().int().nonnegative();
/** Every field is optional: a field the Lead leaves out stays unknown, never zero or passed. */
export const ticketResultSchema = z.object({
  version: z.literal(1),
  /** The required checks for this ticket at its evaluated commit, each with its own result. */
  checks: z.array(z.object({ command: z.string().min(1), result: z.enum(["passed", "failed", "unrun"]) })).optional(),
  /** Whether the first attempt reported done passed its checks and review with no repair. */
  firstPass: z.boolean().optional(),
  /** Review defects confirmed against this ticket, not every finding on the branch. */
  reviewDefects: count.optional(),
  repairRounds: count.optional(),
  /** Qualifying strikes only: a TDD red run, compile error or provider outage is not one. */
  strikes: z.array(z.object({ reason: z.string().min(1) })).optional(),
  /** Needs you items the owner answered for this ticket. */
  ownerInterventions: count.optional(),
});
export type TicketResult = z.infer<typeof ticketResultSchema>;

export interface ResultComment { commentId: string; createdAt: string; body: string }
export type ResultEvidence =
  | { state: "known"; result: TicketResult; commentId: string; createdAt: string }
  | { state: "invalid"; commentId: string; createdAt: string; problem: string };

const fence = new RegExp("^(`{3,}|~{3,})[ \\t]*" + RESULT_FENCE + "[ \\t]*$", "m");

/** The result block in one comment, if it has one. A malformed block is kept as invalid, never guessed at. */
export function parseResultBlock(comment: ResultComment): ResultEvidence | null {
  const open = fence.exec(comment.body);
  if (!open) return null;
  const rest = comment.body.slice(open.index + open[0].length);
  const close = rest.search(new RegExp(`^${open[1][0]}{${open[1].length},}[ \\t]*$`, "m"));
  const where = { commentId: comment.commentId, createdAt: comment.createdAt };
  if (close < 0) return { state: "invalid", ...where, problem: "The result block has no closing fence." };
  let json: unknown;
  try { json = JSON.parse(rest.slice(0, close)); }
  catch { return { state: "invalid", ...where, problem: "The result block isn't valid JSON." }; }
  const parsed = ticketResultSchema.safeParse(json);
  if (!parsed.success) return { state: "invalid", ...where, problem: `The result block doesn't match version 1: ${[...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "root"))].join(", ")}.` };
  return { state: "known", result: parsed.data, ...where };
}

/** The latest result block among a ticket's comments wins, so a recompleted ticket reports its latest result. */
export function latestResult(comments: readonly ResultComment[]): ResultEvidence | null {
  const found = comments.map(parseResultBlock).filter((item): item is ResultEvidence => item !== null);
  return found.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.commentId.localeCompare(a.commentId))[0] ?? null;
}
