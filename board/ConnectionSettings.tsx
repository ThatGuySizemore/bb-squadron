import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useSquadronSignal } from "../hooks/use-squadron-signal.js";
import { linearConnectionChanged } from "../lib/realtime-contract.js";
import { linearContract, type LinearConnectionState } from "../lib/linear-contract.js";
import "./connection.css";

/** The view receives public identity only. BB owns the secret-setting input. */
export function ConnectionView({ connection, busy, error, onCheck }: {
  connection: LinearConnectionState | null;
  busy: boolean;
  error: string;
  onCheck(): void;
}) {
  return (
    <div className="sq sq-connection" aria-busy={busy}>
      <div aria-live="polite" role="status">
        {connection?.workspace && <p className="sq-connection-workspace">{connection.workspace.name}</p>}
        {connection?.actor && <p>Personal account: {connection.actor.name}</p>}
        <p>{connection?.message ?? "Checking the Linear connection…"}</p>
      </div>
      {error && <p className="sq-connection-error" role="alert">{error}</p>}
      <div className="sq-connection-actions">
        <button type="button" className="sq-btn" disabled={busy} onClick={onCheck}>{busy ? "Checking…" : "Check connection"}</button>
      </div>
      <p className="sq-connection-help">Save your personal API key above, then check the connection. The board reads Linear.</p>
    </div>
  );
}

export function ConnectionSettings() {
  const rpc = useRpc<typeof linearContract>();
  const [connection, setConnection] = useState<LinearConnectionState | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    setBusy(true);
    try {
      const next = await rpc.call("linear.connection", null);
      if (current !== request.current) return;
      setConnection(next); setError("");
    } catch {
      if (current === request.current) setError("Couldn't check Linear. Try checking the connection again.");
    } finally { if (current === request.current) setBusy(false); }
  }, [rpc]);
  useEffect(() => { void refresh(); return () => { request.current++; }; }, [refresh]);
  useSquadronSignal(linearConnectionChanged, () => { void refresh(); });
  return <ConnectionView connection={connection} busy={busy} error={error} onCheck={() => { void refresh(); }} />;
}
