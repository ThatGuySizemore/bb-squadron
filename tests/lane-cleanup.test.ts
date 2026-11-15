// SQD-267: a landed lane's saved, idle workers are archived; everything else is kept and listed.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LeadThread, WorkerThread } from "../lib/lead-threads.js";
import { cleanUpLanes, type CleanupLanes, type WorktreeState } from "../lib/lane-cleanup.js";

function worker(id: string, overrides: Partial<WorkerThread> & { role?: string } = {}): WorkerThread {
  const { role = "Worker", ...rest } = overrides;
  return { id, title: id, createdAt: 1, status: "idle", runtime: { displayStatus: "idle" }, environmentId: `env-${id}`,
    record: { role, tickets: [{ id: `t-${id}`, identifier: "WW-123" }] },
    ...rest } as unknown as WorkerThread;
}
function lead(workers: WorkerThread[], overrides: Partial<LeadThread> = {}, id = "lead-1"): LeadThread {
  return { specId: "WW-1", thread: { id, environmentId: `env-${id}` }, workers, ...overrides } as unknown as LeadThread;
}
function lanes(leads: LeadThread[], merged: string[] = ["lead-1"]): CleanupLanes {
  return { leads, merged: new Set(merged), identify: (id) => id };
}
function deps(states: Record<string, WorktreeState | null | "throw">, resume: string[] = []) {
  const archived: string[] = [];
  return { archived, deps: {
    inspect: async (w: WorkerThread) => { const s = states[w.id]; if (s === "throw") throw new Error("host offline"); return s ?? null; },
    current: async (w: WorkerThread) => resume.includes(w.id) ? { ...w, status: "active" } as WorkerThread : w,
    archive: async (id: string) => { archived.push(id); },
  } };
}
const saved: WorktreeState = { clean: true, pushed: true };

test("a landed lane's saved, idle workers are archived and nothing is listed", async () => {
  const { archived, deps: d } = deps({ a: saved, b: saved });
  const result = await cleanUpLanes(lanes([lead([worker("a"), worker("b")])]), d);
  assert.deepEqual(archived, ["a", "b"]);
  assert.deepEqual(result, { archived: ["a", "b"], kept: [] });
});

test("a worker with unpushed commits or uncommitted changes is kept and listed under Needs you", async () => {
  const { archived, deps: d } = deps({ a: { clean: true, pushed: false }, b: { clean: false, pushed: true }, c: saved });
  const result = await cleanUpLanes(lanes([lead([worker("a"), worker("b"), worker("c")])]), d);
  assert.deepEqual(archived, ["c"]);
  assert.deepEqual(result.kept, [
    { specId: "WW-1", threadId: "a", text: "Unsaved work in WW-123's worker. Its branch has commits that aren't on the remote." },
    { specId: "WW-1", threadId: "b", text: "Unsaved work in WW-123's worker. Its worktree has uncommitted changes." },
  ]);
});

test("a lane whose PR hasn't merged is untouched", async () => {
  const { archived, deps: d } = deps({ a: saved });
  const result = await cleanUpLanes(lanes([lead([worker("a")])], []), d);
  assert.deepEqual([archived, result], [[], { archived: [], kept: [] }]);
});

test("an older landed Lead that a returning lane hides is still cleaned, and its unsaved workers stay listed", async () => {
  const { archived, deps: d } = deps({ a: saved, b: { clean: false, pushed: true } });
  const result = await cleanUpLanes(lanes([lead([worker("a"), worker("b")], {}, "old"), lead([worker("c")], {}, "new")], ["old"]), d);
  assert.deepEqual(archived, ["a"]);
  assert.deepEqual(result.kept.map((item) => item.threadId), ["b"]);
});

test("an outside lane is never touched", async () => {
  const { archived, deps: d } = deps({ a: saved });
  await cleanUpLanes(lanes([lead([worker("a")], { outside: true } as Partial<LeadThread>)]), d);
  assert.deepEqual(archived, []);
});

test("a worker resumed while its worktree was checked is not archived", async () => {
  const { archived, deps: d } = deps({ a: saved, b: saved }, ["a"]);
  const result = await cleanUpLanes(lanes([lead([worker("a"), worker("b")])]), d);
  assert.deepEqual(archived, ["b"]);
  assert.deepEqual(result.kept.map((item) => item.threadId), ["a"]);
});

test("a running worker, an unreadable worktree and a failed archive are kept, not archived", async () => {
  const { archived, deps: d } = deps({ a: saved, b: null, c: "throw", d: saved });
  const result = await cleanUpLanes(lanes([lead([
    worker("a", { status: "active" } as Partial<WorkerThread>), worker("b"), worker("c"), worker("d"),
  ])]), { ...d, archive: async (id) => { if (id === "d") throw new Error("no"); await d.archive(id); } });
  assert.deepEqual(archived, []);
  assert.deepEqual(result.kept.map((item) => item.threadId), ["a", "b", "c", "d"]);
});

test("a worker with a pending request or background work counts as running", async () => {
  const { archived, deps: d } = deps({ a: saved, b: saved });
  const result = await cleanUpLanes(lanes([lead([
    worker("a", { hasPendingInteraction: true } as Partial<WorkerThread>),
    worker("b", { activity: { activeBackgroundCommandCount: 1 } } as Partial<WorkerThread>),
  ])]), d);
  assert.deepEqual(archived, []);
  assert.equal(result.kept.length, 2);
});

test("reviewers, threads without a launch record and threads in the Lead's own worktree are never archived", async () => {
  const { archived, deps: d } = deps({ a: saved, b: saved, c: saved, d: saved });
  const result = await cleanUpLanes(lanes([lead([
    worker("a", { role: "Review of codex" }), worker("b", { record: undefined } as Partial<WorkerThread>),
    worker("c", { environmentId: "env-lead-1" }), worker("d", { environmentId: undefined } as Partial<WorkerThread>),
  ])]), d);
  assert.deepEqual([archived, result.kept], [[], []]);
});
