import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { needsYou, type Board, type NeedsYouItem, type NeedsYouKind } from "./board-model.js";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const unreadable = "Couldn't read this project. Make sure its machine is online.";

const kindNames: Record<NeedsYouKind, string> = {
  setup: "Setup", waiting: "Question", failed: "Stopped", blocked: "Stopped", stopped: "Stopped", merge: "Merge waiting",
};

function openNeeds(board: Board): NeedsYouItem[] {
  const items = needsYou(board);
  // A failed read can't establish that Needs you is empty. Keep its safe tracker message.
  if (board.tracker?.state === "failed" && !items.some((item) => item.text === board.tracker!.message)) {
    items.unshift({ key: "tracker", kind: "setup", specId: "", text: board.tracker.message, threadId: null });
  }
  return items;
}

const incomplete = (board: Board | null) => !board || board.tracker?.state !== "current";

/** Register once; later Helper and lane commands belong in this same command table. */
export function registerSquadronCli(bb: BbPluginApi, board: { read(projectId: string): Promise<Board> }) {
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
  const boardLink = () => `${bb.server.experimental_appUrl?.replace(/\/$/, "") ?? ""}/plugins/squadron/board`;
  bb.cli.register(defineCli({
    name: "squadron", summary: "See your projects and what needs you.",
    commands: {
      needs: cliCommand({
        summary: "Show what needs you, with links.",
        options,
        async run({ options }) {
          const rows = await readProjects(options.project);
          const lines = rows.map(({ project, value }) => {
            if (!value) return [`${oneLine(project.name)} | Setup | Project | ${unreadable} | ${boardLink()}`];
            return openNeeds(value).map((item) => {
              const lane = value.lanes.find((lane) => lane.specId === item.specId);
              const text = item.kind === "merge" ? item.localMerge
                ? "The tickets are ready and wait for your local merge."
                : `PR #${lane?.pr?.number} passed its checks and waits for your merge.` : item.text;
              const link = item.kind === "merge" && lane?.pr ? lane.pr.url
                : item.threadId ? `@thread:${item.threadId}` : boardLink();
              return `${oneLine(project.name)} | ${kindNames[item.kind]} | ${(item.ticketId ?? item.specId) || "Project"} | ${oneLine(text)} | ${link}`;
            });
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
