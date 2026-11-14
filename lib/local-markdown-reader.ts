import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { localMarkdownHostContract } from "./local-markdown-contract.js";
import { cachedTrackerReader } from "./tracker-cache.js";

/** The board watcher asks for the selected project's files; reads reuse a 30 s snapshot. */
export function registerLocalMarkdownReader(bb: BbPluginApi, options: { now?: () => number } = {}) {
  const host = bb.hosts.experimental_client({ contract: localMarkdownHostContract });
  return cachedTrackerReader(bb, { kind: "local-markdown", ...options,
    unavailable: "Couldn't read this project's local markdown tracker. Make sure its machine and checkout are available.",
    read: ({ hostId, checkoutPath, bbProjectId, projectName }, signal) => host.call("readLocalMarkdown", { checkoutPath, bbProjectId, projectName },
      { hostId, signal, timeoutMs: 15_000 }),
  });
}
