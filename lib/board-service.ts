// Serves the board: reads the mirror, settings, outbox health and clock,
// runs the Helper core, carries out its commands, and publishes
// `board-changed` whenever a project's board model changes.
import { setTimeout as delay } from "node:timers/promises";
import { experimental_joinHostPath as joinHostPath } from "@get-bb/plugin-sdk";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Board } from "./board-model.js";
import { BOARD_CHANGED, boardContract, type BoardChanged } from "./board-contract.js";
import { helperCore, type HelperInput, type WriteHealth } from "./helper-core.js";
import type { LinearConnectionState } from "./linear-contract.js";
import type { MirrorSnapshot } from "./linear-mirror-contract.js";
import { parseSquadronSettings, type SettingsResult } from "./squadron-settings.js";

export interface BoardSources {
  connection(): Promise<LinearConnectionState>;
  mirror: {
    getSnapshot(bbProjectId: string): MirrorSnapshot;
    sync(bbProjectId: string): Promise<MirrorSnapshot>;
    onChange(listener: (bbProjectId: string) => void): () => void;
  };
  /** The outbox's safe health read for one BB project. */
  writes?(bbProjectId: string): WriteHealth | null;
}

/** How long a watcher pass may reuse a connection check or settings read. */
const REUSE_MS = 60_000;
/** The watcher's pass interval, for changes nothing announces (clock, outbox). */
const WATCH_MS = 15_000;

export function registerBoard(bb: BbPluginApi, sources: BoardSources, options: {
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
} = {}) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const startedAt = now();
  const lifetime = new AbortController();
  bb.onDispose(() => { lifetime.abort(); });
  const projects = new Map<string, {
    published: string | null;
    connection?: { at: number; value: HelperInput["connection"] };
    settings?: { at: number; value: SettingsResult | null };
    catchingUp?: Promise<unknown>;
  }>();
  const project = (id: string) => {
    let entry = projects.get(id);
    if (!entry) projects.set(id, entry = { published: null });
    return entry;
  };

  async function readSettings(projectId: string, signal: AbortSignal): Promise<SettingsResult | null> {
    try {
      const found = await bb.sdk.projects.get({ projectId, signal });
      const source = found.sources.find((item) => item.isDefault);
      const path = source && joinHostPath({ rootPath: source.path, relativePath: "docs/agents/squadron.md" });
      if (!source || !path) return null;
      const file = await bb.sdk.files.read({ hostId: source.hostId, path, rootPath: source.path, signal });
      return file.contentEncoding === "utf8" ? parseSquadronSettings(file.content) : null;
    } catch { return null; }
  }

  async function connection(): Promise<HelperInput["connection"]> {
    try {
      const value = await sources.connection();
      return { status: value.status, message: value.message };
    } catch { return { status: "failed", message: "Couldn't check the Linear connection. Try again shortly." }; }
  }

  /** Fresh reads for a page's request; a watcher pass reuses recent ones. */
  async function compute(projectId: string, fresh: boolean): Promise<Board> {
    const entry = project(projectId);
    const at = now();
    if (fresh || !entry.connection || at - entry.connection.at > REUSE_MS) entry.connection = { at, value: await connection() };
    if (fresh || !entry.settings || at - entry.settings.at > REUSE_MS) entry.settings = { at, value: await readSettings(projectId, lifetime.signal) };
    let writes: WriteHealth | null = null;
    try { writes = sources.writes?.(projectId) ?? null; } catch { writes = null; }
    const { board, commands } = helperCore({
      snapshot: sources.mirror.getSnapshot(projectId), connection: entry.connection.value,
      settings: entry.settings.value, writes, now: now(), startedAt,
    });
    for (const command of commands) {
      if (command.type === "sync" && !entry.catchingUp && !lifetime.signal.aborted) {
        // A failed read is recorded on the snapshot; either way the board is read again.
        const done = entry.catchingUp = sources.mirror.sync(projectId).catch(() => undefined)
          .finally(() => { if (entry.catchingUp === done) entry.catchingUp = undefined; void refresh(projectId); });
      }
    }
    return board;
  }

  function publishIfChanged(projectId: string, board: Board) {
    const entry = project(projectId);
    const json = JSON.stringify(board);
    if (entry.published === json) return;
    const first = entry.published === null;
    entry.published = json;
    if (!first) bb.realtime.publish(BOARD_CHANGED, { projectId } satisfies BoardChanged);
  }

  async function refresh(projectId: string) {
    if (lifetime.signal.aborted) return;
    try { publishIfChanged(projectId, await compute(projectId, false)); }
    catch (error) { bb.log.warn(`board refresh failed: ${error instanceof Error ? error.name : "unknown"}`); }
  }

  sources.mirror.onChange((projectId) => { void refresh(projectId); });

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
