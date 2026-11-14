import type { Board } from "./board-model.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { autopilotContract, autopilotStateSchema, type AutopilotState } from "./autopilot-contract.js";
import { boardChanged, publishSquadronSignal } from "./realtime-contract.js";

const PREFIX = "autopilot.project.";
const defaults = (): AutopilotState => ({ status: "off", laneLimit: 3, consecutiveStops: 0, pauseReason: null });

/** Owner settings only. Lanes and their outcomes remain derived from BB and the tracker. */
export async function registerAutopilot(bb: BbPluginApi) {
  const states = new Map<string, AutopilotState>();
  const pending = new Map<string, Promise<unknown>>();
  const get = async (projectId: string): Promise<AutopilotState> => {
    const parsed = autopilotStateSchema.safeParse(await bb.storage.kv.get(PREFIX + projectId));
    const state = parsed.success ? parsed.data : defaults();
    states.set(projectId, state);
    return state;
  };
  for (const key of await bb.storage.kv.list(PREFIX)) await get(key.slice(PREFIX.length));
  /** Serialize read/modify/write so a brake or owner action cannot overwrite another control. */
  function update(projectId: string, change: (state: AutopilotState) => AutopilotState): Promise<AutopilotState> {
    const run = (pending.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const state = autopilotStateSchema.parse(change(await get(projectId)));
      await bb.storage.kv.set(PREFIX + projectId, state);
      states.set(projectId, state);
      publishSquadronSignal(bb.realtime, boardChanged, { projectId });
      return state;
    });
    pending.set(projectId, run);
    void run.finally(() => { if (pending.get(projectId) === run) pending.delete(projectId); }).catch(() => undefined);
    return run;
  }
  const set = (projectId: string, patch: { status?: "on" | "off"; laneLimit?: number }) => update(projectId, (state) => ({
    ...state, ...patch, ...(patch.status ? { pauseReason: null } : {}),
  }));
  const pause = (projectId: string, reason: string) => update(projectId, (state) => ({ ...state, status: "paused", pauseReason: reason }));
  const resume = (projectId: string) => update(projectId, (state) => ({ ...state, status: "on", pauseReason: null, consecutiveStops: 0 }));
  const isOn = (projectId: string) => states.get(projectId)?.status === "on";
  const enabledProjectIds = () => [...states].filter(([, state]) => state.status === "on").map(([id]) => id);
  bb.rpc.register(autopilotContract, {
    "autopilot.get": ({ projectId }) => get(projectId),
    "autopilot.set": ({ projectId, ...patch }, context) => {
      if (context.experimental_caller.kind !== "client") throw new Error("Change Autopilot from the Squadron board.");
      return set(projectId, patch);
    },
  });
  return { get, set, update, pause, resume, isOn, enabledProjectIds };
}
export type AutopilotControls = Awaited<ReturnType<typeof registerAutopilot>>;

/** Outside lanes and owner merges do not occupy slots; an unanswered question still does. */
export function autopilotLaneCount(board: Board): number {
  return board.lanes.filter((lane) => !lane.outside && lane.state !== "landed" && lane.state !== "merge-waits"
    && (!(lane.stopped ?? lane.state === "stopped") || lane.needs?.some((need) => need.kind === "waiting"))).length;
}
