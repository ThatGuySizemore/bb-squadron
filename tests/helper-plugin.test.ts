import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

function host() {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  let count = 0;
  const fake = createFakePluginHost({ pluginId: "squadron", sdk: {
    projects: { get: async ({ projectId }) => ({ id: projectId, name: projectId, kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
      sources: [{ id: "source", projectId, hostId: "host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
    threads: {
      send: async () => ({ ok: true, delivery: "sent" }),
      get: async ({ threadId }) => { const thread = threads.get(threadId); if (!thread) throw new Error("Thread not found"); return thread; },
      list: async (args) => [...threads.values()].filter((thread) => thread.projectId === args?.projectId),
      spawn: async (args) => { const thread = makeThreadResponse({ id: `thr_helper_${++count}`, projectId: args.projectId, title: args.title }); threads.set(thread.id, thread); return thread; },
    },
  } });
  return { ...fake, threads };
}

test("each project's Start Helper survives a restart; Start new leaves other Helpers and the old thread alone", async (t) => {
  let { bb, harness, threads } = host();
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  assert.equal(await harness.behavior.callRpc("helper.read", { projectId: "one" }), null);
  const first = await harness.behavior.callRpc("helper.start", { projectId: "one" });
  assert.deepEqual(first, { threadId: "thr_helper_1", title: "Helper" });
  const second = await harness.behavior.callRpc("helper.start", { projectId: "two" });
  assert.deepEqual(second, { threadId: "thr_helper_2", title: "Helper" });
  assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "one" }), first);
  assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "two" }), second);
  const args = harness.inspection.sdk.callsTo("threads.spawn")[0][0] as Record<string, unknown>;
  assert.equal(args.visibility, "visible");
  assert.equal(args.prompt, "Use the squadron-helper skill. You are my Helper for BB project one only.");
  assert.equal(args.providerId, undefined, "use the project's default provider and model");
  const old = structuredClone(threads.get("thr_helper_1"));
  ({ bb, harness } = await harness.lifecycle.reload(plugin));
  assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "one" }), first);
  assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "two" }), second);
  assert.deepEqual(await harness.behavior.callRpc("helper.start", { projectId: "two", fresh: true }), { threadId: "thr_helper_3", title: "Helper" });
  assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "one" }), first);
  assert.deepEqual(threads.get("thr_helper_1"), old);
  for (const method of ["threads.archive", "threads.delete", "threads.send", "threads.update"])
    assert.equal(harness.inspection.sdk.callsTo(method).length, 0, `${method} leaves the former Helper alone`);
});

test("archived, deleted and missing Helpers disappear and the next Start creates a fresh Helper", async (t) => {
  const { bb, harness, threads } = host();
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  for (const state of ["archivedAt", "deletedAt", "missing"] as const) {
    const selected = await harness.behavior.callRpc("helper.start", { projectId: "one" }) as { threadId: string };
    const thread = threads.get(selected.threadId)!;
    if (state === "missing") threads.delete(thread.id);
    else threads.set(thread.id, { ...thread, [state]: 123 });
    assert.equal(await harness.behavior.callRpc("helper.read", { projectId: "one" }), null, state);
    await assert.rejects(harness.behavior.callRpc("helper.use", { projectId: "one", threadId: thread.id }), /Choose an active thread/);
    assert.deepEqual(await harness.behavior.callRpc("helper.threads", { projectId: "one" }), []);
    const next = await harness.behavior.callRpc("helper.start", { projectId: "one" }) as { threadId: string };
    assert.notEqual(next.threadId, thread.id);
  }
});

test("selecting recent threads remembers each project's Helper and sends its skill once, including CLI promotion", async (t) => {
  const { bb, harness, threads } = host();
  t.after(() => harness.lifecycle.dispose());
  threads.set("thr_one", makeThreadResponse({ id: "thr_one", projectId: "one", title: "Planning one" }));
  threads.set("thr_two", makeThreadResponse({ id: "thr_two", projectId: "two", title: "Planning two" }));
  await plugin(bb);
  assert.deepEqual(await harness.behavior.callRpc("helper.threads", { projectId: "one" }), [{ threadId: "thr_one", title: "Planning one" }]);
  const use = (projectId: string, threadId: string) => harness.behavior.callRpc("helper.use", { projectId, threadId });
  await use("one", "thr_one");
  await use("two", "thr_two");
  assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "two" }), { threadId: "thr_two", title: "Planning two" });
  await use("one", "thr_one");
  const result = await harness.behavior.runCli(["helper", "use"], { threadId: "thr_two", projectId: "two" });
  assert.deepEqual(result, { exitCode: 0, stderr: "", stdout: "Helper: @thread:thr_two\n" });
  assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "two" }), { threadId: "thr_two", title: "Planning two" });
  assert.deepEqual(harness.inspection.sdk.callsTo("threads.send").map((call) => call[0]), ["thr_one", "thr_two"].map((threadId) => ({
    threadId, mode: "queue-if-active", input: [{ type: "text", mentions: [], text: `Use the squadron-helper skill. You are my Helper for BB project ${threadId === "thr_one" ? "one" : "two"} only.` }],
  })));
  await assert.rejects(use("one", "thr_two"), /Choose an active thread in this project/);
  const outside = await harness.behavior.runCli(["helper", "use"]);
  assert.equal(outside.exitCode, 1);
  assert.match(outside.stderr, /Run this command inside the thread/);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("simultaneous Start clicks share one thread; read or send failures preserve the remembered Helper", async (t) => {
  const { bb, harness, threads } = host();
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const started = await Promise.all(["one", "one", "one"].map((projectId) => harness.behavior.callRpc("helper.start", { projectId })));
  assert.deepEqual(started, Array(3).fill({ threadId: "thr_helper_1", title: "Helper" }));
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
  harness.sdk.stub("threads.get", async () => { throw new Error("Machine is offline"); });
  await assert.rejects(harness.behavior.callRpc("helper.start", { projectId: "one" }), /Machine is offline/);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1, "unreadable is not missing");
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threads.get(threadId)!);
  threads.set("thr_other", makeThreadResponse({ id: "thr_other", projectId: "one" }));
  harness.sdk.stub("threads.send", async () => { throw new Error("Couldn't send"); });
  await assert.rejects(harness.behavior.callRpc("helper.use", { projectId: "one", threadId: "thr_other" }), /Couldn't send/);
  assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "one" }), { threadId: "thr_helper_1", title: "Helper" });
});

test("upgrade assigns the install Helper to its thread's own project once, even when another board reads first", async (t) => {
  let { bb, harness, threads } = host();
  t.after(() => harness.lifecycle.dispose());
  threads.set("old_helper", makeThreadResponse({ id: "old_helper", projectId: "one", title: "My Helper" }));
  await bb.storage.kv.set("helper.thread", "old_helper");
  await plugin(bb);
  assert.equal(await harness.behavior.callRpc("helper.read", { projectId: "two" }), null);
  const old = { threadId: "old_helper", title: "My Helper" };
  assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "one" }), old);
  const second = await harness.behavior.callRpc("helper.start", { projectId: "two" });
  ({ bb, harness } = await harness.lifecycle.reload(plugin));
  assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "one" }), old);
  assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "two" }), second);
  assert.equal(harness.inspection.sdk.callsTo("threads.send").length, 0, "migration never interrupts the existing Helper");
});

test("helper use resolves the thread's own project; an explicit project ID or unique name moves it off its former project", async (t) => {
  const { bb, harness, threads } = host();
  t.after(() => harness.lifecycle.dispose());
  threads.set("planning", makeThreadResponse({ id: "planning", projectId: "one", title: "Planning" }));
  harness.sdk.stub("projects.list", async () => [
    { id: "one", name: "First", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 },
    { id: "two", name: "Second", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 },
  ]);
  await plugin(bb);
  const caller = { threadId: "planning", projectId: "two" };
  const expected = { threadId: "planning", title: "Planning" };
  assert.equal((await harness.behavior.runCli(["helper", "use"], caller)).exitCode, 0);
  assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "one" }), expected);
  assert.equal(await harness.behavior.callRpc("helper.read", { projectId: "two" }), null);
  for (const project of ["Second", "two"]) {
    assert.equal((await harness.behavior.runCli(["helper", "use", "--project", project], caller)).exitCode, 0);
    assert.equal(await harness.behavior.callRpc("helper.read", { projectId: "one" }), null);
    assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "two" }), expected);
  }
  assert.equal(harness.inspection.sdk.callsTo("threads.send").length, 2, "moving re-seeds for the new project once");
  const sent = harness.inspection.sdk.callsTo("threads.send")[1][0] as { input: { text: string }[] };
  assert.match(sent.input[0].text, /BB project two only/);
  assert.equal((await harness.behavior.runCli(["helper", "use", "--project", "missing"], caller)).exitCode, 1);
  assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "two" }), expected);
});

test("concurrent Start clicks in different projects retain independent Helpers", async (t) => {
  const { bb, harness } = host();
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const started = await Promise.all(["one", "two", "three"].map((projectId) => harness.behavior.callRpc("helper.start", { projectId })));
  assert.deepEqual(started, [
    { threadId: "thr_helper_1", title: "Helper" },
    { threadId: "thr_helper_2", title: "Helper" },
    { threadId: "thr_helper_3", title: "Helper" },
  ]);
  for (const [index, projectId] of ["one", "two", "three"].entries())
    assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId }), started[index]);
});

test("an offline migration retries without losing the old Helper, and never remigrates a moved Helper after reload", async (t) => {
  let { bb, harness, threads } = host();
  t.after(() => harness.lifecycle.dispose());
  threads.set("old_helper", makeThreadResponse({ id: "old_helper", projectId: "one", title: "My Helper" }));
  await bb.storage.kv.set("helper.thread", "old_helper");
  await plugin(bb);
  harness.sdk.stub("threads.get", async () => { throw new Error("Machine is offline"); });
  await assert.rejects(harness.behavior.callRpc("helper.read", { projectId: "two" }), /Machine is offline/);
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threads.get(threadId)!);
  assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "one" }), { threadId: "old_helper", title: "My Helper" });
  harness.sdk.stub("projects.list", async () => [{ id: "two", name: "Second", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 }]);
  const caller = { threadId: "old_helper", projectId: "one" };
  assert.equal((await harness.behavior.runCli(["helper", "use", "--project", "two"], caller)).exitCode, 0);
  ({ bb, harness } = await harness.lifecycle.reload(plugin));
  assert.equal(await harness.behavior.callRpc("helper.read", { projectId: "one" }), null);
  assert.deepEqual(await harness.behavior.callRpc("helper.read", { projectId: "two" }), { threadId: "old_helper", title: "My Helper" });
});
