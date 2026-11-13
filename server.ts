// BB Squadron backend. Feature registrations keep their server state here.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerLinearAuth } from "./lib/linear-auth.js";
import { registerLinearOutbox } from "./lib/linear-outbox.js";

export default async function plugin(bb: BbPluginApi) {
  const linear = registerLinearAuth(bb);
  registerLinearOutbox(bb, linear);
  bb.log.info("loaded");
}
