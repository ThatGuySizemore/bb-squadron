import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { needsYou, type Board, type NeedsYouItem, type NeedsYouKind } from "./board-model.js";
import { LINEAR_RATE_LIMIT_MESSAGE } from "./linear-auth.js";

export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const kindNames: Record<NeedsYouKind, string> = {
  "autopilot-check": "Autopilot check",
  "autopilot-paused": "Autopilot paused", setup: "Setup", waiting: "Question", failed: "Stopped", blocked: "Stopped", stopped: "Stopped", merge: "Merge waiting",
};

export const unreadableProject = "Couldn't read this project. Make sure its machine is online.";

export function openNeeds(board: Board | null): NeedsYouItem[] {
  if (!board) return [{ key: "unreadable", kind: "setup", specId: "", text: unreadableProject, threadId: null }];
  const items = needsYou(board);
  // A failed read can't establish that Needs you is empty. Keep its safe tracker message.
  if (board.tracker?.state === "failed"
    && !(board.tracker.kind === "linear" && board.tracker.message === LINEAR_RATE_LIMIT_MESSAGE)
    && !items.some((item) => item.text === board.tracker!.message)) {
    items.unshift({ key: "tracker", kind: "setup", specId: "", text: board.tracker.message, threadId: null });
  }
  return items;
}

export function boardLink(bb: BbPluginApi): string {
  return `${bb.server.experimental_appUrl?.replace(/\/$/, "") ?? ""}/plugins/squadron/board`;
}

export function needLine(projectName: string, board: Board | null, item: NeedsYouItem, link: string): string {
  const lane = board?.lanes.find((lane) => lane.specId === item.specId);
  const text = item.kind === "merge" ? item.localMerge
    ? "The tickets are ready and wait for your local merge."
    : `PR #${lane?.pr?.number} passed its checks and waits for your merge.` : item.text;
  const target = item.kind === "merge" && lane?.pr ? lane.pr.url
    : item.threadId ? `@thread:${item.threadId}` : link;
  return `${oneLine(projectName)} | ${kindNames[item.kind]} | ${oneLine((item.ticketId ?? item.specId) || "Project")} | ${oneLine(text)} | ${target}`;
}
