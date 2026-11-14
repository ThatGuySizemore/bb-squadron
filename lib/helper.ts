// One remembered Helper per project. Replacing it never changes the former thread.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { helperContract, type Helper } from "./helper-contract.js";
import { selectProjectCheckout } from "./project-checkout.js";
import { isActiveProjectThread } from "./project-thread.js";

const key = "helper.thread";
const projectsKey = "helper.projects.v1";
const selectionsSchema = z.record(z.string(), z.string());
const prompt = (projectId: string) => `Use the squadron-helper skill. You are my Helper for BB project ${projectId} only.`;

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
  async function selections() {
    const saved = await bb.storage.kv.get<unknown>(projectsKey);
    if (saved !== null && saved !== undefined) return selectionsSchema.parse(saved);
    const legacyId = await bb.storage.kv.get<string>(key);
    const legacy = legacyId ? await threadById(legacyId) : null;
    const migrated = legacy?.projectId && legacy.archivedAt === null && legacy.deletedAt === null
      ? { [legacy.projectId]: legacy.id } : {};
    // Even an empty map completes migration. An unreadable thread throws before
    // this write, allowing a later read to retry without losing the old Helper.
    await bb.storage.kv.set(projectsKey, migrated);
    return migrated;
  }
  async function selected(id: string | undefined): Promise<Helper | null> {
    if (!id) return null;
    const thread = await threadById(id);
    return thread && thread.archivedAt === null && thread.deletedAt === null
      ? { threadId: thread.id, title: thread.title ?? "Helper" } : null;
  }
  async function readProject(projectId: string) {
    return selected((await selections())[projectId]);
  }
  function read(projectId: string) { return serial(() => readProject(projectId)); }
  // Transitional adapter for SQD-232's existing delivery consumers only. Board
  // and CLI selection always use the project map. Remove this with that ticket.
  function readLegacy() { return serial(async () => selected(await bb.storage.kv.get<string>(key) ?? undefined)); }
  async function remember(projectId: string, threadId: string) {
    const saved = await selections();
    for (const [id, helperId] of Object.entries(saved)) if (helperId === threadId) delete saved[id];
    await bb.storage.kv.set(projectsKey, { ...saved, [projectId]: threadId });
    await bb.storage.kv.set(key, threadId); // SQD-232 compatibility; never used for project selection.
  }
  function start(projectId: string, fresh = false) {
    return serial(async () => {
      const current = await readProject(projectId);
      if (current && !fresh) return current;
      const checkout = await selectProjectCheckout(bb, projectId);
      if (!checkout) throw new Error("This project needs a default checkout before you can start a Helper.");
      const thread = await bb.sdk.threads.spawn({ projectId, title: "Helper", visibility: "visible", prompt: prompt(projectId),
        environment: { type: "host", hostId: checkout.hostId, workspace: { type: "unmanaged", path: checkout.path } },
      });
      await bb.storage.kv.set(`helper.seeded.${thread.id}`, projectId);
      await remember(projectId, thread.id);
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
      if (!thread || thread.archivedAt !== null || thread.deletedAt !== null)
        throw new Error("Choose an active thread in this project.");
      const target = projectId ?? thread.projectId;
      if (!target) throw new Error("Choose a project with --project.");
      if (await bb.storage.kv.get<unknown>(`helper.seeded.${threadId}`) !== target) {
        await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: prompt(target), mentions: [] }] });
        await bb.storage.kv.set(`helper.seeded.${threadId}`, target);
      }
      await remember(target, threadId);
      return { threadId, title: thread.title ?? "Helper" };
    });
  }
  bb.rpc.register(helperContract, {
    "helper.read": ({ projectId }) => read(projectId),
    "helper.start": ({ projectId, fresh }, context) => {
      if (context.experimental_caller.kind !== "client") throw new Error("Start the Helper from the Squadron board.");
      return start(projectId, fresh);
    },
    "helper.threads": ({ projectId }) => recent(projectId),
    "helper.use": async ({ projectId, threadId }, context) => {
      if (context.experimental_caller.kind !== "client") throw new Error("Choose the Helper from the Squadron board.");
      const thread = await threadById(threadId);
      if (!thread || !isActiveProjectThread(thread, threadId, projectId)) throw new Error("Choose an active thread in this project.");
      return use(threadId, projectId);
    },
  });
  return { read, start, use, readLegacy };
}
