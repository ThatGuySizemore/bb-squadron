// Catch up missed BB events. Metadata supplies links; durable records supply authority.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import timers from "node:timers/promises";
import { rebuildLaneLinks } from "./helper-core.js";
import { restartThreadSchema, type RestartThread } from "./restart-contract.js";
import type { LaneService, LaneSources } from "./lane-service.js";
import type { LaneRun } from "./lane-contract.js";
import type { registerWorkers } from "./worker-service.js";
import { pendingBoundPrompt } from "./bound-thread.js";
import { isActiveProjectThread } from "./project-thread.js";
import { diagnostic } from "./diagnostic.js";

type Workers = ReturnType<typeof registerWorkers>;
export function registerRestart(bb: BbPluginApi, sources: Pick<LaneSources, "mirror">, lanes: LaneService, workers: Workers) {
  const lifetime = new AbortController();
  let initial: Promise<void> | undefined;
  let running: Promise<boolean> | undefined;
  let again = false;
  let lastObservations: RestartThread[] = [];
  let lastScanComplete = false;
  // Metadata is mutable and cached only as a hint for this load. Actual
  // membership, parent, environment and status still come from fresh BB rows.
  const metadataCache = new Map<string, Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["getPluginMetadata"]>>>();
  const METADATA_READS_PER_PASS = 200;
  bb.onDispose(async () => { lifetime.abort(); if (running) await Promise.allSettled([running]); });

  async function observe(): Promise<RestartThread[]> {
    const observations: RestartThread[] = [];
    let metadataReads = 0;
    // Include hidden and archived rows; never mistake a truncated list for uniqueness.
    const seen = new Set<string>();
    for (const archived of [false, true]) for (let offset = 0; ; offset += 200) {
      const rows = await bb.sdk.threads.list({ originPluginId: bb.pluginId, archived, includeHidden: true, limit: 200, offset, signal: lifetime.signal });
      lifetime.signal.throwIfAborted();
      for (const thread of rows) {
        if (seen.has(thread.id) || thread.deletedAt !== null || thread.originPluginId !== bb.pluginId) continue;
        seen.add(thread.id);
        if (!metadataCache.has(thread.id)) {
          if (metadataReads >= METADATA_READS_PER_PASS) throw Object.assign(new Error("Thread metadata scan is incomplete."), { name: "RestartScanIncomplete" });
          metadataReads++;
          metadataCache.set(thread.id, await bb.sdk.threads.getPluginMetadata({ threadId: thread.id, signal: lifetime.signal }));
        }
        const metadata = metadataCache.get(thread.id)!;
        const parsed = restartThreadSchema.safeParse({ ...metadata, threadId: thread.id, projectId: thread.projectId,
          parentThreadId: thread.parentThreadId, environmentId: thread.environmentId, branch: thread.environmentBranchName });
        if (parsed.success) observations.push(parsed.data);
      }
      if (rows.length < 200) break;
    }
    for (const id of metadataCache.keys()) if (!seen.has(id)) metadataCache.delete(id);
    return observations;
  }
  function current(run: LaneRun) { return lanes.list(run.bbProjectId).find((item) => item.id === run.id)!; }
  async function observeLead(original: LaneRun) {
    const run = current(original);
    if (run.recoveryOnly || !["starting", "flying"].includes(run.state) || !run.leadThreadId) return;
    try {
      const thread = await bb.sdk.threads.get({ threadId: run.leadThreadId, signal: lifetime.signal });
      if (!isActiveProjectThread(thread, run.leadThreadId, run.bbProjectId) || thread.status === "error") {
        lanes.save({ ...current(run), state: "stopped", startFailure: "lifecycle", stopReason: "The linked Lead failed, stopped or is unavailable. Its branch, progress and lane slot are preserved. Check its thread before resuming." });
      }
    } catch (error) {
      bb.log.warn(`Lane ${run.id} observe-lead: ${diagnostic(error)}`);
      // A failed SDK read isn't evidence that a healthy Lead has stopped.
    }
  }
  async function recoverLead(original: LaneRun, observations: RestartThread[], completeScan: boolean) {
    let run = current(original);
    if (run.recoveryOnly || run.state === "landed" || !(run.state === "starting" || (run.state === "stopped" && ["spawn", "prompt"].includes(run.startFailure ?? "")))) return;
    // An explicit owner stop wins over an interrupted launch.
    if (run.state === "stopped" && run.stoppedAt !== undefined) return;
    if (!run.firstPrompt || run.firstPrompt.released) {
      if (run.state === "starting" && run.leadThreadId) await lanes.reconcileStart(run.id);
      else if (!run.leadThreadId) lanes.save({ ...run, state: "stopped", stopReason: "The Lead identity is unproven. Check BB threads before resuming; the slot stays reserved." });
      return;
    }
    if (!run.leadThreadId) {
      if (!completeScan) return;
      const candidates: string[] = [];
      for (const observation of observations.filter((item) => item.laneId === run.id && item.role === "Lead" && item.specIssueId === run.specIssueId && item.parentThreadId === null)) {
        const thread = await bb.sdk.threads.get({ threadId: observation.threadId, signal: lifetime.signal });
        if (thread.originPluginId === bb.pluginId && isActiveProjectThread(thread, thread.id, run.bbProjectId) && thread.parentThreadId === null &&
          thread.providerId === (run.route.family === "claude" ? "claude-code" : "codex") && await pendingBoundPrompt(bb, thread.id, run.firstPrompt, run.route)) candidates.push(thread.id);
      }
      if (candidates.length !== 1) {
        lanes.save({ ...current(run), state: "stopped", stopReason: `The Lead identity is unproven (${candidates.length} matching pending prompts). Check BB threads before resuming; the slot stays reserved.` });
        return;
      }
      run = { ...current(run), leadThreadId: candidates[0] }; lanes.save(run);
    }
    const thread = await bb.sdk.threads.get({ threadId: run.leadThreadId!, signal: lifetime.signal });
    const row = await pendingBoundPrompt(bb, thread.id, run.firstPrompt!, run.route);
    if (!row || thread.originPluginId !== bb.pluginId || !isActiveProjectThread(thread, run.leadThreadId!, run.bbProjectId) || thread.parentThreadId !== null) {
      lanes.save({ ...current(run), state: "stopped", startFailure: "prompt", stopReason: "The Lead's initial prompt outcome is unproven. Check its queue before resuming; the slot stays reserved." }); return;
    }
    run = { ...current(run), state: "starting", firstPrompt: { ...run.firstPrompt!, queuedMessageId: row.id } };
    delete run.stopReason; delete run.startFailure; lanes.save(run);
    try {
      const result = await bb.sdk.threads.queuedMessages.send({ threadId: thread.id, queuedMessageId: row.id, mode: "auto" });
      run = { ...current(run), firstPrompt: { ...run.firstPrompt!, released: result.delivery === "sent" } }; lanes.save(run);
      if (result.delivery === "sent") await lanes.reconcileStart(run.id);
    } catch (error) {
      lanes.save({ ...current(run), state: "stopped", startFailure: "prompt", stopReason: "The Lead's first prompt could not be confirmed. Its reservation is preserved; check its queue before resuming." });
      bb.log.warn(`Lane ${run.id} recover-prompt: ${diagnostic(error)}`);
    }
  }
  function rebuildLinks(projectId: string) {
    const snapshot = sources.mirror.getSnapshot(projectId);
    if (!lastScanComplete || !snapshot.binding || snapshot.syncedAt === null || snapshot.error) return;
    lanes.replaceRecovered(projectId, rebuildLaneLinks(snapshot, lanes.list(projectId).filter((run) => !run.recoveryOnly || run.state === "canceled"), lastObservations));
  }
  async function pass(): Promise<boolean> {
    let observations = lastObservations;
    try {
      observations = await observe();
      lastObservations = observations; lastScanComplete = true;
    } catch (error) {
      lastScanComplete = false;
      if (!lifetime.signal.aborted) bb.log.warn(`Restart scan: ${diagnostic(error)}`);
    }
    if (lifetime.signal.aborted) return false;
    const completeScan = lastScanComplete;
    const projects = new Set([...lanes.projects(), ...observations.map((thread) => thread.projectId)]);
    for (const projectId of projects) {
      try {
        // Only a complete successful scan may prune disposable observations.
        rebuildLinks(projectId);
        for (const run of lanes.list(projectId).filter((run) => !run.recoveryOnly)) {
          try {
            await lanes.withProject(projectId, () => workers.withLane(run.id, async () => {
              await observeLead(run);
              await recoverLead(run, observations, completeScan);
              const latest = current(run);
              if (latest.state === "flying") await lanes.reconcileStart(run.id);
              await workers.reconcileInLane(projectId, run.id, observations, completeScan);
            }));
          } catch (error) { if (!lifetime.signal.aborted) bb.log.warn(`Lane ${run.id} catch-up: ${diagnostic(error)}`); }
        }
      } catch (error) { if (!lifetime.signal.aborted) bb.log.warn(`Project ${projectId} catch-up: ${diagnostic(error)}`); }
    }
    return completeScan;
  }
  function catchUp(): Promise<boolean> {
    if (running) return running;
    const task = (async () => {
      let complete: boolean;
      do { again = false; complete = await pass(); } while (again && !lifetime.signal.aborted);
      return complete;
    })().finally(() => { running = undefined; });
    running = task; return task;
  }
  // Only the initial scan gates Start. Later failures retain the last links.
  lanes.setRecoveryGate(() => initial ??= catchUp().then((complete) => {
    if (!complete) throw new Error("The initial thread scan is incomplete.");
  }).catch((error) => { initial = undefined; throw error; }), rebuildLinks);
  const schedule = () => { if (running) again = true; void catchUp().catch((error) => { if (!lifetime.signal.aborted) bb.log.warn(`Restart catch-up: ${diagnostic(error)}`); }); };
  if (sources.mirror.onChange) bb.onDispose(sources.mirror.onChange(schedule));
  for (const event of ["thread.created", "thread.active", "thread.idle", "thread.failed", "thread.archived", "thread.unarchived", "thread.deleted"] as const) {
    bb.events.on(event, schedule);
  }
  bb.background.service("restart-catch-up", { start: async (signal) => {
    const stop = AbortSignal.any([signal, lifetime.signal]);
    while (!stop.aborted) {
      try { await catchUp(); }
      catch (error) { if (!stop.aborted) bb.log.warn(`Restart catch-up: ${diagnostic(error)}`); }
      try { await timers.setTimeout(15_000, undefined, { signal: stop }); } catch { return; }
    }
  } });
  return { catchUp };
}
