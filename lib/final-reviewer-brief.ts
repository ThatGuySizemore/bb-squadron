// The final-review lines in Start briefs. They name the one launch command and the same resolver
// the board and squadron launch use, so every surface agrees on the reviewer.
import { finalReviewTickets } from "./board-derive.js";
import { chooseFinalReviewer } from "./final-reviewer.js";
import type { LaunchRoute } from "./launch-route.js";
import type { ProviderModels } from "./model-capabilities.js";
import { familyForProvider, type SquadronSettings } from "./squadron-settings.js";
import type { TrackerIssue, TrackerSnapshot } from "./tracker-contract.js";

const LAUNCH = "`bb squadron launch final-review --base-branch <branch> --prompt-stdin`";

/** A Lead's line: the same for every spec, so Autopilot and the owner send one first message. */
export function leadFinalReviewLine(settings: SquadronSettings): string {
  const chosen = settings.finalReviewFamily === "same"
    ? "Final review is same, so it runs on your own route"
    : "It runs on the Review of <provider> route above for the family that built the most integrated tickets, never your own family by default";
  return `Final review: once every ticket is integrated, launch it once with ${LAUNCH}. ${chosen}, and it prints which work the reviewer is independent of.`;
}

/** A work item's line: its own thread builds it, so its route already decides the reviewer. */
export function workItemFinalReviewLine(settings: SquadronSettings, item: TrackerIssue, snapshot: TrackerSnapshot, own: LaunchRoute,
  catalog: readonly ProviderModels[]): string {
  const choice = chooseFinalReviewer(settings, {
    lead: { family: familyForProvider(own.providerId ?? ""), model: own.model ?? "BB's default model", effort: own.effort },
    tickets: finalReviewTickets(item, snapshot, settings, true), launches: [], projectRoutes: true, catalog });
  const projected = choice.route ? choice.statement.replace(/^Final review: /, "") : choice.problem ?? choice.statement;
  return `Launch it once with ${LAUNCH}; it chooses the review route from this lane's recorded builders and prints which work the reviewer is independent of. From today's route: ${projected}`;
}
