import type { AutopilotState } from "../lib/autopilot-contract.js";
import { Term } from "./Term.js";
import "./autopilot.css";

export type AutopilotChange = { status?: "on" | "off"; laneLimit?: number };

/**
 * Autopilot's switch and lane limit, the last controls in the row under the banner.
 * `reserved` holds its place, invisible and inert, while the board's first read is in
 * flight, so the row doesn't move when the real state arrives (SQD-247).
 */
export function Autopilot({ state, saving = false, onChange, reserved = false }: {
  state: AutopilotState; saving?: boolean; onChange?: (patch: AutopilotChange) => void; reserved?: boolean;
}) {
  const on = state.status === "on";
  return <section className={reserved ? "sq-autopilot sq-reserve" : "sq-autopilot"} aria-label={reserved ? undefined : "Autopilot controls"}
    aria-busy={reserved ? undefined : saving} aria-hidden={reserved || undefined} inert={reserved || undefined}>
    <button type="button" role="switch" aria-checked={state.status !== "off"} aria-label="Autopilot" className="sq-switch" disabled={saving}
      onClick={() => onChange?.({ status: state.status === "off" ? "on" : "off" })}>
      <span className="sq-switch-track" aria-hidden="true"><span className="sq-switch-knob" /></span>
      <Term text="Autopilot" nested /> <span className="sq-autopilot-status">{on ? "On" : state.status === "paused" ? "Paused" : "Off"}</span>
    </button>
    <label className="sq-autopilot-limit">Lane limit
      <select value={state.laneLimit} disabled={saving} onChange={(event) => onChange?.({ laneLimit: Number(event.target.value) })}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((limit) => <option key={limit} value={limit}>{limit}</option>)}
      </select>
    </label>
    {state.checkingMain ? <span className="sq-autopilot-note" role="status">Checking main…</span> : null}
    {saving ? <span className="sq-autopilot-note" role="status">Saving…</span> : null}
  </section>;
}

/** Autopilot's runtime note, on its own line under the controls row; reserved with the controls. */
export function AutopilotNote({ reserved = false }: { reserved?: boolean } = {}) {
  return <p className={reserved ? "sq-autopilot-note sq-autopilot-runtime sq-reserve" : "sq-autopilot-note sq-autopilot-runtime"}
    aria-hidden={reserved || undefined}>Autopilot runs only while BB runs on this Mac.</p>;
}
