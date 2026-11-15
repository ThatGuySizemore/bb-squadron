import type { Board } from "./board-model.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { autopilotContract, autopilotStateSchema, type AutopilotState } from "./autopilot-contract.js";
import { boardChanged, publishSquadronSignal } from "./realtime-contract.js";
import { mainCheckResultSchema } from "./main-check-contract.js";
import type { PullRequestRow } from "./pull-requests.js";

const PREFIX = "autopilot.project.";
const defaults = (): AutopilotState => ({ status: "off", laneLimit: 3, consecutiveStops: 0, pauseReason: null });
const storedSchema = autopilotStateSchema.omit({ checkingMain: true }).extend({
  observedOutcomes: z.record(z.string(), z.enum(["stopped", "landed"])).default({}),
  seenMerges: z.array(z.string()).default([]),
  checkedMerges: z.record(z.string(), mainCheckResultSchema).default({}),
  pendingOutsideEnvironments: z.array(z.string()).default([]),
});
type StoredState = z.infer<typeof storedSchema>;

/** Controls plus deduplication markers; lane states remain derived from BB and the tracker. */
export async function registerAutopilot(bb: BbPluginApi) {
  const states = new Map<string, AutopilotState>();
  const pending = new Map<string, Promise<unknown>>();
  let readMergeBaseline: ((projectId: string) => Promise<unknown>) | undefined;
  const setMergeBaselineReader = (read: typeof readMergeBaseline) => { readMergeBaseline = read; };
  const checking = new Map<string, Promise<void>>();
  const retryAfter = new Map<string, number>();
  let disposed = false;
  bb.onDispose(() => { disposed = true; });
  const withCheck = (projectId: string, state: AutopilotState): AutopilotState =>
    (checking.has(projectId) || retryAfter.has(projectId)) ? { ...state, checkingMain: true } : state;
  const readStored = async (projectId: string): Promise<StoredState> => {
    const parsed = storedSchema.safeParse(await bb.storage.kv.get(PREFIX + projectId));
    return parsed.success ? parsed.data : { ...defaults(), observedOutcomes: {}, seenMerges: [], checkedMerges: {}, pendingOutsideEnvironments: [] };
  };
  const get = async (projectId: string): Promise<AutopilotState> => {
    const state = autopilotStateSchema.parse(await readStored(projectId));
    states.set(projectId, state);
    return withCheck(projectId, state);
  };
  for (const key of await bb.storage.kv.list(PREFIX)) await get(key.slice(PREFIX.length));
  /** Serialize read/modify/write so a brake or owner action cannot overwrite another control. */
  function changeStored(projectId: string, change: (state: StoredState) => StoredState | Promise<StoredState>): Promise<AutopilotState> {
    const run = (pending.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const previous = await readStored(projectId);
      const stored = storedSchema.parse(await change(previous));
      if (stored.pauseLog === undefined) delete stored.pauseLog;
      const state = autopilotStateSchema.parse(stored);
      if (JSON.stringify(previous) === JSON.stringify(stored)) return withCheck(projectId, state);
      await bb.storage.kv.set(PREFIX + projectId, stored);
      states.set(projectId, state);
      publishSquadronSignal(bb.realtime, boardChanged, { projectId });
      return withCheck(projectId, state);
    });
    pending.set(projectId, run);
    void run.finally(() => { if (pending.get(projectId) === run) pending.delete(projectId); }).catch(() => undefined);
    return run;
  }
  const update = (projectId: string, change: (state: AutopilotState) => AutopilotState) =>
    changeStored(projectId, (state) => ({ ...state, ...change(autopilotStateSchema.parse(state)) }));
  const set = async (projectId: string, patch: { status?: "on" | "off"; laneLimit?: number }) => {
    if (patch.status === "on" && (await readStored(projectId)).status === "off") await readMergeBaseline?.(projectId);
    return update(projectId, (state) => {
      if (patch.status === "off") { checking.delete(projectId); retryAfter.delete(projectId); }
      return { ...state, ...patch, ...(patch.status ? { pauseReason: null, pauseLog: undefined } : {}) };
    });
  };
  const rememberMerges = (projectId: string, merges: { url: string }[]) => changeStored(projectId, state => ({ ...state,
    seenMerges: [...new Set([...state.seenMerges, ...merges.map(pr => pr.url)])],
  }));
  const pause = (projectId: string, reason: string) => update(projectId, (state) => ({ ...state, status: "paused", pauseReason: reason }));
  const resume = (projectId: string) => update(projectId, (state) => {
    if (state.status !== "paused") throw new Error("Autopilot isn't paused.");
    return { ...state, status: "on", pauseReason: null, pauseLog: undefined, consecutiveStops: 0 };
  });
  /** Retain merge sources while visible or unresolved, even if the tracker later drops the spec. */
  const rememberOutside = async (projectId: string, environmentIds: string[]) => {
    await changeStored(projectId, (state) => ({ ...state,
      pendingOutsideEnvironments: [...new Set([...state.pendingOutsideEnvironments, ...environmentIds])],
    }));
    return (await readStored(projectId)).pendingOutsideEnvironments;
  };
  /** Reserve one background check per project; host work never holds the save queue. */
  const checkMain = async (projectId: string, merges: { number: number; url: string }[], check: (prNumber: number) => Promise<z.infer<typeof mainCheckResultSchema> & { hostId: string }>, outside: { requests: Record<string, PullRequestRow>; visible: string[] } = { requests: {}, visible: [] }) => {
    const initial = await readStored(projectId);
    if (disposed || initial.status === "off" || checking.has(projectId)
      || Date.now() < (retryAfter.get(projectId) ?? 0)) return get(projectId);
    const retireOutside = () => changeStored(projectId, (state) => ({ ...state,
      pendingOutsideEnvironments: state.pendingOutsideEnvironments.filter((id) => {
        if (outside.visible.includes(id)) return true;
        const row = outside.requests[id];
        return !(row?.outcome === "available" && (row.pullRequest.state === "closed"
          || row.pullRequest.state === "merged" && (state.checkedMerges[row.pullRequest.url] || state.seenMerges.includes(row.pullRequest.url))));
      }),
    }));
    if (!merges.some(pr => !initial.checkedMerges[pr.url] && !initial.seenMerges.includes(pr.url))) {
      await retireOutside();
      return get(projectId);
    }
    if (!checking.has(projectId)) {
      const run = Promise.resolve().then(async () => {
        for (const pr of merges) {
          const state = await readStored(projectId);
          if (disposed || checking.get(projectId) !== run || state.status === "off") return;
          if (state.checkedMerges[pr.url] || state.seenMerges.includes(pr.url)) continue;
          const result = await check(pr.number);
          if (disposed || checking.get(projectId) !== run) return;
          await changeStored(projectId, (state) => {
            if (disposed || checking.get(projectId) !== run || state.seenMerges.includes(pr.url)) return state;
            return { ...state,
              checkedMerges: { ...state.checkedMerges, [pr.url]: mainCheckResultSchema.parse(result) },
              ...(!result.passed && state.status !== "off" ? { status: "paused" as const,
                pauseReason: "Main fails its quick check", pauseLog: { hostId: result.hostId, path: result.logPath } } : {}),
            };
          });
        }
        if (disposed || checking.get(projectId) !== run) return;
        retryAfter.delete(projectId);
        await retireOutside();
      }).catch(() => {
        if (disposed || checking.get(projectId) !== run) return;
        retryAfter.set(projectId, Date.now() + 30_000);
        bb.log.warn("Main quick check unavailable; will retry.");
      }).finally(() => {
        if (checking.get(projectId) !== run) return;
        checking.delete(projectId);
        if (!disposed) publishSquadronSignal(bb.realtime, boardChanged, { projectId });
      });
      checking.set(projectId, run);
    }
    return get(projectId);
  };
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
        : lane.state !== "merge-waits" && (lane.stopped ?? lane.state === "stopped")
          && !lane.needs?.some((need) => need.kind === "waiting") ? "stopped" : null;
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
  const isOn = (projectId: string) => states.get(projectId)?.status === "on" && !checking.has(projectId) && !retryAfter.has(projectId);
  const isEnabled = (projectId: string) => states.has(projectId) && states.get(projectId)?.status !== "off";
  const enabledProjectIds = () => [...states].filter(([, state]) => state.status !== "off").map(([id]) => id);
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
  return { get, set, update, pause, resume, observe, checkMain, rememberOutside, rememberMerges, setMergeBaselineReader, isOn, isEnabled, enabledProjectIds };
}
export type AutopilotControls = Awaited<ReturnType<typeof registerAutopilot>>;

/** Outside lanes and owner merges do not occupy slots; an unanswered question still does. */
export function autopilotLaneCount(board: Board): number {
  return board.lanes.filter((lane) => !lane.outside && lane.state !== "landed" && lane.state !== "merge-waits"
    && (!(lane.stopped ?? lane.state === "stopped") || lane.needs?.some((need) => need.kind === "waiting"))).length;
}
