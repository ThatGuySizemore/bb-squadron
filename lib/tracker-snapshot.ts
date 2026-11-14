import type { MirrorSnapshot } from "./linear-mirror-contract.js";
import type { TrackerSnapshot } from "./tracker-contract.js";

/** The Linear mirror reads its Scope; board derivation consumes only this shape. */
export function linearTrackerSnapshot(bbProjectId: string, mirror: MirrorSnapshot): TrackerSnapshot {
  return {
    kind: "linear", bbProjectId,
    project: mirror.scope ? { name: mirror.scope.name } : null,
    issues: mirror.issues.map(({ teamId: _team, projectId: _project, ...issue }) => ({ ...issue, assignees: issue.assignees ?? [] })),
    relations: mirror.relations, labels: mirror.labels, states: mirror.states,
    syncedAt: mirror.syncedAt, error: mirror.error,
  };
}
