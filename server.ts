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

export default async function plugin(bb: BbPluginApi) {
  const autopilot = await registerAutopilot(bb);
  const linear = registerLinearAuth(bb);
  // The existing Linear poller follows shown boards and projects with Autopilot on.
  let shown: (projectId: string) => boolean = () => false;
  const mirror = registerLinearReader(bb, linear, {
    laneSpecIds: async (projectId) => (await readLeadThreads(bb, projectId)).map((lead) => lead.specId),
    shouldPoll: (projectId) => shown(projectId) || autopilot.isEnabled(projectId) });
  const doctor = registerDoctor(bb, () => linear.getConnection(), (projectId) => mirror.scopeProblem(projectId));
  const tracker = registerTracker(bb, mirror);
  const outside = createOutsideLaneReader(bb);
  const lanes = registerLaneStart(bb, { tracker, doctor: doctor.read, outside });
  const board = registerBoard(bb, { autopilot, startLane: lanes.start, connection: () => linear.getConnection(), tracker, doctor: doctor.read, leads: (projectId) => readLeadThreads(bb, projectId),
    planning: (projectId) => readPlanningThreads(bb, projectId),
    pullRequests: (environmentIds, signal) => readPullRequests(bb, environmentIds, signal), outside });
  shown = board.isShown;
  registerPlanning(bb, { tracker, doctor: doctor.read });
  bb.log.info("loaded");
}
