import { createHash } from "node:crypto";
import { z } from "zod";
import type { Route } from "./board-model.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Schedule first, persist a trusted binding, then explicitly release the row.
 * The dispatch hook rejects unbound/stopped launches if this process fails. */
// A one-day buffer keeps scheduled creation idle while the binding is saved.
// Normal startup explicitly releases it immediately; recovery is separate.
const FIRST_PROMPT_BINDING_DELAY_MS = 24 * 60 * 60 * 1_000;
export const bindingSchedule = () => Date.now() + FIRST_PROMPT_BINDING_DELAY_MS;

export async function releaseBoundPrompt(bb: BbPluginApi, threadId: string) {
  const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
  if (rows.length !== 1) throw new Error("The bound thread's initial prompt could not be identified. Check its queue before resuming.");
  return bb.sdk.threads.queuedMessages.send({ threadId, queuedMessageId: rows[0].id, mode: "auto" });
}

export const firstPromptSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), queuedMessageId: z.string().optional(), released: z.boolean() });
export type FirstPrompt = z.infer<typeof firstPromptSchema>;
export const promptHash = (text: string) => createHash("sha256").update(text).digest("hex");
export const firstPromptIntent = (text: string): FirstPrompt => ({ hash: promptHash(text), released: false });

/** Only the exact still-pending original prompt is eligible for replay. */
export async function pendingBoundPrompt(bb: BbPluginApi, threadId: string, intent: FirstPrompt, route: Route) {
  const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (intent.queuedMessageId && intent.queuedMessageId !== row.id) return null;
  if (row.model !== route.model || row.reasoningLevel !== route.effort || row.permissionMode !== "auto" || row.serviceTier !== "default" || row.groupWithNext) return null;
  if (row.threadId !== threadId || row.originPluginId !== bb.pluginId || row.payload.kind !== "inline" ||
    !["queued", "scheduled", "waiting"].includes(row.state) || row.content.length !== 1 || row.content[0].type !== "text" || row.content[0].mentions.length !== 0 ||
    promptHash(row.content[0].text) !== intent.hash) return null;
  return row;
}
