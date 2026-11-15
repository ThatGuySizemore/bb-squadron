import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { helperFixture } from "./fixtures/helper-plugin.js";
import type { LaunchRecord } from "../lib/launch-record.js";
import { CHECKPOINT_CHECK_MS } from "../lib/checkpoint.js";

// SQD-260: the House rules Checkpoint wakes the project's Helper once, as a plain notice, and never pauses launches.
const epoch = Date.parse("2026-11-15T12:00:00Z");
const policy = (checkpoint: string | null) => `## Squadron policy\n| Setting | Value |\n|---|---|\n| Escalation | retry |\n${checkpoint ? `| Checkpoint | ${checkpoint} |\n` : ""}`;
const route = { providerId: "codex", model: "gpt-6.1-sol", effort: "medium", serviceTier: "default" };

async function fixture(t: TestContext, checkpoint: string | null) {
  const done = new Set<string>();
  /** Tickets whose Linear read fails. */
  const failing = new Set<string>();
  const comments = new Map<string, string>();
  const ticketVariables: Record<string, unknown>[] = [];
  const f = await helperFixture(t, epoch, {
    ticketHistory: (id, variables) => (ticketVariables.push(variables), failing.has(id) ? Response.json({ errors: [{ message: "unavailable" }] }, { status: 500 }) : Response.json({ data: { issue: { id, identifier: id.toUpperCase(), title: `Ticket ${id}`, url: `https://linear.app/fixture/issue/${id}`,
      completedAt: done.has(id) ? "2026-11-15T11:00:00.000Z" : null, state: { type: done.has(id) ? "completed" : "started" },
      ...variables.withComments ? { comments: { nodes: comments.has(id) ? [{ id: `c-${id}`, body: comments.get(id), createdAt: "2026-11-15T11:00:00.000Z" }] : [],
        pageInfo: { hasNextPage: false, endCursor: null } } } : {} } } })),
  }, undefined, undefined, undefined, { houseRules: policy(checkpoint) });
  const metadata = new Map<string, Record<string, unknown>>();
  // Thread metadata lives in BB, so it survives a plugin reload.
  const stub = () => f.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) =>
    metadata.get(threadId) ?? (threadId.startsWith("lead-") ? { role: "lead", specId: "fix-5" } : {}));
  stub();
  let count = 0;
  /** A Worker launch for one ticket, as squadron launch records it. */
  const launch = (projectId: string, ticket: string, record: Partial<LaunchRecord> = {}) => {
    const id = `w-${projectId}-${++count}`;
    f.threads.set(id, makeThreadResponse({ id, projectId, providerId: "codex", title: `Worker ${ticket}`, status: "idle", createdAt: epoch - 100_000 + count }));
    metadata.set(id, { launch: { version: 1, role: "Worker", category: null, policyResolved: true, overrideNote: null, specId: "fix-5",
      tickets: [{ id: ticket, identifier: ticket.toUpperCase() }], leadThreadId: null, launchedBy: "lead", launchedAt: epoch - 100_000 + count,
      requested: route, replacesThreadId: null, escalation: null, ...record } satisfies LaunchRecord });
    return id;
  };
  const historyReads = () => f.linear.operations.filter((name) => name === "SquadronTicketHistory").length;
  const original = f.reload;
  const reload = async () => { await original(); stub(); };
  return Object.assign(f, { done, failing, comments, ticketVariables, launch, historyReads, metadata, reload });
}

test("the checkpoint wakes only that project's Helper once, at n completed routine tickets", async (t) => {
  const f = await fixture(t, "2");
  const first = f.launch("one", "fix-21");
  f.launch("one", "fix-22", { role: "Worker (hard)" });
  f.launch("one", "fix-23", { category: "ui" });
  f.launch("one", "fix-24");
  f.launch("two", "fix-31"); f.launch("two", "fix-32");
  f.done.add("fix-21"); f.done.add("fix-22"); f.done.add("fix-23");
  f.done.add("fix-31"); f.done.add("fix-32");
  await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 0, "one routine ticket done; the hard and ui tickets don't count");
  f.done.add("fix-24");
  await f.advance(CHECKPOINT_CHECK_MS); await f.advance(120_000);
  // Project two has no Helper, so its own checkpoint waits; project one's Helper hears only about project one.
  assert.deepEqual(f.sends(), [{ threadId: "helper", mode: "queue-if-active", input: [{ type: "text", mentions: [], text:
    `Fixture | Checkpoint | 2 routine tickets | 2 routine tickets are done since the first policy-resolved Worker launch, reaching your Checkpoint of 2. Nothing needs you and lanes keep starting. To compare like categories with earlier runs, use bb squadron report. | @thread:${first}` }] }]);
  // Observation reads launch metadata and completion only: no usage, comments, or routes past the cohort start.
  const calls = (name: string) => f.harness.inspection.sdk.callsTo(name).map((call) => call[0] as { threadId: string; types?: string[] });
  assert.deepEqual(calls("threads.events.list").filter((call) => call.threadId.startsWith("w-")).flatMap((call) => call.types ?? []).filter((type) => type !== "provider/modelFallback"), []);
  assert.deepEqual([...new Set(calls("threads.defaultExecutionOptions").map((call) => call.threadId).filter((id) => id.startsWith("w-")))].sort(), [first, "w-two-5"]);
  assert.ok(f.ticketVariables.every((variables) => variables.withComments === false), "the checkpoint never reads comments");
  const reads = f.historyReads();
  await f.advance(CHECKPOINT_CHECK_MS); await f.advance(CHECKPOINT_CHECK_MS);
  assert.equal(f.sends().length, 1, "repeated observations don't repeat it");
  assert.equal(f.historyReads(), reads, "a delivered checkpoint reads nothing more");
  await f.reload(); await f.startWatcher(); await f.advance(CHECKPOINT_CHECK_MS); await f.advance(120_000);
  assert.equal(f.sends().length, 0, "reload doesn't repeat it");
  // The Helper for project two arrives later and gets its own project's notice, once.
  f.threads.set("helper-two", makeThreadResponse({ id: "helper-two", projectId: "two", status: "active" }));
  await f.harness.behavior.callRpc("helper.use", { projectId: "two", threadId: "helper-two" });
  await f.advance(30_000);
  assert.deepEqual(f.sends().map((send) => [send.threadId, send.input[0].text.split(" | ").slice(0, 3).join(" | ")]),
    [["helper-two", "Second | Checkpoint | 2 routine tickets"]]);
});

test("with no Checkpoint setting nothing wakes and no ticket is read", async (t) => {
  const f = await fixture(t, null);
  f.launch("one", "fix-21"); f.launch("one", "fix-24");
  f.done.add("fix-21"); f.done.add("fix-24");
  await f.startWatcher(); await f.advance(120_000); await f.advance(CHECKPOINT_CHECK_MS); await f.advance(120_000);
  assert.equal(f.sends().length, 0);
  assert.equal(f.historyReads(), 0);
});

test("a ticket first launched before the first verified policy Worker, or abandoned, never counts", async (t) => {
  const f = await fixture(t, "2");
  f.launch("one", "fix-20", { policyResolved: false });
  const start = f.launch("one", "fix-21");
  f.launch("one", "fix-22");
  f.done.add("fix-20"); f.done.add("fix-21");
  await f.startWatcher(); await f.advance(CHECKPOINT_CHECK_MS); await f.advance(120_000);
  assert.equal(f.sends().length, 0, "fix-22 is still open, and fix-20 predates the start");
  // A routine ticket that was first launched before the start, then replaced afterwards, still belongs to the earlier period.
  f.launch("one", "fix-20", { replacesThreadId: start });
  await f.advance(CHECKPOINT_CHECK_MS); await f.advance(120_000);
  assert.equal(f.sends().length, 0);
});

test("the checkpoint starts at the first policy Worker BB confirms, skipping one that runs something else", async (t) => {
  const f = await fixture(t, "1");
  f.launch("one", "fix-20", { requested: { ...route, model: "gpt-other" } });
  const start = f.launch("one", "fix-21");
  f.done.add("fix-20"); f.done.add("fix-21");
  await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 1);
  assert.match(f.sends()[0].input[0].text, new RegExp(`1 routine tickets[^]*@thread:${start}$`), "fix-20 predates the verified start and doesn't count");
});

test("a ticket reopened before the threshold, or one a fresh read can't confirm, never counts from an earlier Done", async (t) => {
  const f = await fixture(t, "2");
  f.launch("one", "fix-21"); f.launch("one", "fix-24"); f.launch("one", "fix-25");
  f.done.add("fix-21");
  await f.startWatcher(); await f.advance(CHECKPOINT_CHECK_MS);
  // fix-21 was Done at the last check, then reopened; fix-24 completes. Only one is Done now.
  f.done.delete("fix-21"); f.done.add("fix-24");
  await f.advance(CHECKPOINT_CHECK_MS); await f.advance(120_000);
  assert.equal(f.sends().length, 0, "a reopened ticket's earlier Done doesn't count");
  // fix-21 is Done again but its fresh read fails: an older Done never fills in for an unknown read.
  f.done.add("fix-21"); f.failing.add("fix-21");
  await f.advance(CHECKPOINT_CHECK_MS); await f.advance(120_000);
  assert.equal(f.sends().length, 0, "a failed read is unknown, not Done");
  f.failing.delete("fix-21");
  await f.advance(CHECKPOINT_CHECK_MS); await f.advance(120_000);
  assert.equal(f.sends().length, 1);
  assert.match(f.sends()[0].input[0].text, /\| Checkpoint \| 2 routine tickets \|/);
});

test("a failed send stays pending and is delivered once on retry", async (t) => {
  const f = await fixture(t, "1");
  f.launch("one", "fix-21");
  f.done.add("fix-21");
  let fail = true;
  f.harness.sdk.stub("threads.send", async () => { if (fail) throw new Error("send failed"); return { ok: true, delivery: "queued" }; });
  await f.startWatcher(); await f.advance(120_000);
  const attempts = () => f.harness.inspection.sdk.callsTo("threads.send").filter((call) => String((call[0] as { input: { text: string }[] }).input[0].text).includes("Checkpoint")).length;
  assert.equal(attempts(), 1);
  fail = false;
  await f.advance(30_000);
  assert.equal(attempts(), 2);
  await f.advance(CHECKPOINT_CHECK_MS); await f.advance(120_000);
  assert.equal(attempts(), 2, "after delivery it never sends again");
});

test("bb squadron report reads the caller's project by default, as text or JSON, with usage and unknowns kept apart", async (t) => {
  const f = await fixture(t, "2");
  const worker = f.launch("one", "fix-21");
  f.launch("one", "fix-24");
  f.done.add("fix-21");
  f.comments.set("fix-21", "Done.\n```squadron-result\n" + JSON.stringify({ version: 1, checks: [{ command: "npm run check", result: "passed" }], firstPass: true, reviewDefects: 0, repairRounds: 0, strikes: [], ownerInterventions: 0 }) + "\n```");
  const total = { inputTokens: 900, cachedInputTokens: 400, outputTokens: 100, reasoningOutputTokens: 20, totalTokens: 1000 };
  f.events.set(worker, [{ id: "usage", threadId: worker, seq: 12, createdAt: epoch - 5000, scope: { kind: "thread" }, type: "thread/tokenUsage/updated",
    data: { type: "thread/tokenUsage/updated", threadId: worker, providerThreadId: "provider-1", tokenUsage: { total, last: total, modelContextWindow: 200_000 } } }] as never);
  const text = await f.harness.behavior.runCli(["report"], { threadId: "helper", projectId: "one" });
  assert.equal(text.exitCode, 0, text.stderr);
  assert.match(text.stdout, /Checkpoint: 1 of 2 completed routine tickets since @thread:w-one-1/);
  assert.match(text.stdout, /FIX-21 Ticket fix-21 \| completed 2026-11-15T11:00:00.000Z \| routine \| counts toward the checkpoint/);
  assert.match(text.stdout, /Worker: codex gpt-6.1-sol medium, BB confirms it \| idle \| @thread:w-one-1 \| 1,000 tokens/);
  assert.match(text.stdout, /Not completed[^]*FIX-24 Ticket fix-24 \| open \| routine[^]*usage unknown \(BB has no token usage for this thread\.\)/);
  const json = await f.harness.behavior.runCli(["report", "--json", "--project", "Fixture"], { threadId: "helper" });
  const report = JSON.parse(json.stdout);
  assert.equal(report.projectId, "one");
  assert.deepEqual(report.tickets[0].attempts[0].usage, { state: "reported", total, providerThreadId: "provider-1", seq: 12, at: epoch - 5000,
    coverage: "latest provider session", earlierSessionSeen: false });
  assert.deepEqual(report.tickets[1].checks, { state: "unknown", reason: "The ticket has no result block in its comments." });
  const since = await f.harness.behavior.runCli(["report", "--since", "2026-11-16"], { threadId: "helper", projectId: "one" });
  assert.doesNotMatch(since.stdout, /FIX-21/);
  const bad = await f.harness.behavior.runCli(["report", "--since", "last week"], { threadId: "helper", projectId: "one" });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /--since YYYY-MM-DD/);
  assert.equal(f.harness.inspection.sdk.callsTo("threads.spawn").length, 0, "the report starts nothing");
});
