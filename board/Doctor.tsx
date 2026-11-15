import { experimental_FileLink as FileLink, experimental_useRpcQuery as useRpcQuery, useBbContext } from "@get-bb/plugin-sdk/app";
import type { DoctorReport } from "../lib/doctor.js";
import { doctorContract } from "../lib/doctor-contract.js";
import { Term } from "./Term.js";
import "./doctor.css";

export function DoctorChecks({ report }: { report: DoctorReport }) {
  return (
    <>
    <ul className="sq-doctor-checks" aria-label="Setup checks">
      {report.checks.map((check) => (
        <li key={check.id} className="sq-doctor-check" data-status={check.status}>
          <span className="sq-doctor-name"><Term text={check.name} /></span>
          <span className="sq-tag">{check.status === "pass" ? "Pass" : check.status === "warning" ? "Warning" : "Fix"}</span>
          <p>{check.message}</p>
        </li>
      ))}
    </ul>
    <p className="sq-doctor-files-title">Configuration files</p>
    <ul className="sq-doctor-files" aria-label="Configuration files">
      {report.configurationFiles.map((file) => (
        <li key={file.id}>
          <FileLink target={{ kind: "host", hostId: file.hostId, path: file.path }}><Term text={file.name} nested /></FileLink>
          <span className="sq-tag">{file.exists ? "Present" : "Missing"}</span>
          <span className="sq-doctor-path">{file.path}</span>
        </li>
      ))}
    </ul>
    {report.routes ? <>
      <p className="sq-doctor-files-title">Model routes</p>
      <ul className="sq-doctor-settings" aria-label="Model routes">
        {report.routes.map((row) => (
          <li key={`${row.role}:${row.category ?? ""}`} data-status={row.problem ? "fix" : row.note ? "warning" : "pass"}>
            <span className="sq-doctor-name">{row.category ? `${row.role} for ${row.category} tickets` : row.role}</span>
            <span className="sq-doctor-value">{row.route ? routeWords(row.route) : "Not set"}</span>
            {row.problem || row.note ? <p>{row.problem ?? row.note}</p> : null}
          </li>
        ))}
      </ul>
    </> : null}
    {report.policy ? <>
      <p className="sq-doctor-files-title">Squadron policy</p>
      <ul className="sq-doctor-settings" aria-label="Squadron policy">
        {report.policy.map((row) => (
          <li key={row.setting} data-status={row.source === "default" ? "warning" : "pass"}>
            <span className="sq-doctor-name">{row.setting}</span>
            <span className="sq-doctor-value">{row.value} <span className="sq-tag">{row.source === "default" ? "Default" : "House rules"}</span></span>
            {row.source === "default" ? <p>House rules doesn't set this, so Squadron uses its default.</p> : null}
          </li>
        ))}
      </ul>
    </> : null}
    </>
  );
}

/** Provider, model, effort and tier in the words the Doctor shows; BB's defaults are named as such. */
function routeWords(route: NonNullable<NonNullable<DoctorReport["routes"]>[number]["route"]>): string {
  const model = route.providerId && route.model ? `${route.providerId} · ${route.model}` : "BB's default model";
  const effort = route.effort === "default" ? "BB's default effort" : `${route.effort} effort`;
  return `${model} · ${effort} · ${route.serviceTier} tier`;
}

export function DoctorPanel({ open, id, projectId: chosen }: { open: boolean; id: string; projectId?: string | null }) {
  const context = useBbContext().projectId;
  const projectId = chosen === undefined ? context : chosen;
  const query = useRpcQuery({
    contract: doctorContract, method: "doctor", input: { projectId: projectId ?? "" },
    enabled: open && projectId !== null,
  });
  const summary = query.isFetching ? "Checking setup" : query.error ? "Check again"
    : query.data ? (query.data.ready ? "All checks passed" : "Setup needs attention") : "Check repo setup";
  return (
      <div id={id} className="sq-doctor-body" role="region" aria-label="Doctor" hidden={!open} aria-busy={query.isFetching}>
        <p className="sq-doctor-summary">Doctor: {summary}</p>
        {!projectId ? <p className="sq-clear">Choose a BB project to check its repo setup.</p> : (
          <>
            <div role="status" aria-live="polite">
              {query.isFetching ? <p className="sq-clear">Checking this repo's skills, settings, Linear connection and GitHub login.</p> : null}
              {query.error ? <p className="sq-clear">Couldn't check setup. Make sure this repo's machine is online, then check again.</p> : null}
            </div>
            {query.data && !query.error ? <DoctorChecks report={query.data} /> : null}
            <button type="button" className="sq-btn" disabled={query.isFetching} onClick={() => void query.refetch()}>
              {query.isFetching ? "Checking" : "Check again"}
            </button>
          </>
        )}
      </div>
  );
}
