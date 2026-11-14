// Persist delivery state, not lane decisions. BB and the tracker remain authoritative.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Board } from "./board-model.js";
import type { Helper } from "./helper-contract.js";
import { boardLink, needLine, oneLine, openNeeds } from "./project-observation.js";

const eventSchema = z.object({ projectId: z.string(), key: z.string(), line: z.string(), landing: z.literal(true).optional() });
const deliverySchema = z.object({
  lanes: z.record(z.string(), z.boolean()),
  reported: z.record(z.string(), z.array(z.string())),
  pending: z.record(z.string(), eventSchema),
  firstAt: z.number().nullable(),
  lastAt: z.number().nullable(),
}).refine((value) => !Object.keys(value.pending).length || value.firstAt !== null && value.lastAt !== null);
type DeliveryState = z.infer<typeof deliverySchema>;
const storageKey = "helper.notifications.v1";
const QUIET_MS = 120_000;
const CAP_MS = 600_000;
const RETRY_MS = 30_000;

export function registerHelperNotifier(bb: BbPluginApi, helper: { read(): Promise<Helper | null> }) {
  let state: DeliveryState = { lanes: {}, reported: {}, pending: {}, firstAt: null, lastAt: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  // Pending Needs you items are rechecked after reload before they may be sent.
  const confirmed = new Map<string, Set<string>>();
  const save = () => bb.storage.kv.set(storageKey, state);
  let work: Promise<unknown> = bb.storage.kv.get<unknown>(storageKey).then((saved) => {
    if (saved !== null && saved !== undefined) {
      const parsed = deliverySchema.safeParse(saved);
      if (parsed.success) state = parsed.data;
      else bb.log.warn("Saved Helper notification data is invalid; starting a new observation baseline.");
    }
    schedule();
  });
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const next = work.then(action);
    work = next.catch(() => { bb.log.warn("Helper notification delivery unavailable; will retry."); schedule(RETRY_MS); });
    return next;
  }
  function schedule(retry?: number) {
    clearTimeout(timer);
    if (disposed || !Object.keys(state.pending).length) return;
    const due = Math.min(state.lastAt! + QUIET_MS, state.firstAt! + CAP_MS);
    timer = setTimeout(() => { void serial(flush).catch(() => undefined); }, retry ?? Math.max(0, due - Date.now()));
  }
  async function flush() {
    if (disposed || !Object.keys(state.pending).length) return;
    const selected = await helper.read();
    if (!selected) { schedule(RETRY_MS); return; }
    const events = Object.values(state.pending).filter((event) => event.landing || confirmed.get(event.projectId)?.has(event.key));
    if (!events.length) { schedule(RETRY_MS); return; }
    await bb.sdk.threads.send({ threadId: selected.threadId, mode: "queue-if-active",
      input: [{ type: "text", text: events.map((event) => event.line).sort().join("\n"), mentions: [] }] });
    for (const event of events) {
      const reported = state.reported[event.projectId] ??= [];
      if (!reported.includes(event.key)) reported.push(event.key);
      delete state.pending[JSON.stringify([event.projectId, event.key])];
    }
    if (!Object.keys(state.pending).length) state.firstAt = state.lastAt = null;
    await save();
    schedule(RETRY_MS);
  }
  bb.onDispose(async () => { disposed = true; clearTimeout(timer); await work; });
  function observe(projectId: string, projectName: string, board: Board | null) {
    return serial(async () => {
      if (disposed) return;
      const items = openNeeds(board);
      const current = new Set(items.map((item) => item.key));
      confirmed.set(projectId, current);
      // A failed tracker read cannot establish that an earlier item cleared.
      const complete = board?.tracker?.state === "current";
      if (complete) {
        state.reported[projectId] = (state.reported[projectId] ?? []).filter((key) => key.startsWith("landed:") || current.has(key));
        for (const [id, event] of Object.entries(state.pending))
          if (event.projectId === projectId && !event.landing && !current.has(event.key)) delete state.pending[id];
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
      if (!Object.keys(state.pending).length) state.firstAt = state.lastAt = null;
      else if (added) { state.firstAt ??= Date.now(); state.lastAt = Date.now(); }
      await save();
      schedule();
    });
  }
  return { observe };
}
