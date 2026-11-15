// Serves the board from the tracker reader, settings and clock; publishes
// `board-changed` whenever a project's board model changes.
import { createLiveStepReader } from "./live-step.js";
import { waitFor } from "./watch-clock.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { autopilotLaneCount, type AutopilotControls } from "./autopilot.js";
import type { registerLaneStart } from "./lane-start.js";
import type { Board } from "./board-model.js";
import { boardContract, type ProjectCounts } from "./board-contract.js";
import { boardChanged, publishSquadronSignal, onSquadronSignal } from "./realtime-contract.js";
import { deriveBoard, type BoardInput, type PlanningThread } from "./board-derive.js";
import type { LinearConnectionState } from "./linear-contract.js";
import { readProjectCheckout } from "./project-checkout.js";
import type { ProviderModels } from "./model-capabilities.js";
import type { SettingsResult } from "./squadron-settings.js";
import type { DoctorReport } from "./doctor.js";
import type { LeadThread } from "./lead-threads.js";
import type { PullRequestRow } from "./pull-requests.js";
import type { TrackerReader, TrackerSnapshot } from "./tracker-contract.js";
import { readLaneProgress } from "./lane-progress.js";
import { outsideLaneSpecs, type OutsideLaneReader } from "./outside-lanes.js";
import { mainCheckHostContract } from "./main-check-contract.js";
import { readingProblem } from "./linear-reading.js";

export interface BoardSources {
  autopilot?: AutopilotControls;
  startLane?: ReturnType<typeof registerLaneStart>["startAutomatic"];
  connection(projectId: string): Promise<LinearConnectionState>;
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
    settings?: { at: number; value: SettingsResult | null; catalog?: ProviderModels[] };
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

  async function readSettings(projectId: string, signal: AbortSignal): Promise<{ value: SettingsResult | null; catalog?: ProviderModels[] }> {
    try {
      const checkout = await readProjectCheckout(bb, projectId, signal);
      return { value: checkout?.settings ?? null, catalog: checkout?.providerCatalog };
    } catch { return { value: null }; }
  }

  async function connection(projectId: string): Promise<BoardInput["connection"]> {
    try {
      const value = await sources.connection(projectId);
      return { status: value.status, message: value.message };
    } catch { return { status: "failed", message: "Couldn't check the Linear connection. Try again shortly." }; }
  }

  /** Fresh reads for a page's request; a watcher pass reuses recent ones. */
  async function compute(projectId: string, fresh: boolean): Promise<Board> {
    const entry = project(projectId);
    const at = now();
    const snapshot = await sources.tracker.getSnapshot(projectId);
    if (snapshot.kind === "linear" && (fresh || !entry.connection || at - entry.connection.at > REUSE_MS)) entry.connection = { at, value: await connection(projectId) };
    if (fresh || !entry.settings || at - entry.settings.at > REUSE_MS) entry.settings = { at, ...await readSettings(projectId, lifetime.signal) };
    if (sources.doctor && (fresh || !entry.doctor || at - entry.doctor.at > REUSE_MS)) entry.doctor = { at, value: await sources.doctor(projectId, lifetime.signal) };
    const planning = await sources.planning?.(projectId);
    const leads = await lanesOf(projectId, snapshot, planning);
    const progress = await readLaneProgress(bb, snapshot, leads, lifetime.signal);
    const environments = leads.flatMap(({ thread }) => thread.environmentId ? [thread.environmentId] : []);
    // Outside visibility remains open-only. Its unresolved merge sources survive
    // tracker closure and reload independently, without exposing lane controls.
    const visibleOutside = leads.flatMap(({ outside, thread }) => outside && thread.environmentId ? [thread.environmentId] : []);
    const outsideEnvironments = await sources.autopilot?.rememberOutside(projectId, visibleOutside,
      Object.fromEntries(leads.flatMap(({ outside, thread, specId }) => outside && thread.environmentId
        ? [[thread.environmentId, { specIdentifier: snapshot.issues.find(issue => issue.id === specId)?.identifier ?? specId }]] : []))) ?? [];
    const checkEnvironments = [...new Set([...environments, ...outsideEnvironments])];
    const pullRequests = checkEnvironments.length ? await sources.pullRequests?.(checkEnvironments, lifetime.signal) : undefined;
    const { board } = deriveBoard({
      snapshot, connection: snapshot.kind === "linear" ? entry.connection!.value : { status: "connected", message: "" },
      settings: entry.settings.value, providerCatalog: entry.settings.catalog, now: now(),
      doctor: entry.doctor?.value,
      leads, planning,
      ...progress,
      pullRequests,
    });
    if (sources.autopilot) {
      const problem = readingProblem(snapshot, now());
      const savedLinear = snapshot.kind === "linear" && snapshot.syncedAt !== null;
      // Stops come from live BB threads. A saved tracker completion cannot reset
      // that brake, but a merged PR read in this pass can prove a landing.
      const observation = savedLinear && (snapshot.error || problem)
        ? { ...board, lanes: board.lanes.filter(lane => lane.state !== "landed" || lane.pr?.state === "merged") }
        : board;
      board.autopilot = savedLinear || !snapshot.error && !problem
        ? await sources.autopilot.observe(projectId, observation) : await sources.autopilot.get(projectId);
      if ((savedLinear || !snapshot.error) && snapshot.syncedAt !== null && board.autopilot.status !== "off") {
        // Main is shared: include Outside merges and older Leads hidden by returning lanes.
        const merges = checkEnvironments.flatMap((id) => {
          const row = pullRequests?.[id];
          return row?.outcome === "available" && row.pullRequest.state === "merged" ? [row.pullRequest] : [];
        });
        board.autopilot = await sources.autopilot.checkMain(projectId, merges, async (prNumber) => {
          const checkout = await readProjectCheckout(bb, projectId, lifetime.signal);
          const quickCheck = checkout?.settings?.ok ? checkout.settings.settings.quickCheck : null;
          const checkSetup = checkout?.settings?.ok ? checkout.settings.settings.checkSetup : undefined;
          if (!checkout || !quickCheck) throw new Error("Main quick check setup is unavailable.");
          const result = await bb.hosts.experimental_client({ contract: mainCheckHostContract }).call("runMainQuickCheck",
            { checkoutPath: checkout.path, prNumber, quickCheck, ...(checkSetup ? { checkSetup } : {}) },
            { hostId: checkout.hostId, signal: lifetime.signal, timeoutMs: 32 * 60_000 });
          return { ...result, hostId: checkout.hostId };
        }, { visible: visibleOutside,
          requests: Object.fromEntries(outsideEnvironments.flatMap((id) => pullRequests?.[id] ? [[id, pullRequests[id]]] : [])) });
      }
      // This wait is derived, never stored as an owner-controlled pause. A good
      // read removes it automatically without clearing either existing brake.
      if (snapshot.kind === "linear" && problem && board.autopilot.status === "on") {
        board.autopilot = { ...board.autopilot, status: "paused", pauseReason: problem, waitingForLinear: snapshot.kind === "linear" };
      }
      board.laneCapacity = board.autopilot.laneLimit;
      board.autoStart = board.autopilot.status === "on";
    }
    return board;
  }

  // Switch-on reads merge evidence only, without Doctor, checks, or lane starts.
  sources.autopilot?.setMergeBaselineReader(async (projectId) => {
    const snapshot = await sources.tracker.getSnapshot(projectId);
    if (readingProblem(snapshot, now())) throw new Error("Couldn't read existing merges. Try again shortly.");
    const leads = await lanesOf(projectId, snapshot, await sources.planning?.(projectId));
    const visible = leads.flatMap(({ outside, thread }) => outside && thread.environmentId ? [thread.environmentId] : []);
    const retained = await sources.autopilot!.rememberOutside(projectId, visible,
      Object.fromEntries(leads.flatMap(({ outside, thread, specId }) => outside && thread.environmentId
        ? [[thread.environmentId, { specIdentifier: snapshot.issues.find(issue => issue.id === specId)?.identifier ?? specId }]] : [])));
    const environments = [...new Set([...leads.flatMap(({ thread }) => thread.environmentId ? [thread.environmentId] : []), ...retained])];
    const rows = environments.length ? await sources.pullRequests?.(environments, lifetime.signal) : {};
    await sources.autopilot!.rememberOutside(projectId, [], Object.fromEntries(Object.entries(rows ?? {}).flatMap(([id, row]) =>
      row.outcome === "available" ? [[id, { prNumber: row.pullRequest.number }]] : [])));
    const merges = environments.flatMap(id => {
      const row = rows?.[id];
      if (row?.outcome === "unavailable") throw new Error("Couldn't read existing merges. Try again shortly.");
      return row?.outcome === "available" && row.pullRequest.state === "merged" ? [row.pullRequest] : [];
    });
    await sources.autopilot!.rememberMerges(projectId, merges);
  });

  let publishing = false;
  function publishIfChanged(projectId: string, board: Board) {
    const entry = project(projectId);
    const json = JSON.stringify(board);
    if (entry.published === json) return;
    const first = entry.published === null;
    entry.published = json;
    if (!first) {
      publishing = true;
      try { publishSquadronSignal(bb.realtime, boardChanged, { projectId }); }
      finally { publishing = false; }
    }
  }

  /** Signals that arrive during a refresh coalesce into one more pass. */
  function refresh(projectId: string): Promise<void> {
    const entry = project(projectId);
    if (entry.refreshing) { entry.again = true; return entry.refreshing; }
    const run = async () => {
      // A start emits board-changed. Observe it before the next cycle, without filling every slot at once.
      let attempted = false;
      do {
        entry.again = false;
        if (lifetime.signal.aborted) return;
        let board: Board | null = null;
        try {
          board = await compute(projectId, false);
          publishIfChanged(projectId, board);
          if (!attempted && sources.autopilot?.isOn(projectId) && sources.startLane) {
            const state = await sources.autopilot.get(projectId);
            const flying = autopilotLaneCount(board);
            const next = board.ready.find((spec) => spec.kind !== "work-item" && spec.startReason === null);
            if (board.doctor?.ready && flying < state.laneLimit && next) {
              attempted = true;
              await sources.startLane(projectId, next.id, "autopilot", async () => {
                // Owner controls and hand starts can change while Start checks Doctor.
                const current = await compute(projectId, false);
                return !lifetime.signal.aborted && current.autopilot?.status === "on" && sources.autopilot!.isOn(projectId)
                  && current.ready.some((spec) => spec.id === next.id && spec.kind !== "work-item" && spec.startReason === null)
                  && autopilotLaneCount(current) < current.autopilot.laneLimit;
              });
            }
          }
        }
        catch (error) { bb.log.warn(`board refresh failed: ${error instanceof Error ? error.name : "unknown"}`); }
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

  bb.onDispose(sources.tracker.onChange((projectId) => { void refresh(projectId); }));
  bb.onDispose(onSquadronSignal(bb.realtime, boardChanged, ({ projectId }) => {
    if (!publishing && sources.autopilot?.isEnabled(projectId)) void refresh(projectId);
  }));

  bb.background.service("board-watcher", { start: async (signal) => {
    const stop = AbortSignal.any([signal, lifetime.signal]);
    while (!stop.aborted) {
      const listed = await bb.sdk.projects.list().catch(() => []);
      for (const { id, name } of listed) project(id).name = name;
      const ids = new Set([...listed.map(({ id }) => id), ...sources.autopilot?.enabledProjectIds() ?? []]);
      // A project's refresh retains its own check/start barrier. A long host check
      // must not hold discovery or observation of any other project.
      for (const id of ids) void refresh(id).catch(() => { bb.log.warn("Project observation unavailable."); });
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
      let refreshed = false;
      // A project nothing was polling is read afresh when a board starts showing it.
      if (!wasShown) {
        const snapshot = await sources.tracker.cachedSnapshot?.(projectId);
        const pending = sources.tracker.refresh?.(projectId).then(() => { refreshed = true; });
        if (!snapshot) await pending;
        else void pending?.catch(() => undefined);
      }
      let board = await compute(projectId, true);
      // Use a fast successful refresh if it finished while assembling the board,
      // while a slow request never delays the saved reading.
      if (refreshed) board = await compute(projectId, false);
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
