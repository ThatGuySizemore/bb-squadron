import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { helperFixture, settle } from "./fixtures/helper-plugin.js";
import { workspace, workspaceIssues } from "./fixtures/board-workspace.js";
import { STOP_MESSAGE } from "../lib/lane-contract.js";

const epoch = Date.parse("2026-11-14T12:00:00Z");
function fixture(t: TestContext, options: Parameters<typeof workspace>[0] = {}, storedNotifications?: unknown) {
  return helperFixture(t, epoch, options, storedNotifications);
}

test("unattended projects batch new questions into one queued Helper message after two quiet minutes", async (t) => {
  const f = await fixture(t);
  f.lead("one"); f.lead("two");
  await f.startWatcher();
  await f.advance(119_999);
  assert.equal(f.sends().length, 0);
  await f.advance(1);
  assert.deepEqual(f.sends(), [{ threadId: "helper", mode: "queue-if-active", input: [{ type: "text", mentions: [], text:
    "Fixture | Question | FIX-5 | The Lead for FIX-5 is waiting on you. | @thread:lead-one\nSecond | Question | FIX-5 | The Lead for FIX-5 is waiting on you. | @thread:lead-two" }] }]);
});

test("reported questions survive reload, clear when work resumes, and notify again when they return", async (t) => {
  const f = await fixture(t);
  const lead = f.lead("one");
  await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 1);
  await f.reload(); await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 0, "the new host sends no repeated question");
  f.threads.set(lead.id, { ...lead, title: "Working" });
  await f.advance(30_000);
  f.threads.set(lead.id, lead);
  await f.advance(30_000); await f.advance(120_000);
  assert.equal(f.sends().length, 1, "a cleared question returning is a new event");
});


test("a normally completed quiet Lead becomes a Question at five minutes in the board and Helper batch", async (t) => {
  const f = await fixture(t);
  const lead = f.lead("one", "Lead");
  f.threads.set(lead.id, { ...lead, status: "idle", runtime: { displayStatus: "idle" }, updatedAt: epoch - 86_400_000 });
  f.events.set(lead.id, [{ id: "completed", threadId: lead.id, seq: 4, createdAt: epoch, scope: { kind: "thread" },
    type: "turn/completed", data: { status: "completed", providerThreadId: null } }]);
  await f.startWatcher();
  const early = await f.board();
  assert.equal(early.lanes[0].state, "flying", "normal turn completion isn't a stop");
  assert.equal(early.lanes[0].needs, undefined);
  await f.advance(299_999);
  assert.equal((await f.board()).lanes[0].needs, undefined);
  assert.equal(f.sends().length, 0);
  await f.advance(1);
  assert.deepEqual((await f.board()).lanes[0].needs, [{ threadId: "lead-one", kind: "waiting", text: "The Lead is waiting on you" }]);
  await f.advance(30_000); await f.advance(120_000);
  assert.equal(f.sends().length, 1);
  assert.equal(f.sends()[0].input[0].text, "Fixture | Question | FIX-5 | The Lead is waiting on you | @thread:lead-one");
  await f.advance(120_000);
  assert.equal(f.sends().length, 1);
});

test("a fresh PR landing shares the Needs you batch, survives reload and never replays old landings", async (t) => {
  const f = await fixture(t);
  f.lead("one", "Lead");
  let merged = false;
  f.harness.sdk.stub("plugins.callRpc", async () => ({ "env-one": { outcome: "available", pullRequest: {
    number: 12, state: merged ? "merged" : "open", url: "https://github.example/fixture/pull/12", updatedAt: new Date(Date.now()).toISOString(), checks: { state: "passing" },
  } } }));
  await f.startWatcher();
  await f.advance(120_000);
  assert.equal(f.sends().length, 0, "an open ready PR doesn't wake the Helper");
  merged = true; f.lead("two");
  await f.advance(30_000); await f.advance(120_000);
  assert.equal(f.sends().length, 1);
  assert.equal(f.sends()[0].input[0].text,
    "Fixture | Landed | FIX-5 | The lane landed. | https://github.example/fixture/pull/12\nSecond | Question | FIX-5 | The Lead for FIX-5 is waiting on you. | @thread:lead-two");
  await f.reload(); await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 0, "neither the landing nor the question repeats after reload");
});


test("an unattended Linear poll observes the spec becoming Landed without a PR or board", async (t) => {
  let done = false;
  const spec = workspaceIssues.data.issues.nodes.find((node) => node.identifier === "FIX-5")!;
  const current = () => ({ ...spec, ...(done ? { state: { id: "done", name: "Done", type: "completed" }, updatedAt: new Date(Date.now()).toISOString() } : {}) });
  const f = await fixture(t, {
    issues: () => Response.json({ data: { issues: { ...workspaceIssues.data.issues, nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-5" ? current() : node) } } }),
    laneSpec: (id) => Response.json({ data: { issue: id === "fix-5" ? { ...current(), children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } : null } }),
  });
  f.lead("one", "Lead");
  await f.startWatcher();
  f.harness.behavior.runService("linear-reader"); await settle();
  done = true;
  await f.advance(30_000); await f.advance(120_000);
  assert.equal(f.sends().length, 1);
  assert.equal(f.sends()[0].input[0].text,
    "Fixture | Landed | FIX-5 | The lane landed. | https://linear.app/fixture/issue/FIX-5");
});

test("new items extend the quiet window but a continuous batch flushes at ten minutes", async (t) => {
  const f = await fixture(t);
  f.lead("one");
  await f.startWatcher();
  for (let minute = 1; minute <= 6; minute++) {
    await f.advance(60_000);
    const id = `extra-${minute}`;
    f.projects.push({ ...f.projects[0], id, name: `Project ${minute}` });
    f.lead(id);
    // New thread activity is discovered by the next code watcher pass.
    await f.advance(30_000);
    assert.equal(f.sends().length, 0);
  }
  // Six arrivals end at minute nine. The two-minute quiet window would be
  // minute eleven; the first arrival's ten-minute cap wins.
  await f.advance(59_999);
  assert.equal(f.sends().length, 0);
  await f.advance(1);
  assert.equal(f.sends().length, 1);
  assert.equal(f.sends()[0].input[0].text.split("\n").length, 7);
});

test("a project read failure wakes the Helper as Setup without hiding another project's question", async (t) => {
  const f = await fixture(t);
  f.lead("two");
  const original = f.threads;
  f.harness.sdk.stub("threads.list", async (args: { projectId?: string; parentThreadId?: string }) => {
    if (args.projectId === "one") throw new Error("private host diagnostics");
    return [...original.values()].filter((thread) => thread.projectId === args.projectId && (!args.parentThreadId || thread.parentThreadId === args.parentThreadId))
      .map((thread) => ({ ...thread, hasPendingInteraction: thread.title === "Question", environmentBranchName: "spec/fix-5" }));
  });
  await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends()[0]?.input[0].text,
    "Fixture | Setup | Project | Couldn't read this project. Make sure its machine is online. | /plugins/squadron/board\nSecond | Question | FIX-5 | The Lead for FIX-5 is waiting on you. | @thread:lead-two");
});

test("no Helper sends nothing, a vanished pending item is dropped, and later selection receives current items", async (t) => {
  const f = await fixture(t);
  const lead = f.lead("one");
  f.threads.delete("helper");
  await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 0);
  f.threads.set(lead.id, { ...lead, title: "Working" });
  await f.advance(30_000); await f.reload(); await f.startWatcher();
  f.threads.set("helper", makeThreadResponse({ id: "helper", projectId: "one", status: "active" }));
  await f.advance(120_000);
  assert.equal(f.sends().length, 0, "the pending question cleared before it was delivered");
  f.threads.set(lead.id, lead);
  await f.advance(30_000); await f.advance(120_000);
  assert.equal(f.sends().length, 1);
});

test("an undelivered batch keeps its original quiet deadline across reload and retries a failed send", async (t) => {
  const f = await fixture(t);
  f.lead("one");
  await f.startWatcher(); await f.advance(60_000);
  await f.reload(); await f.startWatcher();
  let failing = true;
  f.harness.sdk.stub("threads.send", async () => { if (failing) throw new Error("private delivery detail"); return { ok: true, delivery: "queued" }; });
  await f.advance(59_999);
  assert.equal(f.sends().length, 0);
  await f.advance(1);
  assert.equal(f.sends().length, 1, "the original deadline attempted delivery");
  failing = false;
  await f.advance(30_000);
  assert.equal(f.sends().length, 2, "the failed send wasn't marked reported");
  await f.reload(); await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 0, "successful queued delivery is remembered");
});

test("genuine stops and busy workers never become quiet Questions", async (t) => {
  const f = await fixture(t);
  const lead = f.lead("one", "Lead");
  f.threads.set(lead.id, { ...lead, status: "idle", runtime: { displayStatus: "idle" } });
  const terminal = { id: "end", threadId: lead.id, seq: 4, createdAt: epoch - 600_000, scope: { kind: "thread" as const },
    type: "turn/completed" as const, data: { status: "completed" as const, providerThreadId: null } };
  const assertNoQuestion = async (state: string) => {
    const lane = (await f.board()).lanes[0];
    assert.equal(lane.state, state);
    assert.ok(!lane.needs?.some((item) => item.text === "The Lead is waiting on you"));
  };
  f.events.set(lead.id, [{ ...terminal, data: { ...terminal.data, status: "interrupted" } }]);
  await assertNoQuestion("stopped");
  f.events.set(lead.id, [{ ...terminal, type: "system/thread/interrupted", data: { reason: "manual-stop" } }]);
  await assertNoQuestion("stopped");
  f.events.set(lead.id, [{ ...terminal, data: { ...terminal.data, status: "failed" } }]);
  await assertNoQuestion("stopped");
  f.events.set(lead.id, []);
  await assertNoQuestion("stopped");
  f.events.set(lead.id, [terminal, { id: "stop", threadId: lead.id, seq: 3, createdAt: epoch - 610_000, scope: { kind: "thread" },
    type: "client/turn/requested", data: { direction: "outbound", execution: { model: "fixture", permissionMode: "auto", reasoningLevel: "medium", serviceTier: "default", source: "client/turn/requested" },
      source: "tell", senderThreadId: null, initiator: "user", input: [{ type: "text", text: STOP_MESSAGE, mentions: [] }], request: { method: "turn/start", params: {} }, requestId: "stop", target: { kind: "auto", expectedTurnId: null } } }]);
  await assertNoQuestion("stopped");
  f.events.set(lead.id, [terminal]);
  f.threads.set("worker", makeThreadResponse({ id: "worker", projectId: "one", parentThreadId: lead.id, status: "active", title: "Worker FIX-6" }));
  await assertNoQuestion("flying");
  f.threads.delete("worker");
  f.harness.sdk.stub("threads.events.list", async () => { throw new Error("offline"); });
  await assertNoQuestion("stopped");
});

test("owner merge waits wake once and suppress a quiet Question; delivery never merges the PR", async (t) => {
  const spec = workspaceIssues.data.issues.nodes.find((node) => node.identifier === "FIX-5")!;
  const ownerSpec = { ...spec, labels: { ...spec.labels, nodes: [...spec.labels.nodes, { id: "owner", name: "accept:owner", color: "#000000" }] } };
  const f = await fixture(t, {
    issues: () => Response.json({ data: { issues: { ...workspaceIssues.data.issues,
      nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-5" ? ownerSpec : node) } } }),
    laneSpec: () => Response.json({ data: { issue: { ...ownerSpec, children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
  });
  const lead = f.lead("one", "Lead");
  f.threads.set(lead.id, { ...lead, status: "idle", runtime: { displayStatus: "idle" } });
  f.events.set(lead.id, [{ id: "end", threadId: lead.id, seq: 4, createdAt: epoch - 600_000, scope: { kind: "thread" },
    type: "turn/completed", data: { status: "completed", providerThreadId: null } }]);
  let merged = false;
  f.harness.sdk.stub("plugins.callRpc", async ({ method }: { method: string }) => {
    assert.equal(method, "pullRequests", "observation grants no merge approval");
    return { "env-one": { outcome: "available", pullRequest: { number: 12, state: merged ? "merged" : "open",
      url: "https://github.example/fixture/pull/12", updatedAt: new Date(Date.now()).toISOString(), checks: { state: "passing" } } } };
  });
  await f.startWatcher();
  assert.equal((await f.board()).lanes[0].state, "merge-waits");
  assert.equal((await f.board()).lanes[0].needs, undefined);
  await f.advance(120_000);
  assert.equal(f.sends()[0]?.input[0].text,
    "Fixture | Merge waiting | FIX-5 | PR #12 passed its checks and waits for your merge. | https://github.example/fixture/pull/12");
  merged = true;
  await f.advance(30_000);
  assert.equal((await f.board()).lanes[0].state, "landed");
  assert.equal((await f.board()).lanes[0].needs, undefined);
  await f.advance(120_000);
  assert.equal(f.sends().length, 2);
  assert.equal(f.sends()[1].input[0].text, "Fixture | Landed | FIX-5 | The lane landed. | https://github.example/fixture/pull/12");
});

test("ticket moves, PR opening and readiness, and check activity never wake the Helper", async (t) => {
  let working = false;
  const f = await fixture(t, { issues: () => Response.json({ data: { issues: { ...workspaceIssues.data.issues,
    nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-6" && working
      ? { ...node, state: { id: "working", name: "In Progress", type: "started" } } : node) } } }) });
  f.lead("one", "Lead");
  let phase = "absent";
  f.harness.sdk.stub("plugins.callRpc", async () => ({ "env-one": phase === "absent" ? { outcome: "absent" } : { outcome: "available", pullRequest: {
    number: 12, state: phase === "draft" ? "draft" : "open", url: "https://github.example/fixture/pull/12", updatedAt: new Date(Date.now()).toISOString(),
    checks: { state: phase === "ready" ? "passing" : "pending" },
  } } }));
  await f.startWatcher();
  f.harness.behavior.runService("linear-reader"); await settle();
  for (const next of ["draft", "open", "checks", "ready"]) {
    phase = next; working = true;
    await f.advance(30_000); await f.advance(120_000);
    assert.equal(f.sends().length, 0, next);
  }
});

test("reload rechecks pending items before delivery so a question cleared while disabled isn't sent", async (t) => {
  const f = await fixture(t);
  const lead = f.lead("one");
  await f.startWatcher(); await f.advance(60_000);
  await f.reload();
  f.threads.set(lead.id, { ...lead, title: "Working" });
  // Startup discovery can be slower than an overdue batch timer.
  await f.advance(60_000);
  assert.equal(f.sends().length, 0, "delivery waits for this run's observation");
  await f.startWatcher(); await f.advance(30_000);
  assert.equal(f.sends().length, 0, "the now-cleared item is removed");
});


test("invalid saved notification data cannot break project observation", async (t) => {
  const f = await fixture(t, {}, { pending: null, reported: "invalid" });
  f.lead("one");
  await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 1);
  assert.equal(f.sends()[0].input[0].text, "Fixture | Question | FIX-5 | The Lead for FIX-5 is waiting on you. | @thread:lead-one");
});

test("landings already present at first observation establish a baseline without a wake", async (t) => {
  const f = await fixture(t);
  f.lead("one", "Lead");
  f.harness.sdk.stub("plugins.callRpc", async () => ({ "env-one": { outcome: "available", pullRequest: {
    number: 12, state: "merged", url: "https://github.example/fixture/pull/12", updatedAt: "2026-11-13T12:00:00Z", checks: { state: "passing" },
  } } }));
  await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 0);
  await f.reload(); await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 0);
});
