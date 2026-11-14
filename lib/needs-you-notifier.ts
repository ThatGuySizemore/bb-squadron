// One push for each new Needs-you item, and nothing else. Items are derived
// from the board; durable claims keep a restart or a repeated board read from
// pushing the same item twice.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { needsYou, type Board, type NeedsYouItem } from "./board-model.js";
import type { LaneService } from "./lane-service.js";
import { diagnostic } from "./diagnostic.js";

const PUSH_PLUGIN = "push-notifications";
const sent = z.object({ ok: z.literal(true), channels: z.array(z.enum(["web", "desktop", "mobile"])) });

function title(item: NeedsYouItem): string {
  const subject = item.issueId ?? item.ticketId ?? item.specId;
  switch (item.kind) {
    case "question": return `Question on ${subject}`;
    case "stopped": return `${subject} stopped`;
    case "merge": return `${subject} waits for your merge`;
    case "setup": return "Squadron needs Linear setup";
    case "write": return subject ? `Linear write for ${subject} needs you` : "Linear write needs you";
  }
}

export function registerNeedsYouNotifications(bb: BbPluginApi, lanes?: Pick<LaneService, "list" | "onChange">) {
  const db = bb.storage.database();
  db.exec(`CREATE TABLE IF NOT EXISTS squadron_needs_you_pushes (bb_project_id TEXT NOT NULL, notify_key TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (bb_project_id, notify_key))`);
  db.exec(`CREATE TABLE IF NOT EXISTS squadron_quiet_threads (thread_id TEXT PRIMARY KEY)`);

  async function push(item: NeedsYouItem) {
    try {
      await bb.sdk.plugins.callRpc({ pluginId: PUSH_PLUGIN, method: "notifications.send", outputSchema: sent,
        input: { title: title(item), body: item.text, ...(item.threadId ? { threadId: item.threadId } : {}) } });
    } catch (error) {
      // The claim stays: a missing or failing push plugin never turns into a
      // repeated push. The item itself stays on the board.
      bb.log.warn(`Needs-you push ${item.kind}: ${diagnostic(error)}`);
    }
  }

  /** Call with every computed board. Claims are taken synchronously, so
   * concurrent reads of the same board push once. An item that leaves Needs
   * you releases its claim; its recurrence is a new item. */
  function observe(projectId: string, board: Board) {
    const items = needsYou(board);
    const present = new Set(items.map((item) => item.notifyKey));
    const claimed = db.prepare(`SELECT notify_key FROM squadron_needs_you_pushes WHERE bb_project_id=?`).all(projectId) as { notify_key: string }[];
    const forget = db.prepare(`DELETE FROM squadron_needs_you_pushes WHERE bb_project_id=? AND notify_key=?`);
    for (const { notify_key: key } of claimed) {
      // Without an outbox health read, blocked-write items are unknown, not gone.
      if (present.has(key) || (!board.writes && key.startsWith("write:"))) continue;
      forget.run(projectId, key);
    }
    const claim = db.prepare(`INSERT OR IGNORE INTO squadron_needs_you_pushes (bb_project_id, notify_key, created_at) VALUES (?, ?, ?)`);
    for (const item of items) {
      if (claim.run(projectId, item.notifyKey, Date.now()).changes === 1) void push(item);
    }
  }

  /** Squadron's Lead finishes many routine turns. Its notification level caps
   * its workers too, so only BB's own approvals and errors still reach the
   * owner beside the Needs-you pushes. Applied once per thread. */
  async function quiet(threadId: string) {
    if (db.prepare(`INSERT OR IGNORE INTO squadron_quiet_threads (thread_id) VALUES (?)`).run(threadId).changes !== 1) return;
    try {
      await bb.sdk.plugins.callRpc({ pluginId: PUSH_PLUGIN, method: "threadNotifications.set", input: { threadId, level: "input-only" },
        outputSchema: z.unknown() });
    } catch (error) { bb.log.warn(`Quiet Lead notifications: ${diagnostic(error)}`); }
  }
  if (lanes) bb.onDispose(lanes.onChange((projectId) => {
    for (const run of lanes.list(projectId)) {
      if (!run.recoveryOnly && run.leadThreadId && run.state !== "landed" && run.state !== "canceled") void quiet(run.leadThreadId);
    }
  }));
  return { observe, quiet };
}
export type NeedsYouNotifications = ReturnType<typeof registerNeedsYouNotifications>;
