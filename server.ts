// BB Squadron backend. Feature registrations keep their server state here.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerLinearAuth } from "./lib/linear-auth.js";
import { registerLinearMirror } from "./lib/linear-mirror.js";
import { registerDoctor } from "./lib/doctor-service.js";
import { registerBoard } from "./lib/board-service.js";

export default async function plugin(bb: BbPluginApi) {
  const linear = registerLinearAuth(bb);
  const mirror = registerLinearMirror(bb, linear);
  registerDoctor(bb, () => linear.getConnection());
  registerBoard(bb, { connection: () => linear.getConnection(), mirror });
  bb.log.info("loaded");
}
