// One remembered Helper for the install. Replacing it never changes the former thread.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { helperContract, type Helper } from "./helper-contract.js";
import { selectProjectCheckout } from "./project-checkout.js";
import { isActiveProjectThread } from "./project-thread.js";

const key = "helper.thread";
const prompt = "Use the squadron-helper skill. You are my Helper for BB Squadron across all my projects.";

export function registerHelper(bb: BbPluginApi) {
  let pending: Promise<unknown> = Promise.resolve();
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const next = pending.then(action);
    pending = next.catch(() => undefined);
    return next;
  }
  async function threadById(threadId: string) {
    try { return await bb.sdk.threads.get({ threadId }); }
    catch (error) {
      const detail = error as { code?: string; status?: number; message?: string } | null;
      if (detail?.status === 404 || detail?.code === "not_found" || detail?.message === "Thread not found") return null;
      throw error;
    }
  }
  async function read(): Promise<Helper | null> {
    const id = await bb.storage.kv.get<string>(key);
    if (!id) return null;
    const thread = await threadById(id);
    return thread && thread.archivedAt === null && thread.deletedAt === null
      ? { threadId: thread.id, title: thread.title ?? "Helper" } : null;
  }
  function start(projectId: string, fresh = false) {
    return serial(async () => {
      const current = await read();
      if (current && !fresh) return current;
      const checkout = await selectProjectCheckout(bb, projectId);
      if (!checkout) throw new Error("This project needs a default checkout before you can start a Helper.");
      const thread = await bb.sdk.threads.spawn({ projectId, title: "Helper", visibility: "visible", prompt,
        environment: { type: "host", hostId: checkout.hostId, workspace: { type: "unmanaged", path: checkout.path } },
      });
      await bb.storage.kv.set(`helper.seeded.${thread.id}`, true);
      await bb.storage.kv.set(key, thread.id);
      return { threadId: thread.id, title: thread.title ?? "Helper" };
    });
  }
  async function recent(projectId: string) {
    const threads = await bb.sdk.threads.list({ projectId, archived: false, limit: 30 });
    return threads.filter((thread) => isActiveProjectThread(thread, thread.id, projectId))
      .map((thread) => ({ threadId: thread.id, title: thread.title ?? "Untitled thread" }));
  }
  function use(threadId: string, projectId?: string) {
    return serial(async () => {
      const thread = await threadById(threadId);
      if (!thread || thread.archivedAt !== null || thread.deletedAt !== null || (projectId && thread.projectId !== projectId))
        throw new Error("Choose an active thread in this project.");
      if (!await bb.storage.kv.get<boolean>(`helper.seeded.${threadId}`)) {
        await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: prompt, mentions: [] }] });
        await bb.storage.kv.set(`helper.seeded.${threadId}`, true);
      }
      await bb.storage.kv.set(key, threadId);
      return { threadId, title: thread.title ?? "Helper" };
    });
  }
  bb.rpc.register(helperContract, {
    "helper.read": () => read(),
    "helper.start": ({ projectId, fresh }, context) => {
      if (context.experimental_caller.kind !== "client") throw new Error("Start the Helper from the Squadron board.");
      return start(projectId, fresh);
    },
    "helper.threads": ({ projectId }) => recent(projectId),
    "helper.use": ({ projectId, threadId }, context) => {
      if (context.experimental_caller.kind !== "client") throw new Error("Choose the Helper from the Squadron board.");
      return use(threadId, projectId);
    },
  });
  return { read, start, use };
}
