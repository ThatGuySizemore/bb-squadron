import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { githubHostContract } from "./github-contract.js";
import { cachedTrackerReader } from "./tracker-cache.js";

/** No background poller: reads follow requests from the board's watcher. */
export function registerGithubReader(bb: BbPluginApi, options: { now?: () => number } = {}) {
  const host = bb.hosts.experimental_client({ contract: githubHostContract });
  return cachedTrackerReader(bb, { kind: "github", ...options,
    unavailable: "Couldn't read GitHub issues. Check this repo's machine and gh login, then try again.",
    read: ({ hostId, checkoutPath, bbProjectId }, signal) => host.call("githubRead", { checkoutPath, bbProjectId },
      { hostId, signal, timeoutMs: 90_000 }),
  });
}
