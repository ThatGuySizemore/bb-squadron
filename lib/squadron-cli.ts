import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { LaneActions } from "./lane-start.js";
import type { Board } from "./board-model.js";
import { helperCommands } from "./helper-cli.js";
import type { registerHelper } from "./helper.js";
import { oneLine, openNeeds, needLine, boardLink, unreadableProject as unreadable } from "./project-observation.js";

const incomplete = (board: Board | null) => !board || board.tracker?.state !== "current";

/** One command table for board reads, shared lane actions and Helper selection. */
export function registerSquadronCli(bb: BbPluginApi, board: { read(projectId: string): Promise<Board> }, actions: LaneActions, helper: ReturnType<typeof registerHelper>) {
  const options = { project: { type: "string", description: "Narrow to a project ID or unique name; otherwise show all projects." } } as const;
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
  async function readProjects(selected?: string) {
    return Promise.all((await projects(selected)).map(async (project) => ({
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
      positionals: [{ name: "spec", description: "Spec identifier.", required: true }],
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
  bb.cli.register(defineCli({
    name: "squadron", summary: "See your projects and act on their specs.",
    commands: {
      ...helperCommands(helper),
      start: actionCommand("start", "Start a spec's Lead."),
      stop: actionCommand("stop", "Ask a spec's Lead to wind down."),
      resume: actionCommand("resume", "Ask a spec's Lead to carry on."),
      merge: actionCommand("merge", "Merge where the board offers Merge. Only the owner's own words approve."),
      needs: cliCommand({
        summary: "Show what needs you, with links.",
        options,
        async run({ options }) {
          const rows = await readProjects(options.project);
          const lines = rows.map(({ project, value }) => {
            if (!value) return [`${oneLine(project.name)} | Setup | Project | ${unreadable} | ${boardLink(bb)}`];
            return openNeeds(value).map((item) => needLine(project.name, value, item, boardLink(bb)));
          });
          const output = lines.flat();
          return { exitCode: rows.some(({ value }) => incomplete(value)) ? 1 : 0, stdout: output.length ? `${output.join("\n")}\n` : "Nothing needs you.\n" };
        },
      }),
      status: cliCommand({
        summary: "Show every project's progress.",
        options,
        async run({ options }) {
          const rows = await readProjects(options.project);
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
