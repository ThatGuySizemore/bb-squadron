import { test } from "node:test";
import assert from "node:assert/strict";
import { helperCore } from "../lib/helper-core.js";
import { input, snapshot, issue, blocks } from "./fixtures/board-snapshots.js";
import type { ReviewRun } from "../lib/worker-contract.js";
import type { LaneRun } from "../lib/lane-contract.js";

const route = { family: "gpt" as const, model: "gpt-6.1-sol", effort: "high" as const };
const lane: LaneRun = { id: "lane", bbProjectId: "proj-one", workspaceId: "workspace", specId: "FIX-1", specIssueId: "fix-1",
  title: "A spec", route, state: "flying", startedAt: 0, leadThreadId: "lead", environmentId: "env", branch: "spec/fix-1", acceptOwner: false };

test("Lead can dispatch a frontier worker; board reads alone never dispatch", () => {
  const value = { ...input(snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1", labels: ["ui"] })])), lanes: [lane] };
  assert.deepEqual(helperCore(value).commands, []);
  const result = helperCore({ ...value, action: { type: "spawn-worker", laneId: "lane", ticketId: "FIX-2" } });
  assert.deepEqual(result.worker, { allowed: true });
  assert.deepEqual(result.commands, [{ type: "spawn-worker", laneId: "lane", ticketIssueId: "fix-2", ticketId: "FIX-2",
    route: { family: "claude", model: "claude-opus-5-5", effort: "high" } }]);
});

test("verified integration unblocks only successors in the same lane while Linear stays open", () => {
  const work = { id: "worker", ticketIssueId: "fix-2", ticketId: "FIX-2", route, startedAt: 0,
    threadId: "worker-thread", environmentId: "env-worker", branch: "bb/worker", commit: "a".repeat(40) };
  const snap = snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" }),
    issue("FIX-3", { parent: "FIX-1" }), issue("FIX-10", { labels: ["ready-for-agent"] }), issue("FIX-11", { parent: "FIX-10" })],
    [blocks("FIX-2", "FIX-3"), blocks("FIX-2", "FIX-11")]);
  const other = { ...lane, id: "other", specId: "FIX-10", specIssueId: "fix-10" };
  const run = { ...lane, workers: [{ ...work, state: "reported" as const }] };
  const dispatch = (lanes: LaneRun[], laneId = "lane", ticketId = "FIX-3") => helperCore({ ...input(snap), lanes,
    action: { type: "spawn-worker", laneId, ticketId } });
  assert.deepEqual(dispatch([run, other]).worker, { allowed: false, reason: "Waits on FIX-2" });
  const review: ReviewRun = { id: "review", route: { family: "claude", model: "claude-opus-5-5", effort: "high" }, threadId: "reviewer-thread", environmentId: "review-env",
    commit: "a".repeat(40), originalCommit: "a".repeat(40), state: "approved", round: 0,
    verdict: { commit: "a".repeat(40), outcome: "approve", findings: [], resolvedFindingIds: [], at: 1 } };
  const integrated: LaneRun = { ...run, workers: [{ ...work, state: "integrated", review, integration: { commit: "a".repeat(40), head: "b".repeat(40), verifiedAt: 1 } }] };
  assert.deepEqual(dispatch([integrated, other]).worker, { allowed: true });
  assert.equal(dispatch([integrated, other]).board.lanes[0].tickets.find((ticket) => ticket.id === "FIX-2")?.state, "branch");
  assert.deepEqual(dispatch([integrated, other], "other", "FIX-11").worker, { allowed: false, reason: "Waits on FIX-2" });
  snap.issues.find((issue) => issue.id === "fix-2")!.state = { id: "done", name: "Done", type: "completed" };
  assert.deepEqual(dispatch([integrated, other], "other", "FIX-11").worker, { allowed: true });
});

test("worker cap and duplicate guards apply before a spawn command, including reserved starts", () => {
  const workers = [2, 3, 4].map((i) => ({ id: `worker-${i}`, ticketIssueId: `fix-${i}`, ticketId: `FIX-${i}`, route,
    state: "spawning" as const, startedAt: 0, threadId: null, environmentId: null, branch: null }));
  const run = { ...lane, workers };
  const snap = snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }), ...[2, 3, 4, 5].map((i) => issue(`FIX-${i}`, { parent: "FIX-1" }))]);
  const dispatch = (ticketId: string) => helperCore({ ...input(snap), lanes: [run], action: { type: "spawn-worker", laneId: "lane", ticketId } });
  assert.deepEqual(dispatch("FIX-5").worker, { allowed: false, reason: "All worker slots are full." });
  assert.deepEqual(dispatch("FIX-2").worker, { allowed: false, reason: "Work has already started on this ticket." });
  assert.deepEqual(dispatch("FIX-5").commands, []);
});

test("ancestry alone and approval for a stale commit never release a successor", () => {
  const work = { id: "worker", ticketIssueId: "fix-2", ticketId: "FIX-2", route, startedAt: 0,
    threadId: "worker-thread", environmentId: "env-worker", branch: "bb/worker", commit: "a".repeat(40),
    state: "integrated" as const, integration: { commit: "a".repeat(40), head: "b".repeat(40), verifiedAt: 1 } };
  const snap = snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" }),
    issue("FIX-3", { parent: "FIX-1" })], [blocks("FIX-2", "FIX-3")]);
  const result = helperCore({ ...input(snap), lanes: [{ ...lane, workers: [work] }],
    action: { type: "spawn-worker", laneId: "lane", ticketId: "FIX-3" } });
  assert.deepEqual(result.worker, { allowed: false, reason: "Waits on FIX-2" });
  assert.equal(result.board.lanes[0].tickets[0].state, "review");
  const stale: ReviewRun = { id: "review", route: { family: "claude", model: "claude-opus-5-5", effort: "high" }, threadId: "reviewer-thread", environmentId: "review-env",
    commit: "c".repeat(40), originalCommit: "c".repeat(40), state: "approved", round: 0,
    verdict: { commit: "c".repeat(40), outcome: "approve", findings: [], resolvedFindingIds: [], at: 1 } };
  const dispatch = (review: ReviewRun) => helperCore({ ...input(snap), lanes: [{ ...lane, workers: [{ ...work, review }] }],
    action: { type: "spawn-worker", laneId: "lane", ticketId: "FIX-3" } });
  assert.deepEqual(dispatch(stale).worker, { allowed: false, reason: "Waits on FIX-2" });
  assert.deepEqual(dispatch({ ...stale, route, commit: work.commit, verdict: { ...stale.verdict!, commit: work.commit } }).worker,
    { allowed: false, reason: "Waits on FIX-2" });
});

test("SIZE-932: Ready separates internal ordering from external blockers with a partly available frontier", () => {
  const snap = snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }),
    issue("FIX-2", { parent: "FIX-1" }), issue("FIX-3", { parent: "FIX-1" }), issue("FIX-4", { parent: "FIX-1" }), issue("OUT-9", { outside: true })],
    [blocks("FIX-2", "FIX-3"), blocks("OUT-9", "FIX-4")]);
  const ready = helperCore(input(snap)).board.ready[0];
  assert.equal(ready.startReason, null);
  assert.deepEqual(ready.blockedBy, ["OUT-9"]);
  const dispatch = (ticketId: string) => helperCore({ ...input(snap), lanes: [lane], action: { type: "spawn-worker", laneId: "lane", ticketId } });
  assert.deepEqual(dispatch("FIX-2").worker, { allowed: true });
  assert.deepEqual(dispatch("FIX-3").worker, { allowed: false, reason: "Waits on FIX-2" });
  assert.deepEqual(dispatch("FIX-4").worker, { allowed: false, reason: "Waits on OUT-9" });
  assert.deepEqual(dispatch("FIX-2").board.lanes[0].tickets.map((ticket) => [ticket.id, ticket.state, ticket.blockedBy]), [
    ["FIX-2", "ready", []], ["FIX-3", "blocked", ["FIX-2"]], ["FIX-4", "blocked", ["OUT-9"]],
  ]);
});

test("a spec blocker added to a flying lane still needs Linear Done before another worker starts", () => {
  const snap = snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" }), issue("FIX-10", { labels: ["ready-for-agent"] })],
    [blocks("FIX-10", "FIX-1")]);
  const dispatch = () => helperCore({ ...input(snap), lanes: [lane], action: { type: "spawn-worker", laneId: "lane", ticketId: "FIX-2" } });
  assert.deepEqual(dispatch().worker, { allowed: false, reason: "Waits on FIX-10" });
  snap.issues.find((issue) => issue.id === "fix-10")!.state = { id: "done", name: "Done", type: "completed" };
  assert.deepEqual(dispatch().worker, { allowed: true });
});

test("cancelled blockers resolve consistently for Ready, dispatch and lane cards", () => {
  const cancelled = issue("OUT-9", { outside: true });
  cancelled.state = { id: "cancelled", name: "Canceled", type: "canceled" };
  const snap = snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" }), cancelled], [blocks("OUT-9", "FIX-2")]);
  const ready = helperCore({ ...input(snap), action: { type: "start", specId: "FIX-1" } });
  assert.deepEqual(ready.start, { allowed: true });
  assert.deepEqual(ready.board.ready[0].blockedBy, []);
  const result = helperCore({ ...input(snap), lanes: [lane], action: { type: "spawn-worker", laneId: "lane", ticketId: "FIX-2" } });
  assert.deepEqual(result.worker, { allowed: true });
  assert.deepEqual(result.board.lanes[0].tickets.map((ticket) => [ticket.id, ticket.state, ticket.blockedBy]), [["FIX-2", "ready", []]]);
});

test("unknown blockers fail closed in Ready, dispatch and cards without exposing the relation UUID", () => {
  const unknownId = "11111111-2222-4333-8444-555555555555";
  const snap = snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" })], [blocks(unknownId, "FIX-2")]);
  const ready = helperCore({ ...input(snap), action: { type: "start", specId: "FIX-1" } });
  assert.deepEqual(ready.start, { allowed: false, reason: "Every ticket waits on a blocker: Unknown blocker" });
  assert.deepEqual(ready.board.ready[0].blockedBy, ["Unknown blocker"]);
  const result = helperCore({ ...input(snap), lanes: [lane], action: { type: "spawn-worker", laneId: "lane", ticketId: "FIX-2" } });
  assert.deepEqual(result.worker, { allowed: false, reason: "Waits on Unknown blocker" });
  assert.deepEqual(result.board.lanes[0].tickets.map((ticket) => [ticket.id, ticket.state, ticket.blockedBy]), [["FIX-2", "blocked", ["Unknown blocker"]]]);
  assert.ok(!JSON.stringify([ready, result]).includes(unknownId));
  // An independent ticket still supplies a frontier; it does not resolve the
  // unknown blocker on its sibling or turn internal ordering into a spec hold.
  snap.issues.push(issue("FIX-3", { parent: "FIX-1" }));
  const partial = helperCore({ ...input(snap), action: { type: "start", specId: "FIX-1" } });
  assert.deepEqual(partial.start, { allowed: true });
  const available = helperCore({ ...input(snap), lanes: [lane], action: { type: "spawn-worker", laneId: "lane", ticketId: "FIX-3" } });
  assert.deepEqual(available.worker, { allowed: true });
  assert.deepEqual(available.board.lanes[0].tickets.map((ticket) => [ticket.id, ticket.state, ticket.blockedBy]), [
    ["FIX-2", "blocked", ["Unknown blocker"]], ["FIX-3", "ready", []],
  ]);
});

test("spec-level unknown and cancelled blockers use the same rule on Ready, dispatch and all cards", () => {
  const snap = snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" })], [blocks("missing-endpoint", "FIX-1")]);
  const ready = () => helperCore({ ...input(snap), action: { type: "start", specId: "FIX-1" } });
  const dispatch = () => helperCore({ ...input(snap), lanes: [lane], action: { type: "spawn-worker", laneId: "lane", ticketId: "FIX-2" } });
  assert.deepEqual(ready().start, { allowed: false, reason: "Waits on Unknown blocker" });
  assert.deepEqual(dispatch().worker, { allowed: false, reason: "Waits on Unknown blocker" });
  assert.deepEqual(dispatch().board.lanes[0].tickets.map((ticket) => [ticket.state, ticket.blockedBy]), [["blocked", ["Unknown blocker"]]]);
  const cancelled = { ...issue("OUT-9", { outside: true }), id: "missing-endpoint", state: { id: "cancelled", name: "Canceled", type: "canceled" } };
  snap.issues.push(cancelled);
  assert.deepEqual(ready().start, { allowed: true });
  assert.deepEqual(dispatch().worker, { allowed: true });
  assert.deepEqual(dispatch().board.lanes[0].tickets.map((ticket) => [ticket.state, ticket.blockedBy]), [["ready", []]]);
});

test("fix-round resume rechecks the worker cap and reserves only the original worker", () => {
  const review: ReviewRun = { id: "review", route: { family: "claude", model: "claude-opus-5-5", effort: "high" }, threadId: "reviewer", environmentId: "env",
    originalCommit: "a".repeat(40), commit: "a".repeat(40), state: "changes", round: 0,
    firstFindings: [{ id: "S1", kind: "in-spec", text: "Fix required behavior." }],
    verdict: { commit: "a".repeat(40), outcome: "changes", findings: [{ id: "S1", kind: "in-spec", text: "Fix required behavior." }], resolvedFindingIds: [], at: 0 } };
  const work = { id: "worker", ticketIssueId: "fix-2", ticketId: "FIX-2", route, startedAt: 0,
    threadId: "worker-thread", environmentId: "env-worker", branch: "bb/worker", commit: "a".repeat(40), state: "reported" as const, review };
  const other = [3, 4, 5].map((i) => ({ ...work, id: `worker-${i}`, ticketIssueId: `fix-${i}`, ticketId: `FIX-${i}`, state: "working" as const, review: undefined }));
  const snap = snapshot([issue("FIX-1", { labels: ["ready-for-agent"] }), ...[2, 3, 4, 5].map((i) => issue(`FIX-${i}`, { parent: "FIX-1" }))]);
  const resume = (workers: LaneRun["workers"]) => helperCore({ ...input(snap), lanes: [{ ...lane, workers }],
    action: { type: "resume-worker", laneId: "lane", ticketId: "FIX-2" } });
  assert.deepEqual(resume([work, ...other]).worker, { allowed: false, reason: "All worker slots are full." });
  const allowed = resume([work, ...other.slice(0, 1)]);
  assert.deepEqual(allowed.worker, { allowed: true });
  assert.deepEqual(allowed.commands, [{ type: "resume-worker", laneId: "lane", workerId: "worker" }]);
  assert.equal(resume([{ ...work, review: { ...review, round: 1 } }]).worker?.allowed, false);
});
