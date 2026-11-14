import type { Board } from "./board-model.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { autopilotContract, autopilotStateSchema, type AutopilotState } from "./autopilot-contract.js";
import { boardChanged, publishSquadronSignal } from "./realtime-contract.js";

const PREFIX = "autopilot.project.";
const defaults = (): AutopilotState => ({ status: "off", laneLimit: 3, consecutiveStops: 0, pauseReason: null });
const storedSchema = autopilotStateSchema.extend({
  observedOutcomes: z.record(z.string(), z.enum(["stopped", "landed"])).default({}),
});
type StoredState = z.infer<typeof storedSchema>;

/** Controls plus deduplication markers; lane states remain derived from BB and the tracker. */
export async function registerAutopilot(bb: BbPluginApi) {
  const states = new Map<string, AutopilotState>();
  const pending = new Map<string, Promise<unknown>>();
  const readStored = async (projectId: string): Promise<StoredState> => {
    const parsed = storedSchema.safeParse(await bb.storage.kv.get(PREFIX + projectId));
    return parsed.success ? parsed.data : { ...defaults(), observedOutcomes: {} };
  };
  const get = async (projectId: string): Promise<AutopilotState> => {
    const state = autopilotStateSchema.parse(await readStored(projectId));
    states.set(projectId, state);
    return state;
  };
  for (const key of await bb.storage.kv.list(PREFIX)) await get(key.slice(PREFIX.length));
  /** Serialize read/modify/write so a brake or owner action cannot overwrite another control. */
  function changeStored(projectId: string, change: (state: StoredState) => StoredState): Promise<AutopilotState> {
    const run = (pending.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const previous = await readStored(projectId);
      const stored = storedSchema.parse(change(previous));
      const state = autopilotStateSchema.parse(stored);
      if (JSON.stringify(previous) === JSON.stringify(stored)) return state;
      await bb.storage.kv.set(PREFIX + projectId, stored);
      states.set(projectId, state);
      publishSquadronSignal(bb.realtime, boardChanged, { projectId });
      return state;
    });
    pending.set(projectId, run);
    void run.finally(() => { if (pending.get(projectId) === run) pending.delete(projectId); }).catch(() => undefined);
    return run;
  }
  const update = (projectId: string, change: (state: AutopilotState) => AutopilotState) =>
    changeStored(projectId, (state) => ({ ...state, ...change(autopilotStateSchema.parse(state)) }));
  const set = (projectId: string, patch: { status?: "on" | "off"; laneLimit?: number }) => update(projectId, (state) => ({
    ...state, ...patch, ...(patch.status ? { pauseReason: null } : {}),
  }));
  const pause = (projectId: string, reason: string) => update(projectId, (state) => ({ ...state, status: "paused", pauseReason: reason }));
  const resume = (projectId: string) => update(projectId, (state) => ({ ...state, status: "on", pauseReason: null, consecutiveStops: 0 }));
  const observe = (projectId: string, board: Board) => changeStored(projectId, (state) => {
    if (state.status === "off") return state;
    const observedOutcomes = { ...state.observedOutcomes };
    let consecutiveStops = state.consecutiveStops;
    let status = state.status;
    let pauseReason = state.pauseReason;
    for (const lane of [...board.lanes].sort((a, b) => (a.outcomeAt ?? 0) - (b.outcomeAt ?? 0)
      || a.leadThreadId.localeCompare(b.leadThreadId))) {
      if (lane.outside) continue;
      const outcome = lane.state === "landed" ? "landed"
        : lane.state === "stopped" && !lane.needs?.some((need) => need.kind === "waiting") ? "stopped" : null;
      const previous = observedOutcomes[lane.leadThreadId];
      if (!outcome || previous === outcome || previous === "landed") continue;
      observedOutcomes[lane.leadThreadId] = outcome;
      consecutiveStops = outcome === "landed" ? 0 : consecutiveStops + 1;
      if (consecutiveStops >= 2 && status === "on") {
        status = "paused";
        pauseReason = "Two lanes in a row stopped";
      }
    }
    return { ...state, observedOutcomes, consecutiveStops, status, pauseReason };
  });
  const isOn = (projectId: string) => states.get(projectId)?.status === "on";
  const enabledProjectIds = () => [...states].filter(([, state]) => state.status === "on").map(([id]) => id);
  bb.rpc.register(autopilotContract, {
    "autopilot.get": ({ projectId }) => get(projectId),
    "autopilot.resume": ({ projectId }, context) => {
      if (context.experimental_caller.kind !== "client") throw new Error("Resume Autopilot from the Squadron board.");
      return resume(projectId);
    },
    "autopilot.set": ({ projectId, ...patch }, context) => {
      if (context.experimental_caller.kind !== "client") throw new Error("Change Autopilot from the Squadron board.");
      return set(projectId, patch);
    },
  });
  return { get, set, update, pause, resume, observe, isOn, enabledProjectIds };
}
export type AutopilotControls = Awaited<ReturnType<typeof registerAutopilot>>;

/** Outside lanes and owner merges do not occupy slots; an unanswered question still does. */
export function autopilotLaneCount(board: Board): number {
  return board.lanes.filter((lane) => !lane.outside && lane.state !== "landed" && lane.state !== "merge-waits"
    && (!(lane.stopped ?? lane.state === "stopped") || lane.needs?.some((need) => need.kind === "waiting"))).length;
}
