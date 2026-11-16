import { test, type TestContext } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { helperFixture } from "./fixtures/helper-plugin.js";
import { turnIntervals, unionMs } from "../lib/active-time.js";
import { workItemPrompt } from "../lib/work-item-prompt.js";
import { parseSquadronSettings } from "../lib/squadron-settings.js";
import { house, shared } from "./fixtures/model-routes.js";

// SQD-276: a lane's time limit counts only the time its threads are running a turn.
const epoch = Date.parse("2026-11-16T12:00:00Z");
const MIN = 60_000;
type Event = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];
type Kind = "turn/started" | "turn/completed" | "system/thread/interrupted";

/** Boundary events at minutes after the epoch, newest first, as BB lists them. */
function turns(threadId: string, boundaries: [number, Kind][]): Event[] {
  return boundaries.map(([minute, type], index) => ({ id: `${threadId}-${index}`, threadId, seq: index + 1, createdAt: epoch + minute * MIN,
    scope: { kind: "thread" as const }, type,
    data: type === "turn/completed" ? { status: "completed", providerThreadId: null } : type === "turn/started" ? { providerThreadId: null } : { reason: "stop" },
  }) as unknown as Event).reverse();
}

test("only running turns count: gaps, interruptions and an open turn", () => {
  const events = turns("t", [[0, "turn/started"], [10, "turn/completed"], [70, "turn/started"], [75, "system/thread/interrupted"], [200, "turn/started"]]);
  assert.equal(unionMs(turnIntervals(events, epoch + 210 * MIN, false)), 15 * MIN, "an open turn on a thread that isn't running ended unseen and counts nothing");
  assert.equal(unionMs(turnIntervals(events, epoch + 210 * MIN, true)), 25 * MIN, "an open turn on a running thread counts up to now");
});

test("a new start closes a turn that never recorded its end, and a stray end counts nothing", () => {
  const events = turns("t", [[5, "turn/completed"], [10, "turn/started"], [20, "turn/started"], [30, "turn/completed"]]);
  assert.equal(unionMs(turnIntervals(events, epoch + 40 * MIN, false)), 20 * MIN);
});

test("overlapping intervals count once", () => {
  assert.equal(unionMs([[0, 10 * MIN], [5 * MIN, 20 * MIN], [30 * MIN, 31 * MIN]]), 21 * MIN);
});

async function fixture(t: TestContext) {
  const f = await helperFixture(t, epoch + 600 * MIN);
  const lead = f.lead("one", "Lead FIX-5");
  f.threads.set(lead.id, { ...lead, status: "idle", runtime: { displayStatus: "idle" } });
  const child = (id: string, status: "idle" | "active" = "idle") => {
    const thread = makeThreadResponse({ id, projectId: "one", parentThreadId: lead.id, title: id, status, createdAt: epoch });
    f.threads.set(id, thread); return thread;
  };
  const run = (...args: string[]) => f.harness.behavior.runCli(["time", "FIX-5", ...args], { threadId: lead.id, projectId: "one" });
  return { f, lead, child, run };
}

test("time counts turns across a declared wait, a Stop with Resume and idle gaps, and counts overlap once", async (t) => {
  const { f, lead, child, run } = await fixture(t);
  child("worker-a"); child("worker-b");
  // Lead: 0-30 working, a declared wait (30-150) that isn't a turn, 150-160 after the other lane lands,
  // then a Stop's wind-down 300-305, stopped for hours, and a Resume turn 500-520.
  f.events.set(lead.id, turns(lead.id, [[0, "turn/started"], [30, "turn/completed"], [150, "turn/started"], [160, "turn/completed"],
    [300, "turn/started"], [305, "turn/completed"], [500, "turn/started"], [520, "system/thread/interrupted"]]));
  // Workers overlap the Lead (10-40 overlaps 0-30 by 20) and each other.
  f.events.set("worker-a", turns("worker-a", [[10, "turn/started"], [40, "turn/completed"]]));
  f.events.set("worker-b", turns("worker-b", [[20, "turn/started"], [45, "turn/completed"]]));
  const out = await run();
  assert.equal(out.exitCode, 0, out.stderr);
  // Union: 0-45 (45) + 150-160 (10) + 300-305 (5) + 500-520 (20) = 80 minutes. Wall time is 600+.
  assert.match(out.stdout, /FIX-5 active time: 1 h 20 min of its 8 h lane limit/);
  assert.match(out.stdout, /waiting, stopped and idle time isn't counted/i);
  assert.match(out.stdout, /overlap counts once/i);
});

test("time reads a running turn up to now and pages events a hundred at a time", async (t) => {
  const { f, lead, run } = await fixture(t);
  f.threads.set(lead.id, { ...f.threads.get(lead.id)!, status: "active", runtime: { displayStatus: "active" } });
  f.events.set(lead.id, turns(lead.id, [[580, "turn/started"]]));
  const limits: unknown[] = [];
  f.harness.sdk.stub("threads.events.list", async (args: Parameters<BbPluginApi["sdk"]["threads"]["events"]["list"]>[0]) => {
    limits.push(args.limit);
    return (f.events.get(args.threadId) ?? []).filter((event) => !args.beforeSeq || event.seq < Number(args.beforeSeq));
  });
  const out = await run();
  assert.equal(out.exitCode, 0, out.stderr);
  assert.match(out.stdout, /active time: 20 min of/);
  assert.ok(limits.length && limits.every((limit) => Number(limit) <= 100), `event pages stay within 100: ${limits}`);
});

test("a work item reads against the worker limit and a spec against the lane limit", async (t) => {
  const { f, lead, run } = await fixture(t);
  f.events.set(lead.id, turns(lead.id, [[0, "turn/started"], [30, "turn/completed"]]));
  assert.match((await run()).stdout, /of its 8 h lane limit/);
  const original = f.harness.sdk;
  original.stub("threads.getPluginMetadata", async () => ({ role: "lead", specId: "fix-5", kind: "work-item" }));
  assert.match((await run()).stdout, /of its 1 h 30 min worker limit/);
});

test("time exits non-zero for a spec with no Lead", async (t) => {
  const { f } = await fixture(t);
  const out = await f.harness.behavior.runCli(["time", "FIX-404"], { threadId: "x", projectId: "one" });
  assert.equal(out.exitCode, 1);
});

const settings = () => { const parsed = parseSquadronSettings(shared, "linear", house); assert.ok(parsed.ok); return parsed.settings; };

test("the work-item brief counts active time and names the command that reads it", () => {
  const brief = workItemPrompt({ identifier: "FIX-9", url: "https://example.test/FIX-9", settings: settings(), houseRules: "/h.md", machine: "/m.md", acceptOwner: false });
  assert.match(brief, /counts only active time/i);
  assert.match(brief, /bb squadron time 'FIX-9'/);
  assert.doesNotMatch(brief, /from this thread's creation/);
  assert.doesNotMatch(brief, /cumulative elapsed time/);
});

test("the Lead skill and settings doc say the limits count active time", async () => {
  const skill = await readFile("skills/squadron-lead/SKILL.md", "utf8");
  assert.match(skill, /bb squadron time/);
  assert.match(skill, /active time/i);
  assert.doesNotMatch(skill, /elapsed time against project settings/);
  assert.match(await readFile("docs/settings.md", "utf8"), /active time/i);
});
