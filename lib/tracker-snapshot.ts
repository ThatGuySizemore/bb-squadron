import type { MirrorSnapshot } from "./linear-mirror-contract.js";
import type { TrackerSnapshot } from "./tracker-contract.js";

/** The Linear mirror keeps its binding and RPCs; board derivation consumes only this shape. */
export function linearTrackerSnapshot(bbProjectId: string, mirror: MirrorSnapshot): TrackerSnapshot {
  const { binding } = mirror;
  return {
    kind: "linear", bbProjectId,
    project: binding ? { name: `${binding.team.name} · ${binding.project.name}` } : null,
    issues: mirror.issues.map(({ teamId, projectId, ...issue }) => ({
      ...issue, assignees: issue.assignees ?? [],
      inProject: binding ? teamId === binding.team.id && projectId === binding.project.id : issue.inProject,
    })),
    relations: mirror.relations, labels: mirror.labels, states: mirror.states,
    syncedAt: mirror.syncedAt, error: mirror.error,
  };
}
