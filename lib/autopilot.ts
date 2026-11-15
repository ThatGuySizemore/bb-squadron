import type { Board } from "./board-model.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { autopilotContract, autopilotStateSchema, type AutopilotState } from "./autopilot-contract.js";
import { boardChanged, publishSquadronSignal } from "./realtime-contract.js";
import { mainCheckResultSchema } from "./main-check-contract.js";
import type { PullRequestRow } from "./pull-requests.js";

const PREFIX = "autopilot.project.";
const defaults = (): AutopilotState => ({ status: "off", laneLimit: 3, consecutiveStops: 0, pauseReason: null });
const outsideReferenceSchema = z.object({ specIdentifier: z.string().optional(), prNumber: z.number().optional() });
const storedSchema = autopilotStateSchema.omit({ checkingMain: true }).extend({
  observedOutcomes: z.record(z.string(), z.enum(["stopped", "landed"])).default({}),
  seenMerges: z.array(z.string()).default([]),
  checkedMerges: z.record(z.string(), mainCheckResultSchema).default({}),
  pendingOutsideEnvironments: z.array(z.string()).default([]),
  unreadableSince: z.record(z.string(), z.number()).default({}),
  outsideNames: z.record(z.string(), z.string()).default({}), // First-candidate display labels, read only for compatibility.
  outsideReferences: z.record(z.string(), outsideReferenceSchema).default({}),
  pendingMainChecks: z.record(z.string(), z.number()).default({}),
  outsideMergeUrls: z.record(z.string(), z.string()).default({}),
});
type StoredState = z.infer<typeof storedSchema>;

/** Controls plus deduplication markers; lane states remain derived from BB and the tracker. */
export async function registerAutopilot(bb: BbPluginApi) {
  const states = new Map<string, StoredState>();
  const pending = new Map<string, Promise<unknown>>();
  let readMergeBaseline: ((projectId: string) => Promise<unknown>) | undefined;
  const setMergeBaselineReader = (read: typeof readMergeBaseline) => { readMergeBaseline = read; };
  const checking = new Map<string, Promise<void>>();
  const retryAfter = new Map<string, number>();
  let disposed = false;
  bb.onDispose(() => { disposed = true; });
  const withCheck = (projectId: string, state: AutopilotState): AutopilotState =>
    (checking.has(projectId) || retryAfter.has(projectId) || Object.keys(states.get(projectId)?.unreadableSince ?? {}).length
      || Object.keys(states.get(projectId)?.pendingMainChecks ?? {}).length) ? { ...state, checkingMain: true } : state;
  const readStored = async (projectId: string): Promise<StoredState> => {
    const parsed = storedSchema.safeParse(await bb.storage.kv.get(PREFIX + projectId));
    return parsed.success ? parsed.data : storedSchema.parse(defaults());
  };
  const get = async (projectId: string): Promise<AutopilotState> => {
    const stored = await readStored(projectId);
    const state = autopilotStateSchema.parse(stored);
    states.set(projectId, stored);
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
      states.set(projectId, stored);
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
    return changeStored(projectId, (state) => {
      if (patch.status === "off") { checking.delete(projectId); retryAfter.delete(projectId); }
      return { ...state, ...patch, ...(patch.status ? { pauseReason: null, pauseLog: undefined } : {}),
        ...(patch.status === "off" ? { pendingOutsideEnvironments: [], unreadableSince: {}, outsideNames: {}, outsideReferences: {}, pendingMainChecks: {}, outsideMergeUrls: {} } : {}) };
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
  const rememberOutside = async (projectId: string, environmentIds: string[], references: Record<string, z.infer<typeof outsideReferenceSchema>> = {}) => {
    await changeStored(projectId, (state) => ({ ...state,
      pendingOutsideEnvironments: [...new Set([...state.pendingOutsideEnvironments, ...environmentIds])].filter(id => !state.skippedMainChecks?.[id]),
      outsideReferences: { ...state.outsideReferences, ...Object.fromEntries(Object.entries(references).map(([id, reference]) =>
        [id, { ...state.outsideReferences[id], ...reference }])) },
    }));
    return (await readStored(projectId)).pendingOutsideEnvironments;
  };
  /** Observe PR evidence independently of the host reservation; never discard a recovered merge. */
  const checkMain = async (projectId: string, merges: { number: number; url: string }[], check: (prNumber: number) => Promise<z.infer<typeof mainCheckResultSchema> & { hostId: string }>, outside: { requests: Record<string, PullRequestRow>; visible: string[] } = { requests: {}, visible: [] }) => {
    const initial = await readStored(projectId);
    if (disposed || initial.status === "off") return get(projectId);
    const retireOutside = () => changeStored(projectId, (state) => {
      if (disposed || state.status === "off") return state;
      const pendingMainChecks = { ...state.pendingMainChecks };
      const outsideMergeUrls = { ...state.outsideMergeUrls };
      for (const pr of merges) {
        if (!state.checkedMerges[pr.url] && !state.seenMerges.includes(pr.url)) pendingMainChecks[pr.url] = pr.number;
      }
      for (const [id, row] of Object.entries(outside.requests)) {
        if (row.outcome === "available" && row.pullRequest.state === "merged") outsideMergeUrls[id] = row.pullRequest.url;
        else if (row.outcome !== "unavailable") delete outsideMergeUrls[id];
      }
      const unreadableSince = { ...state.unreadableSince };
      const outsideReferences = { ...state.outsideReferences };
      for (const [id, row] of Object.entries(outside.requests)) {
        if (row.outcome === "available") outsideReferences[id] = { ...outsideReferences[id], prNumber: row.pullRequest.number };
      }
      const skippedMainChecks = { ...state.skippedMainChecks };
      const pendingOutsideEnvironments = state.pendingOutsideEnvironments.filter((id) => {
        const mergeUrl = outsideMergeUrls[id];
        if (mergeUrl) {
          delete unreadableSince[id];
          if (!state.checkedMerges[mergeUrl] && !state.seenMerges.includes(mergeUrl)) return true;
          delete outsideMergeUrls[id];
          return outside.visible.includes(id);
        }
        const row = outside.requests[id];
        if (row?.outcome === "absent") {
          delete unreadableSince[id];
          return outside.visible.includes(id);
        }
        if (row?.outcome === "available") {
          delete unreadableSince[id];
          return outside.visible.includes(id) || !(row.pullRequest.state === "closed"
            || row.pullRequest.state === "merged" && (state.checkedMerges[row.pullRequest.url] || state.seenMerges.includes(row.pullRequest.url)));
        }
        unreadableSince[id] ??= Date.now();
        if (Date.now() - unreadableSince[id] < 30 * 60_000) return true;
        const reference = outsideReferences[id];
        const name = reference?.prNumber !== undefined ? `PR #${reference.prNumber}`
          : state.outsideNames[id] ?? reference?.specIdentifier ?? id;
        skippedMainChecks[id] = `Couldn't check main after ${name}; Autopilot carried on.`;
        delete unreadableSince[id];
        return false;
      });
      return { ...state, pendingOutsideEnvironments, unreadableSince, outsideReferences, pendingMainChecks, outsideMergeUrls,
        ...(Object.keys(skippedMainChecks).length ? { skippedMainChecks } : {}) };
    });
    await retireOutside();
    if (checking.has(projectId) || Date.now() < (retryAfter.get(projectId) ?? 0)
      || !Object.keys((await readStored(projectId)).pendingMainChecks).length) {
      return get(projectId);
    }
    if (!checking.has(projectId)) {
      const run = Promise.resolve().then(async () => {
        while (true) {
          const state = await readStored(projectId);
          if (disposed || checking.get(projectId) !== run || state.status === "off") return;
          const next = Object.entries(state.pendingMainChecks)[0];
          if (!next) break;
          const [url, number] = next;
          const result = await check(number);
          if (disposed || checking.get(projectId) !== run) return;
          await changeStored(projectId, (state) => {
            if (disposed || checking.get(projectId) !== run || state.seenMerges.includes(url)) return state;
            const pendingMainChecks = { ...state.pendingMainChecks };
            delete pendingMainChecks[url];
            return { ...state,
              pendingMainChecks,
              checkedMerges: { ...state.checkedMerges, [url]: mainCheckResultSchema.parse(result) },
              ...(!result.passed && state.status !== "off" ? { status: "paused" as const,
                pauseReason: "Main fails its quick check", pauseLog: { hostId: result.hostId, path: result.logPath } } : {}),
            };
          });
        }
        if (disposed || checking.get(projectId) !== run) return;
        retryAfter.delete(projectId);
        // PR rows captured when this run began are stale now. The next observation retires sources.
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
  const isOn = (projectId: string) => states.get(projectId)?.status === "on" && !checking.has(projectId) && !retryAfter.has(projectId)
    && !Object.keys(states.get(projectId)?.unreadableSince ?? {}).length && !Object.keys(states.get(projectId)?.pendingMainChecks ?? {}).length;
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
