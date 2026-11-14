/** Membership and lifecycle validity only; this never grants write authority. */
export function isActiveProjectThread(
  thread: { id: string; projectId: string | null; deletedAt: number | null; archivedAt: number | null },
  threadId: string,
  bbProjectId: string,
): boolean {
  return thread.id === threadId && thread.projectId === bbProjectId && thread.deletedAt === null && thread.archivedAt === null;
}
