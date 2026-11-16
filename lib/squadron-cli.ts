import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { LaneActions } from "./lane-start.js";
import type { Board } from "./board-model.js";
import { helperCommands } from "./helper-cli.js";
import type { registerHelper } from "./helper.js";
import type { AutopilotControls } from "./autopilot.js";
import type { registerPlanning } from "./planning.js";
import type { registerLaunch } from "./launch-cli.js";
import { oneLine, openNeeds, needLine, boardLink, unreadableProject as unreadable } from "./project-observation.js";
import { checkTicketResult } from "./result-check.js";
import { formatRunReport, readRunReport, type ReportSources } from "./run-report.js";

/** A --since value: a UTC calendar date, or an ISO date-time with its timezone. */
export function parseSince(value: string): number {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`)
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(date)) throw new PluginCliError("Use --since YYYY-MM-DD (UTC) or an ISO date-time with a timezone.");
  return date;
}

const incomplete = (board: Board | null) => !board || board.tracker?.state !== "current";

/** Board reads, shared lane and Autopilot controls, and Helper selection. */
export function registerSquadronCli(bb: BbPluginApi, board: { read(projectId: string): Promise<Board> }, actions: LaneActions, helper: ReturnType<typeof registerHelper>, autopilot: AutopilotControls, planning: ReturnType<typeof registerPlanning>, launch: ReturnType<typeof registerLaunch>, report: ReportSources) {
  const options = {
    project: { type: "string", description: "Project ID or unique name; defaults to the caller's project." },
    all: { type: "boolean", description: "Show every project." },
  } as const;
  async function projects(selected?: string) {
    const all = await bb.sdk.projects.list();
    if (selected === undefined) return all;
    const exact = all.find((project) => project.id === selected);
    if (exact) return [exact];
    const matches = all.filter((project) => project.name === selected);
    if (!matches.length) throw new PluginCliError(`No project matches "${selected}".`);
    if (matches.length > 1) throw new PluginCliError(`More than one project matches "${selected}". Use its project ID.`);
    return matches;
  }
  async function readProjects(selection: { project?: string; all?: boolean }, callerProject?: string) {
    if (selection.all && selection.project !== undefined)
      throw new PluginCliError("Use either --project or --all.");
    const selected = selection.project ?? callerProject;
    if (!selection.all && selected === undefined)
      throw new PluginCliError("Choose a project with --project or use --all.");
    return Promise.all((await projects(selection.all ? undefined : selected)).map(async (project) => ({
      project, value: await board.read(project.id).catch(() => null),
    })));
  }
  async function actionProject(selected: string | undefined, callerProject: string | undefined) {
    if (selected === undefined && callerProject) return callerProject;
    const matches = await projects(selected);
    if (!matches.length) throw new PluginCliError("No projects.");
    if (matches.length > 1) throw new PluginCliError("Choose a project with --project.");
    return matches[0].id;
  }
  function actionCommand(action: Exclude<keyof LaneActions, "wait">, summary: string) {
    return cliCommand({
      summary,
      options: { project: { type: "string", description: "Project ID or unique name; defaults to the caller's project." },
        ...(action === "stop" ? { reason: { type: "string" as const, description: "two-strikes or time-limit records a policy stop and says why the lane stopped." } } : {}),
      },
      positionals: [{ name: "spec", description: "Spec or work item identifier.", required: true }],
      async run({ options, positionals }, context) {
        try {
          const projectId = await actionProject(options.project, context.projectId);
          if (options.reason !== undefined && options.reason !== "two-strikes" && options.reason !== "time-limit") throw new Error("Stop reason must be two-strikes or time-limit.");
          const result = action === "stop" ? await actions.stop(projectId, positionals.spec, options.reason)
            : await actions[action](projectId, positionals.spec);
          const specId = oneLine(positionals.spec);
          if ("number" in result) return { exitCode: 0, stdout: `Squash-merged PR #${result.number} for ${specId}.\n` };
          const messages = {
            start: `Started ${specId}.`,
            stop: `Asked the Lead for ${specId} to wind down.`,
            resume: `Asked the Lead for ${specId} to carry on from its last summary.`,
            merge: `Asked the Lead for ${specId} to merge locally.`,
          };
          return { exitCode: 0, stdout: `${messages[action]} @thread:${result.threadId}\n` };
        } catch (error) {
          return { exitCode: 1, stderr: `${oneLine(error instanceof Error ? error.message : String(error))}\n` };
        }
      },
    });
  }
  /** A Lead declares what it holds back for, as a fixed control like Stop. */
  function waitCommand() {
    return cliCommand({
      summary: "Declare what this lane is waiting on, such as another lane that holds the same files.",
      options: { project: { type: "string", description: "Project ID or unique name; defaults to the caller's project." },
        on: { type: "string", description: "The lane or reason this lane is waiting on." } },
      positionals: [{ name: "spec", description: "Spec or work item identifier.", required: true }],
      async run({ options, positionals }, context) {
        try {
          const projectId = await actionProject(options.project, context.projectId);
          if (!options.on?.trim()) throw new Error("Say what the lane is waiting on with --on.");
          const result = await actions.wait(projectId, positionals.spec, options.on);
          return { exitCode: 0, stdout: `Recorded that ${oneLine(positionals.spec)} is waiting on ${oneLine(options.on)}. @thread:${result.threadId}\n` };
        } catch (error) {
          return { exitCode: 1, stderr: `${oneLine(error instanceof Error ? error.message : String(error))}\n` };
        }
      },
    });
  }
  function autopilotCommand(action: "on" | "off" | "lanes" | "resume" | "pause") {
    return cliCommand({
      summary: {
        on: "Turn Autopilot on at the owner's request.",
        off: "Turn Autopilot off at the owner's request.",
        pause: "Pause Autopilot at the owner's request.",
        resume: "Resume paused Autopilot at the owner's request.",
        lanes: "Set Autopilot's lane limit at the owner's request.",
      }[action],
      options: { project: { type: "string", description: "Project ID or unique name; defaults to the caller's project." } },
      positionals: action === "lanes" ? [{ name: "count", description: "Whole lane count from 1 to 10." }] : [],
      async run({ options, positionals }, context) {
        try {
          const projectId = await actionProject(options.project, context.projectId);
          if (action === "pause") {
            await autopilot.pause(projectId, "Paused at your request");
            return { exitCode: 0, stdout: "Autopilot paused.\n" };
          }
          if (action === "resume") {
            await autopilot.resume(projectId);
            return { exitCode: 0, stdout: "Autopilot resumed.\n" };
          }
          if (action === "lanes") {
            const laneLimit = Number(positionals.count);
            if (!Number.isInteger(laneLimit) || laneLimit < 1 || laneLimit > 10)
              throw new Error("Choose a whole lane count from 1 to 10.");
            await autopilot.set(projectId, { laneLimit });
            return { exitCode: 0, stdout: `Autopilot lane limit: ${laneLimit}.\n` };
          }
          await autopilot.set(projectId, { status: action });
          return { exitCode: 0, stdout: `Autopilot ${action}.\n` };
        } catch (error) {
          return { exitCode: 1, stderr: `${oneLine(error instanceof Error ? error.message : String(error))}\n` };
        }
      },
    });
  }
  bb.cli.register(defineCli({
    name: "squadron", summary: "See your projects and act on their specs and work items.",
    commands: {
      ...planning.commands,
      ...launch.commands,
      ...helperCommands(helper, (selected) => actionProject(selected, undefined)),
      "autopilot on": autopilotCommand("on"),
      "autopilot off": autopilotCommand("off"),
      "autopilot lanes": autopilotCommand("lanes"),
      "autopilot resume": autopilotCommand("resume"),
      "autopilot pause": autopilotCommand("pause"),
      start: actionCommand("start", "Start a spec or work item."),
      stop: actionCommand("stop", "Ask a spec's Lead to wind down."),
      wait: waitCommand(),
      resume: actionCommand("resume", "Ask a spec's Lead to carry on."),
      merge: actionCommand("merge", "Merge where the board offers Merge. Only the owner's own words approve."),
      report: cliCommand({
        summary: "Show how each ticket went: routes, checks, strikes, escalations and token usage, from existing records.",
        options: {
          project: { type: "string", description: "Project ID or unique name; defaults to the caller's project." },
          since: { type: "string", description: "Only tickets completed on or after this UTC date (YYYY-MM-DD) or ISO date-time." },
          json: { type: "boolean", description: "Print the report as JSON." },
        },
        async run({ options }, context) {
          try {
            const since = options.since === undefined ? null : parseSince(options.since);
            const selected = options.project ?? context.projectId;
            if (selected === undefined) throw new PluginCliError("Choose a project with --project.");
            const [project] = await projects(selected);
            if (!project) throw new PluginCliError(`No project matches "${selected}".`);
            const value = await readRunReport(bb, report, project, { since });
            return { exitCode: 0, stdout: options.json ? `${JSON.stringify(value, null, 2)}\n` : formatRunReport(value) };
          } catch (error) {
            return { exitCode: 1, stderr: `${oneLine(error instanceof Error ? error.message : String(error))}\n` };
          }
        },
      }),
      result: cliCommand({
        summary: "Check a ticket's latest result block, as bb squadron report will read it. Exits non-zero when it is missing or invalid.",
        options: { project: { type: "string", description: "Project ID or unique name; defaults to the caller's project." } },
        positionals: [{ name: "ticket", description: "Ticket or work item identifier.", required: true }],
        async run({ options, positionals }, context) {
          try {
            const selected = options.project ?? context.projectId;
            if (selected === undefined) throw new PluginCliError("Choose a project with --project.");
            const [project] = await projects(selected);
            if (!project) throw new PluginCliError(`No project matches "${selected}".`);
            const checked = await checkTicketResult(report.history, project.id, positionals.ticket);
            return checked.ok ? { exitCode: 0, stdout: checked.text } : { exitCode: 1, stderr: `${oneLine(checked.problem)}\n` };
          } catch (error) {
            return { exitCode: 1, stderr: `${oneLine(error instanceof Error ? error.message : String(error))}\n` };
          }
        },
      }),
      needs: cliCommand({
        summary: "Show what needs you, with links.",
        options,
        async run({ options }, context) {
          const rows = await readProjects(options, context.projectId);
          const lines = rows.map(({ project, value }) => {
            if (!value) return [`${oneLine(project.name)} | Setup | Project | ${unreadable} | ${boardLink(bb)}`];
            return openNeeds(value).map((item) => needLine(project.name, value, item, boardLink(bb)));
          });
          const output = lines.flat();
          return { exitCode: rows.some(({ value }) => incomplete(value)) ? 1 : 0, stdout: output.length ? `${output.join("\n")}\n` : "Nothing needs you.\n" };
        },
      }),
      status: cliCommand({
        summary: "Show your project's progress.",
        options,
        async run({ options }, context) {
          const rows = await readProjects(options, context.projectId);
          const lines = rows.map(({ project, value }) => {
            if (!value) return `${oneLine(project.name)} | Tracker: ${unreadable} | Ready ? | Shaping ? | Flying ? | Landed today ? | Needs you ?`;
            return `${oneLine(project.name)} | Tracker: ${oneLine(value.tracker?.message ?? "Not read yet.")} | Ready ${incomplete(value) ? "?" : value.ready.length} | Shaping ${incomplete(value) ? "?" : value.shaping.length} | Flying ${value.lanes.filter((lane) => lane.state !== "landed").length} | Landed today ${value.lanes.filter((lane) => lane.state === "landed" && lane.landedAt !== undefined && new Date(lane.landedAt).toDateString() === new Date().toDateString()).length} | Needs you ${openNeeds(value).length}`;
          });
          return { exitCode: rows.some(({ value }) => incomplete(value)) ? 1 : 0, stdout: lines.length ? `${lines.join("\n")}\n` : "No projects.\n" };
        },
      }),
    },
  }));
}
