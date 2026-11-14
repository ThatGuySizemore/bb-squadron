import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { laneContract } from "./lane-contract.js";
import { deriveBoard } from "./board-derive.js";
import { readLeadThreads } from "./lead-threads.js";
import { readProjectCheckout } from "./project-checkout.js";
import { resolveRoute } from "./squadron-settings.js";
import type { DoctorReport } from "./doctor.js";
import type { MirrorSnapshot } from "./linear-mirror-contract.js";
import { boardChanged, publishSquadronSignal } from "./realtime-contract.js";

export function registerLaneStart(bb: BbPluginApi, sources: {
  mirror: { getSnapshot(projectId: string): MirrorSnapshot };
  doctor(projectId: string): Promise<DoctorReport>;
}) {
  const starting = new Map<string, Promise<{ threadId: string }>>();
  async function start(projectId: string, specId: string) {
    const snapshot = sources.mirror.getSnapshot(projectId);
    const leads = await readLeadThreads(bb, projectId);
    const spec = snapshot.issues.find((issue) => issue.identifier === specId && issue.inProject);
    const existing = spec && leads.find((lead) => lead.specId === spec.id);
    if (existing) return { threadId: existing.thread.id };
    const checkout = await readProjectCheckout(bb, projectId);
    if (!checkout) throw new Error("This BB project has no default checkout to start a lane in.");
    const doctor = await sources.doctor(projectId);
    const { board } = deriveBoard({ snapshot, leads, settings: checkout.settings, doctor,
      connection: { status: "connected", message: "" }, now: Date.now() });
    const ready = board.ready.find((row) => row.id === specId);
    if (!ready || !spec) throw new Error(`${specId} isn't a ready spec in this project's Linear project. Read the board again.`);
    if (ready.startReason) throw new Error(ready.startReason);
    if (!checkout.settings?.ok) throw new Error("Fix docs/agents/squadron.md, then try Start again.");
    const route = resolveRoute(checkout.settings.settings, spec.labels.map((label) => label.name));
    const ownerPath = (id: "playbook" | "machine-profile") => doctor.configurationFiles.find((file) => file.id === id)?.path;
    const thread = await bb.sdk.threads.spawn({
      projectId, title: `Lead ${spec.identifier}`, visibility: "visible",
      providerId: route.family === "claude" ? "claude-code" : "codex", model: route.model, reasoningLevel: route.effort, serviceTier: "default",
      pluginMetadata: { role: "lead", specId: spec.id },
      environment: { type: "host", hostId: checkout.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
      prompt: ["Use the squadron-lead skill for this spec.", "", `Spec: ${spec.url}`,
        "Repo rules: AGENTS.md and docs/agents/", "Project settings: docs/agents/squadron.md",
        `Playbook: ${ownerPath("playbook") ?? "~/.bb-squadron/playbook.md"}`,
        `Machine profile: ${ownerPath("machine-profile") ?? "~/.bb-squadron/machine.md"}`,
      ].join("\n"),
    });
    publishSquadronSignal(bb.realtime, boardChanged, { projectId });
    return { threadId: thread.id };
  }
  bb.rpc.register(laneContract, {
    "lane.start": ({ projectId, specId }, context) => {
      if (context.experimental_caller.kind !== "client") throw new Error("Start a lane from the Squadron board.");
      const key = JSON.stringify([projectId, specId]);
      let running = starting.get(key);
      if (!running) {
        running = start(projectId, specId).finally(() => { starting.delete(key); });
        starting.set(key, running);
      }
      return running;
    },
  });
}
