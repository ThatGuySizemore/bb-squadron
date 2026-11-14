// BB Squadron backend. Feature registrations keep their server state here.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerLinearAuth } from "./lib/linear-auth.js";
import { registerLinearReader } from "./lib/linear-reader.js";
import { registerDoctor } from "./lib/doctor-service.js";
import { registerBoard } from "./lib/board-service.js";
import { registerPlanning } from "./lib/planning.js";
import { registerLaneStart } from "./lib/lane-start.js";
import { readLeadThreads } from "./lib/lead-threads.js";
import { readPullRequests } from "./lib/pull-requests.js";

export default async function plugin(bb: BbPluginApi) {
  const linear = registerLinearAuth(bb);
  const mirror = registerLinearReader(bb, linear, {
    laneSpecIds: async (projectId) => (await readLeadThreads(bb, projectId)).map((lead) => lead.specId) });
  const doctor = registerDoctor(bb, () => linear.getConnection());
  registerBoard(bb, { connection: () => linear.getConnection(), mirror, doctor: doctor.read, leads: (projectId) => readLeadThreads(bb, projectId),
    pullRequests: (environmentIds, signal) => readPullRequests(bb, environmentIds, signal) });
  registerPlanning(bb, { mirror });
  registerLaneStart(bb, { mirror, doctor: doctor.read });
  bb.log.info("loaded");
}
