// Persist delivery state, not lane decisions. BB and the tracker remain authoritative.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Board } from "./board-model.js";
import type { Helper } from "./helper-contract.js";
import { boardLink, needLine, oneLine, openNeeds } from "./project-observation.js";

// A landing or a plain notice is an event, not Needs you: it needs no recheck and never clears with Needs you.
const eventSchema = z.object({ projectId: z.string(), key: z.string(), line: z.string(), landing: z.literal(true).optional(), notice: z.literal(true).optional() });
/** Plain notice keys. Once reported, a notice is never sent again for that key. */
const NOTICE_PREFIX = "notice:";
const deliverySchema = z.object({
  lanes: z.record(z.string(), z.boolean()),
  reported: z.record(z.string(), z.array(z.string())),
  pending: z.record(z.string(), eventSchema),
  firstAt: z.number().nullable(),
  lastAt: z.number().nullable(),
}).refine((value) => !Object.keys(value.pending).length || value.firstAt !== null && value.lastAt !== null);
type DeliveryState = z.infer<typeof deliverySchema>;
const storageKey = "helper.notifications.projects.v1";
const emptyState = (): DeliveryState => ({ lanes: {}, reported: {}, pending: {}, firstAt: null, lastAt: null });
const QUIET_MS = 120_000;
const CAP_MS = 600_000;
const RETRY_MS = 30_000;

export function registerHelperNotifier(bb: BbPluginApi, helper: { read(projectId: string): Promise<Helper | null> }) {
  let projects: Record<string, DeliveryState> = {};
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  // Pending Needs you items are rechecked after reload before they may be sent.
  const confirmed = new Map<string, Set<string>>();
  const save = () => bb.storage.kv.set(storageKey, projects);
  let work: Promise<unknown> = (async () => {
    const saved = await bb.storage.kv.get<unknown>(storageKey);
    if (saved !== null && saved !== undefined) {
      const parsed = z.record(z.string(), deliverySchema).safeParse(saved);
      if (parsed.success) projects = parsed.data;
      else bb.log.warn("Saved Helper notification data is invalid; starting a new observation baseline.");
    } else {
      const legacy = await bb.storage.kv.get<unknown>("helper.notifications.v1");
      const parsed = deliverySchema.safeParse(legacy);
      if (parsed.success) {
        const state = parsed.data;
        for (const [id, reported] of Object.entries(state.reported)) (projects[id] ??= emptyState()).reported[id] = reported;
        for (const [id, landed] of Object.entries(state.lanes)) {
          const [projectId] = JSON.parse(id) as [string, string];
          (projects[projectId] ??= emptyState()).lanes[id] = landed;
        }
        for (const [id, event] of Object.entries(state.pending)) {
          const target = projects[event.projectId] ??= emptyState();
          target.pending[id] = event;
          target.firstAt = state.firstAt;
          target.lastAt = state.lastAt;
        }
        await save();
      } else if (legacy !== null && legacy !== undefined) bb.log.warn("Saved Helper notification data is invalid; starting a new observation baseline.");
    }
    for (const projectId of Object.keys(projects)) schedule(projectId);
  })();
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const next = work.then(action);
    work = next.catch(() => { bb.log.warn("Helper notification delivery unavailable; will retry."); });
    return next;
  }
  function schedule(projectId: string, retry?: number) {
    clearTimeout(timers.get(projectId));
    timers.delete(projectId);
    const state = projects[projectId];
    if (disposed || !state || !Object.keys(state.pending).length) return;
    const due = Math.min(state.lastAt! + QUIET_MS, state.firstAt! + CAP_MS);
    timers.set(projectId, setTimeout(() => {
      void serial(() => flush(projectId)).catch(() => schedule(projectId, RETRY_MS));
    }, retry ?? Math.max(0, due - Date.now())));
  }
  async function flush(projectId: string) {
    const state = projects[projectId];
    if (disposed || !state || !Object.keys(state.pending).length) return;
    const selected = await helper.read(projectId);
    if (!selected) { schedule(projectId, RETRY_MS); return; }
    const events = Object.values(state.pending).filter((event) => event.landing || event.notice || confirmed.get(event.projectId)?.has(event.key));
    if (!events.length) { schedule(projectId, RETRY_MS); return; }
    await bb.sdk.threads.send({ threadId: selected.threadId, mode: "queue-if-active",
      input: [{ type: "text", text: events.map((event) => event.line).sort().join("\n"), mentions: [] }] });
    for (const event of events) {
      const reported = state.reported[event.projectId] ??= [];
      if (!reported.includes(event.key)) reported.push(event.key);
      delete state.pending[JSON.stringify([event.projectId, event.key])];
    }
    if (!Object.keys(state.pending).length) state.firstAt = state.lastAt = null;
    await save();
    schedule(projectId, RETRY_MS);
  }
  bb.onDispose(async () => { disposed = true; for (const timer of timers.values()) clearTimeout(timer); await work; });
  function observe(projectId: string, projectName: string, board: Board | null) {
    return serial(async () => {
      if (disposed) return;
      const state = projects[projectId] ??= emptyState();
      const items = openNeeds(board);
      const current = new Set(items.map((item) => item.key));
      confirmed.set(projectId, current);
      // A failed tracker read cannot establish that an earlier item cleared.
      const complete = board?.tracker?.state === "current";
      if (complete) {
        state.reported[projectId] = (state.reported[projectId] ?? []).filter((key) => key.startsWith("landed:") || key.startsWith(NOTICE_PREFIX) || current.has(key));
        for (const [id, event] of Object.entries(state.pending))
          if (event.projectId === projectId && !event.landing && !event.notice && !current.has(event.key)) delete state.pending[id];
      }
      let added = false;
      for (const item of items) {
        const id = JSON.stringify([projectId, item.key]);
        if (state.reported[projectId]?.includes(item.key)) continue;
        const line = needLine(projectName, board, item, boardLink(bb));
        if (state.pending[id]) state.pending[id].line = line;
        else { state.pending[id] = { projectId, key: item.key, line }; added = true; }
      }
      if (complete && board) for (const lane of board.lanes) {
        const id = JSON.stringify([projectId, lane.leadThreadId]);
        const landed = lane.state === "landed";
        const key = `landed:${lane.leadThreadId}`;
        const eventId = JSON.stringify([projectId, key]);
        // Initial history is a baseline. Only a lane observed underway can freshly land.
        if (landed && state.lanes[id] === false && !state.reported[projectId]?.includes(key) && !state.pending[eventId]) {
          state.pending[eventId] = { projectId, key, landing: true,
            line: `${oneLine(projectName)} | Landed | ${oneLine(lane.specId)} | The lane landed. | ${lane.pr?.url ?? lane.url ?? `@thread:${lane.leadThreadId}`}` };
          added = true;
        }
        state.lanes[id] = landed;
      }
      // A stalled lane with a Helper gets one plain notice per PR head. It is not Needs you and never repeats for a reported key.
      // A notice still waiting when its stall clears is withdrawn, so the Helper is never told to wake a Lead that has moved on.
      if (complete && board) {
        const stalls = new Map<string, string>();
        for (const lane of board.lanes) if (lane.stall && !lane.stall.owner && lane.pr)
          stalls.set(NOTICE_PREFIX + `stall:${lane.leadThreadId}:${lane.stall.key}`,
            `${oneLine(projectName)} | Stalled | ${oneLine(lane.specId)} | ${oneLine(lane.stall.text)} | ${lane.pr.url}`);
        for (const [id, event] of Object.entries(state.pending))
          if (event.projectId === projectId && event.key.startsWith(NOTICE_PREFIX + "stall:") && !stalls.has(event.key)) delete state.pending[id];
        for (const [key, line] of stalls) added = enqueue(state, projectId, key.slice(NOTICE_PREFIX.length), line) || added;
      }
      if (!Object.keys(state.pending).length) state.firstAt = state.lastAt = null;
      else if (added) { state.firstAt ??= Date.now(); state.lastAt = Date.now(); }
      await save();
      schedule(projectId);
    });
  }
  /** Whether this project's notice was already reported or is waiting for delivery. */
  function noticed(projectId: string, name: string) {
    return serial(async () => {
      const key = NOTICE_PREFIX + name;
      return projects[projectId]?.reported[projectId]?.includes(key) === true || Boolean(projects[projectId]?.pending[JSON.stringify([projectId, key])]);
    });
  }
  /**
   * Queue one plain notice for this project's Helper alone, in the same batch, retry and missing-Helper handling as Needs you.
   * It is neither Needs you nor a landing, and a reported notice never repeats.
   */
  function notice(projectId: string, name: string, line: string) {
    return serial(async () => {
      if (disposed) return;
      const state = projects[projectId] ??= emptyState();
      if (!enqueue(state, projectId, name, line)) return;
      await save();
      schedule(projectId);
    });
  }
  /** Queue a notice unless its key was reported or is already pending; true when it was added. The caller saves and schedules. */
  function enqueue(state: DeliveryState, projectId: string, name: string, line: string): boolean {
    const key = NOTICE_PREFIX + name;
    const id = JSON.stringify([projectId, key]);
    if (state.reported[projectId]?.includes(key) || state.pending[id]) return false;
    state.pending[id] = { projectId, key, line, notice: true };
    state.firstAt ??= Date.now();
    state.lastAt = Date.now();
    return true;
  }
  return { observe, noticed, notice };
}
