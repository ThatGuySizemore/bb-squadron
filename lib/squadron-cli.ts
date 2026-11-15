import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { LaneActions } from "./lane-start.js";
import type { Board } from "./board-model.js";
import { helperCommands } from "./helper-cli.js";
import type { registerHelper } from "./helper.js";
import type { AutopilotControls } from "./autopilot.js";
import type { registerPlanning } from "./planning.js";
import { oneLine, openNeeds, needLine, boardLink, unreadableProject as unreadable } from "./project-observation.js";

const incomplete = (board: Board | null) => !board || board.tracker?.state !== "current";

/** Board reads, shared lane and Autopilot controls, and Helper selection. */
export function registerSquadronCli(bb: BbPluginApi, board: { read(projectId: string): Promise<Board> }, actions: LaneActions, helper: ReturnType<typeof registerHelper>, autopilot: AutopilotControls, planning: ReturnType<typeof registerPlanning>) {
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
  function actionCommand(action: keyof LaneActions, summary: string) {
    return cliCommand({
      summary,
      options: { project: { type: "string", description: "Project ID or unique name; defaults to the caller's project." } },
      positionals: [{ name: "spec", description: "Spec or work item identifier.", required: true }],
      async run({ options, positionals }, context) {
        try {
          const projectId = await actionProject(options.project, context.projectId);
          const result = await actions[action](projectId, positionals.spec);
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
      ...helperCommands(helper, (selected) => actionProject(selected, undefined)),
      "autopilot on": autopilotCommand("on"),
      "autopilot off": autopilotCommand("off"),
      "autopilot lanes": autopilotCommand("lanes"),
      "autopilot resume": autopilotCommand("resume"),
      "autopilot pause": autopilotCommand("pause"),
      start: actionCommand("start", "Start a spec or work item."),
      stop: actionCommand("stop", "Ask a spec's Lead to wind down."),
      resume: actionCommand("resume", "Ask a spec's Lead to carry on."),
      merge: actionCommand("merge", "Merge where the board offers Merge. Only the owner's own words approve."),
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
