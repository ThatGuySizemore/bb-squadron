// What each launch was given and what BB reports it runs. The record is seeded
// into the thread's own Squadron metadata at spawn and never rewritten; BB's
// thread records are the only store (no ledger, no database).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { launchRouteSchema, otherFamily, type LaunchRoute, type LaunchView, type ReportedRoute, type Route } from "./board-model.js";
import { DEFAULT_EFFORT_UNPROVED, effectiveEffort, type ProviderModels } from "./model-capabilities.js";
import { MODEL_ROLES, matchRoute, policyRows, providerFor, type ModelRole, type SquadronSettings } from "./squadron-settings.js";

export type { LaunchRoute, LaunchView, ReportedRoute };
export const LAUNCH_METADATA_KEY = "launch";
/** The one service tier fleet launches use. */
export const LAUNCH_SERVICE_TIER = "default";

export const launchRecordSchema = z.object({
  version: z.literal(1),
  /** The route role this launch resolved: a Model routes role name. */
  role: z.enum(MODEL_ROLES),
  /** The ticket label exception that chose the route; null for the role's own row. */
  category: z.string().nullable(),
  /** House rules Model routes resolved this launch. The earliest such launch opens a project's policy cohort. */
  policyResolved: z.boolean(),
  /** An approved repo exception's note, verbatim. It records a claim and grants nothing. */
  overrideNote: z.string().nullable(),
  /** Stable tracker ID of the spec, work item or planned issue; null for unscoped planning. */
  specId: z.string().nullable(),
  /** Tickets this thread builds. Empty means lane-wide: a Lead, reviewer or planning thread. */
  tickets: z.array(z.object({ id: z.string(), identifier: z.string() })),
  /** The Lead that launched this thread; null when Squadron launched it from the board or Autopilot. */
  leadThreadId: z.string().nullable(),
  launchedBy: z.enum(["owner", "autopilot", "lead"]),
  /** Epoch milliseconds when Squadron asked BB to spawn the thread. */
  launchedAt: z.number(),
  /** Exactly what Squadron passed to BB. A null provider or model means BB's project default. */
  requested: launchRouteSchema,
  /** The earlier attempt this one replaces, for every replacement, escalated or not. */
  replacesThreadId: z.string().nullable(),
  /** Set only when a replacement runs at a higher effort (same role and model) or on a hard route. */
  escalation: z.object({ kind: z.enum(["effort", "model"]), reason: z.string().min(1) }).nullable(),
});
export type LaunchRecord = z.infer<typeof launchRecordSchema>;

/** The record in a thread's Squadron metadata, or null when it has none or it doesn't parse. */
export function readLaunchMetadata(metadata: Record<string, unknown> | null | undefined): LaunchRecord | null {
  const parsed = launchRecordSchema.safeParse(metadata?.[LAUNCH_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

export interface ResolvedLaunch {
  role: ModelRole;
  category: string | null;
  policyResolved: boolean;
  overrideNote: string | null;
  /** null only for legacy planning, which keeps BB's project default as before. */
  route: Route | null;
}

const ROLE_ROW_MISSING = (role: ModelRole, shared: boolean) => shared
  ? `Add the ${role} row to House rules Model routes.`
  : `Add a ${role} row to the Routes table in docs/agents/squadron.md, or opt in with Defaults: House rules.`;

/** The one resolver Doctor's route view, Start, the board and squadron launch all use. Never substitutes. */
export function resolveLaunch(settings: SquadronSettings, request: { role: ModelRole; labels?: readonly string[] }, catalog?: readonly ProviderModels[]): ResolvedLaunch {
  const shared = settings.routeDefaults === "house-rules";
  const labels = request.labels ?? [];
  const resolved = (route: Route | null, category: string | null): ResolvedLaunch => {
    const problem = route && lowEffortProblem(settings, request.role, route, catalog);
    if (problem) throw new Error(problem);
    return { role: request.role, category, policyResolved: shared, overrideNote: route?.overrideNote ?? null, route };
  };
  const roleRow = settings.modelRoutes?.[request.role] ?? settings.routes.find((row) => row.role === request.role);
  if (request.role === "Lead") {
    const lead = settings.routes.find((row) => row.label?.toLowerCase() === "lead");
    if (lead) return resolved(withoutLabel(lead), null);
    const row = matchRoute(settings, labels);
    return resolved(withoutLabel(row), row.label);
  }
  if (request.role === "Worker") {
    const row = matchRoute(settings, labels);
    return resolved(withoutLabel(row), row.label);
  }
  if (roleRow) return resolved(withoutLabel(roleRow), null);
  if (shared) throw new Error(ROLE_ROW_MISSING(request.role, true));
  if (request.role === "Planning") return resolved(null, null);
  if (request.role === "Review of claude-code" || request.role === "Review of codex") {
    // Legacy family tables: the default row speaks for its family before label rows.
    const family = otherFamily(request.role === "Review of claude-code" ? "claude" : "gpt");
    const row = [...settings.routes].sort((a, b) => Number(b.label === null) - Number(a.label === null))
      .find((route) => route.family === family && route.label?.toLowerCase() !== "lead");
    if (row) return resolved(withoutLabel(row), null);
  }
  throw new Error(ROLE_ROW_MISSING(request.role, false));
}

/**
 * Squadron policy's Low effort setting: off refuses every low route; mechanical only allows low for Mechanical alone.
 * A `default` effort counts as low when BB advertises low as the model's native default. An unknown default isn't refused.
 */
export function lowEffortProblem(settings: SquadronSettings, role: ModelRole, route: Route, catalog?: readonly ProviderModels[]): string | null {
  if (effectiveEffort({ providerId: route.providerId, model: route.model, effort: route.effort }, catalog) !== "low") return null;
  const what = route.effort === "default" ? `${providerFor(route)} ${route.model}'s default effort (low, as BB advertises it)` : "low effort";
  if (settings.policy.lowEffort === "off") return `Low effort is off in House rules Squadron policy, so the ${role} route (${what}) is refused. Set Low effort to mechanical only to allow it for Mechanical, or name a higher effort.`;
  return role === "Mechanical" ? null : `Low effort is mechanical only, so the ${role} route (${what}) is refused. Name a higher effort.`;
}

function withoutLabel(row: Route & { label?: string | null }): Route {
  const { label: _label, ...route } = row;
  return route;
}

/** The fields Squadron passes to BB for a resolved route. */
export function requestedRoute(route: Route | null): LaunchRoute {
  if (!route) return { providerId: null, model: null, effort: "default", serviceTier: LAUNCH_SERVICE_TIER };
  return { providerId: providerFor(route), model: route.model, effort: route.effort, serviceTier: LAUNCH_SERVICE_TIER };
}

/** Spawn arguments for a requested route: an explicit route, or BB's default with the fleet tier. */
export function spawnRoute(requested: LaunchRoute): { providerId?: string; model?: string; reasoningLevel?: string; serviceTier: string } {
  return {
    ...(requested.providerId ? { providerId: requested.providerId } : {}),
    ...(requested.model ? { model: requested.model } : {}),
    ...(requested.effort === "default" ? {} : { reasoningLevel: requested.effort }),
    serviceTier: requested.serviceTier,
  };
}

/** One line per role, then each ticket label exception, shared by Doctor's route view and the Lead's brief. */
export interface RouteViewRow { role: ModelRole; category: string | null; route: LaunchRoute | null; problem?: string; note?: string }
export function launchRoutes(settings: SquadronSettings, catalog?: readonly ProviderModels[]): RouteViewRow[] {
  const row = (role: ModelRole, labels: string[] = []): RouteViewRow => {
    try {
      const launch = resolveLaunch(settings, { role, labels }, catalog);
      const unproved = launch.route?.effort === "default" && launch.route.providerId && effectiveEffort(launch.route, catalog) === null;
      return { role, category: launch.category, route: requestedRoute(launch.route), ...(unproved ? { note: DEFAULT_EFFORT_UNPROVED } : {}) };
    } catch (error) { return { role, category: labels[0] ?? null, route: null, problem: error instanceof Error ? error.message : String(error) }; }
  };
  const exceptions = settings.routes.filter((route) => route.label !== null && route.role === undefined && route.label.toLowerCase() !== "lead");
  return [row("Lead"), ...MODEL_ROLES.filter((role) => role !== "Lead").map((role) => row(role)),
    ...exceptions.map((route) => row("Worker", [route.label!]))];
}

export function routeText(route: LaunchRoute): string {
  const model = route.providerId && route.model ? `${route.providerId} ${route.model}` : "BB's default model";
  return `${model}, ${route.effort} effort, ${route.serviceTier} tier`;
}

export function routeViewLine(row: RouteViewRow): string {
  const name = row.category ? `${row.role} for ${row.category} tickets` : row.role;
  return `- ${name}: ${row.route ? routeText(row.route) : `not set. ${row.problem ?? ""}`.trim()}${row.note ? ` (${row.note})` : ""}`;
}

/** Efforts whose relative order is settled. BB advertises other IDs (ultra, ultracode) without a rank. */
const EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"];
/**
 * Whether `raised` is provably above `base` for a model, given the efforts BB advertises for it in BB's order.
 * Both must be advertised and on the settled ladder, and BB's order must agree. Anything else is refused by name.
 */
export function compareEffort(raised: string, base: string, advertised: readonly string[]): { higher: true } | { higher: false; problem: string } {
  if (!advertised.includes(raised)) return { higher: false, problem: `doesn't support ${raised} effort on this machine` };
  const off = [raised, base].filter((effort) => !EFFORT_LADDER.includes(effort));
  if (off.length) return { higher: false, problem: `BB doesn't rank ${off.join(" or ")} against the route's ${base} effort, so it can't be recorded as a raised effort. Use a hard route or a ranked level (${EFFORT_LADDER.join(", ")})` };
  const order = (effort: string) => EFFORT_LADDER.indexOf(effort);
  const listed = (effort: string) => advertised.indexOf(effort);
  if (order(raised) <= order(base)) return { higher: false, problem: `${raised} isn't higher than the route's ${base} effort` };
  if (listed(base) >= 0 && listed(raised) < listed(base)) return { higher: false, problem: `BB lists ${raised} before ${base}, so its rank is unproven` };
  return { higher: true };
}

export type LaunchField = "providerId" | "model" | "effort" | "serviceTier";
/** Known fields where BB reports something other than what was requested. Unreported fields and BB defaults never count. */
export function routeMismatch(requested: LaunchRoute, reported: ReportedRoute | null): LaunchField[] {
  if (!reported) return [];
  const differs = (want: string | null, got: string | null) => want !== null && got !== null && want !== got;
  const fields: LaunchField[] = [];
  if (differs(requested.providerId, reported.providerId)) fields.push("providerId");
  if (differs(requested.model, reported.model)) fields.push("model");
  if (requested.effort !== "default" && differs(requested.effort, reported.effort)) fields.push("effort");
  if (differs(requested.serviceTier, reported.serviceTier)) fields.push("serviceTier");
  return fields;
}

/** What BB reports a thread runs: its execution options, with a later provider model fallback winning. Null when unreadable; absent fields stay null. */
export async function reportedRoute(bb: BbPluginApi, thread: { id: string; providerId: string | null }): Promise<ReportedRoute | null> {
  try {
    const execution = await bb.sdk.threads.defaultExecutionOptions({ threadId: thread.id });
    if (!execution) return null;
    const fallback = await Promise.resolve().then(() => bb.sdk.threads.events.list({
      threadId: thread.id, types: ["provider/modelFallback"], order: "desc", limit: "1" })).catch(() => []);
    const latest = fallback[0];
    const model = latest?.type === "provider/modelFallback" && latest.seq > (execution.seq ?? -1) ? latest.data.fallbackModel : execution.model;
    return { providerId: thread.providerId ?? null, model: model || null, effort: execution.reasoningLevel || null, serviceTier: execution.serviceTier || null };
  } catch { return null; }
}

/** Mismatch fields and the verification state they imply. */
/**
 * Mismatch fields and the verification state they imply. Any known difference is a mismatch.
 * Verified needs BB to report every field the launch set explicitly; a gap leaves it unknown.
 */
export function verify(requested: LaunchRoute, reported: ReportedRoute | null): Pick<LaunchAttempt, "mismatch" | "verification"> {
  const mismatch = routeMismatch(requested, reported);
  if (mismatch.length) return { mismatch, verification: "mismatch" };
  const complete = reported !== null && (requested.providerId === null || reported.providerId !== null)
    && (requested.model === null || reported.model !== null)
    && (requested.effort === "default" || reported.effort !== null) && reported.serviceTier !== null;
  return { mismatch, verification: complete ? "verified" : "unknown" };
}

export function launchView(record: LaunchRecord, reported: ReportedRoute | null): LaunchView {
  return { role: record.role, category: record.category, policyResolved: record.policyResolved,
    requested: record.requested, reported, ...verify(record.requested, reported),
    escalation: record.escalation, replacesThreadId: record.replacesThreadId };
}

type BbThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
export interface LaunchAttempt {
  threadId: string;
  parentThreadId: string | null;
  title: string | null;
  createdAt: number;
  archivedAt: number | null;
  deletedAt: number | null;
  status: string;
  record: LaunchRecord;
  /** What BB reports now; null when unreadable, which is unknown rather than a match. */
  reported: ReportedRoute | null;
  mismatch: LaunchField[];
  /** verified: BB reports exactly the request; mismatch: it reports something else; unknown: unreadable. */
  verification: "verified" | "mismatch" | "unknown";
}
export interface LaunchRecords {
  /** Every recorded launch in the project, active and archived, oldest first. */
  attempts: LaunchAttempt[];
  /** The earliest verified, policy-resolved Worker launch, which opens the project's evaluation cohort. Not narrowed by the filter. */
  firstVerifiedPolicyWorker: LaunchAttempt | null;
  /** Children of recorded Leads launched outside squadron launch: listed so they are never silently dropped. */
  unrecorded: { threadId: string; parentThreadId: string; title: string | null; createdAt: number; archivedAt: number | null }[];
}

async function listAll(bb: BbPluginApi, args: { projectId: string; originPluginId?: string; parentThreadId?: string }): Promise<BbThread[]> {
  const found = new Map<string, BbThread>();
  for (const archived of [false, true]) {
    for (let offset = 0; ; offset += 200) {
      const page = await bb.sdk.threads.list({ ...args, archived, includeHidden: true, limit: 200, offset });
      for (const thread of page) if (thread.projectId === args.projectId) found.set(thread.id, thread);
      if (page.length < 200) break;
    }
  }
  return [...found.values()];
}

const byCreation = <T extends { createdAt: number; threadId: string }>(a: T, b: T) => a.createdAt - b.createdAt || a.threadId.localeCompare(b.threadId);

/**
 * Read-only launch history for reports and reviewer choice: every recorded attempt with its
 * spec, ticket and role linkage, including archived, replaced and abandoned ones.
 * `specId` narrows attempts to one spec or work item by its stable tracker ID.
 */
export async function readLaunchRecords(bb: BbPluginApi, projectId: string, filter: { specId?: string } = {}): Promise<LaunchRecords> {
  const threads = await listAll(bb, { projectId, originPluginId: bb.pluginId });
  const attempts: LaunchAttempt[] = [];
  for (const thread of threads) {
    const record = readLaunchMetadata(await bb.sdk.threads.getPluginMetadata({ threadId: thread.id }).catch(() => null));
    if (!record) continue;
    const reported = await reportedRoute(bb, thread);
    attempts.push({ threadId: thread.id, parentThreadId: thread.parentThreadId ?? null, title: thread.title ?? null,
      createdAt: thread.createdAt, archivedAt: thread.archivedAt ?? null, deletedAt: thread.deletedAt ?? null, status: thread.status,
      record, reported, ...verify(record.requested, reported) });
  }
  attempts.sort(byCreation);
  const firstVerifiedPolicyWorker = attempts.find((attempt) => attempt.record.policyResolved && attempt.record.role === "Worker" && attempt.verification === "verified") ?? null;
  const selected = filter.specId === undefined ? attempts : attempts.filter((attempt) => attempt.record.specId === filter.specId);
  const recorded = new Set(attempts.map((attempt) => attempt.threadId));
  // Lane owners: spec Leads, and work item lanes Squadron started on a Worker route.
  const leads = selected.filter((attempt) => attempt.record.role === "Lead"
    || (attempt.record.launchedBy !== "lead" && attempt.record.role === "Worker"));
  const unrecorded: LaunchRecords["unrecorded"] = [];
  for (const lead of leads) {
    for (const child of await listAll(bb, { projectId, parentThreadId: lead.threadId })) {
      if (child.parentThreadId !== lead.threadId || recorded.has(child.id)) continue;
      unrecorded.push({ threadId: child.id, parentThreadId: lead.threadId, title: child.title ?? null, createdAt: child.createdAt, archivedAt: child.archivedAt ?? null });
    }
  }
  return { attempts: selected, firstVerifiedPolicyWorker, unrecorded: unrecorded.sort(byCreation) };
}

/** A recorded launch without BB's live route: enough for categories and cohorts. */
export interface LaunchEntry { threadId: string; createdAt: number; record: LaunchRecord }
/**
 * The light read the checkpoint uses: every recorded launch, active and archived, from metadata alone,
 * and the cohort start. BB's live route is read only for policy-resolved Worker launches, oldest first,
 * stopping at the first verified one. No usage, events beyond that, or Lead children.
 */
export async function readLaunchCohort(bb: BbPluginApi, projectId: string): Promise<{ attempts: LaunchEntry[]; firstVerifiedPolicyWorker: LaunchEntry | null }> {
  const attempts: LaunchEntry[] = [];
  const threads = new Map<string, BbThread>();
  for (const thread of await listAll(bb, { projectId, originPluginId: bb.pluginId })) {
    const record = readLaunchMetadata(await bb.sdk.threads.getPluginMetadata({ threadId: thread.id }).catch(() => null));
    if (!record) continue;
    threads.set(thread.id, thread);
    attempts.push({ threadId: thread.id, createdAt: thread.createdAt, record });
  }
  attempts.sort(byCreation);
  for (const attempt of attempts) {
    if (!attempt.record.policyResolved || attempt.record.role !== "Worker") continue;
    if (verify(attempt.record.requested, await reportedRoute(bb, threads.get(attempt.threadId)!)).verification === "verified")
      return { attempts, firstVerifiedPolicyWorker: attempt };
  }
  return { attempts, firstVerifiedPolicyWorker: null };
}

/** The resolved Squadron policy for a Lead's brief. The Lead reads these values, not House rules prose. */
export function policyBriefLines(settings: SquadronSettings): string[] {
  return ["Squadron policy resolved at Start (follow these values, and the squadron-lead skill's text for each mode):",
    ...policyRows(settings).map((row) => `- ${row.setting}: ${row.value}`)];
}
