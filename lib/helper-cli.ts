import { cliCommand, PluginCliError } from "@get-bb/plugin-sdk";
import type { registerHelper } from "./helper.js";

export function helperCommands(helper: ReturnType<typeof registerHelper>) {
  return {
    "helper use": cliCommand({
      summary: "Make this thread the Helper across all projects.",
      async run(_input, context) {
        if (!context.threadId) throw new PluginCliError("Run this command inside the thread you want to use as Helper.");
        const selected = await helper.use(context.threadId);
        return { exitCode: 0, stdout: `Helper: @thread:${selected.threadId}\n` };
      },
    }),
  };
}
