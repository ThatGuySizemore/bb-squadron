import { test } from "node:test";
import assert from "node:assert/strict";
import { needsYou } from "../lib/board-model.js";
import { laneHost, commit } from "./fixtures/lane-host.js";

test("a worker's question reaches Needs you, holds its done report, and clears only on the owner's own message", async (t) => {
  const host = await laneHost(t);
  await host.rpc("lanes.start");
  const worker = await host.call("squadron_spawn_worker", { ticketId: "FIX-6" });
  const context = { threadId: worker.threadId, projectId: "proj-one" };
  await assert.rejects(host.call("squadron_report", { type: "question", text: "Lead asks?" }), /Only workers ask the owner/);
  const asked = await host.call("squadron_report", { type: "question", text: "Should the empty state say \"No lanes\"?" }, context);
  assert.equal(asked.state, "question");
  assert.match(asked.message, /Finish your turn/);
  let board = await host.board();
  const ticket = board.lanes[0].tickets.find((item) => item.id === "FIX-6");
  assert.equal(ticket?.state, "question");
  assert.deepEqual(needsYou(board).filter((item) => item.kind === "question").map(({ ticketId, text, threadId }) => ({ ticketId, text, threadId })), [
    { ticketId: "FIX-6", text: "Should the empty state say \"No lanes\"?", threadId: worker.threadId },
  ]);
  await assert.rejects(host.call("squadron_report", { type: "done", commit, summary: "Done anyway." }, context), /question is still open/);
  // The Lead, the worker itself, Squadron's Helper and core notices never answer for the owner.
  assert.equal((await host.dispatch(worker.threadId, { initiator: "agent", senderThreadId: "thr_lead" })).action, "proceed");
  assert.equal((await host.dispatch(worker.threadId, { initiator: "agent", senderThreadId: worker.threadId })).action, "proceed");
  await host.dispatch(worker.threadId, { initiator: "user", originPluginId: "squadron" });
  await host.dispatch(worker.threadId, { initiator: "system" });
  await host.settle();
  assert.equal((await host.board()).lanes[0].tickets.find((item) => item.id === "FIX-6")?.state, "question");
  assert.equal((await host.dispatch(worker.threadId, { initiator: "user" })).action, "proceed");
  await host.settle();
  board = await host.board();
  assert.equal(board.lanes[0].tickets.find((item) => item.id === "FIX-6")?.state, "working");
  assert.deepEqual(needsYou(board).filter((item) => item.kind === "question"), []);
  const done = await host.call("squadron_report", { type: "done", commit, summary: "Built with tests." }, context);
  assert.equal(done.state, "reported");
});

test("each new Needs-you item sends exactly one push, durable across reload, and nothing else does", async (t) => {
  const host = await laneHost(t);
  await host.rpc("lanes.start");
  await host.settle();
  assert.deepEqual(host.levels, [{ threadId: "thr_lead", level: "input-only" }],
    "the Lead's routine finished-turn pushes are off; its workers inherit the cap, and BB's own approval and error prompts stay");
  const worker = await host.call("squadron_spawn_worker", { ticketId: "FIX-6" });
  const context = { threadId: worker.threadId, projectId: "proj-one" };
  await host.board(); await host.settle();
  assert.equal(host.pushes.length, 0, "starting a lane and a worker needs nothing from the owner");
  await host.call("squadron_report", { type: "question", text: "Which wording?" }, context);
  await host.board(); await host.board(); await host.settle();
  assert.deepEqual(host.pushes, [{ title: "Question on FIX-6", body: "Which wording?", threadId: worker.threadId }]);
  const next = await host.harness.lifecycle.reload(async (api) => { await (await import("../server.js")).default(api); });
  await next.harness.behavior.callRpc("board", { projectId: "proj-one" }); await host.settle();
  assert.equal(host.pushes.length, 1, "a restart doesn't repeat a push for an item already sent");
  await next.harness.inspection.registrations.hooks["message.dispatch"]!((await import("@get-bb/plugin-sdk/testing")).makeMessageDispatchHookContext({
    thread: { id: worker.threadId }, project: { id: "proj-one" }, initiator: "user", senderThreadId: null }));
  await host.settle();
  await next.harness.behavior.callRpc("board", { projectId: "proj-one" }); await host.settle();
  await next.harness.behavior.callAgentTool("squadron_report", { type: "question", text: "One more: which colour?" }, context);
  await next.harness.behavior.callRpc("board", { projectId: "proj-one" }); await host.settle();
  assert.deepEqual(host.pushes.map((push) => push.body), ["Which wording?", "One more: which colour?"], "a later question is a new item");
});

test("a failed push leaves the board readable and the item still in Needs you", async (t) => {
  const host = await laneHost(t, { pushFails: true });
  await host.rpc("lanes.start");
  const worker = await host.call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await host.call("squadron_report", { type: "question", text: "Which wording?" }, { threadId: worker.threadId, projectId: "proj-one" });
  const board = await host.board(); await host.settle();
  assert.equal(needsYou(board).filter((item) => item.kind === "question").length, 1);
  assert.equal(JSON.stringify(host.harness.inspection.logEntries).includes("fake-private-push-error"), false);
});

test("Stop parks the lane in Needs you with one push; Resume clears it and wakes the Lead and its working workers", async (t) => {
  const host = await laneHost(t);
  await host.rpc("lanes.start");
  const worker = await host.call("squadron_spawn_worker", { ticketId: "FIX-6" });
  const reported = await host.call("squadron_spawn_worker", { ticketId: "FIX-7" });
  await host.call("squadron_report", { type: "done", commit, summary: "Built with tests." }, { threadId: reported.threadId, projectId: "proj-one" });
  await host.rpc("lanes.stop");
  let board = await host.board(); await host.settle();
  assert.equal(board.lanes[0].state, "stopped");
  assert.deepEqual(needsYou(board).map(({ kind, specId, text, threadId }) => ({ kind, specId, text, threadId })), [{
    kind: "stopped", specId: "FIX-5", threadId: "thr_lead",
    text: "You stopped this lane. Its threads, worktrees and branch are kept. Resume, re-plan or cancel it.",
  }]);
  assert.deepEqual(host.harness.inspection.sdk.callsTo("threads.stop").map(([args]) => (args as { threadId: string }).threadId).sort(), ["thr_lead", worker.threadId, reported.threadId].sort());
  assert.equal(host.harness.inspection.sdk.callsTo("threads.delete").length + host.harness.inspection.sdk.callsTo("threads.archive").length, 0);
  assert.deepEqual(host.pushes, [{ title: "FIX-5 stopped", body: "You stopped this lane. Its threads, worktrees and branch are kept. Resume, re-plan or cancel it.", threadId: "thr_lead" }]);
  assert.equal((await host.dispatch("thr_lead", { initiator: "agent", originPluginId: "squadron" })).action, "reject", "nothing Squadron sends wakes a stopped lane");
  await assert.rejects(host.call("squadron_spawn_worker", { ticketId: "FIX-7" }), /isn't ready for workers/);
  await assert.rejects(host.rpc("lanes.stop"), /Only a flying lane can stop/);

  await host.rpc("lanes.resume");
  board = await host.board(); await host.settle();
  assert.equal(board.lanes[0].state, "flying");
  assert.equal(board.lanes[0].stopReason, undefined);
  assert.deepEqual(needsYou(board), []);
  assert.deepEqual(host.sends.filter((send) => /resumed/.test(send.text)).map((send) => send.threadId).sort(), ["thr_lead", worker.threadId].sort());
  assert.ok(!host.sends.some((send) => send.threadId === reported.threadId && /resumed/.test(send.text)), "a reported worker waits for its review");
  assert.ok(host.sends.every((send) => !/resumed/.test(send.text) || /grants no other approval/.test(send.text)));
  assert.equal(host.pushes.length, 1, "resuming pushes nothing");
  await assert.rejects(host.rpc("lanes.resume"), /Only a stopped lane can resume/);

  await host.rpc("lanes.stop"); await host.board(); await host.settle();
  assert.equal(host.pushes.length, 2, "a second stop is a new Needs-you item");
});

test("Resume releases a Lead's still-queued first prompt instead of sending a notice, and refuses an unconfirmed Lead", async (t) => {
  const host = await laneHost(t);
  await host.rpc("lanes.start");
  await host.rpc("lanes.stop");
  host.queued.set("thr_lead", 1);
  const before = host.harness.inspection.sdk.callsTo("threads.queuedMessages.send").length;
  await host.rpc("lanes.resume");
  assert.equal(host.harness.inspection.sdk.callsTo("threads.queuedMessages.send").length, before + 1);
  assert.equal(host.sends.filter((send) => send.threadId === "thr_lead").length, 0);
});

test("Cancel stops the lane's threads, keeps its branch and returns the spec to Ready with a Linear status and signed comment", async (t) => {
  const host = await laneHost(t);
  await host.rpc("lanes.start");
  const worker = await host.call("squadron_spawn_worker", { ticketId: "FIX-6" });
  await host.call("squadron_report", { type: "question", text: "Which wording?" }, { threadId: worker.threadId, projectId: "proj-one" });
  await host.rpc("lanes.cancel");
  const board = await host.board(); await host.settle();
  assert.deepEqual(board.lanes, []);
  assert.deepEqual(board.ready.filter((spec) => spec.id === "FIX-5").map(({ id, keptBranch, startReason }) => ({ id, keptBranch, startReason })),
    [{ id: "FIX-5", keptBranch: "bb/integration", startReason: null }]);
  assert.deepEqual(needsYou(board), []);
  assert.deepEqual(host.harness.inspection.sdk.callsTo("threads.stop").map(([args]) => (args as { threadId: string }).threadId).sort(), ["thr_lead", worker.threadId].sort());
  assert.equal(host.harness.inspection.sdk.callsTo("threads.delete").length + host.harness.inspection.sdk.callsTo("threads.archive").length, 0);
  assert.deepEqual((await host.harness.behavior.resolveAgentConfiguration((await import("@get-bb/plugin-sdk/testing")).makePluginAgentConfigurationContext({
    thread: { id: "thr_lead" }, project: { id: "proj-one" } }))).tools, [], "a canceled lane grants no tools");
  const delivery = host.harness.behavior.runService("linear-outbox"); t.after(() => delivery.controller.abort());
  for (let i = 0; i < 200 && host.mutations.length < 4; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const fix5 = host.mutations.filter((item) => item.variables.id === "fix-5" || item.variables.input.issueId === "fix-5");
  assert.deepEqual(fix5.filter((item) => item.query.includes("issueUpdate")).map((item) => item.variables.input.stateId), ["state-started", "state-ready"]);
  assert.match(fix5.filter((item) => item.query.includes("commentCreate")).map((item) => item.variables.input.body).join("\n"), /Lane canceled by the owner\. Integration branch kept: bb\/integration\./);
  await assert.rejects(host.rpc("lanes.cancel"), /no longer flying/);
  const again = await host.rpc("lanes.start") as { threadId: string };
  assert.notEqual(again.threadId, "thr_lead", "the owner can start the spec again by hand");
});

test("Resume refuses a lane whose Lead was never confirmed; Cancel still returns its spec to Ready without Linear writes", async (t) => {
  const host = await laneHost(t, { leadSpawnFails: true });
  await assert.rejects(host.rpc("lanes.start"), /spawn result is unknown/);
  await host.board(); await host.settle();
  assert.equal(host.pushes.length, 1, "the stopped lane is a new Needs-you item");
  await assert.rejects(host.rpc("lanes.resume"), /Lead was never confirmed/);
  await host.rpc("lanes.cancel");
  const board = await host.board();
  assert.deepEqual(board.lanes, []);
  assert.equal(board.ready.find((spec) => spec.id === "FIX-5")?.keptBranch, undefined);
  assert.deepEqual(needsYou(board), []);
  const delivery = host.harness.behavior.runService("linear-outbox"); t.after(() => delivery.controller.abort());
  await host.settle();
  assert.deepEqual(host.mutations, []);
});

test("the owner's Stop during a slow start pass is not overwritten when provisioning finishes", async (t) => {
  let open!: () => void;
  const host = await laneHost(t, { leadEnvironmentGate: new Promise<void>((resolve) => { open = resolve; }) });
  const starting = host.rpc("lanes.start");
  for (let i = 0; i < 100 && !host.harness.inspection.sdk.callsTo("environments.get").length; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  await host.rpc("lanes.stop");
  open();
  await starting;
  const board = await host.board();
  assert.equal(board.lanes[0].state, "stopped");
  assert.equal(board.lanes[0].stopReason, "You stopped this lane. Its threads, worktrees and branch are kept. Resume, re-plan or cancel it.");
  assert.equal(board.lanes[0].branch, "bb/integration", "the start pass still records the branch it observed");
});
