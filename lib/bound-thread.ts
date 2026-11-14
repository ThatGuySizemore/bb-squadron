import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Schedule first, persist a trusted binding, then explicitly release the row.
 * The dispatch hook rejects unbound/stopped launches if this process fails. */
export const bindingSchedule = () => Date.now() + 86_400_000;

export async function releaseBoundPrompt(bb: BbPluginApi, threadId: string) {
  const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
  if (rows.length !== 1) throw new Error("The bound thread's initial prompt could not be identified. Check its queue before resuming.");
  await bb.sdk.threads.queuedMessages.send({ threadId, queuedMessageId: rows[0].id, mode: "auto" });
}
