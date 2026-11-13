// BB Squadron backend. Feature registrations keep their server state here.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerLinearAuth } from "./lib/linear-auth.js";

export default async function plugin(bb: BbPluginApi) {
  registerLinearAuth(bb);
  bb.log.info("loaded");
}
