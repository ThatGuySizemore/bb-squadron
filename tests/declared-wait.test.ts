import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { helperFixture } from "./fixtures/helper-plugin.js";
import { workspaceIssues } from "./fixtures/board-workspace.js";
import { done } from "./fixtures/linear-mirror.js";
import { needsYou } from "../lib/board-model.js";

const epoch = Date.parse("2026-11-15T12:00:00Z");
type Fixture = Awaited<ReturnType<typeof helperFixture>>;

/** FIX-9 stands in for the lane that holds the files the Lead also needs. */
const fixture = (t: TestContext, landed = false) => helperFixture(t, epoch, { issues: () => Response.json({ data: { issues: { ...workspaceIssues.data.issues,
  nodes: workspaceIssues.data.issues.nodes.map((node) => landed && node.identifier === "FIX-9" ? { ...node, state: done } : node),
} } }) });

/** BB records the control input the CLI sends; a completed turn then ends beyond it. */
function recordControl(f: Fixture, leadId: string, extra: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>> = []) {
  f.harness.sdk.stub("threads.send", async ({ threadId, input }: Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0]) => {
    if (threadId === leadId) f.events.set(threadId, [
      ...extra,
      { id: "end", threadId, seq: 5, createdAt: epoch, scope: { kind: "thread" },
        type: "turn/completed", data: { status: "completed", providerThreadId: null } },
      { id: "control", threadId, seq: 4, createdAt: epoch - 1, scope: { kind: "thread" },
        type: "client/turn/requested", data: { direction: "outbound", source: "tell", senderThreadId: leadId, initiator: "agent",
          execution: { model: "fixture", permissionMode: "auto", reasoningLevel: "medium", serviceTier: "default", source: "client/turn/requested" },
          input, request: { method: "turn/start", params: {} }, requestId: "control", target: { kind: "auto", expectedTurnId: null } } },
      { id: "started", threadId, seq: 3, createdAt: epoch - 2, scope: { kind: "thread" },
        type: "turn/started", data: { providerThreadId: null } as never },
    ]);
    return { ok: true as const, delivery: "queued" as const };
  });
}
const idle = (f: Fixture, leadId: string) => f.threads.set(leadId, { ...f.threads.get(leadId)!, status: "idle", runtime: { displayStatus: "idle" } });

test("a declared wait shows Waiting on the named lane, stays out of Needs you and never wakes the Helper", async (t) => {
  const f = await fixture(t);
  const lead = f.lead("one", "Lead FIX-5");
  recordControl(f, lead.id);
  const result = await f.harness.behavior.runCli(["wait", "FIX-5", "--on", "FIX-9"], { projectId: "one", threadId: lead.id });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(f.sends().find((send) => send.threadId === lead.id)?.mode, "steer-if-active");
  idle(f, lead.id);
  await f.startWatcher();
  await f.advance(480_000);
  const board = await f.board();
  assert.deepEqual(board.lanes[0].waitingOn, ["FIX-9"]);
  assert.equal(board.lanes[0].stopped, false);
  assert.equal(board.lanes[0].state, "flying");
  assert.deepEqual(needsYou(board), []);
  assert.equal(f.sends().filter((send) => send.threadId === "helper").length, 0);
  await f.reload(); await f.startWatcher(); await f.advance(480_000);
  assert.deepEqual((await f.board()).lanes[0].waitingOn, ["FIX-9"], "the wait survives reload");
  assert.equal(f.sends().length, 0);
});

test("a declared wait takes any reason, even one that is not an issue", async (t) => {
  const f = await fixture(t);
  const lead = f.lead("one", "Lead FIX-5");
  recordControl(f, lead.id);
  const result = await f.harness.behavior.runCli(["wait", "FIX-5", "--on", "the reader files. Held by FIX-9"], { projectId: "one", threadId: lead.id });
  assert.equal(result.exitCode, 0, result.stderr);
  idle(f, lead.id);
  const board = await f.board();
  assert.deepEqual(board.lanes[0].waitingOn, ["the reader files. Held by FIX-9"]);
  assert.deepEqual(needsYou(board), []);
});

test("a declared wait clears when the named lane lands", async (t) => {
  const f = await fixture(t, true);
  const lead = f.lead("one", "Lead FIX-5");
  recordControl(f, lead.id);
  await f.harness.behavior.runCli(["wait", "FIX-5", "--on", "FIX-9"], { projectId: "one", threadId: lead.id });
  idle(f, lead.id);
  const board = await f.board();
  assert.equal(board.lanes[0].waitingOn, undefined);
  assert.equal(board.lanes[0].stopped, true, "an idle Lead whose wait is over reads as it does today");
});

test("a declared wait clears when the Lead starts work again", async (t) => {
  const f = await fixture(t);
  const lead = f.lead("one", "Lead FIX-5");
  recordControl(f, lead.id);
  await f.harness.behavior.runCli(["wait", "FIX-5", "--on", "FIX-9"], { projectId: "one", threadId: lead.id });
  idle(f, lead.id);
  assert.deepEqual((await f.board()).lanes[0].waitingOn, ["FIX-9"]);
  // The Lead takes a new turn, runs, and goes quiet without declaring a wait again.
  const events = f.events.get(lead.id)!;
  f.events.set(lead.id, [
    { id: "end-2", threadId: lead.id, seq: 8, createdAt: epoch + 1, scope: { kind: "thread" },
      type: "turn/completed", data: { status: "completed", providerThreadId: null } },
    { id: "started-2", threadId: lead.id, seq: 7, createdAt: epoch, scope: { kind: "thread" },
      type: "turn/started", data: { providerThreadId: null } as never },
    ...events,
  ]);
  const board = await f.board();
  assert.equal(board.lanes[0].waitingOn, undefined);
});

test("an idle Lead with no wait and no question behaves as before", async (t) => {
  const f = await fixture(t);
  const lead = f.lead("one", "Lead FIX-5");
  idle(f, lead.id);
  const board = await f.board();
  assert.equal(board.lanes[0].stopped, true);
  assert.equal(board.lanes[0].waitingOn, undefined);
  assert.deepEqual(needsYou(board).map(({ kind, text }) => ({ kind, text })), [{ kind: "stopped", text: "The lane stopped." }]);
});

test("wait needs a reason and the Stop message never reads as a wait", async (t) => {
  const f = await fixture(t);
  const lead = f.lead("one", "Lead FIX-5");
  const missing = await f.harness.behavior.runCli(["wait", "FIX-5"], { projectId: "one", threadId: lead.id });
  assert.equal(missing.exitCode, 1);
  const blank = await f.harness.behavior.runCli(["wait", "FIX-5", "--on", "  "], { projectId: "one", threadId: lead.id });
  assert.equal(blank.exitCode, 1);
  assert.match(blank.stderr, /waiting on/i);
});
