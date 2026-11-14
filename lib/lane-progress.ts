import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { LeadThread } from "./lead-threads.js";
import { selectProjectCheckout } from "./project-checkout.js";
import { repositoryHostContract, type RepositoryState } from "./repository-contract.js";
import { localMarkdownHostContract } from "./local-markdown-contract.js";
import type { TrackerSnapshot } from "./tracker-contract.js";

export interface LaneProgress {
  repository?: RepositoryState;
  /** Local integration snapshots keyed by spec's opaque id. Main stays in BoardInput.snapshot. */
  laneSnapshots?: Record<string, TrackerSnapshot>;
}

/** Read-only lane inputs. Git and file reads execute on the project's selected host. */
export async function readLaneProgress(bb: BbPluginApi, snapshot: TrackerSnapshot, leads: LeadThread[], signal?: AbortSignal): Promise<LaneProgress> {
  if (!leads.length) return {};
  const checkout = await selectProjectCheckout(bb, snapshot.bbProjectId, signal);
  if (!checkout) return {};
  const options = { hostId: checkout.hostId, signal, timeoutMs: 15_000 };
  const repository = await bb.hosts.experimental_client({ contract: repositoryHostContract }).call("readRepositoryState",
    { checkoutPath: checkout.path, branches: leads.map((lead) => lead.branch) }, options).catch(() => undefined);
  const laneSnapshots: Record<string, TrackerSnapshot> = {};
  if (snapshot.kind === "local-markdown") {
    const host = bb.hosts.experimental_client({ contract: localMarkdownHostContract });
    for (const lead of leads) {
      if (!lead.branch) continue;
      try {
        laneSnapshots[lead.specId] = await host.call("readLocalMarkdown", { checkoutPath: checkout.path,
          bbProjectId: snapshot.bbProjectId, projectName: snapshot.project?.name ?? "Local markdown", branch: lead.branch }, options);
      } catch { /* An unavailable branch supplies no evidence of ticket progress. */ }
    }
  }
  return { repository, laneSnapshots };
}
