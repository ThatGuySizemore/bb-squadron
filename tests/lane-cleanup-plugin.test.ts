// SQD-267: Clean up after landing, end to end through the board watcher on the fake plugin host.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { helperFixture, settle } from "./fixtures/helper-plugin.js";
import { needsYou } from "../lib/board-model.js";

const epoch = Date.parse("2026-11-14T12:00:00Z");
const route = { providerId: "codex", model: "gpt-6.1-sol", effort: "medium", serviceTier: "default" };

async function landedLane(t: TestContext, settingsExtra: string, state: "merged" | "open" = "merged") {
  const worktrees: Record<string, { clean: boolean; pushed: boolean } | "offline"> = {};
  const f = await helperFixture(t, epoch, {}, undefined, undefined, undefined, { settingsExtra, worktree: (path) => {
    const value = worktrees[path];
    if (!value || value === "offline") throw new Error("host offline");
    return value;
  } });
  f.projects.splice(1);
  f.lead("one", "Lead FIX-5");
  const metadata = new Map<string, Record<string, unknown>>();
  f.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) =>
    metadata.get(threadId) ?? (threadId.startsWith("lead-") ? { role: "lead", specId: "fix-5" } : {}));
  f.harness.sdk.stub("plugins.callRpc", async () => ({ "env-one": { outcome: "available", pullRequest: {
    number: 1, state, url: "https://example.invalid/pr/1", updatedAt: new Date(epoch + 1000).toISOString(), checks: { state: "passing" } } } }));
  f.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) =>
    ({ id: environmentId, projectId: "one", hostId: "host", path: `/worktrees/${environmentId}`, status: "ready" }));
  const archived: string[] = [];
  f.harness.sdk.stub("threads.archive", async ({ threadId }: { threadId: string }) => {
    archived.push(threadId);
    f.threads.set(threadId, { ...f.threads.get(threadId)!, archivedAt: epoch + 2000 });
    return { ok: true };
  });
  let count = 0;
  const worker = (name: string, state: { clean: boolean; pushed: boolean } | "offline", role = "Worker") => {
    const id = `w-${name}`;
    f.threads.set(id, makeThreadResponse({ id, projectId: "one", parentThreadId: "lead-one", environmentId: `env-${name}`,
      providerId: "codex", title: `Worker ${name}`, status: "idle", createdAt: epoch - 100_000 + ++count }));
    metadata.set(id, { launch: { version: 1, role, category: null, policyResolved: true, overrideNote: null, specId: "fix-5",
      tickets: [{ id: name, identifier: `FIX-${name}` }], leadThreadId: "lead-one", launchedBy: "lead", launchedAt: epoch - 100_000 + count,
      requested: route, replacesThreadId: null, escalation: null } });
    worktrees[`/worktrees/env-${name}`] = state;
    return id;
  };
  const pass = async () => { await f.startWatcher(); await f.advance(30_000); await settle(); return await f.board(); };
  return { f, worker, archived, pass };
}

test("a landed lane's saved workers are archived, and an unsaved worker is kept under Needs you", async (t) => {
  const { f, worker, archived, pass } = await landedLane(t, "\n## Clean up\n\nAfter landing\n");
  worker("a", { clean: true, pushed: true });
  worker("b", { clean: true, pushed: false });
  worker("c", { clean: false, pushed: true });
  worker("r", { clean: true, pushed: true }, "Review of codex");
  const board = await pass();
  assert.equal(board.lanes[0].state, "landed");
  assert.deepEqual(archived, ["w-a"]);
  assert.deepEqual(board.cleanup?.map((item) => [item.threadId, item.text]), [
    ["w-b", "Unsaved work in FIX-b's worker. Its branch has commits that aren't on the remote."],
    ["w-c", "Unsaved work in FIX-c's worker. Its worktree has uncommitted changes."],
  ]);
  assert.deepEqual(needsYou(board).filter((item) => item.kind === "cleanup").map((item) => item.threadId), ["w-b", "w-c"]);
  assert.equal(f.threads.get("lead-one")?.archivedAt ?? null, null, "the Lead is never archived");
  assert.equal(f.threads.get("w-r")?.archivedAt ?? null, null, "a reviewer is never archived");
  // Once the owner saves the work, the next pass archives it and the item goes away.
  f.harness.sdk.stub("threads.archive", async ({ threadId }: { threadId: string }) => { archived.push(threadId); f.threads.set(threadId, { ...f.threads.get(threadId)!, archivedAt: epoch + 3000 }); return { ok: true }; });
  worker("b", { clean: true, pushed: true });
  worker("c", { clean: true, pushed: true });
  const after = await pass();
  assert.deepEqual(archived.sort(), ["w-a", "w-b", "w-c"]);
  assert.equal(after.cleanup?.length ?? 0, 0);
});

test("reading the board never archives a worker; only the watcher does", async (t) => {
  const { f, worker, archived } = await landedLane(t, "\n## Clean up\n\nAfter landing\n");
  worker("a", { clean: true, pushed: true });
  assert.equal((await f.board()).lanes[0].state, "landed");
  await settle();
  assert.deepEqual(archived, [], "a board read leaves threads alone");
  await f.startWatcher();
  await settle();
  assert.deepEqual(archived, ["w-a"]);
});

test("a worker resumed during the worktree check is not archived", async (t) => {
  const { f, worker, archived, pass } = await landedLane(t, "\n## Clean up\n\nAfter landing\n");
  worker("a", { clean: true, pushed: true });
  f.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => {
    f.threads.set("w-a", { ...f.threads.get("w-a")!, status: "active" });
    return { id: environmentId, projectId: "one", hostId: "host", path: `/worktrees/${environmentId}`, status: "ready" };
  });
  await pass();
  assert.deepEqual(archived, []);
});

test("a project without the setting archives nothing", async (t) => {
  const { f, worker, archived, pass } = await landedLane(t, "");
  worker("a", { clean: true, pushed: true });
  const board = await pass();
  assert.equal(board.lanes[0].state, "landed");
  assert.deepEqual(archived, []);
  assert.equal(board.cleanup, undefined);
  assert.equal(f.threads.get("w-a")?.archivedAt ?? null, null);
});

test("a lane that hasn't landed is untouched even with the setting on", async (t) => {
  const { worker, archived, pass } = await landedLane(t, "\n## Clean up\n\nAfter landing\n", "open");
  worker("a", { clean: true, pushed: true });
  const board = await pass();
  assert.notEqual(board.lanes[0].state, "landed");
  assert.deepEqual(archived, []);
});

test("an unreadable worktree keeps the worker and says it couldn't be checked", async (t) => {
  const { worker, archived, pass } = await landedLane(t, "\n## Clean up\n\nAfter landing\n");
  worker("a", "offline");
  const board = await pass();
  assert.deepEqual(archived, []);
  assert.deepEqual(board.cleanup?.map((item) => item.text), ["Unsaved work in FIX-a's worker. Its worktree couldn't be checked."]);
});
