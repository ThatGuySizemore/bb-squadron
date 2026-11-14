import type { TicketState } from "./board-model.js";

/** Tickets whose agent activity is read and kept in view on a Flying lane. */
export function isActiveTicket(state: TicketState): boolean {
  return state === "working" || state === "review" || state === "question" || state === "failed";
}
