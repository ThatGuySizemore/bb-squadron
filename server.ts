// BB Squadron backend. Feature registrations keep their server state here.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerLinearAuth } from "./lib/linear-auth.js";
import { registerLinearOutbox } from "./lib/linear-outbox.js";
import { registerDoctor } from "./lib/doctor-service.js";

export default async function plugin(bb: BbPluginApi) {
  const linear = registerLinearAuth(bb);
  registerLinearOutbox(bb, linear);
  registerDoctor(bb, () => linear.getConnection());
  bb.log.info("loaded");
}
