import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { linearMirrorContract, MirrorCatalog } from "../lib/linear-mirror-contract.js";

/** Pick the Linear team and project whose open issues fill this BB project's board. */
export function BindProject({ projectId, onBound }: { projectId: string; onBound: () => void }) {
  const rpc = useRpc<typeof linearMirrorContract>();
  const [catalog, setCatalog] = useState<MirrorCatalog | null>(null);
  const [teamId, setTeamId] = useState("");
  const [linearProjectId, setLinearProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    rpc.call("linear.catalog", null).then((next) => {
      if (!current) return;
      setCatalog(next);
      setTeamId(next.teams[0]?.id ?? "");
    }).catch(() => { if (current) setError("Couldn't list Linear teams. Check the Linear connection, then reopen the board."); });
    return () => { current = false; };
  }, [rpc]);
  const projects = catalog?.projects.filter((project) => project.teamIds.includes(teamId)) ?? [];
  // A team change falls back to that team's first project.
  const chosen = projects.some((project) => project.id === linearProjectId) ? linearProjectId : projects[0]?.id ?? "";
  async function bind() {
    setBusy(true); setError("");
    try {
      await rpc.call("linear.bind", { bbProjectId: projectId, teamId, projectId: chosen });
      onBound();
    } catch { setError("Couldn't bind that project. Check that it belongs to the team, then try again."); }
    finally { setBusy(false); }
  }
  if (!catalog) {
    return error ? <span className="sq-bind-error" role="alert">{error}</span> : <span className="sq-bind-wait">Listing Linear teams</span>;
  }
  return (
    <span className="sq-bind">
      <label>
        <span className="sq-sr">Linear team</span>
        <select className="sq-select" value={teamId} disabled={busy} onChange={(event) => setTeamId(event.currentTarget.value)}>
          {catalog.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
        </select>
      </label>
      <label>
        <span className="sq-sr">Linear project</span>
        <select className="sq-select" value={chosen} disabled={busy || !projects.length} onChange={(event) => setLinearProjectId(event.currentTarget.value)}>
          {projects.length ? projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)
            : <option value="">No projects in this team</option>}
        </select>
      </label>
      <button type="button" className="sq-btn" data-tone="amber" disabled={busy || !teamId || !chosen} onClick={() => void bind()}>
        {busy ? "Binding" : "Bind project"}
      </button>
      {error ? <span className="sq-bind-error" role="alert">{error}</span> : null}
    </span>
  );
}
