import type { AutopilotState } from "../lib/autopilot-contract.js";
import { Term } from "./Term.js";
import "./autopilot.css";

export type AutopilotChange = { status?: "on" | "off"; laneLimit?: number };

/** Project controls stay below the header so the formation and project picker keep their space. */
export function Autopilot({ state, saving = false, onChange }: {
  state: AutopilotState; saving?: boolean; onChange?: (patch: AutopilotChange) => void;
}) {
  const on = state.status === "on";
  return <section className="sq-autopilot" aria-label="Autopilot controls" aria-busy={saving}>
    <button type="button" role="switch" aria-checked={state.status !== "off"} aria-label="Autopilot" className="sq-switch" disabled={saving}
      onClick={() => onChange?.({ status: state.status === "off" ? "on" : "off" })}>
      <span className="sq-switch-track" aria-hidden="true"><span className="sq-switch-knob" /></span>
      <Term text="Autopilot" nested /> <span>{on ? "On" : state.status === "paused" ? "Paused" : "Off"}</span>
    </button>
    <label className="sq-autopilot-limit">Lane limit
      <select value={state.laneLimit} disabled={saving} onChange={(event) => onChange?.({ laneLimit: Number(event.target.value) })}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((limit) => <option key={limit} value={limit}>{limit}</option>)}
      </select>
    </label>
    <span className="sq-autopilot-note">Autopilot runs only while BB runs on this Mac.</span>
    {state.checkingMain ? <span className="sq-autopilot-note" role="status">Checking main…</span> : null}
    {saving ? <span className="sq-autopilot-note" role="status">Saving…</span> : null}
  </section>;
}
