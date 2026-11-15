// Code watches the clock. Only a successful queued send advances summary history.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Board } from "./board-model.js";
import type { Helper } from "./helper-contract.js";
import { oneLine, openNeeds, unreadableProject } from "./project-observation.js";

const key = "helper.summary.projects.v1";
const savedSchema = z.object({
  boundary: z.number().nullable(),
  day: z.string().nullable(),
  seen: z.array(z.string()),
  landed: z.record(z.string(), z.object({ projectId: z.string(), specId: z.string() })),
});
type History = z.infer<typeof savedSchema>;
const emptyHistory = (): History => ({ boundary: null, day: null, seen: [], landed: {} });
const timeSchema = z.string().regex(/^(Off|([01]\d|2[0-3]):[0-5]\d)$/, "Use HH:MM in 24-hour time, or Off.");

export function registerHelperSummary(bb: BbPluginApi, helper: { read(projectId: string): Promise<Helper | null> }) {
  const settings = bb.settings.define({ dailySummaryTime: { type: "string", label: "Daily summary time", default: "08:00",
    description: "Server-local time, HH:MM (24-hour), or Off. One summary per day; a missed time sends on the next schedule check.",
    experimental_schema: timeSchema } });
  let histories: Record<string, History> = {};
  let disposed = false;
  const ready = (async () => {
    const saved = await bb.storage.kv.get<unknown>(key);
    // Refuse corrupt history rather than silently forgetting what was delivered.
    if (saved !== null && saved !== undefined) {
      histories = z.record(z.string(), savedSchema).parse(saved);
      return;
    }
    const legacy = await bb.storage.kv.get<unknown>("helper.summary.v1");
    if (legacy === null || legacy === undefined) return;
    const history = savedSchema.parse(legacy);
    const projects = await bb.sdk.projects.list();
    for (const project of projects) histories[project.id] = { ...emptyHistory(), day: history.day, boundary: history.boundary };
    for (const id of history.seen) {
      const [projectId] = JSON.parse(id) as [string, string];
      (histories[projectId] ??= emptyHistory()).seen.push(id);
    }
    for (const [id, item] of Object.entries(history.landed)) (histories[item.projectId] ??= emptyHistory()).landed[id] = item;
    await bb.storage.kv.set(key, histories);
  })();
  let work: Promise<unknown> = ready.catch(() => undefined);
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const next = work.then(async () => { await ready; return action(); });
    work = next.catch(() => undefined);
    return next;
  }
  async function remember(projectId: string, board: Board | null) {
    if (board?.tracker?.state !== "current") return;
    const history = histories[projectId] ??= emptyHistory();
    for (const lane of board.lanes) {
      const id = JSON.stringify([projectId, lane.leadThreadId]);
      if (lane.state !== "landed" || history.seen.includes(id)) continue;
      history.seen.push(id);
      history.landed[id] = { projectId, specId: lane.specId };
    }
    await bb.storage.kv.set(key, histories);
  }
  function observe(projectId: string, _name: string, board: Board | null) {
    return serial(async () => { if (!disposed) await remember(projectId, board); });
  }
  function register(read: (projectId: string) => Promise<Board>) {
    // SDK schedules use server-local time and are registered only at load. A
    // stable minute schedule lets settings change live without overlapping jobs.
    bb.background.schedule("helper-daily-summary", "* * * * *", () => serial(async () => {
      if (disposed) return;
      const time = timeSchema.parse((await settings.get()).dailySummaryTime);
      if (time === "Off") return;
      const now = new Date();
      const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
      const [hour, minute] = time.split(":").map(Number);
      if (now.getHours() * 60 + now.getMinutes() < hour * 60 + minute) return;
      const projects = await bb.sdk.projects.list();
      const failures: unknown[] = [];
      for (const project of projects) {
        try {
          const history = histories[project.id] ??= emptyHistory();
          if (history.day === day) continue;
          const selected = await helper.read(project.id);
          if (!selected) continue;
          const board = await read(project.id).catch(() => null);
          await remember(project.id, board);
          const landed = [...new Set(Object.values(history.landed).map((item) => oneLine(item.specId)))].sort();
          const flying = board ? [...new Set(board.lanes.filter((lane) => lane.state !== "landed").map((lane) => oneLine(lane.specId)))].sort().join(", ") || "none" : "unavailable";
          const line = `${oneLine(project.name)} | Landed since last summary: ${landed.join(", ") || "none"} | Flying: ${flying} | Needs you: ${openNeeds(board).length}${board ? "" : ` | Setup: ${unreadableProject}`}`;
          // Settings and Helper selection may change while the board is read.
          const current = timeSchema.parse((await settings.get()).dailySummaryTime);
          const latest = await helper.read(project.id);
          if (disposed || current !== time || latest?.threadId !== selected.threadId) continue;
          await bb.sdk.threads.send({ threadId: selected.threadId, mode: "queue-if-active",
            input: [{ type: "text", mentions: [], text: `Daily summary\n${line}` }] });
          histories[project.id] = { ...history, day, boundary: now.getTime(), landed: {} };
          await bb.storage.kv.set(key, histories);
        } catch (error) { failures.push(error); }
      }
      // One failed project's delivery must not consume or prevent another's.
      if (failures.length) throw failures[0];
    }));
  }
  bb.onDispose(async () => { disposed = true; await work; });
  return { observe, register };
}
