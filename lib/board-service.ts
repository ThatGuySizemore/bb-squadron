// Serves the board from the Linear reader, settings and clock; publishes
// `board-changed` whenever a project's board model changes.
import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Board } from "./board-model.js";
import { boardContract } from "./board-contract.js";
import { boardChanged, publishSquadronSignal } from "./realtime-contract.js";
import { deriveBoard, type BoardInput } from "./board-derive.js";
import type { LinearConnectionState } from "./linear-contract.js";
import { readProjectCheckout } from "./project-checkout.js";
import type { SettingsResult } from "./squadron-settings.js";
import type { DoctorReport } from "./doctor.js";
import type { LeadThread } from "./lead-threads.js";
import type { PullRequestRow } from "./pull-requests.js";
import type { TrackerReader } from "./tracker-contract.js";
import { readLaneProgress } from "./lane-progress.js";

export interface BoardSources {
  connection(): Promise<LinearConnectionState>;
  doctor?(projectId: string, signal?: AbortSignal): Promise<DoctorReport>;
  leads?(projectId: string): Promise<LeadThread[]>;
  /** Rows from BB's pull-request plugin for the Leads' environments. */
  pullRequests?(environmentIds: string[], signal?: AbortSignal): Promise<Record<string, PullRequestRow>>;
  tracker: TrackerReader;
}

/** How long a watcher pass may reuse a connection check or settings read. */
const REUSE_MS = 60_000;
/** The watcher's pass interval, for changes nothing announces (clock, settings). */
const WATCH_MS = 15_000;

export function registerBoard(bb: BbPluginApi, sources: BoardSources, options: {
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
} = {}) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const lifetime = new AbortController();
  bb.onDispose(() => { lifetime.abort(); });
  const projects = new Map<string, {
    published: string | null;
    connection?: { at: number; value: BoardInput["connection"] };
    settings?: { at: number; value: SettingsResult | null };
    doctor?: { at: number; value: DoctorReport };
    /** The refresh in progress, and whether another signal arrived during it. */
    refreshing?: Promise<void>;
    again?: boolean;
  }>();
  const project = (id: string) => {
    let entry = projects.get(id);
    if (!entry) projects.set(id, entry = { published: null });
    return entry;
  };

  async function readSettings(projectId: string, signal: AbortSignal): Promise<SettingsResult | null> {
    try { return (await readProjectCheckout(bb, projectId, signal))?.settings ?? null; }
    catch { return null; }
  }

  async function connection(): Promise<BoardInput["connection"]> {
    try {
      const value = await sources.connection();
      return { status: value.status, message: value.message };
    } catch { return { status: "failed", message: "Couldn't check the Linear connection. Try again shortly." }; }
  }

  /** Fresh reads for a page's request; a watcher pass reuses recent ones. */
  async function compute(projectId: string, fresh: boolean): Promise<Board> {
    const entry = project(projectId);
    const at = now();
    const snapshot = await sources.tracker.getSnapshot(projectId);
    if (snapshot.kind === "linear" && (fresh || !entry.connection || at - entry.connection.at > REUSE_MS)) entry.connection = { at, value: await connection() };
    if (fresh || !entry.settings || at - entry.settings.at > REUSE_MS) entry.settings = { at, value: await readSettings(projectId, lifetime.signal) };
    if (sources.doctor && (fresh || !entry.doctor || at - entry.doctor.at > REUSE_MS)) entry.doctor = { at, value: await sources.doctor(projectId, lifetime.signal) };
    const leads = await sources.leads?.(projectId);
    const progress = await readLaneProgress(bb, snapshot, leads ?? [], lifetime.signal);
    const environments = (leads ?? []).flatMap(({ thread }) => thread.environmentId ? [thread.environmentId] : []);
    const { board } = deriveBoard({
      snapshot, connection: snapshot.kind === "linear" ? entry.connection!.value : { status: "connected", message: "" },
      settings: entry.settings.value, now: now(),
      doctor: entry.doctor?.value,
      leads,
      ...progress,
      pullRequests: environments.length ? await sources.pullRequests?.(environments, lifetime.signal) : undefined,
    });
    return board;
  }

  function publishIfChanged(projectId: string, board: Board) {
    const entry = project(projectId);
    const json = JSON.stringify(board);
    if (entry.published === json) return;
    const first = entry.published === null;
    entry.published = json;
    if (!first) publishSquadronSignal(bb.realtime, boardChanged, { projectId });
  }

  /** Signals that arrive during a refresh coalesce into one more pass. */
  function refresh(projectId: string): Promise<void> {
    const entry = project(projectId);
    if (entry.refreshing) { entry.again = true; return entry.refreshing; }
    const run = async () => {
      do {
        entry.again = false;
        if (lifetime.signal.aborted) return;
        try { publishIfChanged(projectId, await compute(projectId, false)); }
        catch (error) { bb.log.warn(`board refresh failed: ${error instanceof Error ? error.name : "unknown"}`); }
      } while (entry.again);
    };
    const running = entry.refreshing = run().finally(() => { if (entry.refreshing === running) entry.refreshing = undefined; });
    return running;
  }

  sources.tracker.onChange((projectId) => { void refresh(projectId); });

  bb.background.service("board-watcher", { start: async (signal) => {
    const stop = AbortSignal.any([signal, lifetime.signal]);
    while (!stop.aborted) {
      for (const id of [...projects.keys()]) await refresh(id);
      try { await wait(WATCH_MS, stop); } catch { return; }
    }
  } });

  bb.rpc.register(boardContract, {
    board: async ({ projectId }) => {
      const board = await compute(projectId, true);
      publishIfChanged(projectId, board);
      return board;
    },
  });

  return { refresh };
}
