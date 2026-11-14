// BB Squadron backend. Feature registrations keep their server state here.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerLinearAuth } from "./lib/linear-auth.js";
import { registerLinearOutbox } from "./lib/linear-outbox.js";
import { registerLinearMirror } from "./lib/linear-mirror.js";
import { registerDoctor } from "./lib/doctor-service.js";
import { registerBoard } from "./lib/board-service.js";
import { registerPlanning } from "./lib/planning.js";

export default async function plugin(bb: BbPluginApi) {
  const linear = registerLinearAuth(bb);
  const outbox = registerLinearOutbox(bb, linear);
  const mirror = registerLinearMirror(bb, linear);
  registerDoctor(bb, () => linear.getConnection());
  registerBoard(bb, { connection: () => linear.getConnection(), mirror, writes: (id) => outbox.getHealth(id) });
  registerPlanning(bb, { connection: () => linear.getConnection(), mirror, outbox });
  bb.log.info("loaded");
}
