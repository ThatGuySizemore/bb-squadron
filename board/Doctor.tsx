import { experimental_FileLink as FileLink, experimental_useRpcQuery as useRpcQuery, useBbContext } from "@get-bb/plugin-sdk/app";
import type { DoctorReport } from "../lib/doctor.js";
import { doctorContract } from "../lib/doctor-contract.js";
import "./doctor.css";

export function DoctorChecks({ report }: { report: DoctorReport }) {
  return (
    <>
    <ul className="sq-doctor-checks" aria-label="Setup checks">
      {report.checks.map((check) => (
        <li key={check.id} className="sq-doctor-check" data-status={check.status}>
          <span className="sq-doctor-name">{check.name}</span>
          <span className="sq-tag">{check.status === "pass" ? "Pass" : check.status === "warning" ? "Warning" : "Fix"}</span>
          <p>{check.message}</p>
        </li>
      ))}
    </ul>
    <p className="sq-doctor-files-title">Configuration files</p>
    <ul className="sq-doctor-files" aria-label="Configuration files">
      {report.configurationFiles.map((file) => (
        <li key={file.id}>
          <FileLink target={{ kind: "host", hostId: file.hostId, path: file.path }}>{file.name}</FileLink>
          <span className="sq-tag">{file.exists ? "Present" : "Missing"}</span>
          <span className="sq-doctor-path">{file.path}</span>
        </li>
      ))}
    </ul>
    </>
  );
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
