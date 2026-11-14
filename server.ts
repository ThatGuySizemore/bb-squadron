// BB Squadron backend. Feature registrations keep their server state here.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerLinearAuth } from "./lib/linear-auth.js";
import { registerLinearOutbox } from "./lib/linear-outbox.js";
import { registerLinearMirror } from "./lib/linear-mirror.js";
import { registerDoctor } from "./lib/doctor-service.js";
import { registerBoard } from "./lib/board-service.js";
import { registerPlanning } from "./lib/planning.js";
import { registerWorkers } from "./lib/worker-service.js";
import { registerLanes } from "./lib/lane-service.js";
import { registerSignedCommentAvatars } from "./lib/linear-avatar.js";

export default async function plugin(bb: BbPluginApi) {
  registerSignedCommentAvatars(bb);
  const linear = registerLinearAuth(bb);
  const outbox = registerLinearOutbox(bb, linear);
  const mirror = registerLinearMirror(bb, linear);
  const doctor = registerDoctor(bb, () => linear.getConnection());
  const lanes = registerLanes(bb, { connection: () => linear.getConnection(), mirror, doctor, outbox });
  const workers = registerWorkers(bb, { connection: () => linear.getConnection(), mirror, outbox }, lanes);
  const planning = registerPlanning(bb, { connection: () => linear.getConnection(), mirror, outbox });
  bb.agents.configure((context) => ({
    tools: [...outbox.toolsForThread(context.project.id, context.thread.id), ...workers.toolsForThread(context.project.id, context.thread.id)],
    skills: [...(planning.isBound(context.project.id, context.thread.id) ? ["squadron-planner"] : []), ...workers.skillsForThread(context.project.id, context.thread.id)],
  }));
  registerBoard(bb, { connection: () => linear.getConnection(), mirror, writes: (id) => outbox.getHealth(id), lanes });
  bb.experimental_hooks.on("message.dispatch", (context) => {
    if (context.originPluginId !== bb.pluginId) return { action: "proceed" };
    return workers.canDispatch(context.project.id, context.thread.id) || planning.isBound(context.project.id, context.thread.id)
      ? { action: "proceed" } : { action: "reject", message: "Squadron couldn't confirm this thread's active service binding. Check its lane or planning thread before resuming." };
  });
  bb.log.info("loaded");
}
