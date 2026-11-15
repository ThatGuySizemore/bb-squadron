import type { AutopilotState } from "../lib/autopilot-contract.js";
import { Term } from "./Term.js";
import { DitherCanvas } from "./DitherCanvas.js";
import "./autopilot.css";

export type AutopilotChange = { status?: "on" | "off"; laneLimit?: number };

/**
 * Autopilot's switch and lane limit, the last controls in the row under the banner.
 * Its width never depends on its state, so the row keeps its shape; what it is
 * doing right now is said on its note's line. `reserve` holds its place, unseen
 * and inert, before the board's first read.
 */
export function Autopilot({ state, saving = false, onChange, reserve = false }: {
  state: AutopilotState; saving?: boolean; onChange?: (patch: AutopilotChange) => void; reserve?: boolean;
}) {
  const on = state.status === "on";
  // A held place is the real controls, unseen, unread and inert, so it takes exactly their room.
  const held = reserve ? { className: "sq-autopilot sq-reserve", "aria-hidden": true, inert: true } : { className: "sq-autopilot", "aria-label": "Autopilot controls", "aria-busy": saving };
  return <section {...held}>
    {reserve ? <DitherCanvas fx={{ kind: "reading", delay: 0.4, shape: "bar" }} className="sq-reading-bar sq-autopilot-reading" /> : null}
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
  </section>;
}

const RUNS_HERE = "Autopilot runs only while BB runs on this Mac.";

/** Autopilot's note, on its own line under the controls row: what it is doing now, then where it runs. */
export function AutopilotNote({ state, saving = false, reserve = false }: { state?: AutopilotState; saving?: boolean; reserve?: boolean }) {
  const now = [state?.waitingForLinear ? state.pauseReason : null, state?.checkingMain ? "Checking main…" : null, saving ? "Saving…" : null].filter(Boolean);
  // One line always, what Autopilot is doing first; the whole note is its hover title when the line is cut.
  return <p className={reserve ? "sq-autopilot-note sq-autopilot-runtime sq-reserve" : "sq-autopilot-note sq-autopilot-runtime"} aria-hidden={reserve || undefined}
    title={[...now, RUNS_HERE].join(" ")}>
    {state?.waitingForLinear ? <span role="status">{state.pauseReason} </span> : null}
    {state?.checkingMain ? <span role="status">Checking main… </span> : null}
    {saving ? <span role="status">Saving… </span> : null}
    {RUNS_HERE}
  </p>;
}
