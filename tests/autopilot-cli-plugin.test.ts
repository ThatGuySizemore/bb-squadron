import { test } from "node:test";
import assert from "node:assert/strict";
import { helperFixture } from "./fixtures/helper-plugin.js";

const epoch = Date.parse("2026-11-14T12:00:00Z");

test("board Resume refuses when Autopilot is not paused without changing its state", async (t) => {
  const f = await helperFixture(t, epoch);
  for (const status of ["off", "on"] as const) {
    await f.harness.behavior.callRpc("autopilot.set", { projectId: "one", status });
    await assert.rejects(f.harness.behavior.callRpc("autopilot.resume", { projectId: "one" }),
      { message: "Autopilot isn't paused." });
    assert.equal((await f.board()).autopilot?.status, status);
  }
});

test("CLI on and off use the board's per-project controls and project selection", async (t) => {
  const f = await helperFixture(t, epoch);
  assert.deepEqual(await f.harness.behavior.runCli(["autopilot", "on"], { projectId: "one" }),
    { exitCode: 0, stdout: "Autopilot on.\n", stderr: "" });
  assert.deepEqual((await f.board()).autopilot,
    { status: "on", laneLimit: 3, consecutiveStops: 0, pauseReason: null });
  assert.equal((await f.board("two")).autopilot?.status, "off");
  assert.deepEqual(await f.harness.behavior.runCli(["autopilot", "off", "--project", "Fixture"], { projectId: "two" }),
    { exitCode: 0, stdout: "Autopilot off.\n", stderr: "" });
  assert.equal((await f.board()).autopilot?.status, "off");
});

test("CLI lane limits match the board and refuse invalid counts with one line", async (t) => {
  const f = await helperFixture(t, epoch);
  for (const count of ["1", "10"]) {
    assert.deepEqual(await f.harness.behavior.runCli(["autopilot", "lanes", count], { projectId: "one" }),
      { exitCode: 0, stdout: `Autopilot lane limit: ${count}.\n`, stderr: "" });
    assert.equal((await f.board()).autopilot?.laneLimit, Number(count));
  }
  for (const count of ["0", "11", "1.5", "NaN", "2x", "Infinity"]) {
    assert.deepEqual(await f.harness.behavior.runCli(["autopilot", "lanes", count], { projectId: "one" }),
      { exitCode: 1, stdout: "", stderr: "Choose a whole lane count from 1 to 10.\n" });
    assert.equal((await f.board()).autopilot?.laneLimit, 10);
  }
  assert.equal((await f.board("two")).autopilot?.laneLimit, 3);
});

test("CLI Resume shares the board's refusal and resets the brake count only from paused", async (t) => {
  const f = await helperFixture(t, epoch);
  for (const status of ["off", "on"] as const) {
    await f.harness.behavior.callRpc("autopilot.set", { projectId: "one", status });
    assert.deepEqual(await f.harness.behavior.runCli(["autopilot", "resume"], { projectId: "one" }),
      { exitCode: 1, stdout: "", stderr: "Autopilot isn't paused.\n" });
    assert.equal((await f.board()).autopilot?.status, status);
  }
  const first = f.lead("one", "Lead");
  f.threads.set(first.id, { ...first, status: "idle" });
  f.threads.set("lead-second", { ...first, id: "lead-second", status: "idle" });
  f.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) =>
    ({ role: "lead", specId: threadId === "lead-second" ? "fix-1" : "fix-5" }));
  assert.deepEqual((await f.board()).autopilot,
    { status: "paused", laneLimit: 3, consecutiveStops: 2, pauseReason: "Two lanes in a row stopped" });
  assert.deepEqual(await f.harness.behavior.runCli(["autopilot", "resume", "--project", "one"]),
    { exitCode: 0, stdout: "Autopilot resumed.\n", stderr: "" });
  assert.deepEqual((await f.board()).autopilot,
    { status: "on", laneLimit: 3, consecutiveStops: 0, pauseReason: null });
});

test("CLI Pause keeps flying work and delivers Autopilot paused through Needs you and the Helper", async (t) => {
  const f = await helperFixture(t, epoch);
  f.lead("one", "Lead");
  await f.harness.behavior.runCli(["autopilot", "on"], { projectId: "one" });
  assert.deepEqual(await f.harness.behavior.runCli(["autopilot", "pause"], { projectId: "one" }),
    { exitCode: 0, stdout: "Autopilot paused.\n", stderr: "" });
  assert.deepEqual((await f.board()).autopilot,
    { status: "paused", laneLimit: 3, consecutiveStops: 0, pauseReason: "Paused at your request" });
  assert.equal((await f.board()).lanes[0].state, "flying");
  assert.deepEqual(await f.harness.behavior.runCli(["needs", "--project", "one"]), {
    exitCode: 0, stdout: "Fixture | Autopilot paused | Project | Paused at your request | /plugins/squadron/board\n", stderr: "",
  });
  await f.startWatcher();
  await f.advance(120_000);
  assert.equal(f.sends().length, 1);
  assert.equal(f.sends()[0].input[0].text,
    "Fixture | Autopilot paused | Project | Paused at your request | /plugins/squadron/board");
  assert.equal(f.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  await f.reload();
  assert.equal((await f.board()).autopilot?.status, "paused");
  assert.deepEqual(await f.harness.behavior.runCli(["autopilot", "resume"], { projectId: "one" }),
    { exitCode: 0, stdout: "Autopilot resumed.\n", stderr: "" });
  assert.equal((await f.harness.behavior.runCli(["needs", "--project", "one"])).stdout, "Nothing needs you.\n");
});

test("Autopilot commands keep project refusals short and preserve client-only board RPC access", async (t) => {
  const f = await helperFixture(t, epoch);
  f.projects.push({ ...f.projects[1], id: "three" });
  for (const args of [["on"], ["off"], ["pause"], ["resume"], ["lanes", "4"]]) {
    for (const [selection, reason] of [
      [[], "Choose a project with --project."],
      [["--project", "Missing"], 'No project matches "Missing".'],
      [["--project", "Second"], 'More than one project matches "Second". Use its project ID.'],
    ] as const) {
      assert.deepEqual(await f.harness.behavior.runCli(["autopilot", ...args, ...selection]),
        { exitCode: 1, stdout: "", stderr: `${reason}\n` });
    }
  }
  assert.deepEqual(await f.harness.behavior.runCli(["autopilot", "lanes"], { projectId: "one" }),
    { exitCode: 1, stdout: "", stderr: "Choose a whole lane count from 1 to 10.\n" });
  for (const [method, input, reason] of [
    ["autopilot.set", { projectId: "one", status: "on" }, "Change Autopilot from the Squadron board."],
    ["autopilot.resume", { projectId: "one" }, "Resume Autopilot from the Squadron board."],
  ] as const) {
    await assert.rejects(f.harness.behavior.callRpc(method, input,
      { experimental_caller: { kind: "plugin", pluginId: "other" } }), { message: reason });
  }
  assert.equal((await f.board()).autopilot?.status, "off");
});

test("CLI Pause and lane changes retain the existing stop count until Resume", async (t) => {
  const f = await helperFixture(t, epoch);
  await f.harness.behavior.callRpc("autopilot.set", { projectId: "one", status: "on" });
  const stopped = f.lead("one", "Lead");
  f.threads.set(stopped.id, { ...stopped, status: "idle" });
  assert.equal((await f.board()).autopilot?.consecutiveStops, 1);
  await f.harness.behavior.runCli(["autopilot", "pause"], { projectId: "one", threadId: "helper" });
  await f.harness.behavior.runCli(["autopilot", "lanes", "4"], { projectId: "one", threadId: "helper" });
  assert.deepEqual((await f.board()).autopilot,
    { status: "paused", laneLimit: 4, consecutiveStops: 1, pauseReason: "Paused at your request" });
  await f.harness.behavior.runCli(["autopilot", "resume"], { projectId: "one", threadId: "helper" });
  assert.deepEqual((await f.board()).autopilot,
    { status: "on", laneLimit: 4, consecutiveStops: 0, pauseReason: null });
});
