// The one documented way a Lead launches workers, reviewers and helper threads.
// It resolves the route with the same resolver as Start, Doctor and the board,
// refuses an unrunnable route rather than substituting, and records the launch.
import { cliCommand, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { readProjectCheckout } from "./project-checkout.js";
import { isOpenIssue } from "./linear-issues.js";
import { routeProblem } from "./model-capabilities.js";
import type { ModelRole } from "./squadron-settings.js";
import type { TrackerReader } from "./tracker-contract.js";
import { compareEffort, LAUNCH_METADATA_KEY, readLaunchMetadata, reportedRoute, requestedRoute, resolveLaunch, routeMismatch,
  routeText, spawnRoute, type LaunchRecord } from "./launch-record.js";

export const LAUNCH_ROLES = {
  worker: "Worker", "worker-hard": "Worker (hard)", planning: "Planning", "planning-hard": "Planning (hard)",
  "review-of-claude-code": "Review of claude-code", "review-of-codex": "Review of codex", mechanical: "Mechanical",
} as const satisfies Record<string, Exclude<ModelRole, "Lead">>;
type LaunchRoleName = keyof typeof LAUNCH_ROLES;
const NEEDS_TICKET: readonly ModelRole[] = ["Worker", "Worker (hard)"];
const HARD: Partial<Record<ModelRole, ModelRole>> = { "Worker (hard)": "Worker", "Planning (hard)": "Planning" };

export interface LaunchInput {
  role: LaunchRoleName;
  ticket?: string;
  baseBranch: string;
  prompt: string;
  title?: string;
  replaces?: string;
  effort?: string;
  reason?: string;
}

export function registerLaunch(bb: BbPluginApi, tracker: TrackerReader) {
  const fail = (message: string): never => { throw new PluginCliError(message); };
  async function launch(projectId: string, callerThreadId: string, input: LaunchInput) {
    const caller = await Promise.resolve().then(() => bb.sdk.threads.get({ threadId: callerThreadId })).catch(() => null);
    const callerMetadata = caller?.projectId === projectId ? await bb.sdk.threads.getPluginMetadata({ threadId: callerThreadId }).catch(() => null) : null;
    if (!caller || callerMetadata?.role !== "lead" || typeof callerMetadata.specId !== "string") {
      return fail("Run squadron launch inside a Squadron Lead thread in this project.");
    }
    const specId = callerMetadata.specId;
    const role = LAUNCH_ROLES[input.role];
    const checkout = await readProjectCheckout(bb, projectId);
    if (!checkout) return fail("This BB project has no default checkout to launch in.");
    if (!checkout.settings?.ok) return fail(checkout.settings ? checkout.settings.issues.map((issue) => issue.message).join(" ") : "Fix docs/agents/squadron.md, then launch again.");
    const snapshot = await tracker.getSnapshot(projectId);
    const spec = snapshot.issues.find((issue) => issue.id === specId);
    const specName = spec?.identifier ?? "this spec";
    let ticket: (typeof snapshot.issues)[number] | undefined;
    if (input.ticket !== undefined) {
      ticket = snapshot.issues.find((issue) => issue.identifier.toLowerCase() === input.ticket!.toLowerCase() && issue.inProject && isOpenIssue(issue)
        && (issue.parentId === specId || issue.id === specId));
      if (!ticket) return fail(`${input.ticket} isn't an open ticket of ${specName}. Read the tickets again.`);
    } else if (NEEDS_TICKET.includes(role)) return fail(`Name the ticket a ${role} builds with --ticket.`);
    const resolved = (() => {
      try { return resolveLaunch(checkout.settings.settings, { role, labels: ticket?.labels.map((label) => label.name) ?? [] }); }
      catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
    })();
    const routed = requestedRoute(resolved.route);
    const tickets = ticket ? [{ id: ticket.id, identifier: ticket.identifier }] : [];

    // Replacement and escalation: strikes, deadlines and budgets carry over; nothing here resets them.
    let replaced: LaunchRecord | null = null;
    if (input.replaces !== undefined) {
      const thread = await Promise.resolve().then(() => bb.sdk.threads.get({ threadId: input.replaces! })).catch(() => null);
      replaced = thread?.projectId === projectId ? readLaunchMetadata(await bb.sdk.threads.getPluginMetadata({ threadId: input.replaces }).catch(() => null)) : null;
      if (!replaced || replaced.leadThreadId !== callerThreadId) return fail(`${input.replaces} isn't a thread this Lead launched with squadron launch.`);
      if (replaced.tickets.map((item) => item.id).join() !== tickets.map((item) => item.id).join()) {
        return fail(`${input.replaces} worked on ${replaced.tickets.map((item) => item.identifier).join(", ") || "no ticket"}; a replacement keeps the same ticket.`);
      }
    }
    let escalation: LaunchRecord["escalation"] = null;
    let requested = routed;
    const reason = input.reason?.trim();
    if (input.effort !== undefined) {
      if (!replaced) return fail("Raise effort only for a replacement: name the earlier attempt with --replaces.");
      if (!reason) return fail("Give the escalation reason with --reason.");
      // An effort-only escalation keeps the replaced attempt's role, provider and model, read from its own record.
      // Today's route must still name that model; neither side is rewritten to fit the other.
      const before = replaced.requested;
      const ran = `${before.providerId ?? "BB's default provider"} ${before.model ?? "default model"}`;
      if (replaced.role !== role) return fail(`${input.replaces} ran as ${replaced.role}; an effort-only escalation keeps that role. Launch ${role} as a plain replacement, or use a hard route with --reason.`);
      if (!before.providerId || !before.model) return fail(`${input.replaces} ran on BB's default model, so a raised effort can't be compared. Launch a plain replacement.`);
      if (routed.providerId !== before.providerId || routed.model !== before.model) {
        return fail(`${input.replaces} ran on ${ran}, but today's ${role} route is ${routed.providerId ?? "BB's default provider"} ${routed.model ?? "default model"}. An effort-only escalation keeps the model; launch a plain replacement instead.`);
      }
      const provider = checkout.providerCatalog.find((entry) => entry.providerId === before.providerId);
      const model = provider?.models.find((entry) => entry.id === before.model);
      // BB's advertised efforts decide what is runnable; an unranked or unknown comparison is refused, never substituted.
      const advertised = model?.efforts ?? [];
      const overReplaced = compareEffort(input.effort, before.effort, advertised);
      if (!overReplaced.higher) return fail(`${ran}: ${overReplaced.problem.replace("the route's", `${input.replaces}'s`)}.`);
      const overRoute = compareEffort(input.effort, routed.effort, advertised);
      if (!overRoute.higher) return fail(`${ran}: ${overRoute.problem}.`);
      requested = { ...routed, effort: input.effort };
      escalation = { kind: "effort", reason };
    } else if (replaced && HARD[role] === replaced.role) {
      if (!reason) return fail(`Give the reason for the ${role} route with --reason.`);
      escalation = { kind: "model", reason };
    } else if (reason) {
      return fail("A reason is recorded only when a replacement runs at a higher effort or on a hard route.");
    }
    if (requested.providerId && requested.model) {
      const problem = routeProblem({ providerId: requested.providerId, model: requested.model, effort: requested.effort }, checkout.providerCatalog);
      if (problem) return fail(`Route ${resolved.category ?? role}: ${problem}`);
    }

    const name = ticket?.identifier ?? spec?.identifier ?? "";
    const title = input.title ?? `${role.startsWith("Review") ? "Review" : role} ${name}`.trim();
    if (ticket && !title.includes(ticket.identifier)) return fail(`Put ${ticket.identifier} in the title so the board can show this thread on its ticket.`);
    const record: LaunchRecord = { version: 1, role, category: resolved.category, policyResolved: resolved.policyResolved,
      overrideNote: resolved.overrideNote, specId, tickets, leadThreadId: callerThreadId, launchedBy: "lead", launchedAt: Date.now(),
      requested, replacesThreadId: input.replaces ?? null, escalation };
    const thread = await bb.sdk.threads.spawn({
      projectId, title, visibility: "visible", parentThreadId: callerThreadId, parentNotifications: "auto",
      ...spawnRoute(requested),
      // No `role` key: a launched child is never read as a Lead or planning thread.
      pluginMetadata: { [LAUNCH_METADATA_KEY]: record },
      environment: { type: "host", hostId: checkout.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: input.baseBranch } } },
      prompt: input.prompt,
    });
    const reported = await reportedRoute(bb, { id: thread.id, providerId: thread.providerId ?? requested.providerId });
    return { thread, record, reported, mismatch: routeMismatch(requested, reported) };
  }

  const command = cliCommand({
    summary: "Launch a worker, reviewer or helper thread from a Lead on its recorded route.",
    options: {
      ticket: { type: "string", description: "Ticket identifier the thread builds; required for worker and worker-hard." },
      "base-branch": { type: "string", required: true, description: "The integration branch the new worktree starts from." },
      prompt: { type: "string", stdin: true, description: "The thread's brief. Use --prompt-stdin for long briefs." },
      title: { type: "string", description: "Thread title; defaults to the role and ticket, and must contain the ticket identifier." },
      replaces: { type: "string", description: "Thread ID of the earlier attempt this one replaces." },
      effort: { type: "string", description: "Effort-only escalation: a higher effort the route's model supports. Needs --replaces and --reason." },
      reason: { type: "string", description: "Why this replacement escalates. Only with a raised effort or a hard route." },
    },
    positionals: [{ name: "role", description: `One of ${Object.keys(LAUNCH_ROLES).join(", ")}.`, required: true }],
    async run({ options, positionals }, context) {
      try {
        if (!context.threadId || !context.projectId) throw new PluginCliError("Run squadron launch inside a Squadron Lead thread in this project.");
        if (!(positionals.role in LAUNCH_ROLES)) throw new PluginCliError(`Choose a role: ${Object.keys(LAUNCH_ROLES).join(", ")}.`);
        if (!options.prompt?.trim()) throw new PluginCliError("Give the thread's brief with --prompt or --prompt-stdin.");
        const result = await launch(context.projectId, context.threadId, {
          role: positionals.role as LaunchRoleName, ticket: options.ticket, baseBranch: options["base-branch"], prompt: options.prompt,
          title: options.title, replaces: options.replaces, effort: options.effort, reason: options.reason,
        });
        const lines = [`Launched ${result.thread.title ?? result.record.role} on ${routeText(result.record.requested)} @thread:${result.thread.id}`];
        if (result.mismatch.length && result.reported) lines.push(`BB reports a different ${result.mismatch.join(", ")} than requested: ${result.mismatch.map((field) => `${field} ${result.reported![field] ?? "unknown"}`).join(", ")}. The launch record keeps the request.`);
        if (!result.reported) lines.push("BB's report of the route couldn't be read yet; the launch record keeps the request.");
        return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
      } catch (error) {
        return { exitCode: 1, stderr: `${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ")}\n` };
      }
    },
  });
  return { launch, commands: { launch: command } };
}
