import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { helperFixture } from "./fixtures/helper-plugin.js";
import { workspaceIssues } from "./fixtures/board-workspace.js";
import { needsYou } from "../lib/board-model.js";

const epoch = Date.parse("2026-11-15T12:00:00Z");
type Fixture = Awaited<ReturnType<typeof helperFixture>>;
type Checks = "no_checks" | "failing" | "pending" | "passing";
const STALL = "Stalled: PR #541 is open and its required checks aren't posted. Next: the Lead runs the repo's merge steps.";

const fixture = (t: TestContext, acceptOwner = false) => {
  const nodes = workspaceIssues.data.issues.nodes.map((node) => acceptOwner && node.identifier === "FIX-5"
    ? { ...node, labels: { ...node.labels, nodes: [...node.labels.nodes, { id: "accept", name: "accept:owner", color: "#aaaaaa" }] } } : node);
  return helperFixture(t, epoch, {
    issues: () => Response.json({ data: { issues: { ...workspaceIssues.data.issues, nodes } } }),
    laneSpec: () => Response.json({ data: { issue: { ...nodes.find((node) => node.identifier === "FIX-5")!, children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
  });
};

/** One open PR on the Lead's environment; `head` is its updatedAt, the stand-in for a new push. */
function pr(f: Fixture, checks: Checks, head = epoch, state = "open") {
  f.harness.sdk.stub("plugins.callRpc", async () => ({ "env-one": { outcome: "available", pullRequest: {
    number: 541, state, url: "https://example.invalid/pr/541", updatedAt: new Date(head).toISOString(), checks: { state: checks } } } }));
}
/** The Lead ended a normal turn at `at`, optionally with an owner question as its last words. */
function idleLead(f: Fixture, at = epoch, text?: string) {
  const lead = f.lead("one", "Lead FIX-5");
  f.threads.set(lead.id, { ...lead, status: "idle", runtime: { displayStatus: "idle" } });
  f.events.set(lead.id, [
    { id: "completed", threadId: lead.id, seq: 4, createdAt: at, scope: { kind: "thread" }, type: "turn/completed", data: { status: "completed", providerThreadId: null } },
    ...(text ? [{ id: "message", threadId: lead.id, seq: 3, createdAt: at, scope: { kind: "thread" as const }, type: "item/completed" as const,
      data: { providerThreadId: "provider", item: { id: "answer", type: "agentMessage" as const, text } } }] : []),
  ]);
  return lead;
}
const stallSends = (f: Fixture) => f.sends().filter((send) => send.input[0].text.includes("Stalled"));

test("a Lead idle 5 minutes with an open PR and no posted checks gets a stall line, never Needs you, and the Helper hears once", async (t) => {
  const f = await fixture(t);
  idleLead(f); pr(f, "no_checks");
  await f.startWatcher();
  await f.advance(299_000);
  assert.equal((await f.board()).lanes[0].stall, undefined, "under 5 minutes it is an ordinary idle Lead");
  await f.advance(1_000);
  const lane = (await f.board()).lanes[0];
  assert.equal(lane.state, "pr-open");
  assert.equal(lane.stall?.text, STALL);
  assert.deepEqual(needsYou(await f.board()), []);
  await f.advance(30_000); await f.advance(120_000);
  assert.deepEqual(stallSends(f).map((send) => [send.threadId, send.input[0].text]), [["helper", `Fixture | Stalled | FIX-5 | ${STALL} | https://example.invalid/pr/541`]]);
  await f.board(); await f.board(); await f.advance(600_000);
  assert.equal(stallSends(f).length, 1, "rereading the board never repeats it");
  await f.reload(); await f.startWatcher(); await f.advance(14_400_000);
  assert.equal(stallSends(f).length, 0, "hours later, after a reload, the same head sends nothing more");
  assert.deepEqual(needsYou(await f.board()), [], "a long stall adds no Needs you");
});

test("a push to a new head raises one fresh notice", async (t) => {
  const f = await fixture(t);
  idleLead(f); pr(f, "failing");
  await f.startWatcher(); await f.advance(400_000); await f.advance(150_000);
  assert.equal(stallSends(f).length, 1);
  assert.match((await f.board()).lanes[0].stall!.text, /failing/);
  pr(f, "failing", epoch + 3_600_000);
  await f.advance(30_000); await f.advance(150_000); await f.advance(30_000); await f.advance(150_000);
  assert.equal(stallSends(f).length, 2);
});

test("the stall clears when checks go pending or passing, when the Lead runs, or when the PR merges", async (t) => {
  for (const [name, change] of [
    ["pending", (f: Fixture) => pr(f, "pending")],
    ["passing", (f: Fixture) => pr(f, "passing")],
    ["merged", (f: Fixture) => pr(f, "passing", epoch, "merged")],
    ["running", (f: Fixture) => { const lead = f.threads.get("lead-one")!; f.threads.set(lead.id, { ...lead, status: "active", runtime: { displayStatus: "active" } }); }],
  ] as const) await t.test(name, async (t) => {
    const f = await fixture(t);
    idleLead(f); pr(f, "no_checks");
    await f.startWatcher(); await f.advance(400_000);
    assert.ok((await f.board()).lanes[0].stall);
    change(f);
    assert.equal((await f.board()).lanes[0].stall, undefined);
  });
});

test("a declared wait reads Waiting on and raises no stall, notice or Needs you", async (t) => {
  const f = await fixture(t);
  const lead = idleLead(f); pr(f, "no_checks");
  f.harness.sdk.stub("threads.send", async ({ threadId, input }: { threadId: string; input: unknown }) => {
    if (threadId === lead.id) f.events.set(lead.id, [
      { id: "end", threadId, seq: 5, createdAt: epoch, scope: { kind: "thread" }, type: "turn/completed", data: { status: "completed", providerThreadId: null } },
      { id: "control", threadId, seq: 4, createdAt: epoch - 1, scope: { kind: "thread" }, type: "client/turn/requested", data: { direction: "outbound", source: "tell", senderThreadId: lead.id, initiator: "agent",
        execution: { model: "fixture", permissionMode: "auto", reasoningLevel: "medium", serviceTier: "default", source: "client/turn/requested" },
        input, request: { method: "turn/start", params: {} }, requestId: "control", target: { kind: "auto", expectedTurnId: null } } } as never,
      { id: "started", threadId, seq: 3, createdAt: epoch - 2, scope: { kind: "thread" }, type: "turn/started", data: { providerThreadId: null } as never },
    ]);
    return { ok: true as const, delivery: "queued" as const };
  });
  const result = await f.harness.behavior.runCli(["wait", "FIX-5", "--on", "a rate limit lifting"], { projectId: "one", threadId: lead.id });
  assert.equal(result.exitCode, 0, result.stderr);
  await f.startWatcher(); await f.advance(600_000);
  const board = await f.board();
  assert.deepEqual(board.lanes[0].waitingOn, ["a rate limit lifting"]);
  assert.equal(board.lanes[0].stall, undefined);
  assert.deepEqual(needsYou(board), []);
  assert.equal(stallSends(f).length, 0);
});

test("the Lead's own Needs you line stays the one owner item, with no stall", async (t) => {
  const f = await fixture(t);
  idleLead(f, epoch, "Needs you: which tool posts fleet/review?"); pr(f, "no_checks");
  await f.startWatcher(); await f.advance(400_000);
  const board = await f.board();
  assert.equal(board.lanes[0].stall, undefined);
  assert.deepEqual(needsYou(board).map(({ kind, text }) => ({ kind, text })), [{ kind: "waiting", text: "The Lead is waiting on you" }]);
  await f.advance(300_000);
  assert.equal(stallSends(f).length, 0);
});

test("a project with no Helper sends a stalled lane straight to Needs you", async (t) => {
  const f = await fixture(t);
  idleLead(f); pr(f, "no_checks");
  f.threads.set("helper", { ...f.threads.get("helper")!, archivedAt: epoch });
  await f.startWatcher(); await f.advance(400_000);
  const board = await f.board();
  assert.deepEqual(needsYou(board).map(({ kind, text }) => ({ kind, text })), [{ kind: "waiting", text: STALL }]);
  assert.equal(board.lanes[0].stall?.text, STALL);
});

test("passing checks and accept:owner stay as they were", async (t) => {
  const passing = await fixture(t);
  idleLead(passing); pr(passing, "passing");
  await passing.startWatcher(); await passing.advance(600_000);
  assert.equal((await passing.board()).lanes[0].stall, undefined);
  assert.equal(stallSends(passing).length, 0);
});

test("an accept:owner lane with no checks raises no stall", async (t) => {
  const f = await fixture(t, true);
  idleLead(f); pr(f, "no_checks");
  await f.startWatcher(); await f.advance(600_000);
  const board = await f.board();
  assert.equal(board.lanes[0].acceptOwner, true);
  assert.equal(board.lanes[0].stall, undefined);
  assert.equal(stallSends(f).length, 0);
});

test("a stall that clears before its notice is delivered sends nothing", async (t) => {
  const f = await fixture(t);
  idleLead(f); pr(f, "no_checks");
  await f.startWatcher(); await f.advance(300_000);
  assert.ok((await f.board()).lanes[0].stall);
  pr(f, "passing", epoch, "merged");
  await f.advance(30_000); await f.advance(150_000);
  assert.equal(stallSends(f).length, 0, "the cleared stall is withdrawn before delivery");
});
