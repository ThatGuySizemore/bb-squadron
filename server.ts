// BB Squadron: backend entry. The Helper (Linear sync, lanes, Linear writes)
// lands here in the build tickets. For the board prototype it only loads.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded (board prototype, synthetic data)");
}
