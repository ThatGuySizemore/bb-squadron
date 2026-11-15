import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { helperFixture } from "./fixtures/helper-plugin.js";
import { workspace } from "./fixtures/board-workspace.js";

const epoch = Date.parse("2026-11-14T14:00:00Z");
function fixture(t: TestContext, options: Parameters<typeof workspace>[0] = {}, storedNotifications?: unknown, storedSummary?: unknown) {
  return helperFixture(t, epoch, options, storedNotifications, storedSummary);
}

test("registered daily schedule queues one summary per project at 08:00 server local", async (t) => {
  const previous = process.env.TZ;
  process.env.TZ = "America/Chicago";
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  const f = await fixture(t);
  f.threads.set("helper-two", makeThreadResponse({ id: "helper-two", projectId: "two", status: "active" }));
  await f.harness.behavior.callRpc("helper.use", { projectId: "two", threadId: "helper-two" });
  f.lead("one", "Lead"); f.lead("two");
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.deepEqual(f.sends(), [{ threadId: "helper", mode: "queue-if-active", input: [{ type: "text", mentions: [], text:
    "Daily summary\nFixture | Landed since last summary: none | Flying: FIX-5 | Needs you: 0" }] },
    { threadId: "helper-two", mode: "queue-if-active", input: [{ type: "text", mentions: [], text:
      "Daily summary\nSecond | Landed since last summary: none | Flying: FIX-5 | Needs you: 1" }] }]);
  await Promise.all([f.harness.behavior.runSchedule("helper-daily-summary"), f.harness.behavior.runSchedule("helper-daily-summary")]);
  assert.equal(f.sends().length, 2);
  await f.reload();
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.equal(f.sends().length, 0);
});

test("time changes apply immediately, Off and no Helper send nothing, and the local day sends once", async (t) => {
  const f = await fixture(t);
  const run = () => f.harness.behavior.runSchedule("helper-daily-summary");
  await f.harness.behavior.setSettings({ dailySummaryTime: "23:59" });
  await run();
  assert.equal(f.sends().length, 0);
  await f.harness.behavior.setSettings({ dailySummaryTime: "Off" });
  await run();
  assert.equal(f.sends().length, 0);
  await f.harness.behavior.setSettings({ dailySummaryTime: "00:00" });
  f.threads.delete("helper");
  await run();
  assert.equal(f.sends().length, 0);
  f.threads.set("helper", makeThreadResponse({ id: "helper", projectId: "one", status: "active" }));
  await run();
  assert.equal(f.sends().length, 1);
  await f.harness.behavior.setSettings({ dailySummaryTime: "01:00" });
  await run();
  assert.equal(f.sends().length, 1, "a settings change doesn't cause a second summary today");
  await assert.rejects(f.harness.behavior.setSettings({ dailySummaryTime: "25:00" }));
  await assert.rejects(f.harness.behavior.setSettings({ dailySummaryTime: "8am" }));
});

test("failed sends preserve observed landings across reload even when their Lead disappears", async (t) => {
  const f = await fixture(t);
  await f.harness.behavior.setSettings({ dailySummaryTime: "00:00" });
  f.lead("one", "Lead");
  const run = () => f.harness.behavior.runSchedule("helper-daily-summary");
  await run();
  await f.advance(86_400_000);
  f.harness.sdk.stub("plugins.callRpc", async () => ({ "env-one": { outcome: "available", pullRequest: {
    number: 12, state: "merged", url: "https://github.example/fixture/pull/12", updatedAt: new Date(Date.now()).toISOString(), checks: { state: "passing" },
  } } }));
  f.harness.sdk.stub("threads.send", async () => { throw new Error("delivery failed"); });
  await assert.rejects(run(), /delivery failed/);
  await f.reload();
  f.threads.delete("lead-one");
  f.harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "queued" }));
  await run();
  assert.equal(f.sends()[0].input[0].text,
    "Daily summary\nFixture | Landed since last summary: FIX-5 | Flying: none | Needs you: 0");
  await f.advance(86_400_000);
  await f.reload();
  f.lead("one", "Lead");
  f.harness.sdk.stub("plugins.callRpc", async () => ({ "env-one": { outcome: "available", pullRequest: {
    number: 12, state: "merged", url: "https://github.example/fixture/pull/12", updatedAt: "2026-11-15T14:00:00Z", checks: { state: "passing" },
  } } }));
  await run();
  assert.equal(f.sends()[0].input[0].text,
    "Daily summary\nFixture | Landed since last summary: none | Flying: none | Needs you: 0");
});

test("default time follows server-local DST, including a skipped time and a repeated hour", async (t) => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  const f = await fixture(t);
  const run = () => f.harness.behavior.runSchedule("helper-daily-summary");
  t.mock.timers.setTime(Date.parse("2026-11-14T12:59:00Z"));
  await run();
  assert.equal(f.sends().length, 0, "07:59 server local is before the default");
  t.mock.timers.setTime(Date.parse("2026-11-14T13:00:00Z"));
  await run();
  assert.equal(f.sends().length, 1, "08:00 server local sends, independent of UTC");
  await f.harness.behavior.setSettings({ dailySummaryTime: "02:30" });
  t.mock.timers.setTime(Date.parse("2027-03-14T06:59:00Z"));
  await run();
  assert.equal(f.sends().length, 1);
  t.mock.timers.setTime(Date.parse("2027-03-14T07:00:00Z"));
  await run();
  assert.equal(f.sends().length, 2, "a skipped local time catches up at 03:00");
  await f.harness.behavior.setSettings({ dailySummaryTime: "01:30" });
  t.mock.timers.setTime(Date.parse("2027-11-07T05:30:00Z"));
  await run();
  assert.equal(f.sends().length, 3);
  await f.reload();
  t.mock.timers.setTime(Date.parse("2027-11-07T06:30:00Z"));
  await run();
  assert.equal(f.sends().length, 0, "the repeated 01:30 doesn't send again after reload");
});

test("shared unattended observation retains a landing while summary is Off and the lane later disappears", async (t) => {
  const f = await fixture(t);
  await f.harness.behavior.setSettings({ dailySummaryTime: "Off" });
  f.lead("one", "Lead");
  await f.startWatcher();
  f.harness.sdk.stub("plugins.callRpc", async () => ({ "env-one": { outcome: "available", pullRequest: {
    number: 12, state: "merged", url: "https://github.example/fixture/pull/12", updatedAt: new Date(Date.now()).toISOString(), checks: { state: "passing" },
  } } }));
  await f.advance(30_000);
  await f.reload();
  f.threads.delete("lead-one");
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.equal(f.sends().length, 0);
  await f.harness.behavior.setSettings({ dailySummaryTime: "00:00" });
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.equal(f.sends()[0].input[0].text,
    "Daily summary\nFixture | Landed since last summary: FIX-5 | Flying: none | Needs you: 0");
});

test("turning summary Off during board reads cancels delivery without consuming landing history", async (t) => {
  const f = await fixture(t);
  await f.harness.behavior.setSettings({ dailySummaryTime: "00:00" });
  f.lead("one", "Lead");
  f.harness.sdk.stub("plugins.callRpc", async () => {
    await f.harness.behavior.setSettings({ dailySummaryTime: "Off" });
    return { "env-one": { outcome: "available", pullRequest: {
      number: 12, state: "merged", url: "https://github.example/fixture/pull/12", updatedAt: new Date(Date.now()).toISOString(), checks: { state: "passing" },
    } } };
  });
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.equal(f.sends().length, 0);
  f.threads.delete("lead-one");
  await f.harness.behavior.setSettings({ dailySummaryTime: "00:00" });
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.equal(f.sends()[0].input[0].text,
    "Daily summary\nFixture | Landed since last summary: FIX-5 | Flying: none | Needs you: 0");
});

test("a failed summary leaves only that project's boundary pending across reload", async (t) => {
  const f = await fixture(t);
  await f.harness.behavior.setSettings({ dailySummaryTime: "00:00" });
  f.threads.set("helper-two", makeThreadResponse({ id: "helper-two", projectId: "two", status: "active" }));
  await f.harness.behavior.callRpc("helper.use", { projectId: "two", threadId: "helper-two" });
  f.lead("one", "Lead"); f.lead("two", "Lead");
  f.harness.sdk.stub("plugins.callRpc", async () => Object.fromEntries(["one", "two"].map((id) => [`env-${id}`, { outcome: "available", pullRequest: {
    number: 12, state: "merged", url: `https://github.example/${id}/pull/12`, updatedAt: new Date(Date.now()).toISOString(), checks: { state: "passing" },
  } }])));
  f.harness.sdk.stub("threads.send", async ({ threadId }: { threadId: string }) => {
    if (threadId === "helper") throw new Error("first project delivery failed");
    return { ok: true, delivery: "queued" };
  });
  await assert.rejects(f.harness.behavior.runSchedule("helper-daily-summary"), /first project delivery failed/);
  assert.deepEqual(f.sends().map((send) => [send.threadId, send.input[0].text]), [
    ["helper", "Daily summary\nFixture | Landed since last summary: FIX-5 | Flying: none | Needs you: 0"],
    ["helper-two", "Daily summary\nSecond | Landed since last summary: FIX-5 | Flying: none | Needs you: 0"],
  ]);
  await f.reload();
  f.threads.delete("lead-one"); f.threads.delete("lead-two");
  f.harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "queued" }));
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.deepEqual(f.sends().map((send) => [send.threadId, send.input[0].text]), [
    ["helper", "Daily summary\nFixture | Landed since last summary: FIX-5 | Flying: none | Needs you: 0"],
  ]);
  await f.advance(86_400_000);
  await f.reload();
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.deepEqual(f.sends().map((send) => [send.threadId, send.input[0].text]), [
    ["helper", "Daily summary\nFixture | Landed since last summary: none | Flying: none | Needs you: 0"],
    ["helper-two", "Daily summary\nSecond | Landed since last summary: none | Flying: none | Needs you: 0"],
  ]);
});

test("a project with no Helper retains its landing when another project's summary succeeds", async (t) => {
  const f = await fixture(t);
  await f.harness.behavior.setSettings({ dailySummaryTime: "00:00" });
  f.lead("two", "Lead");
  f.harness.sdk.stub("plugins.callRpc", async () => ({ "env-two": { outcome: "available", pullRequest: {
    number: 12, state: "merged", url: "https://github.example/two/pull/12", updatedAt: new Date(Date.now()).toISOString(), checks: { state: "passing" },
  } } }));
  await f.startWatcher();
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.deepEqual(f.sends().map((send) => [send.threadId, send.input[0].text]), [
    ["helper", "Daily summary\nFixture | Landed since last summary: none | Flying: none | Needs you: 0"],
  ]);
  await f.reload();
  f.threads.delete("lead-two");
  f.threads.set("helper-two", makeThreadResponse({ id: "helper-two", projectId: "two", status: "active" }));
  await f.harness.behavior.callRpc("helper.use", { projectId: "two", threadId: "helper-two" });
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.deepEqual(f.sends().map((send) => [send.threadId, send.input[0].text]), [
    ["helper-two", "Daily summary\nSecond | Landed since last summary: FIX-5 | Flying: none | Needs you: 0"],
  ]);
});

test("upgrading shared summary history retains the delivered day and each project's pending landings", async (t) => {
  const now = new Date(epoch);
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const f = await fixture(t, {}, undefined, { boundary: epoch, day,
    seen: ['["one","old-first"]', '["two","old-second"]'],
    landed: {
      '["one","old-first"]': { projectId: "one", specId: "FIX-101" },
      '["two","old-second"]': { projectId: "two", specId: "FIX-202" },
    },
  });
  await f.harness.behavior.setSettings({ dailySummaryTime: "00:00" });
  f.threads.set("helper-two", makeThreadResponse({ id: "helper-two", projectId: "two", status: "active" }));
  await f.harness.behavior.callRpc("helper.use", { projectId: "two", threadId: "helper-two" });
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.equal(f.sends().length, 0, "the already delivered local day survives the upgrade");
  await f.advance(86_400_000); await f.reload();
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.deepEqual(f.sends().map((send) => [send.threadId, send.input[0].text]), [
    ["helper", "Daily summary\nFixture | Landed since last summary: FIX-101 | Flying: none | Needs you: 0"],
    ["helper-two", "Daily summary\nSecond | Landed since last summary: FIX-202 | Flying: none | Needs you: 0"],
  ]);
  await f.advance(86_400_000); await f.reload();
  await f.harness.behavior.runSchedule("helper-daily-summary");
  assert.deepEqual(f.sends().map((send) => [send.threadId, send.input[0].text]), [
    ["helper", "Daily summary\nFixture | Landed since last summary: none | Flying: none | Needs you: 0"],
    ["helper-two", "Daily summary\nSecond | Landed since last summary: none | Flying: none | Needs you: 0"],
  ]);
});
