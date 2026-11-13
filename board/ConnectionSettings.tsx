import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { linearContract, type LinearConnectionState } from "../lib/linear-contract.js";
import "./connection.css";

type Setup = { callbackUrl: string; oauthConfigured: boolean };

/** The view receives public identity only. BB owns the secret-setting inputs. */
export function ConnectionView({ connection, setup, busy, error, onConnect, onCheck, onDisconnect }: {
  connection: LinearConnectionState | null;
  setup: Setup | null;
  busy: boolean;
  error: string;
  onConnect(): void;
  onCheck(): void;
  onDisconnect(): void;
}) {
  return (
    <div className="sq sq-connection" aria-busy={busy}>
      <div aria-live="polite" role="status">
        {connection?.workspace && <p className="sq-connection-workspace">{connection.workspace.name}</p>}
        {connection?.actor && <p>{connection.mode === "app" ? "App" : "Personal account"}: {connection.actor.name}</p>}
        <p>{connection?.message ?? "Checking the Linear connection…"}</p>
      </div>
      {error && <p className="sq-connection-error" role="alert">{error}</p>}
      <div className="sq-connection-actions">
        <button type="button" className="sq-btn" data-tone="primary" disabled={busy || !setup?.oauthConfigured} onClick={onConnect}>Connect Linear</button>
        <button type="button" className="sq-btn" disabled={busy} onClick={onCheck}>{busy ? "Checking…" : "Check connection"}</button>
        {connection && connection.status !== "disconnected" && (
          <button type="button" className="sq-btn" data-tone="danger" disabled={busy} onClick={onDisconnect}>Disconnect</button>
        )}
      </div>
      {!setup?.oauthConfigured && <p className="sq-connection-help">To connect the Squadron app, save its OAuth client ID and client secret above.</p>}
      <p className="sq-connection-help">For a personal account, save a personal API key above, then check the connection. Writes use that person's name.</p>
      {setup && (
        <details className="sq-connection-help">
          <summary>OAuth app setup</summary>
          <p>In Linear's API settings, create an OAuth app named Squadron. Register this callback URL, then save the app's client ID and client secret above.</p>
          <code className="sq-connection-callback">{setup.callbackUrl}</code>
          <p>Connect Linear requests read and write access and installs the app as the writer.</p>
        </details>
      )}
    </div>
  );
}

export function ConnectionSettings() {
  const rpc = useRpc<typeof linearContract>();
  const navigate = useBbNavigate();
  const [connection, setConnection] = useState<LinearConnectionState | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    setBusy(true);
    try {
      const [next, configuration] = await Promise.all([rpc.call("linear.connection", null), rpc.call("linear.setup", null)]);
      if (current !== request.current) return;
      setConnection(next); setSetup(configuration); setError("");
    } catch {
      if (current === request.current) setError("Couldn't check Linear. Try checking the connection again.");
    } finally { if (current === request.current) setBusy(false); }
  }, [rpc]);
  useEffect(() => { void refresh(); return () => { request.current++; }; }, [refresh]);
  useRealtime("linear-connection-changed", () => { void refresh(); });
  async function connect() {
    setBusy(true); setError("");
    try {
      const { url } = await rpc.call("linear.connect", null);
      if (!navigate.openUrl(url)) setError("Couldn't open Linear. Check your browser settings, then try again.");
    } catch { setError("Couldn't start the connection. Check the OAuth app settings above, then try again."); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    request.current++;
    setBusy(true); setError("");
    try { setConnection(await rpc.call("linear.disconnect", null)); }
    catch { setError("Couldn't disconnect Linear. Try again."); }
    finally { setBusy(false); }
  }
  return <ConnectionView connection={connection} setup={setup} busy={busy} error={error}
    onConnect={() => { void connect(); }} onCheck={() => { void refresh(); }} onDisconnect={() => { void disconnect(); }} />;
}
