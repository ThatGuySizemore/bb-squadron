import { cliCommand, PluginCliError } from "@get-bb/plugin-sdk";
import type { registerHelper } from "./helper.js";

export function helperCommands(helper: ReturnType<typeof registerHelper>, resolveProject: (selected: string) => Promise<string>) {
  return {
    "helper use": cliCommand({
      summary: "Make this thread the Helper for its project.",
      options: { project: { type: "string", description: "Project ID or unique name; defaults to this thread's own project." } },
      async run({ options }, context) {
        if (!context.threadId) throw new PluginCliError("Run this command inside the thread you want to use as Helper.");
        const projectId = options.project === undefined ? undefined : await resolveProject(options.project);
        const selected = await helper.use(context.threadId, projectId);
        return { exitCode: 0, stdout: `Helper: @thread:${selected.threadId}\n` };
      },
    }),
  };
}
