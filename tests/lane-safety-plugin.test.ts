import { test } from "node:test";
import assert from "node:assert/strict";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { laneHost, commit } from "./fixtures/lane-host.js";

test("trusted role skills and strike reports use saved bindings; two strikes stop with the Lead summary and survive Resume/reload", async (t) => {
  const host = await laneHost(t);
  await host.rpc("lanes.start");
  const worker = await host.call("squadron_spawn_worker", { ticketId: "FIX-6" });
  const context = { projectId: "proj-one", threadId: worker.threadId };
  const configured = async (threadId: string) => host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    project: { id: "proj-one" }, thread: { id: threadId }, pluginMetadata: { role: "Lead" } }));
  assert.deepEqual((await configured("thr_lead")).skills, ["squadron-lead"]);
  assert.deepEqual((await configured(worker.threadId)).skills, ["squadron-worker"]);
  assert.deepEqual((await configured("forged")).skills, []);
  const failure = { type: "failure", ticketId: "FIX-6", kind: "quick-check", eventId: "check-a", commit, summary: "Lead: reported work fails the quick check." };
  assert.equal((await host.call("squadron_report", failure)).count, 0, "compile error before reported completion is ignored");
  await assert.rejects(host.call("squadron_report", failure, context), /Lead/);
  await host.call("squadron_report", { type: "done", commit, summary: "Build completed." }, context);
  assert.equal((await host.call("squadron_report", failure)).count, 1);
  assert.equal((await host.call("squadron_report", failure)).count, 1);
  await host.rpc("lanes.stop"); await host.rpc("lanes.resume");
  const next = await host.harness.lifecycle.reload(async (api) => { await (await import("../server.js")).default(api); });
  const fixedCommit = "c".repeat(40);
  await next.harness.behavior.callAgentTool("squadron_report", { type: "done", commit: fixedCommit, summary: "Fixed head." }, context);
  const result = JSON.parse(String(await next.harness.behavior.callAgentTool("squadron_report", { ...failure, eventId: "check-c", commit: fixedCommit, summary: "Lead: second deliverable failed after the fix." }, { projectId: "proj-one", threadId: "thr_lead" })));
  assert.equal(result.count, 2);
  const status = await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as import("../lib/board-model.js").Board;
  assert.equal(status.lanes[0].state, "stopped");
  assert.match(status.lanes[0].stopReason!, /Lead: second deliverable failed after the fix/);
  assert.equal(status.lanes[0].branch, "bb/integration");
});

test("worker reports truly stuck; unrelated ticket and ordinary red progress do not share strikes", async (t) => {
  const host = await laneHost(t); await host.rpc("lanes.start");
  const worker = await host.call("squadron_spawn_worker", { ticketId: "FIX-6" });
  const context = { projectId: "proj-one", threadId: worker.threadId };
  await host.call("squadron_report", { type: "progress", summary: "Red compile failure; fixing the missing export." }, context);
  assert.equal((await host.call("squadron_report", { type: "stuck", eventId: "stuck-a", summary: "No way forward: required input cannot be obtained." }, context)).count, 1);
  const second = await host.call("squadron_spawn_worker", { ticketId: "FIX-7" });
  assert.equal((await host.call("squadron_report", { type: "stuck", eventId: "stuck-a", summary: "No way forward: different blocker." }, { ...context, threadId: second.threadId })).count, 1);
  assert.equal((await host.board()).lanes[0].state, "flying");
});

test("injected time checks nudge a bound worker, passive polling and Helper sends do not count, next check stops through lifecycle", async (t) => {
  let now = 1_000_000;
  const host = await laneHost(t, { now: () => now }); await host.rpc("lanes.start");
  const worker = await host.call("squadron_spawn_worker", { ticketId: "FIX-6" });
  now += 10_800_001;
  await host.safety.check("proj-one");
  assert.match(host.sends.at(-1)!.text, /Act at once/);
  assert.equal(host.sends.at(-1)!.threadId, worker.threadId);
  assert.equal((await host.board()).lanes[0].state, "flying");
  await host.call("squadron_status", {}, { projectId: "proj-one", threadId: worker.threadId });
  await host.bb.sdk.threads.send({ threadId: worker.threadId, mode: "steer-if-active", input: [{ type: "text", mentions: [], text: "Helper metadata notification" }] });
  now += 60_000; await host.safety.check("proj-one");
  assert.equal((await host.board()).lanes[0].state, "stopped");
  assert.ok(host.harness.inspection.sdk.callsTo("threads.stop").length >= 2);
});

test("a bound-agent progress report after a nudge prevents stop at next check; reported completion leaves worker clock", async (t) => {
  let now = 1_000_000;
  const host = await laneHost(t, { now: () => now }); await host.rpc("lanes.start");
  const worker = await host.call("squadron_spawn_worker", { ticketId: "FIX-6" });
  const context = { projectId: "proj-one", threadId: worker.threadId };
  now += 10_800_001; await host.safety.check("proj-one");
  await host.call("squadron_report", { type: "progress", summary: "Preserved work, finishing the one compile repair." }, context);
  now += 60_000; await host.safety.check("proj-one");
  assert.equal((await host.board()).lanes[0].state, "flying");
  await host.call("squadron_report", { type: "done", commit, summary: "Finished." }, context);
  now += 60_000; await host.safety.check("proj-one");
  assert.equal((await host.board()).lanes[0].state, "flying");
  now = 29_800_001; await host.safety.check("proj-one");
  assert.equal(host.sends.at(-1)!.threadId, "thr_lead");
});

test("queued nudges wait for observed dispatch before the next-check stop, including across reload", async (t) => {
  let now = 1_000_000;
  const host = await laneHost(t, { now: () => now, queueNudges: true }); await host.rpc("lanes.start");
  const worker = await host.call("squadron_spawn_worker", { ticketId: "FIX-6" });
  now += 10_800_001; await host.safety.check("proj-one");
  now += 60_000; await host.safety.check("proj-one");
  assert.equal((await host.board()).lanes[0].state, "flying", "a queued nudge has not told the worker to act");
  assert.equal(host.sends.filter((item) => item.text.includes("Act at once")).length, 1, "one pending nudge, no queue flooding");
  let recovered!: Awaited<ReturnType<typeof import("../server.js").registerSquadron>>;
  const next = await host.harness.lifecycle.reload(async (api) => { recovered = await (await import("../server.js")).registerSquadron(api, { now: () => now }); });
  await next.harness.behavior.emitThreadEvent("message.dispatched", { entry: host.nudgeRows[0] });
  await next.harness.behavior.callAgentTool("squadron_status", {}, { projectId: "proj-one", threadId: worker.threadId });
  now += 60_000;
  await recovered.safety.check("proj-one");
  const board = await next.harness.behavior.callRpc("board", { projectId: "proj-one" }) as import("../lib/board-model.js").Board;
  assert.equal(board.lanes[0].state, "stopped");
});
