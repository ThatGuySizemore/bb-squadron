// BB Squadron backend. Feature registrations keep their server state here.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerAutopilot } from "./lib/autopilot.js";
import { registerLinearAuth } from "./lib/linear-auth.js";
import { registerLinearReader } from "./lib/linear-reader.js";
import { registerDoctor } from "./lib/doctor-service.js";
import { registerBoard } from "./lib/board-service.js";
import { readPlanningThreads, registerPlanning } from "./lib/planning.js";
import { registerLaneStart } from "./lib/lane-start.js";
import { readLeadThreads } from "./lib/lead-threads.js";
import { readPullRequests } from "./lib/pull-requests.js";
import { registerTracker } from "./lib/tracker-service.js";
import { createOutsideLaneReader } from "./lib/outside-lanes.js";
import { registerSquadronCli } from "./lib/squadron-cli.js";
import { registerLaunch } from "./lib/launch-cli.js";
import { registerHelperNotifier } from "./lib/helper-notifier.js";
import { registerHelperSummary } from "./lib/helper-summary.js";
import { registerHelper } from "./lib/helper.js";
import { createTicketHistoryReader } from "./lib/ticket-history.js";
import { registerCheckpoint } from "./lib/checkpoint.js";
import { liveCleanUp } from "./lib/lane-cleanup.js";
import { readProjectCheckout } from "./lib/project-checkout.js";

export default async function plugin(bb: BbPluginApi) {
  const autopilot = await registerAutopilot(bb);
  const linear = registerLinearAuth(bb);
  const mirror = registerLinearReader(bb, linear, {
    shouldPoll: (projectId) => board.isShown(projectId),
    laneSpecIds: async (projectId) => (await readLeadThreads(bb, projectId)).map((lead) => lead.specId) });
  const connection = (projectId: string) => linear.getConnection(mirror.getSnapshot(projectId).syncedAt);
  const doctor = registerDoctor(bb, connection, (projectId) => mirror.scopeProblem(projectId));
  const tracker = registerTracker(bb, mirror);
  const outside = createOutsideLaneReader(bb);
  const helper = registerHelper(bb);
  const notifier = registerHelperNotifier(bb, helper);
  const summary = registerHelperSummary(bb, helper);
  const history = createTicketHistoryReader(linear, tracker);
  // The House rules Checkpoint as Doctor and Start resolve it; unreadable settings leave it unknown.
  const checkpointSetting = async (projectId: string, signal?: AbortSignal) => {
    const settings = (await readProjectCheckout(bb, projectId, signal))?.settings;
    return settings?.ok ? settings.settings.policy.checkpoint : "unknown" as const;
  };
  const checkpoint = registerCheckpoint(bb, { notifier, history, checkpoint: checkpointSetting });
  const lanes = registerLaneStart(bb, { tracker, doctor: doctor.read, outside, onAction: mirror.resetCadence });
  const board = registerBoard(bb, { autopilot, startLane: lanes.startAutomatic, connection,
    observed: async (...args) => { await notifier.observe(...args); await summary.observe(...args); checkpoint.observe(args[0], args[1]); },
    tracker, doctor: doctor.read, leads: (projectId) => readLeadThreads(bb, projectId),
    planning: (projectId) => readPlanningThreads(bb, projectId),
    pullRequests: (environmentIds, signal) => readPullRequests(bb, environmentIds, signal), outside,
    cleanUp: liveCleanUp(bb) });
  summary.register(board.read);
  const planning = registerPlanning(bb, { tracker, doctor: doctor.read, onAction: mirror.resetCadence });
  registerSquadronCli(bb, board, lanes, helper, autopilot, planning, registerLaunch(bb, tracker), { history, checkpoint: checkpointSetting });
  bb.log.info("loaded");
}
