// Serves the board from the Linear reader, settings and clock; publishes
// `board-changed` whenever a project's board model changes.
import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Board } from "./board-model.js";
import { boardContract, type ProjectCounts } from "./board-contract.js";
import { boardChanged, publishSquadronSignal } from "./realtime-contract.js";
import { deriveBoard, type BoardInput } from "./board-derive.js";
import type { LinearConnectionState } from "./linear-contract.js";
import { readProjectCheckout } from "./project-checkout.js";
import type { SettingsResult } from "./squadron-settings.js";
import type { DoctorReport } from "./doctor.js";
import type { LeadThread } from "./lead-threads.js";
import type { PullRequestRow } from "./pull-requests.js";
import type { TrackerReader } from "./tracker-contract.js";

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
const WATCH_MS = 30_000;
/** A board page asks again every 30 s while it shows a project; after this, nothing shows it. */
export const SHOWN_MS = 75_000;

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
    /** When a board page last read this project. Only shown projects are polled. */
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
    const environments = (leads ?? []).flatMap(({ thread }) => thread.environmentId ? [thread.environmentId] : []);
    const { board } = deriveBoard({
      snapshot, connection: snapshot.kind === "linear" ? entry.connection!.value : { status: "connected", message: "" },
      settings: entry.settings.value, now: now(),
      doctor: entry.doctor?.value,
      leads,
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

  /** Whether a board page is showing this project now. */
  function isShown(projectId: string): boolean {
    const at = projects.get(projectId)?.shownAt;
    return at !== undefined && now() - at < SHOWN_MS;
  }

  sources.tracker.onChange((projectId) => { if (isShown(projectId)) void refresh(projectId); });

  bb.background.service("board-watcher", { start: async (signal) => {
    const stop = AbortSignal.any([signal, lifetime.signal]);
    while (!stop.aborted) {
      for (const id of [...projects.keys()].filter(isShown)) await refresh(id);
      try { await wait(WATCH_MS, stop); } catch { return; }
    }
  } });

  const pickDb = bb.storage.database();
  pickDb.exec("CREATE TABLE IF NOT EXISTS board_pick (id INTEGER PRIMARY KEY CHECK (id = 1), project_id TEXT NOT NULL)");

  async function listProjects() {
    return (await bb.sdk.projects.list()).map(({ id, name }) => ({ id, name }));
  }

  /** One project's picker row: a fresh read through the reader contract, never a poller. */
  async function counts(projectId: string): Promise<ProjectCounts["projects"][number]> {
    try {
      const snapshot = await (sources.tracker.refresh ?? sources.tracker.getSnapshot)(projectId);
      const note = snapshot.error ?? (snapshot.kind === "linear" && !snapshot.project ? "Choose its Linear project on its board."
        : snapshot.syncedAt === null ? "Not read yet." : null);
      if (note) return { id: projectId, tracker: snapshot.kind, ready: null, flying: null, note };
      const { board } = deriveBoard({ snapshot, connection: { status: "connected", message: "" }, settings: null, now: now(),
        leads: await sources.leads?.(projectId) });
      return { id: projectId, tracker: snapshot.kind, ready: board.ready.length,
        flying: board.lanes.filter((lane) => lane.state !== "landed").length, note: null };
    } catch {
      return { id: projectId, tracker: null, ready: null, flying: null, note: "Couldn't read this project. Make sure its machine is online." };
    }
  }

  bb.rpc.register(boardContract, {
    board: async ({ projectId }) => {
      const entry = project(projectId);
      const wasShown = isShown(projectId);
      entry.shownAt = now();
      // A project nothing was polling is read afresh when a board starts showing it.
      if (!wasShown) await sources.tracker.refresh?.(projectId);
      const board = await compute(projectId, true);
      publishIfChanged(projectId, board);
      return board;
    },
    "board.projects": async () => {
      const listed = await listProjects();
      const row = pickDb.prepare("SELECT project_id FROM board_pick WHERE id = 1").get() as { project_id: string } | undefined;
      return { projects: listed, lastPick: row && listed.some((item) => item.id === row.project_id) ? row.project_id : null };
    },
    "board.projectCounts": async () => ({ projects: await Promise.all((await listProjects()).map(({ id }) => counts(id))) }),
    "board.pick": ({ projectId }) => {
      pickDb.prepare("INSERT INTO board_pick VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id").run(projectId);
      return { projectId };
    },
  });

  return { refresh, isShown };
}
