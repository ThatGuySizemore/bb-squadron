// BB Squadron backend. Feature registrations keep their server state here.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerLinearAuth } from "./lib/linear-auth.js";
import { registerLinearReader } from "./lib/linear-reader.js";
import { registerDoctor } from "./lib/doctor-service.js";
import { registerBoard } from "./lib/board-service.js";
import { registerPlanning } from "./lib/planning.js";

export default async function plugin(bb: BbPluginApi) {
  const linear = registerLinearAuth(bb);
  const mirror = registerLinearReader(bb, linear);
  registerDoctor(bb, () => linear.getConnection());
  registerBoard(bb, { connection: () => linear.getConnection(), mirror });
  registerPlanning(bb, { mirror });
  bb.log.info("loaded");
}
