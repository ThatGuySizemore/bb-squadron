import { test } from "node:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { helperFixture } from "./fixtures/helper-plugin.js";
import { needsYou } from "../lib/board-model.js";

const epoch = Date.parse("2026-11-14T12:00:00Z");

test("a Lead records its two-strike stop through the CLI, shows Stopped and wakes its Helper once", async (t) => {
  const f = await helperFixture(t, epoch);
  const lead = f.lead("one", "Lead FIX-5");
  // BB persists the control input. A completed wind-down turn must retain it.
  const recordControl = async ({ threadId, input }: Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0]) => {
    if (threadId === lead.id) f.events.set(threadId, [
      { id: "end", threadId, seq: 4, createdAt: epoch, scope: { kind: "thread" },
        type: "turn/completed", data: { status: "completed", providerThreadId: null } },
      { id: "control", threadId, seq: 3, createdAt: epoch - 1, scope: { kind: "thread" },
        type: "client/turn/requested", data: { direction: "outbound", source: "tell", senderThreadId: lead.id, initiator: "agent",
          execution: { model: "fixture", permissionMode: "auto", reasoningLevel: "medium", serviceTier: "default", source: "client/turn/requested" },
          input, request: { method: "turn/start", params: {} }, requestId: "control", target: { kind: "auto", expectedTurnId: null } } },
    ]);
    return { ok: true as const, delivery: "queued" as const };
  };
  f.harness.sdk.stub("threads.send", recordControl);
  const result = await f.harness.behavior.runCli(["stop", "FIX-5", "--reason", "two-strikes"], { projectId: "one", threadId: lead.id });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal((await f.board()).lanes[0].stopped, false, "wind-down is still running");
  f.threads.set(lead.id, { ...lead, status: "idle", runtime: { displayStatus: "idle" } });
  await f.startWatcher();
  const board = await f.board();
  assert.equal(board.lanes[0].state, "stopped");
  assert.equal(board.lanes[0].stopped, true);
  assert.deepEqual(needsYou(board).map(({ kind, text }) => ({ kind, text })), [
    { kind: "stopped", text: "Stopped after two strikes, wants a new go" },
  ]);
  await f.advance(120_000);
  assert.equal(f.sends().filter((send) => send.threadId === "helper")[0]?.input[0].text,
    "Fixture | Stopped | FIX-5 | Stopped after two strikes, wants a new go | @thread:lead-one");
  await f.reload(); await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 0, "the same stop isn't sent again after reload");
  f.harness.sdk.stub("threads.send", recordControl);
  const resumed = await f.harness.behavior.runCli(["resume", "FIX-5"], { projectId: "one" });
  assert.equal(resumed.exitCode, 0, resumed.stderr);
  assert.equal((await f.board()).lanes[0].stopped, false, "a later Resume supersedes the stop evidence");
  assert.deepEqual(needsYou(await f.board()), []);
});
