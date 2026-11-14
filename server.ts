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
import { registerHelperNotifier } from "./lib/helper-notifier.js";
import { registerHelperSummary } from "./lib/helper-summary.js";
import { registerHelper } from "./lib/helper.js";

export default async function plugin(bb: BbPluginApi) {
  const autopilot = await registerAutopilot(bb);
  const linear = registerLinearAuth(bb);
  const mirror = registerLinearReader(bb, linear, {
    shouldPoll: (projectId) => board.isShown(projectId),
    laneSpecIds: async (projectId) => (await readLeadThreads(bb, projectId)).map((lead) => lead.specId) });
  const doctor = registerDoctor(bb, () => linear.getConnection(), (projectId) => mirror.scopeProblem(projectId));
  const tracker = registerTracker(bb, mirror);
  const outside = createOutsideLaneReader(bb);
  const helper = registerHelper(bb);
  // SQD-232 replaces this temporary compatibility adapter with project delivery.
  const legacyHelper = { read: helper.readLegacy };
  const notifier = registerHelperNotifier(bb, legacyHelper);
  const summary = registerHelperSummary(bb, legacyHelper);
  const lanes = registerLaneStart(bb, { tracker, doctor: doctor.read, outside });
  const board = registerBoard(bb, { autopilot, startLane: lanes.startAutomatic, connection: () => linear.getConnection(),
    observed: async (...args) => { await notifier.observe(...args); await summary.observe(...args); },
    tracker, doctor: doctor.read, leads: (projectId) => readLeadThreads(bb, projectId),
    planning: (projectId) => readPlanningThreads(bb, projectId),
    pullRequests: (environmentIds, signal) => readPullRequests(bb, environmentIds, signal), outside });
  summary.register(board.read);
  registerPlanning(bb, { tracker, doctor: doctor.read });
  registerSquadronCli(bb, board, lanes, helper, autopilot);
  bb.log.info("loaded");
}
