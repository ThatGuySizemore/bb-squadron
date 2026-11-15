// SQD-271: the last board read for each project, kept for as long as the page
// lives. The side panel remounts its board on every chat switch; a project it
// has already read opens on this board at once while the refresh runs.
import type { Board } from "../lib/board-model.js";

const lastRead = new Map<string, Board>();

/** The last board read for exactly this project, never another's. */
export function lastBoardOf(projectId: string | null): Board | null {
  return projectId === null ? null : lastRead.get(projectId) ?? null;
}

export function rememberBoard(projectId: string, board: Board): void {
  lastRead.set(projectId, board);
}

/** A page reload starts from nothing; tests stand in for one with this. */
export function forgetBoards(): void {
  lastRead.clear();
}
