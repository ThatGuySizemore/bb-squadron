import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRunReport, formatRunReport, type ReportInput } from "../lib/run-report.js";
import type { LaunchAttempt, LaunchRecord, LaunchRecords } from "../lib/launch-record.js";
import { createTicketHistoryReader, type HistoryRead, type TicketHistory } from "../lib/ticket-history.js";
import type { TrackerSnapshot } from "../lib/tracker-contract.js";
import { latestResult } from "../lib/ticket-result.js";
import type { ThreadUsage } from "../lib/thread-usage.js";

// SQD-260: one row per ticket from launch records, usage and ticket evidence. Unknown stays unknown.
const sonnet = { providerId: "claude-code", model: "claude-sonnet-5-5", effort: "medium", serviceTier: "default" };
const opus = { providerId: "claude-code", model: "claude-opus-5-5", effort: "high", serviceTier: "default" };
let clock = 0;
function attempt(threadId: string, record: Partial<LaunchRecord> & { tickets: LaunchRecord["tickets"] }, options: { verified?: boolean; archived?: boolean; status?: string } = {}): LaunchAttempt {
  const at = ++clock * 1000;
  const requested = record.requested ?? sonnet;
  return { threadId, parentThreadId: "lead", title: threadId, createdAt: at, archivedAt: options.archived ? at + 1 : null, deletedAt: null,
    status: options.status ?? "idle",
    record: { version: 1, role: "Worker", category: null, policyResolved: true, overrideNote: null, specId: "spec-1", leadThreadId: "lead",
      launchedBy: "lead", launchedAt: at, requested, replacesThreadId: null, escalation: null, ...record },
    reported: options.verified === false ? null : { ...requested, effort: requested.effort },
    mismatch: [], verification: options.verified === false ? "unknown" : "verified" };
}
const ticket = (id: string) => ({ id, identifier: id.toUpperCase() });
function records(attempts: LaunchAttempt[]): LaunchRecords {
  const sorted = [...attempts].sort((a, b) => a.createdAt - b.createdAt);
  return { attempts: sorted, unrecorded: [],
    firstVerifiedPolicyWorker: sorted.find((item) => item.record.policyResolved && item.record.role === "Worker" && item.verification === "verified") ?? null };
}
function done(id: string, completedAt: string | null, body?: string): TicketHistory {
  return { id, identifier: id.toUpperCase(), title: `Ticket ${id}`, url: null, outcome: "completed", completedAt,
    result: body === undefined ? null : latestResult([{ commentId: `c-${id}`, createdAt: completedAt ?? "2026-11-15T09:00:00Z", body }]) };
}
const history = (...tickets: TicketHistory[]): HistoryRead => ({ source: "linear", tickets: new Map(tickets.map((item) => [item.id, item])) });
const block = (value: object) => `Done. Merged into the integration branch.\n\n\`\`\`squadron-result\n${JSON.stringify({ version: 1, ...value })}\n\`\`\`\n`;
const used = (total: number, providerThreadId = "p", earlierSessionSeen = false): ThreadUsage => ({ state: "reported", providerThreadId, seq: 7, at: 1,
  coverage: "latest provider session", earlierSessionSeen,
  total: { inputTokens: total - 100, cachedInputTokens: 10, outputTokens: 100, reasoningOutputTokens: 5, totalTokens: total } });
function input(launches: LaunchRecords, read: HistoryRead | null, usage: Record<string, ThreadUsage> = {}, extra: Partial<ReportInput> = {}): ReportInput {
  return { projectId: "p1", projectName: "Fixture", readAt: Date.parse("2026-11-15T12:00:00Z"), since: null, checkpoint: 3,
    records: launches, history: read, usage: new Map(Object.entries(usage)), ...extra };
}

test("a clean first pass reports its route, checks, review and usage from the ticket's result block", () => {
  const worker = attempt("w1", { tickets: [ticket("a")] });
  const report = deriveRunReport(input(records([worker]), history(done("a", "2026-11-15T10:00:00Z", block({
    checks: [{ command: "npm run check", result: "passed" }, { command: "npm test", result: "passed" }],
    firstPass: true, reviewDefects: 0, repairRounds: 0, strikes: [], ownerInterventions: 0 }))), { w1: used(1200) }));
  const [row] = report.tickets;
  assert.equal(row.identifier, "A");
  assert.equal(row.category, "routine");
  assert.equal(row.countsTowardCheckpoint, true);
  assert.deepEqual(row.attempts.map((item) => [item.role, item.requested.model, item.requested.effort, item.verification]),
    [["Worker", "claude-sonnet-5-5", "medium", "verified"]]);
  assert.deepEqual(row.checks, { state: "known", value: [{ command: "npm run check", result: "passed" }, { command: "npm test", result: "passed" }] });
  assert.deepEqual([row.firstPass, row.reviewDefects, row.repairRounds, row.strikes, row.ownerInterventions].map((item) => item.state === "known" && item.value),
    [true, 0, 0, [], 0]);
  assert.deepEqual(row.attempts[0].usage, used(1200));
  assert.equal(row.evidence?.commentId, "c-a");
  const text = formatRunReport(report);
  assert.match(text, /A Ticket a \| completed 2026-11-15T10:00:00Z \| routine \| counts toward the checkpoint/);
  assert.match(text, /Checks: npm run check passed; npm test passed/);
  assert.match(text, /First pass: yes \| Review defects: 0 \| Repair rounds: 0 \| Strikes: 0 \| Owner interventions: 0/);
  assert.match(text, /1,200 tokens in its latest provider session \(/);
  assert.doesNotMatch(text, /\$|price|cost|saving|%/i);
});

test("a strike and escalation keep every attempt, its usage and the reason, and the ticket stays routine", () => {
  const first = attempt("w1", { tickets: [ticket("b")] }, { archived: true });
  const raised = attempt("w2", { tickets: [ticket("b")], requested: { ...sonnet, effort: "high" }, replacesThreadId: "w1",
    escalation: { kind: "effort", reason: "Checks were too thin." } }, { archived: true });
  const hard = attempt("w3", { tickets: [ticket("b")], role: "Worker (hard)", requested: opus, replacesThreadId: "w2",
    escalation: { kind: "model", reason: "Investigation lacked the insight." } });
  const report = deriveRunReport(input(records([first, raised, hard]), history(done("b", "2026-11-15T11:00:00Z", block({
    checks: [{ command: "npm run check", result: "passed" }], firstPass: false, reviewDefects: 2, repairRounds: 2,
    strikes: [{ reason: "Quick check failed after done." }], ownerInterventions: 1 }))),
  { w1: used(500), w2: used(700, "p2", true), w3: { state: "unknown", reason: "BB has no token usage for this thread." } }));
  const [row] = report.tickets;
  // Regression: a routine ticket finished by a raised effort or Worker (hard) replacement still counts once as routine.
  assert.equal(row.category, "routine");
  assert.equal(row.countsTowardCheckpoint, true);
  assert.equal(report.checkpoint.counted, 1);
  assert.deepEqual(row.attempts.map((item) => [item.threadId, item.role, item.requested.effort, item.archived, item.replacesThreadId]),
    [["w1", "Worker", "medium", true, null], ["w2", "Worker", "high", true, "w1"], ["w3", "Worker (hard)", "high", false, "w2"]]);
  assert.deepEqual(row.escalations, [{ threadId: "w2", kind: "effort", reason: "Checks were too thin." },
    { threadId: "w3", kind: "model", reason: "Investigation lacked the insight." }]);
  assert.deepEqual(row.strikes, { state: "known", value: [{ reason: "Quick check failed after done." }] });
  assert.deepEqual(row.attempts.map((item) => item.usage.state), ["reported", "reported", "unknown"]);
  const text = formatRunReport(report);
  assert.match(text, /Strikes: 1 \(Quick check failed after done\.\)/);
  assert.match(text, /effort escalation: Checks were too thin\./);
  // Usage is never claimed for a whole thread: the latest session only, and a different earlier session is named.
  assert.match(text, /700 tokens in its latest provider session \([^)]*\); an earlier session's usage isn't included/);
  assert.match(text, /usage unknown \(BB has no token usage for this thread\.\)/);
});

test("missing or malformed result evidence leaves checks and outcomes unknown, never passed or zero", () => {
  const launches = records([attempt("w1", { tickets: [ticket("c")] }), attempt("w2", { tickets: [ticket("d")] }), attempt("w3", { tickets: [ticket("e")] })]);
  const report = deriveRunReport(input(launches, history(
    done("c", "2026-11-15T10:00:00Z"),
    done("d", "2026-11-15T10:05:00Z", "Done.\n```squadron-result\n{ not json\n```"),
    done("e", "2026-11-15T10:10:00Z", block({ firstPass: true })))));
  const [c, d, e] = report.tickets;
  assert.deepEqual(c.checks, { state: "unknown", reason: "The ticket has no result block in its comments." });
  assert.deepEqual(d.checks, { state: "unknown", reason: "The result block isn't valid JSON." });
  assert.deepEqual(e.checks, { state: "unknown", reason: "The result block leaves this out." });
  assert.deepEqual(e.firstPass, { state: "known", value: true });
  assert.equal(e.reviewDefects.state, "unknown");
  assert.deepEqual(c.attempts[0].usage, { state: "unknown", reason: "Usage wasn't read." });
  assert.match(formatRunReport(report), /Checks: unknown\n {2}First pass: unknown \| Review defects: unknown/);
  // An unread tracker proves no completion at all.
  const unread = deriveRunReport(input(launches, null));
  assert.deepEqual(unread.tickets.map((row) => row.outcome), ["unknown", "unknown", "unknown"]);
  assert.equal(unread.checkpoint.counted, 0);
  assert.equal(unread.coverage.tracker, "unread");
});

test("only routine tickets first launched from the first verified policy Worker count; hard, label and abandoned tickets show but don't", () => {
  const legacy = attempt("old", { tickets: [ticket("f")], policyResolved: false });
  const unverified = attempt("unv", { tickets: [ticket("g")] }, { verified: false });
  const start = attempt("w1", { tickets: [ticket("h")] });
  const hard = attempt("w2", { tickets: [ticket("i")], role: "Worker (hard)", requested: opus });
  const label = attempt("w3", { tickets: [ticket("j")], category: "ui", requested: opus });
  const abandoned = attempt("w4", { tickets: [ticket("k")] }, { archived: true, status: "idle" });
  const routine = attempt("w5", { tickets: [ticket("l")] });
  const lead = attempt("lead", { tickets: [], role: "Lead", requested: { ...sonnet, effort: "high" }, leadThreadId: null, launchedBy: "owner" });
  const pair = attempt("w6", { tickets: [ticket("m"), ticket("n")] });
  const launches = records([legacy, unverified, start, hard, label, abandoned, routine, lead, pair]);
  assert.equal(launches.firstVerifiedPolicyWorker?.threadId, "w1");
  const declined: TicketHistory = { ...done("k", null), outcome: "declined" };
  const report = deriveRunReport(input(launches, history(done("f", "2026-11-15T09:00:00Z"), done("g", "2026-11-15T09:01:00Z"),
    done("h", "2026-11-15T09:02:00Z"), done("i", "2026-11-15T09:03:00Z"), done("j", "2026-11-15T09:04:00Z"), declined,
    done("l", "2026-11-15T09:06:00Z"), done("m", "2026-11-15T09:07:00Z"), done("n", "2026-11-15T09:08:00Z")),
  { lead: used(9000), w6: used(3000), w4: used(400) }));
  const rows = Object.fromEntries(report.tickets.map((row) => [row.identifier, row]));
  assert.deepEqual(Object.fromEntries(report.tickets.map((row) => [row.identifier, [row.category, row.period, row.countsTowardCheckpoint]])), {
    F: ["routine", "earlier", false], G: ["routine", "earlier", false], H: ["routine", "policy", true], I: ["hard", "policy", false],
    J: ["label:ui", "policy", false], K: ["routine", "policy", false], L: ["routine", "policy", true], M: ["routine", "policy", true], N: ["routine", "policy", true],
  });
  assert.equal(report.checkpoint.counted, 4);
  assert.equal(report.checkpoint.reached, true, "historical catch-up past n still reaches the checkpoint");
  assert.deepEqual(report.checkpoint.start, { threadId: "w1", launchedAt: start.record.launchedAt });
  // The abandoned routine ticket is shown with its usage but never counted.
  assert.deepEqual(rows.K.attempts[0].usage, used(400));
  assert.equal(rows.K.outcome, "declined");
  // Shared threads are listed once and never split: the two-ticket worker's usage isn't repeated on either row.
  assert.deepEqual(rows.M.attempts[0].usage, { state: "shared", tickets: ["M", "N"] });
  assert.deepEqual(report.sharedThreads.map((thread) => [thread.threadId, thread.usage.state === "reported" && thread.usage.total.totalTokens]),
    [["lead", 9000], ["w6", 3000]]);
  assert.match(formatRunReport(report), /Not completed \(shown for their attempts and usage; they never count\):\n\nK Ticket k \| declined/);
});

test("an unset checkpoint is reported as not set and is never reached", () => {
  const report = deriveRunReport(input(records([attempt("w1", { tickets: [ticket("a")] })]), history(done("a", "2026-11-15T10:00:00Z")), {}, { checkpoint: null }));
  assert.deepEqual([report.checkpoint.setting, report.checkpoint.counted, report.checkpoint.reached], [null, 1, false]);
  assert.match(formatRunReport(report), /Checkpoint: not set\./);
});

test("--since filters by the tracker's completion date, never by updates, and names undated tickets it left out", () => {
  const launches = records([attempt("w1", { tickets: [ticket("a")] }), attempt("w2", { tickets: [ticket("b")] }), attempt("w3", { tickets: [ticket("c")] })]);
  const report = deriveRunReport(input(launches, history(done("a", "2026-11-14T23:59:59Z"), done("b", "2026-11-15T00:00:00Z"), done("c", null)),
    {}, { since: Date.parse("2026-11-15T00:00:00Z") }));
  assert.deepEqual(report.tickets.map((row) => row.identifier), ["B"]);
  assert.match(report.coverage.notes.join("\n"), /1 completed ticket has no completion date, so --since left it out\./);
  assert.equal(report.checkpoint.counted, 3, "the checkpoint ignores --since");
});

test("shipped docs describe the Checkpoint neutrally, with no owner's value baked in", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["docs/report.md", "docs/settings.md", "skills/squadron-helper/SKILL.md", "skills/squadron-lead/report.md", "skills/squadron-lead/policy.md"]) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /Checkpoint \| \d|\bten\b|first 10\b/i, file);
  }
});

test("no completed tickets is scoped to launch records, and the historical gap stays stated", () => {
  const report = deriveRunReport(input(records([]), history()));
  const text = formatRunReport(report);
  assert.match(text, /No completed tickets in launch records\./);
  assert.match(text, /Work done without one, including all work before launch records existed, isn't listed\./);
});

test("saved GitHub CLOSED is unknown, not completed; Local markdown counts only an explicit Done", async () => {
  const issue = (id: string, name: string, type: string) => ({ id, identifier: id, title: id, description: null, url: `u/${id}`, updatedAt: "2026-11-15T00:00:00Z",
    parentId: null, state: { id: name, name, type }, labels: [], assignees: [], inProject: true });
  const snapshot = (kind: TrackerSnapshot["kind"], issues: ReturnType<typeof issue>[]): TrackerSnapshot =>
    ({ kind, bbProjectId: "p1", project: { name: "Fixture" }, issues, relations: [], labels: [], states: [], syncedAt: 1, error: null });
  const linear = { graphql: async () => { throw new Error("not Linear"); } };
  const read = async (kind: TrackerSnapshot["kind"], issues: ReturnType<typeof issue>[]) =>
    (await createTicketHistoryReader(linear, { getSnapshot: () => snapshot(kind, issues) })
      .read("p1", issues.map((item) => ({ id: item.id, identifier: item.id })), { comments: false })).tickets;
  const github = await read("github", [issue("#1", "CLOSED", "completed"), issue("#2", "OPEN", "started")]);
  assert.deepEqual([github.get("#1")?.outcome, github.get("#2")?.outcome], ["unknown", "open"]);
  assert.match(github.get("#1")?.problem ?? "", /completed or not planned/);
  const local = await read("local-markdown", [issue("a", "Done", "completed"), issue("b", "closed", "completed"), issue("c", "resolved", "completed")]);
  assert.deepEqual(["a", "b", "c"].map((id) => local.get(id)?.outcome), ["completed", "unknown", "unknown"]);
  // A GitHub project's closed routine tickets therefore never reach the checkpoint.
  const launches = records([attempt("w1", { tickets: [ticket("#1")] })]);
  assert.equal(deriveRunReport(input(launches, { source: "snapshot", tickets: github }, {}, { checkpoint: 1 })).checkpoint.reached, false);
});
