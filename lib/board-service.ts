// Serves the board from the tracker reader, settings and clock; publishes
// `board-changed` whenever a project's board model changes.
import { createLiveStepReader } from "./live-step.js";
import { waitFor } from "./watch-clock.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Board } from "./board-model.js";
import { boardContract, type ProjectCounts } from "./board-contract.js";
import { boardChanged, publishSquadronSignal } from "./realtime-contract.js";
import { deriveBoard, type BoardInput, type PlanningThread } from "./board-derive.js";
import type { LinearConnectionState } from "./linear-contract.js";
import { readProjectCheckout } from "./project-checkout.js";
import type { SettingsResult } from "./squadron-settings.js";
import type { DoctorReport } from "./doctor.js";
import type { LeadThread } from "./lead-threads.js";
import type { PullRequestRow } from "./pull-requests.js";
import type { TrackerReader, TrackerSnapshot } from "./tracker-contract.js";
import { readLaneProgress } from "./lane-progress.js";
import { outsideLaneSpecs, type OutsideLaneReader } from "./outside-lanes.js";

export interface BoardSources {
  connection(): Promise<LinearConnectionState>;
  observed?(projectId: string, projectName: string, board: Board | null): Promise<void>;
  doctor?(projectId: string, signal?: AbortSignal): Promise<DoctorReport>;
  leads?(projectId: string): Promise<LeadThread[]>;
  /** Open planning threads, so a spec being planned shows under Shaping. */
  planning?(projectId: string): Promise<PlanningThread[]>;
  /** Rows from BB's pull-request plugin for the Leads' environments. */
  pullRequests?(environmentIds: string[], signal?: AbortSignal): Promise<Record<string, PullRequestRow>>;
  tracker: TrackerReader;
  /** Lanes started outside Squadron, shown read-only. */
  outside?: OutsideLaneReader;
}

/** How long a watcher pass may reuse a connection check or settings read. */
const REUSE_MS = 60_000;
/** The watcher's pass interval, for changes nothing announces (clock, settings). */
const WATCH_MS = 30_000;
/** A board page asks again every 30 s while it shows a project; after this, nothing shows it. */
export const SHOWN_MS = 75_000;

export function registerBoard(bb: BbPluginApi, sources: BoardSources, options: {
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
} = {}) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  const liveSteps = createLiveStepReader(bb, now);
  const lifetime = new AbortController();
  bb.onDispose(() => { lifetime.abort(); });
  const projects = new Map<string, {
    published: string | null;
    name?: string;
    /** When a page last read this project, for a fresh read when it reopens. */
    shownAt?: number;
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

  /** Squadron's Leads, then the outside lanes flying the specs no Squadron Lead or planning thread has. */
  async function lanesOf(projectId: string, snapshot: TrackerSnapshot, planning: PlanningThread[] = []): Promise<LeadThread[]> {
    const leads = await sources.leads?.(projectId) ?? [];
    if (!sources.outside) return leads;
    try { return [...leads, ...await sources.outside(projectId, outsideLaneSpecs(snapshot, leads, planning))]; }
    catch (error) {
      // Outside lanes are only shown; failing to read them never hides Squadron's own lanes.
      bb.log.warn(`outside lanes unavailable: ${error instanceof Error ? error.name : "unknown"}`);
      return leads;
    }
  }

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
    const planning = await sources.planning?.(projectId);
    const leads = await lanesOf(projectId, snapshot, planning);
    const progress = await readLaneProgress(bb, snapshot, leads, lifetime.signal);
    const environments = leads.flatMap(({ thread }) => thread.environmentId ? [thread.environmentId] : []);
    const { board } = deriveBoard({
      snapshot, connection: snapshot.kind === "linear" ? entry.connection!.value : { status: "connected", message: "" },
      settings: entry.settings.value, now: now(),
      doctor: entry.doctor?.value,
      leads, planning,
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
        let board: Board | null = null;
        try {
          board = await compute(projectId, false);
          publishIfChanged(projectId, board);
        } catch (error) {
          bb.log.warn(`board refresh failed: ${error instanceof Error ? error.name : "unknown"}`);
        }
        if (sources.observed && !lifetime.signal.aborted) {
          const name = entry.name ?? await bb.sdk.projects.get({ projectId }).then((value) => value.name).catch(() => projectId);
          await sources.observed(projectId, name, board).catch(() => { bb.log.warn("Project notification observation unavailable."); });
        }
      } while (entry.again);
    };
    const running = entry.refreshing = run().finally(() => { if (entry.refreshing === running) entry.refreshing = undefined; });
    return running;
  }

  /** Whether a board page is showing this project now. */
  function isShown(projectId: string): boolean {
    const at = projects.get(projectId)?.shownAt;
    return at !== undefined && now() - at < SHOWN_MS;
  }

  sources.tracker.onChange((projectId) => { void refresh(projectId); });

  bb.background.service("board-watcher", { start: async (signal) => {
    const stop = AbortSignal.any([signal, lifetime.signal]);
    while (!stop.aborted) {
      const listed = await bb.sdk.projects.list().catch(() => []);
      for (const { id, name } of listed) project(id).name = name;
      await Promise.all(listed.map(({ id }) => refresh(id)));
      try { await wait(WATCH_MS, stop); } catch { return; }
    }
  } });

  const pickKey = "board.projectPick";

  async function listProjects() {
    return (await bb.sdk.projects.list()).map(({ id, name }) => ({ id, name }));
  }

  /** One project's picker row: a fresh read through the reader contract, never a poller. */
  async function counts(projectId: string): Promise<ProjectCounts["projects"][number]> {
    try {
      const snapshot = await (sources.tracker.refresh ?? sources.tracker.getSnapshot)(projectId);
      const note = snapshot.error ?? (snapshot.syncedAt === null ? "Not read yet." : null);
      if (note) return { id: projectId, tracker: snapshot.kind, ready: null, flying: null, note };
      const planning = await sources.planning?.(projectId);
      const leads = await lanesOf(projectId, snapshot, planning);
      const progress = await readLaneProgress(bb, snapshot, leads, lifetime.signal);
      const { board } = deriveBoard({ snapshot, connection: { status: "connected", message: "" }, settings: null, now: now(),
        leads, planning, ...progress });
      return { id: projectId, tracker: snapshot.kind, ready: board.ready.length,
        flying: board.lanes.filter((lane) => lane.state !== "landed").length, note: null };
    } catch {
      return { id: projectId, tracker: null, ready: null, flying: null, note: "Couldn't read this project. Make sure its machine is online." };
    }
  }

  bb.rpc.register(boardContract, {
    board: async ({ projectId, visibleLaneIds, refreshLive }) => {
      const entry = project(projectId);
      const wasShown = isShown(projectId);
      entry.shownAt = now();
      // A project nothing was polling is read afresh when a board starts showing it.
      if (!wasShown) await sources.tracker.refresh?.(projectId);
      const board = await compute(projectId, true);
      publishIfChanged(projectId, board);
      return liveSteps(board, projectId, visibleLaneIds, refreshLive);
    },
    "board.projects": async () => {
      const listed = await listProjects();
      const picked = await bb.storage.kv.get<string>(pickKey);
      return { projects: listed, lastPick: picked && listed.some((item) => item.id === picked) ? picked : null };
    },
    "board.projectCounts": async () => ({ projects: await Promise.all((await listProjects()).map(({ id }) => counts(id))) }),
    "board.pick": async ({ projectId }) => {
      await bb.storage.kv.set(pickKey, projectId);
      return { projectId };
    },
  });

  /** A one-shot CLI read does not mark a board page visible. */
  async function read(projectId: string): Promise<Board> {
    await sources.tracker.refresh?.(projectId);
    return compute(projectId, true);
  }

  return { refresh, isShown, read };
}
