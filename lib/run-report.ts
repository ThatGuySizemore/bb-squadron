// `bb squadron report`: how each ticket went, derived on demand from launch records,
// BB thread usage and ticket evidence. Nothing here is stored, and nothing acts.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readLaunchRecords, type LaunchAttempt, type LaunchRecords } from "./launch-record.js";
import type { LaunchRoute, ReportedRoute } from "./launch-route.js";
import type { HistoryRead, TicketHistory, TicketHistoryReader, TicketOutcome } from "./ticket-history.js";
import type { TicketResult } from "./ticket-result.js";
import { readThreadUsage, type ThreadUsage } from "./thread-usage.js";

export type Known<T> = { state: "known"; value: T } | { state: "unknown"; reason: string };
export type AttemptUsage = ThreadUsage | { state: "shared"; tickets: string[] };
export interface AttemptRow {
  threadId: string;
  role: string;
  /** The ticket label exception that chose the route; null for the role's own row. */
  label: string | null;
  policyResolved: boolean;
  launchedAt: number;
  launchedBy: string;
  status: string;
  archived: boolean;
  deleted: boolean;
  requested: LaunchRoute;
  reported: ReportedRoute | null;
  verification: LaunchAttempt["verification"];
  mismatch: string[];
  replacesThreadId: string | null;
  escalation: { kind: "effort" | "model"; reason: string } | null;
  /** This attempt's own usage, or shared when it worked on several tickets and is listed once under shared threads. */
  usage: AttemptUsage;
}
export interface TicketRow {
  id: string;
  identifier: string;
  title: string | null;
  url: string | null;
  outcome: TicketOutcome;
  completedAt: string | null;
  /** Set by the ticket's first launch: routine, hard, `label:<name>`, or another role's name. */
  category: string;
  /** policy: first launched at or after the checkpoint start under House rules routes. earlier: before it, or without them. */
  period: "policy" | "earlier";
  countsTowardCheckpoint: boolean;
  /** Every recorded attempt, oldest first: replaced, stopped, failed and archived ones included. */
  attempts: AttemptRow[];
  escalations: { threadId: string; kind: "effort" | "model"; reason: string }[];
  checks: Known<NonNullable<TicketResult["checks"]>>;
  firstPass: Known<boolean>;
  reviewDefects: Known<number>;
  repairRounds: Known<number>;
  strikes: Known<NonNullable<TicketResult["strikes"]>>;
  ownerInterventions: Known<number>;
  /** The completion comment the results came from. */
  evidence: { commentId: string; createdAt: string } | null;
  problems: string[];
}
export interface CheckpointProgress {
  /** The House rules Checkpoint: null when unset, unknown when settings couldn't be read. */
  setting: number | null | "unknown";
  /** The earliest verified, policy-resolved Worker launch; null before there is one. */
  start: { threadId: string; launchedAt: number } | null;
  /** Completed routine tickets first launched at or after the start. A lower bound when some tickets are unknown. */
  counted: number;
  reached: boolean;
}
export interface RunReport {
  version: 1;
  projectId: string;
  projectName: string;
  readAt: number;
  since: number | null;
  checkpoint: CheckpointProgress;
  tickets: TicketRow[];
  /** Threads that worked on no single ticket (Leads, reviewers, planning) or on several. Listed once, never split across tickets. */
  sharedThreads: (Omit<AttemptRow, "usage"> & { usage: ThreadUsage; specId: string | null; tickets: string[] })[];
  /** Children of recorded Leads launched without a launch record: shown so they are never silently dropped. */
  unrecordedThreads: { threadId: string; parentThreadId: string; title: string | null; createdAt: number; archived: boolean; usage: ThreadUsage }[];
  coverage: { tickets: "launch records"; tracker: HistoryRead["source"] | "unread"; notes: string[] };
}

export interface ReportInput {
  projectId: string;
  projectName: string;
  readAt: number;
  since: number | null;
  checkpoint: number | null | "unknown";
  records: LaunchRecords;
  history: HistoryRead | null;
  usage: ReadonlyMap<string, ThreadUsage>;
}

/** A ticket's category comes from its first launch, so a later escalation never moves it out of routine. */
export function categoryOf(record: LaunchAttempt["record"]): string {
  if (record.role === "Worker") return record.category === null ? "routine" : `label:${record.category}`;
  if (record.role === "Worker (hard)") return "hard";
  return record.role;
}

/** Each ticket's attempts, oldest first, keyed by stable tracker ID. */
export function attemptsByTicket(records: LaunchRecords): Map<string, { identifier: string; attempts: LaunchAttempt[] }> {
  const tickets = new Map<string, { identifier: string; attempts: LaunchAttempt[] }>();
  for (const attempt of records.attempts) for (const ticket of attempt.record.tickets) {
    const entry = tickets.get(ticket.id) ?? { identifier: ticket.identifier, attempts: [] };
    entry.attempts.push(attempt);
    tickets.set(ticket.id, entry);
  }
  return tickets;
}

/** Whether a ticket's first launch falls in the checkpoint period: policy-resolved, at or after the earliest verified policy Worker. */
function inPolicyPeriod(first: LaunchAttempt, start: LaunchAttempt | null): boolean {
  return start !== null && first.record.policyResolved && (first.createdAt > start.createdAt
    || first.createdAt === start.createdAt && first.threadId >= start.threadId);
}

/** Routine tickets first launched in the policy period. Only these can count toward the checkpoint. */
export function checkpointCandidates(records: LaunchRecords): { id: string; identifier: string }[] {
  const start = records.firstVerifiedPolicyWorker;
  return [...attemptsByTicket(records)].flatMap(([id, { identifier, attempts }]) =>
    inPolicyPeriod(attempts[0], start) && categoryOf(attempts[0].record) === "routine" ? [{ id, identifier }] : []);
}

export function checkpointProgress(records: LaunchRecords, history: HistoryRead | null, setting: number | null | "unknown"): CheckpointProgress {
  const start = records.firstVerifiedPolicyWorker;
  const counted = checkpointCandidates(records).filter((ticket) => history?.tickets.get(ticket.id)?.outcome === "completed").length;
  return { setting, start: start && { threadId: start.threadId, launchedAt: start.record.launchedAt }, counted,
    reached: typeof setting === "number" && start !== null && counted >= setting };
}

const missing = (why: string) => ({ state: "unknown" as const, reason: why });
function known<T>(value: T | undefined, why: string): Known<T> {
  return value === undefined ? missing(why) : { state: "known", value };
}

function attemptRow(attempt: LaunchAttempt, usage: AttemptUsage): AttemptRow {
  const { record } = attempt;
  return { threadId: attempt.threadId, role: record.role, label: record.category, policyResolved: record.policyResolved,
    launchedAt: record.launchedAt, launchedBy: record.launchedBy, status: attempt.status,
    archived: attempt.archivedAt !== null, deleted: attempt.deletedAt !== null,
    requested: record.requested, reported: attempt.reported, verification: attempt.verification, mismatch: attempt.mismatch,
    replacesThreadId: record.replacesThreadId, escalation: record.escalation, usage };
}

const usageOf = (usage: ReadonlyMap<string, ThreadUsage>, threadId: string): ThreadUsage =>
  usage.get(threadId) ?? { state: "unknown", reason: "Usage wasn't read." };

/** The whole report from already-read sources. Pure: the same inputs always give the same report. */
export function deriveRunReport(input: ReportInput): RunReport {
  const { records, history } = input;
  const notes: string[] = [];
  const start = records.firstVerifiedPolicyWorker;
  const rows: TicketRow[] = [];
  let undated = 0;
  for (const [id, { identifier, attempts }] of attemptsByTicket(records)) {
    const first = attempts[0];
    const tracked: TicketHistory | undefined = history?.tickets.get(id);
    const outcome = tracked?.outcome ?? "unknown";
    const completedAt = tracked?.completedAt ?? null;
    if (input.since !== null) {
      if (outcome === "completed") {
        if (completedAt === null) { undated++; continue; }
        if (Date.parse(completedAt) < input.since) continue;
      } else if (!attempts.some((attempt) => attempt.record.launchedAt >= input.since!)) continue;
    }
    const category = categoryOf(first.record);
    const period = inPolicyPeriod(first, start) ? "policy" : "earlier";
    const evidence = tracked?.result;
    const why = evidence === undefined || evidence === "unread" ? "The ticket's comments weren't read."
      : evidence === null ? "The ticket has no result block in its comments."
        : evidence.state === "invalid" ? evidence.problem : "The result block leaves this out.";
    const result = evidence && evidence !== "unread" && evidence.state === "known" ? evidence.result : undefined;
    const problems = [...tracked?.problem ? [tracked.problem] : [], ...!tracked ? ["The tracker wasn't read for this ticket."] : []];
    rows.push({ id, identifier: tracked?.identifier ?? identifier, title: tracked?.title ?? null, url: tracked?.url ?? null,
      outcome, completedAt, category, period, countsTowardCheckpoint: period === "policy" && category === "routine" && outcome === "completed",
      attempts: attempts.map((attempt) => attemptRow(attempt, attempt.record.tickets.length === 1 ? usageOf(input.usage, attempt.threadId)
        : { state: "shared", tickets: attempt.record.tickets.map((ticket) => ticket.identifier) })),
      escalations: attempts.flatMap((attempt) => attempt.record.escalation ? [{ threadId: attempt.threadId, ...attempt.record.escalation }] : []),
      checks: known(result?.checks, why), firstPass: known(result?.firstPass, why), reviewDefects: known(result?.reviewDefects, why),
      repairRounds: known(result?.repairRounds, why), strikes: known(result?.strikes, why), ownerInterventions: known(result?.ownerInterventions, why),
      evidence: evidence && evidence !== "unread" ? { commentId: evidence.commentId, createdAt: evidence.createdAt } : null, problems });
  }
  const rank = (row: TicketRow) => row.outcome === "completed" ? 0 : 1;
  rows.sort((a, b) => rank(a) - rank(b) || (a.completedAt ?? "").localeCompare(b.completedAt ?? "")
    || a.attempts[0].launchedAt - b.attempts[0].launchedAt || a.identifier.localeCompare(b.identifier));
  if (undated) notes.push(`${undated} completed ticket${undated === 1 ? " has" : "s have"} no completion date, so --since left ${undated === 1 ? "it" : "them"} out.`);
  if (!history) notes.push("The tracker wasn't read, so every ticket's outcome is unknown.");
  else if (history.source === "snapshot") notes.push("This tracker gives no completion dates or comments here, so dates and results are unknown.");
  if (records.unrecorded.length) notes.push(`${records.unrecorded.length} thread${records.unrecorded.length === 1 ? "" : "s"} started by a Lead without a launch record ${records.unrecorded.length === 1 ? "is" : "are"} listed separately; their tickets are unknown.`);
  notes.push("Tickets come from launch records. Work done without one isn't listed.");
  const shared = records.attempts.filter((attempt) => attempt.record.tickets.length !== 1)
    .filter((attempt) => input.since === null || attempt.record.launchedAt >= input.since
      || attempt.record.tickets.some((ticket) => rows.some((row) => row.id === ticket.id)));
  return {
    version: 1, projectId: input.projectId, projectName: input.projectName, readAt: input.readAt, since: input.since,
    checkpoint: checkpointProgress(records, history, input.checkpoint),
    tickets: rows,
    sharedThreads: shared.map((attempt) => ({ ...attemptRow(attempt, usageOf(input.usage, attempt.threadId)) as Omit<AttemptRow, "usage">,
      usage: usageOf(input.usage, attempt.threadId), specId: attempt.record.specId, tickets: attempt.record.tickets.map((ticket) => ticket.identifier) })),
    unrecordedThreads: records.unrecorded.map((thread) => ({ threadId: thread.threadId, parentThreadId: thread.parentThreadId, title: thread.title,
      createdAt: thread.createdAt, archived: thread.archivedAt !== null, usage: usageOf(input.usage, thread.threadId) })),
    coverage: { tickets: "launch records", tracker: history?.source ?? "unread", notes },
  };
}

export interface ReportSources {
  history: TicketHistoryReader;
  /** The resolved Checkpoint setting: a number, null when unset, or unknown when settings couldn't be read. */
  checkpoint(projectId: string, signal?: AbortSignal): Promise<number | null | "unknown">;
}

/** Reads every source the report needs, then derives it. Read-only. */
export async function readRunReport(bb: BbPluginApi, sources: ReportSources, project: { id: string; name: string },
  options: { since: number | null; signal?: AbortSignal }): Promise<RunReport> {
  const readAt = Date.now();
  const records = await readLaunchRecords(bb, project.id);
  const tickets = [...attemptsByTicket(records)].map(([id, { identifier }]) => ({ id, identifier }));
  const history = await sources.history.read(project.id, tickets, { comments: true, signal: options.signal }).catch(() => null);
  const usage = new Map<string, ThreadUsage>();
  for (const id of [...records.attempts.map((attempt) => attempt.threadId), ...records.unrecorded.map((thread) => thread.threadId)])
    if (!usage.has(id)) usage.set(id, await readThreadUsage(bb, id));
  const checkpoint = await sources.checkpoint(project.id, options.signal).catch(() => "unknown" as const);
  return deriveRunReport({ projectId: project.id, projectName: project.name, readAt, since: options.since, checkpoint, records, history, usage });
}

// Text output, in Owner words.
const iso = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
const number = (value: number) => value.toLocaleString("en");
function usageText(usage: AttemptUsage): string {
  if (usage.state === "shared") return `usage shared with ${usage.tickets.join(", ")}, listed under shared threads`;
  if (usage.state === "unknown") return `usage unknown (${usage.reason})`;
  const { total } = usage;
  return `${number(total.totalTokens)} tokens (input ${number(total.inputTokens)}, cached ${number(total.cachedInputTokens)}, output ${number(total.outputTokens)}, reasoning ${number(total.reasoningOutputTokens)})${usage.sessions === "several" ? ", latest provider session only" : ""}`;
}
function routeText(route: LaunchRoute) {
  return `${route.providerId ?? "BB default"} ${route.model ?? "default model"} ${route.effort}`;
}
function attemptText(attempt: Omit<AttemptRow, "usage"> & { usage: AttemptUsage }) {
  const ran = attempt.verification === "verified" ? "BB confirms it" : attempt.verification === "mismatch"
    ? `BB reports something else (${attempt.mismatch.join(", ")}: ${attempt.reported ? `${attempt.reported.providerId ?? "?"} ${attempt.reported.model ?? "?"} ${attempt.reported.effort ?? "?"}` : "?"})` : "what BB runs is unknown";
  const state = [attempt.status, attempt.archived ? "archived" : null, attempt.deleted ? "deleted" : null].filter(Boolean).join(", ");
  return `${attempt.role}${attempt.label ? ` for ${attempt.label}` : ""}: ${routeText(attempt.requested)}, ${ran} | ${state}`
    + `${attempt.replacesThreadId ? ` | replaces @thread:${attempt.replacesThreadId}` : ""}`
    + `${attempt.escalation ? ` | ${attempt.escalation.kind} escalation: ${attempt.escalation.reason}` : ""}`
    + ` | @thread:${attempt.threadId} | ${usageText(attempt.usage)}`;
}
function knownText<T>(value: Known<T>, show: (value: T) => string) {
  return value.state === "known" ? show(value.value) : "unknown";
}
export function formatRunReport(report: RunReport): string {
  const lines: string[] = [`${report.projectName} | Report read ${iso(report.readAt)}${report.since !== null ? ` | Completed since ${iso(report.since)}` : ""}`];
  const { checkpoint } = report;
  lines.push(checkpoint.setting === null ? "Checkpoint: not set."
    : checkpoint.setting === "unknown" ? `Checkpoint: setting unknown. ${checkpoint.counted} completed routine tickets counted.`
      : !checkpoint.start ? `Checkpoint: ${checkpoint.setting}. Counting starts at the first verified policy-resolved Worker launch; there isn't one yet.`
        : `Checkpoint: ${checkpoint.counted} of ${checkpoint.setting} completed routine tickets since @thread:${checkpoint.start.threadId} (${iso(checkpoint.start.launchedAt)})${checkpoint.reached ? ", reached" : ""}.`);
  for (const note of report.coverage.notes) lines.push(`Note: ${note}`);
  const completed = report.tickets.filter((row) => row.outcome === "completed");
  const other = report.tickets.filter((row) => row.outcome !== "completed");
  const ticket = (row: TicketRow) => {
    lines.push("", `${row.identifier}${row.title ? ` ${row.title}` : ""} | ${row.outcome}${row.completedAt ? ` ${row.completedAt}` : ""} | ${row.category}${row.countsTowardCheckpoint ? " | counts toward the checkpoint" : row.period === "earlier" ? " | before the checkpoint start" : ""}`);
    row.attempts.forEach((attempt, index) => lines.push(`  ${index + 1}. ${attemptText(attempt)}`));
    lines.push(`  Checks: ${knownText(row.checks, (checks) => checks.length ? checks.map((check) => `${check.command} ${check.result}`).join("; ") : "none required")}`);
    lines.push(`  First pass: ${knownText(row.firstPass, (value) => value ? "yes" : "no")} | Review defects: ${knownText(row.reviewDefects, String)} | Repair rounds: ${knownText(row.repairRounds, String)} | Strikes: ${knownText(row.strikes, (strikes) => strikes.length ? `${strikes.length} (${strikes.map((strike) => strike.reason).join("; ")})` : "0")} | Owner interventions: ${knownText(row.ownerInterventions, String)}`);
    if (row.escalations.length) lines.push(`  Escalations: ${row.escalations.map((item) => `${item.kind}: ${item.reason}`).join("; ")}`);
    for (const problem of row.problems) lines.push(`  Note: ${problem}`);
  };
  if (!completed.length) lines.push("", "No completed tickets.");
  completed.forEach(ticket);
  if (other.length) { lines.push("", "Not completed (shown for their attempts and usage; they never count):"); other.forEach(ticket); }
  if (report.sharedThreads.length) {
    lines.push("", "Shared threads (usage listed once, not split across tickets):");
    for (const thread of report.sharedThreads) lines.push(`  ${thread.specId ?? "No spec"}${thread.tickets.length ? ` (${thread.tickets.join(", ")})` : ""}: ${attemptText(thread)}`);
  }
  if (report.unrecordedThreads.length) {
    lines.push("", "Threads without a launch record:");
    for (const thread of report.unrecordedThreads) lines.push(`  ${thread.title ?? "Untitled"} | started by @thread:${thread.parentThreadId}${thread.archived ? " | archived" : ""} | @thread:${thread.threadId} | ${usageText(thread.usage)}`);
  }
  return `${lines.join("\n")}\n`;
}
