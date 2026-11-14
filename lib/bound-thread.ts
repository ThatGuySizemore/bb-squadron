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
  await bb.sdk.threads.queuedMessages.send({ threadId, queuedMessageId: rows[0].id, mode: "auto" });
}
