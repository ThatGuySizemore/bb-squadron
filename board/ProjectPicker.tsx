// The board header's project picker: every BB project, its tracker kind and
// its Ready and Flying counts. Counts load in one call when the picker opens.
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { boardContract, PickerProjects, ProjectCounts } from "../lib/board-contract.js";
import { trackerName } from "../lib/tracker-detection.js";
import "./picker.css";

/** BB's sidebar filter isn't readable by plugins, so the board opens on the
 * route's project, then the owner's last pick, then an open picker. A pick in
 * this page wins over both. */
export function currentProject(state: { picked: string | null; context: string | null; lastPick: string | null }): string | null {
  return state.picked ?? state.context ?? state.lastPick;
}

/** A small pixel chevron on 2px cells: down when closed, up when open. */
function Chevron({ open }: { open: boolean }) {
  const cells = open ? [[0, 4], [2, 2], [4, 0], [6, 2], [8, 4]] : [[0, 0], [2, 2], [4, 4], [6, 2], [8, 0]];
  return (
    <svg aria-hidden="true" width={10} height={6} viewBox="0 0 10 6" shapeRendering="crispEdges" className="sq-picker-chevron">
      {cells.map(([x, y]) => <rect key={`${x}.${y}`} x={x} y={y} width={2} height={2} />)}
    </svg>
  );
}

export function ProjectButton({ name, open, controls, onToggle }: { name: string | null; open: boolean; controls: string; onToggle: () => void }) {
  return (
    <button type="button" className="sq-picker-button" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <span className="sq-sr">Project: </span>
      <span className="sq-picker-name">{name ?? "Choose a project"}</span>
      <Chevron open={open} />
    </button>
  );
}

function countsText(row: ProjectCounts["projects"][number] | undefined, loading: boolean): string {
  if (loading) return "Counting";
  if (!row) return "No counts";
  if (row.ready === null || row.flying === null) return row.note ?? "No counts";
  return `${row.ready} ready · ${row.flying} flying`;
}

/** The open picker: a flat list in the page flow, like Doctor's checks. */
export function ProjectList({ id, projects, counts, current, onPick }: {
  id: string;
  projects: PickerProjects["projects"];
  /** null while the counts load. */
  counts: ProjectCounts | null;
  current: string | null;
  onPick: (projectId: string) => void;
}) {
  const byId = new Map(counts?.projects.map((row) => [row.id, row]) ?? []);
  return (
    <div id={id} className="sq-picker" role="region" aria-label="BB projects" aria-busy={counts === null}>
      {projects.length === 0 ? <p className="sq-clear">No BB projects yet. Add one in BB's sidebar.</p> : (
        <ul className="sq-picker-list">
          {projects.map((project) => {
            const row = byId.get(project.id);
            const tracker = counts === null ? null : row?.tracker ? trackerName(row.tracker) : "Tracker unknown";
            const unknown = counts === null || !row || row.ready === null || row.flying === null;
            return (
              <li key={project.id}>
                <button type="button" className="sq-picker-row" aria-current={project.id === current} onClick={() => onPick(project.id)}>
                  <span className="sq-picker-row-name">{project.name}</span>
                  {tracker ? <span className="sq-tag">{tracker}</span> : <span />}
                  <span className="sq-picker-counts sq-num" data-unknown={unknown}>{countsText(row, counts === null)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Loads the counts once each time the picker opens. */
export function ProjectListLoader(props: Omit<Parameters<typeof ProjectList>[0], "counts">) {
  const rpc = useRpc<typeof boardContract>();
  const [counts, setCounts] = useState<ProjectCounts | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    rpc.call("board.projectCounts", null).then((next) => { if (current) setCounts(next); })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [rpc]);
  return (
    <>
      <ProjectList {...props} counts={failed ? { projects: [] } : counts} />
      {failed ? <p className="sq-picker-error" role="alert">Couldn't count each project's specs. Pick a project to read its board.</p> : null}
    </>
  );
}
