import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { helperFixture, settle } from "./fixtures/helper-plugin.js";
import { workspace, workspaceIssues } from "./fixtures/board-workspace.js";
import { STOP_MESSAGE } from "../lib/lane-contract.js";
import { end, openExternalBlocker } from "./fixtures/linear-mirror.js";
import { needsYou } from "../lib/board-model.js";

const epoch = Date.parse("2026-11-14T12:00:00Z");
async function secondHelper(f: Awaited<ReturnType<typeof fixture>>) {
  f.threads.set("helper-two", makeThreadResponse({ id: "helper-two", projectId: "two", status: "active" }));
  await f.harness.behavior.callRpc("helper.use", { projectId: "two", threadId: "helper-two" });
}
function fixture(t: TestContext, options: Parameters<typeof workspace>[0] = {}, storedNotifications?: unknown) {
  return helperFixture(t, epoch, options, storedNotifications);
}

test("unattended projects send questions only to their own Helper after two quiet minutes", async (t) => {
  const f = await fixture(t);
  await secondHelper(f);
  f.lead("one"); f.lead("two");
  await f.startWatcher();
  await f.advance(119_999);
  assert.equal(f.sends().length, 0);
  await f.advance(1);
  assert.deepEqual(f.sends(), [
    { threadId: "helper", mode: "queue-if-active", input: [{ type: "text", mentions: [], text:
      "Fixture | Question | FIX-5 | The Lead for FIX-5 is waiting on you. | @thread:lead-one" }] },
    { threadId: "helper-two", mode: "queue-if-active", input: [{ type: "text", mentions: [], text:
      "Second | Question | FIX-5 | The Lead for FIX-5 is waiting on you. | @thread:lead-two" }] },
  ]);
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

test("a stopped work item sends one Needs you line across repeated observations and reload", async (t) => {
  const f = await fixture(t, { issues: () => Response.json({ data: { issues: { ...workspaceIssues.data.issues,
    nodes: workspaceIssues.data.issues.nodes.filter((node) => node.identifier === "FIX-9"),
  } } }) });
  f.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) =>
    threadId === "lead-one" ? { role: "lead", specId: "fix-9", kind: "work-item" } : {});
  const lead = f.lead("one", "Work item FIX-9");
  f.threads.set(lead.id, { ...lead, status: "idle", runtime: { displayStatus: "idle" } });
  f.events.set(lead.id, [
    { id: "completed", threadId: lead.id, seq: 4, createdAt: epoch, scope: { kind: "thread" },
      type: "turn/completed", data: { status: "completed", providerThreadId: null } },
    { id: "stop", threadId: lead.id, seq: 3, createdAt: epoch - 1, scope: { kind: "thread" }, type: "client/turn/requested", data: {
      direction: "outbound", execution: { model: "fixture", permissionMode: "auto", reasoningLevel: "medium", serviceTier: "default", source: "client/turn/requested" },
      source: "tell", senderThreadId: null, initiator: "user", input: [{ type: "text", text: STOP_MESSAGE, mentions: [] }],
      request: { method: "turn/start", params: {} }, requestId: "stop", target: { kind: "auto", expectedTurnId: null } } },
  ]);
  await f.startWatcher();
  assert.deepEqual((await f.board()).lanes.map((lane) => [lane.specId, lane.kind, lane.state]), [["FIX-9", "work-item", "stopped"]]);
  await f.advance(120_000);
  assert.deepEqual(f.sends().map((send) => send.input[0].text), [
    "Fixture | Stopped | FIX-9 | The lane was stopped. Resume to continue. | @thread:lead-one",
  ]);
  await f.advance(120_000);
  assert.equal(f.sends().length, 1);
  await f.reload(); await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 0, "reload retains the existing notification receipt");
});


test("an idle Lead's latest plain-text owner question becomes Needs you and wakes its Helper", async (t) => {
  const f = await fixture(t);
  const lead = f.lead("one", "Lead");
  f.threads.set(lead.id, { ...lead, status: "idle", runtime: { displayStatus: "idle" }, updatedAt: epoch - 86_400_000 });
  f.events.set(lead.id, [{ id: "completed", threadId: lead.id, seq: 4, createdAt: epoch, scope: { kind: "thread" },
    type: "turn/completed", data: { status: "completed", providerThreadId: null } },
  { id: "message", threadId: lead.id, seq: 3, createdAt: epoch, scope: { kind: "thread" },
    type: "item/completed", data: { providerThreadId: "provider",
      item: { id: "answer", type: "agentMessage", text: "Can you choose which wording we should ship?" } } }]);
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

test("a bold mid-paragraph Needs you request appears on the board and wakes the Helper", async (t) => {
  const f = await fixture(t);
  const lead = f.lead("one", "Lead");
  f.threads.set(lead.id, { ...lead, status: "idle", runtime: { displayStatus: "idle" } });
  f.events.set(lead.id, [
    { id: "completed", threadId: lead.id, seq: 4, createdAt: epoch, scope: { kind: "thread" },
      type: "turn/completed", data: { status: "completed", providerThreadId: null } },
    { id: "message", threadId: lead.id, seq: 3, createdAt: epoch, scope: { kind: "thread" },
      type: "item/completed", data: { providerThreadId: "provider", item: { id: "answer", type: "agentMessage",
        text: "The branch and progress summary are saved. **Needs you:** a new go for focused repairs before another review." } } },
  ]);
  await f.startWatcher(); await f.advance(300_000);
  assert.deepEqual(needsYou(await f.board()).map(({ kind, text }) => ({ kind, text })), [
    { kind: "waiting", text: "The Lead is waiting on you" },
  ]);
  await f.advance(120_000);
  assert.equal(f.sends()[0]?.input[0].text, "Fixture | Question | FIX-5 | The Lead is waiting on you | @thread:lead-one");
});

test("idle status messages and unreadable question evidence never wake the Helper", async (t) => {
  const f = await fixture(t);
  const lead = f.lead("one", "Lead");
  f.threads.set(lead.id, { ...lead, status: "idle", runtime: { displayStatus: "idle" } });
  f.events.set(lead.id, [{ id: "completed", threadId: lead.id, seq: 4, createdAt: epoch, scope: { kind: "thread" },
    type: "turn/completed", data: { status: "completed", providerThreadId: null } },
  { id: "message", threadId: lead.id, seq: 3, createdAt: epoch, scope: { kind: "thread" },
    type: "item/completed", data: { providerThreadId: "provider",
      item: { id: "answer", type: "agentMessage", text: "FIX-6 still waits for the reader files." } } }]);
  await f.startWatcher(); await f.advance(480_000);
  assert.equal((await f.board()).lanes[0].needs, undefined);
  assert.equal(f.sends().length, 0);
});

test("quoted and inline-code Needs you markers stay quiet", async (t) => {
  const f = await fixture(t);
  const lead = f.lead("one", "Lead");
  f.threads.set(lead.id, { ...lead, status: "idle", runtime: { displayStatus: "idle" } });
  for (const text of [
    "> The old reply said **Needs you:** a new go.",
    "The marker is `**Needs you:** a new go` in this example.",
    "The marker is ``**Needs you:** a new go`` in this example.",
  ]) {
    f.events.set(lead.id, [
      { id: "end", threadId: lead.id, seq: 4, createdAt: epoch, scope: { kind: "thread" },
        type: "turn/completed", data: { status: "completed", providerThreadId: null } },
      { id: "message", threadId: lead.id, seq: 3, createdAt: epoch, scope: { kind: "thread" },
        type: "item/completed", data: { providerThreadId: "provider", item: { id: "reply", type: "agentMessage", text } } },
    ]);
    await f.startWatcher(); await f.advance(480_000);
    assert.deepEqual(needsYou(await f.board()), [], text);
    assert.equal(f.sends().length, 0, text);
  }
});

test("questions inside Markdown fences never become Needs you, including unfinished fences", async (t) => {
  const f = await fixture(t);
  const lead = f.lead("one", "Lead");
  f.threads.set(lead.id, { ...lead, status: "idle", runtime: { displayStatus: "idle" } });
  for (const text of [
    "Example only:\n~~~text\nCan you choose which wording we should ship?\n~~~",
    "Example only:\n```text\nCan you choose which wording we should ship?",
    "Example only:\n~~~~text\n~~~\nNeeds you: Choose the wording.\n~~~~",
    "Example only:\n    Can you choose which wording we should ship?",
  ]) {
    f.events.set(lead.id, [
      { id: "completed", threadId: lead.id, seq: 4, createdAt: epoch, scope: { kind: "thread" },
        type: "turn/completed", data: { status: "completed", providerThreadId: null } },
      { id: "message", threadId: lead.id, seq: 3, createdAt: epoch, scope: { kind: "thread" },
        type: "item/completed", data: { providerThreadId: "provider",
          item: { id: "answer", type: "agentMessage", text } } },
    ]);
    await f.startWatcher(); await f.advance(480_000);
    assert.deepEqual(needsYou(await f.board()), [], text);
    assert.equal(f.sends().length, 0, text);
  }
});

test("an idle lane blocked outside itself stays quiet, but an explicit owner question still wakes its Helper", async (t) => {
  const f = await fixture(t, { issues: () => Response.json({ data: { issues: { ...workspaceIssues.data.issues,
    nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-6" ? { ...node,
      inverseRelations: { nodes: [{ id: "wait", type: "blocks", issue: openExternalBlocker, relatedIssue: node }], pageInfo: end },
    } : node),
  } } }) });
  const lead = f.lead("one", "Lead");
  f.threads.set(lead.id, { ...lead, status: "idle", runtime: { displayStatus: "idle" } });
  const events = (text: string) => [
    { id: "completed", threadId: lead.id, seq: 4, createdAt: epoch, scope: { kind: "thread" as const },
      type: "turn/completed" as const, data: { status: "completed" as const, providerThreadId: null } },
    { id: "message", threadId: lead.id, seq: 3, createdAt: epoch, scope: { kind: "thread" as const },
      type: "item/completed" as const, data: { providerThreadId: "provider",
        item: { id: "answer", type: "agentMessage" as const, text } } },
  ];
  f.events.set(lead.id, events("FIX-6 still waits for OUT-10."));
  await f.startWatcher(); await f.advance(480_000);
  let board = await f.board();
  assert.deepEqual(board.lanes[0].waitingOn, ["OUT-10"]);
  assert.deepEqual(needsYou(board), []);
  assert.equal(f.sends().length, 0);
  for (const text of [
    "FIX-6 waits on OUT-10. Nothing needs you: it starts when OUT-10 lands.",
    "FIX-6 waits on OUT-10. **Needs you:**",
    "FIX-6 waits on OUT-10. Needs you: none",
    "FIX-6 waits on OUT-10. Needs you: 0",
  ]) {
    f.events.set(lead.id, events(text));
    await f.advance(30_000); await f.advance(120_000);
    board = await f.board();
    assert.deepEqual(board.lanes[0].waitingOn, ["OUT-10"]);
    assert.deepEqual(needsYou(board), [], text);
    assert.equal(f.sends().length, 0, text);
  }
  f.events.set(lead.id, events("Can you choose the wording while OUT-10 finishes?"));
  await f.advance(30_000); await f.advance(120_000);
  board = await f.board();
  assert.deepEqual(needsYou(board).map(({ kind }) => kind), ["waiting"]);
  assert.equal(f.sends().length, 1);
});

test("a fresh PR landing and another project question reach only their Helpers and never replay", async (t) => {
  const f = await fixture(t);
  await secondHelper(f);
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
  assert.equal(f.sends().length, 2);
  assert.equal(f.sends()[0].input[0].text,
    "Fixture | Landed | FIX-5 | The lane landed. | https://github.example/fixture/pull/12");
  assert.equal(f.sends()[0].threadId, "helper");
  assert.equal(f.sends()[1].threadId, "helper-two");
  assert.equal(f.sends()[1].input[0].text, "Second | Question | FIX-5 | The Lead for FIX-5 is waiting on you. | @thread:lead-two");
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
  await f.advance(299_999);
  assert.equal(f.sends().length, 0, "an unattended project waits for its five-minute read");
  await f.advance(1); await f.advance(120_000);
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
    const lead = f.lead("one");
    f.threads.set(id, { ...lead, id, parentThreadId: lead.id, environmentId: `env-${id}` });
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
  await secondHelper(f);
  f.lead("two");
  const original = f.threads;
  f.harness.sdk.stub("threads.list", async (args: { projectId?: string; parentThreadId?: string }) => {
    if (args.projectId === "one") throw new Error("private host diagnostics");
    return [...original.values()].filter((thread) => thread.projectId === args.projectId && (!args.parentThreadId || thread.parentThreadId === args.parentThreadId))
      .map((thread) => ({ ...thread, hasPendingInteraction: thread.title === "Question", environmentBranchName: "spec/fix-5" }));
  });
  await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends()[0]?.input[0].text,
    "Fixture | Setup | Project | Couldn't read this project. Make sure its machine is online. | /plugins/squadron/board");
  assert.equal(f.sends().length, 2);
  assert.equal(f.sends()[0].threadId, "helper");
  assert.equal(f.sends()[1].threadId, "helper-two");
  assert.equal(f.sends()[1].input[0].text, "Second | Question | FIX-5 | The Lead for FIX-5 is waiting on you. | @thread:lead-two");
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
  // A history that can't be read isn't a Stop (SQD-275): the lane stays Flying, says it couldn't read, and never asks a quiet Question.
  f.harness.sdk.stub("threads.events.list", async () => { throw new Error("offline"); });
  await assertNoQuestion("flying");
  assert.deepEqual((await f.board()).lanes[0].needs?.map((need) => need.text), ["Squadron couldn't read the Lead for FIX-5 (offline). Open it to check."]);
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

test("the two-stop brake sends the Helper one Autopilot pause with its reason and keeps Resume an owner action", async (t) => {
  const f = await fixture(t);
  const first = f.lead("one", "Lead");
  f.threads.set(first.id, { ...first, status: "error" });
  f.threads.set("lead-second", makeThreadResponse({ id: "lead-second", projectId: "one", title: "Lead FIX-1",
    environmentId: "env-second", status: "error", createdAt: epoch + 1 }));
  f.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) =>
    threadId.startsWith("lead-") ? { role: "lead", specId: threadId === "lead-second" ? "fix-1" : "fix-5" } : {});
  await f.harness.behavior.callRpc("autopilot.set", { projectId: "one", status: "on" });
  await f.startWatcher();
  assert.equal((await f.board()).autopilot?.status, "paused");
  await f.advance(119_999);
  assert.equal(f.sends().length, 0);
  await f.advance(1);
  assert.equal(f.sends().length, 1);
  const pauseLine = "Fixture | Autopilot paused | Project | Two lanes in a row stopped | /plugins/squadron/board";
  assert.ok(f.sends()[0].input[0].text.split("\n").includes(pauseLine));
  assert.equal(f.sends()[0].threadId, "helper");
  assert.equal(f.sends()[0].mode, "queue-if-active");
  assert.equal(f.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  await f.advance(120_000);
  assert.equal(f.sends().length, 1, "an already reported pause doesn't wake again");
  await assert.rejects(f.harness.behavior.callRpc("autopilot.resume", { projectId: "one" },
    { experimental_caller: { kind: "plugin", pluginId: "other" } }), /Resume Autopilot from the Squadron board/);
  assert.equal((await f.board()).autopilot?.status, "paused", "notification grants no permission to resume");
});

test("a failed merged-main check reaches the Helper once with its reason, log on the board, and owner-only Resume", async (t) => {
  const f = await fixture(t);
  f.lead("one", "Lead");
  let merged = false;
  f.harness.sdk.stub("plugins.callRpc", async () => ({ "env-one": { outcome: "available", pullRequest: {
    number: 12, state: merged ? "merged" : "open", url: "https://github.example/fixture/pull/12",
    updatedAt: new Date(epoch).toISOString(), checks: { state: "passing" },
  } } }));
  f.setMainCheck(async () => ({ passed: false, logPath: "/scratch/main-failure.log",
    mergedCommit: "a".repeat(40), baseCommit: "b".repeat(40) }));
  await f.harness.behavior.callRpc("autopilot.set", { projectId: "one", status: "on" });
  await f.startWatcher();
  merged = true;
  await f.advance(30_000);
  const board = await f.board();
  assert.equal(board.autopilot?.status, "paused");
  assert.equal(board.autopilot?.pauseReason, "Main fails its quick check");
  assert.deepEqual(board.autopilot?.pauseLog, { hostId: "host", path: "/scratch/main-failure.log" });
  await f.advance(120_000);
  assert.equal(f.sends().length, 1);
  assert.equal(f.sends()[0].input[0].text,
    "Fixture | Autopilot paused | Project | Main fails its quick check | /plugins/squadron/board\nFixture | Landed | FIX-5 | The lane landed. | https://github.example/fixture/pull/12");
  assert.equal(f.sends()[0].mode, "queue-if-active");
  assert.equal(f.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  await assert.rejects(f.harness.behavior.callRpc("autopilot.resume", { projectId: "one" },
    { experimental_caller: { kind: "plugin", pluginId: "other" } }), /Resume Autopilot from the Squadron board/);
  await f.reload(); await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 0, "reload doesn't repeat the pause or landing");
  assert.equal((await f.board()).autopilot?.status, "paused");
  const resumed = await f.harness.behavior.callRpc("autopilot.resume", { projectId: "one" });
  assert.deepEqual(resumed, { status: "on", laneLimit: 3, consecutiveStops: 0, pauseReason: null });
});

test("another project's new arrival cannot extend the first project's deadline, including after reload", async (t) => {
  const f = await fixture(t);
  await secondHelper(f);
  f.lead("one");
  await f.startWatcher();
  await f.advance(60_000);
  f.lead("two");
  await f.advance(30_000);
  await f.reload(); await f.startWatcher();
  await f.advance(29_999);
  assert.equal(f.sends().length, 0);
  await f.advance(1);
  assert.deepEqual(f.sends().map((send) => send.threadId), ["helper"]);
  await f.advance(89_999);
  assert.equal(f.sends().length, 1);
  await f.advance(1);
  assert.deepEqual(f.sends().map((send) => send.threadId), ["helper", "helper-two"]);
});

test("a project without a Helper stays silent while another project's Helper receives only its own question", async (t) => {
  const f = await fixture(t);
  f.lead("one"); f.lead("two");
  await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 1);
  assert.deepEqual((await f.board("two")).lanes[0].needs, [{ threadId: "lead-two", kind: "waiting", text: "The Lead for FIX-5 is waiting on you." }]);
  assert.equal(f.sends()[0].threadId, "helper");
  assert.equal(f.sends()[0].input[0].text, "Fixture | Question | FIX-5 | The Lead for FIX-5 is waiting on you. | @thread:lead-one");
  await f.reload(); await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 0);
  await secondHelper(f); await f.advance(30_000);
  assert.equal(f.sends().length, 1);
  assert.equal(f.sends()[0].threadId, "helper-two");
  assert.equal(f.sends()[0].input[0].text, "Second | Question | FIX-5 | The Lead for FIX-5 is waiting on you. | @thread:lead-two");
});

test("a failed project delivery retries without blocking another Helper or replaying its reported question", async (t) => {
  const f = await fixture(t);
  await secondHelper(f);
  const first = f.lead("one"); f.lead("two");
  let failing = true;
  f.harness.sdk.stub("threads.send", async ({ threadId }: { threadId: string }) => {
    if (threadId === "helper" && failing) throw new Error("delivery failed");
    return { ok: true, delivery: "queued" };
  });
  await f.startWatcher(); await f.advance(120_000);
  assert.deepEqual(f.sends().map((send) => send.threadId), ["helper", "helper-two"]);
  failing = false;
  await f.advance(30_000);
  assert.deepEqual(f.sends().map((send) => send.threadId), ["helper", "helper-two", "helper"]);
  await f.reload(); await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 0);
  f.threads.set(first.id, { ...first, title: "Working" });
  await f.advance(30_000);
  f.threads.set(first.id, first);
  await f.advance(30_000); await f.advance(120_000);
  assert.deepEqual(f.sends().map((send) => send.threadId), ["helper"], "clearing A never clears B's reported question");
});

test("upgrading a pending shared batch retains its deadline and routes its lines by project", async (t) => {
  const pending = {
    '["one","waiting:lead-one"]': { projectId: "one", key: "waiting:lead-one", line: "old first line" },
    '["two","waiting:lead-two"]': { projectId: "two", key: "waiting:lead-two", line: "old second line" },
  };
  const f = await fixture(t, {}, { lanes: {}, reported: {}, pending, firstAt: epoch - 60_000, lastAt: epoch - 60_000 });
  await secondHelper(f);
  f.lead("one"); f.lead("two");
  await f.startWatcher(); await f.advance(59_999);
  assert.equal(f.sends().length, 0);
  await f.advance(1);
  assert.deepEqual(f.sends().map((send) => [send.threadId, send.input[0].text]), [
    ["helper", "Fixture | Question | FIX-5 | The Lead for FIX-5 is waiting on you. | @thread:lead-one"],
    ["helper-two", "Second | Question | FIX-5 | The Lead for FIX-5 is waiting on you. | @thread:lead-two"],
  ]);
  await f.reload(); await f.startWatcher(); await f.advance(120_000);
  assert.equal(f.sends().length, 0);
});
