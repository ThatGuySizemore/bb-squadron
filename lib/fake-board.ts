// SYNTHETIC DATA. A simulated factory for the board prototype: specs,
// tickets, threads and PRs here are invented so every state and animation
// can be judged. The live Helper replaces this module.
import type { Board, Lane, ReadySpec, Route, Ticket } from "./board-model.js";
import { canMerge, reviewerFor } from "./board-model.js";

const OPUS: Route = { family: "claude", model: "Opus 5.5", effort: "high" };
const SOL: Route = { family: "gpt", model: "GPT-6.1 Sol", effort: "high" };
const OPUS_MED: Route = { family: "claude", model: "Opus 5.5", effort: "medium" };

/** Scripted moments, keyed by ticket id. */
const SCRIPT: Record<string, { asks?: string; fails?: string }> = {
  "SQD-33": {
    asks: "Linear returns blocking links both ways. Should a spec wait on a blocker from another team, or ignore it?",
  },
  "SQD-17": {
    fails: "The pixel burst test failed twice: the reduced-motion snapshot still shows motion. Two strikes; the lane stopped.",
  },
};

function hash(text: string): number {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Math.abs(h);
}

/** Ticks a ticket spends working before review, 3 to 6. */
function workTicks(id: string): number {
  return 3 + (hash(id) % 4);
}

function ticket(id: string, title: string, route: Route, blockedBy: string[] = [], state: Ticket["state"] = "blocked", minutes = 0): Ticket {
  return { id, title, route, blockedBy, state, minutes };
}

function thread(id: string): string {
  return `thr_demo_${id.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

export function initialBoard(): Board {
  const lane412: Lane = {
    specId: "SQD-12",
    title: "The board shows live lanes",
    lead: OPUS_MED,
    leadThreadId: thread("lead-12"),
    branch: "squadron/sqd-12-live-board",
    state: "flying",
    minutes: 96,
    acceptOwner: false,
    tickets: [
      ticket("SQD-13", "Board page reads lanes from the Helper", SOL, [], "branch", 34),
      ticket("SQD-14", "Sortie line with dependency columns", OPUS, ["SQD-13"], "working", 22),
      ticket("SQD-15", "Ticket card shows thread, AI and time", OPUS, ["SQD-13"], "review", 28),
      ticket("SQD-16", "Needs-you strip with actions", OPUS, ["SQD-14", "SQD-15"]),
      ticket("SQD-17", "Pixel burst when a spec lands", OPUS, ["SQD-16"]),
      ticket("SQD-18", "PR chip reads checks from BB", SOL, ["SQD-16"]),
      ticket("SQD-19", "Ready and Open issues sections", OPUS, ["SQD-17", "SQD-18"]),
      ticket("SQD-20", "Board refetches on board-changed", SOL, ["SQD-19"]),
    ],
  };
  const lane430: Lane = {
    specId: "SQD-30",
    title: "Linear sync with blocking links",
    lead: SOL,
    leadThreadId: thread("lead-30"),
    branch: "squadron/sqd-30-linear-sync",
    state: "flying",
    minutes: 141,
    acceptOwner: true,
    tickets: [
      ticket("SQD-31", "Connect Linear as the Squadron app", SOL, [], "branch", 41),
      ticket("SQD-32", "Mirror issues, sub-issues and relations", SOL, ["SQD-31"], "branch", 52),
      ticket("SQD-33", "Spec waits on open blockers", SOL, ["SQD-32"], "working", 18),
      ticket("SQD-34", "Poll tiers and catch-up on start", SOL, ["SQD-32"], "ready"),
      ticket("SQD-35", "Signed comments per agent", OPUS, ["SQD-31"], "working", 12),
      ticket("SQD-36", "Status moves on lane events", SOL, ["SQD-33", "SQD-35"]),
    ],
  };
  for (const lane of [lane412, lane430]) {
    for (const t of lane.tickets) {
      if (t.state !== "blocked" && t.state !== "ready") t.threadId = thread(t.id);
    }
  }
  const ready: ReadySpec[] = [
    { id: "SQD-40", title: "Plan button starts a planning thread", ticketCount: 5, routes: [OPUS, SOL], blockedBy: [], acceptOwner: false },
    { id: "SQD-50", title: "Doctor checks before Start", ticketCount: 4, routes: [SOL], blockedBy: ["SQD-30"], acceptOwner: false },
    { id: "SQD-60", title: "Routes table chooses each ticket's AI", ticketCount: 6, routes: [SOL, OPUS], blockedBy: [], acceptOwner: true },
  ];
  return {
    tick: 0,
    laneCapacity: 3,
    workersPerLane: 3,
    autoStart: false,
    lanes: [
      lane412,
      lane430,
      {
        specId: "SQD-1",
        title: "Plugin skeleton and settings",
        lead: OPUS_MED,
        leadThreadId: thread("lead-1"),
        branch: "squadron/sqd-1-skeleton",
        state: "landed",
        minutes: 188,
        acceptOwner: false,
        landedAt: Date.now() - 2 * 60 * 60 * 1000,
        pr: { number: 3, checks: "passing", url: "https://github.com/example/bb-squadron/pull/3" },
        tickets: [
          ticket("SQD-2", "Install from a local path", SOL, [], "done", 31),
          ticket("SQD-3", "Settings and secrets", SOL, ["SQD-2"], "done", 44),
          ticket("SQD-4", "Nav page shell", OPUS, ["SQD-2"], "done", 38),
        ],
      },
    ],
    ready,
    openIssues: [
      { id: "SQD-71", title: "Linear webhooks as a speed-up over polling", priority: 3, labels: [] },
      { id: "SQD-72", title: "GitHub Issues as a ticket source", priority: 2, labels: ["v2"] },
      { id: "SQD-73", title: "Retry Linear writes after a rate limit", priority: 2, labels: ["follow-up"] },
      { id: "SQD-74", title: "Time per ticket on the lane header", priority: 4, labels: [] },
      { id: "SQD-75", title: "Auto-start switch remembers per project", priority: 0, labels: [] },
      { id: "SQD-76", title: "Keyboard shortcuts to jump between lanes", priority: 1, labels: ["ui"] },
    ],
  };
}

const MINUTES_PER_TICK = 4;
const progress = new Map<string, number>();

/** Forget simulated progress, so Reset replays the scripted moments. */
export function resetSimulation() {
  progress.clear();
}

function laneTicketsDone(lane: Lane): boolean {
  return lane.tickets.every((t) => t.state === "branch" || t.state === "done");
}

function landedIds(board: Board): Set<string> {
  return new Set(board.lanes.filter((l) => l.state === "landed").map((l) => l.specId));
}

/** One step of the simulated factory. Pure apart from the progress counters. */
export function step(prev: Board): Board {
  const board: Board = structuredClone(prev);
  board.tick += 1;
  for (const lane of board.lanes) {
    if (lane.state === "landed" || lane.state === "stopped" || lane.state === "merge-waits") continue;
    lane.minutes += MINUTES_PER_TICK;
    const counter = (key: string) => {
      const n = (progress.get(key) ?? 0) + 1;
      progress.set(key, n);
      return n;
    };
    if (lane.state === "spec-review") {
      if (counter(`spec:${lane.specId}`) >= 3) {
        lane.state = "pr-open";
        lane.pr = { number: 10 + (hash(lane.specId) % 80), checks: "pending", url: `https://github.com/example/bb-squadron/pull/${10 + (hash(lane.specId) % 80)}` };
      }
      continue;
    }
    if (lane.state === "pr-open" && lane.pr) {
      const n = counter(`pr:${lane.specId}`);
      if (n >= 2) lane.pr.checks = "passing";
      if (n >= 3) {
        if (lane.acceptOwner) lane.state = "merge-waits";
        else land(board, lane);
      }
      continue;
    }
    const states = new Map(lane.tickets.map((t) => [t.id, t.state]));
    let active = lane.tickets.filter((t) => t.state === "working" || t.state === "review" || t.state === "question").length;
    for (const t of lane.tickets) {
      if (t.state === "working") {
        t.minutes += MINUTES_PER_TICK;
        const n = counter(t.id);
        const script = SCRIPT[t.id];
        if (script?.asks && !progress.has(`asked:${t.id}`) && n >= 2) {
          progress.set(`asked:${t.id}`, 1);
          t.state = "question";
          t.question = script.asks;
        } else if (script?.fails && !progress.has(`failed:${t.id}`) && n >= 3) {
          progress.set(`failed:${t.id}`, 1);
          t.state = "failed";
          t.failure = script.fails;
          lane.state = "stopped";
          lane.stopReason = `${t.id}: ${script.fails}`;
        } else if (n >= workTicks(t.id)) {
          t.state = "review";
          progress.set(t.id, 0);
        }
      } else if (t.state === "review") {
        t.minutes += MINUTES_PER_TICK;
        if (counter(`review:${t.id}`) >= 2) t.state = "branch";
      } else if (t.state === "blocked") {
        if (t.blockedBy.every((b) => states.get(b) === "branch" || states.get(b) === "done")) t.state = "ready";
      }
      if (t.state === "ready" && active < board.workersPerLane && lane.state === "flying") {
        t.state = "working";
        t.threadId ??= thread(t.id);
        active += 1;
      }
    }
    if (lane.state === "flying" && laneTicketsDone(lane)) lane.state = "spec-review";
  }
  if (board.autoStart) {
    const next = board.ready.find((s) => canStart(board, s) === null);
    if (next) startSpec(board, next.id);
  }
  return board;
}

function land(board: Board, lane: Lane) {
  lane.state = "landed";
  lane.landedAt = Date.now();
  for (const t of lane.tickets) t.state = "done";
}

function flyingCount(board: Board): number {
  return board.lanes.filter((l) => l.state !== "landed").length;
}

/** Why a ready spec can't start, or null when it can. */
export function canStart(board: Board, spec: ReadySpec): string | null {
  const landed = landedIds(board);
  const open = spec.blockedBy.filter((b) => !landed.has(b));
  if (open.length > 0) return `Waits on ${open.join(", ")}`;
  if (flyingCount(board) >= board.laneCapacity) return `All ${board.laneCapacity} lanes are flying`;
  return null;
}

function startSpec(board: Board, specId: string) {
  const spec = board.ready.find((s) => s.id === specId);
  if (!spec || canStart(board, spec) !== null) return;
  board.ready = board.ready.filter((s) => s.id !== specId);
  const n = Number(spec.id.split("-")[1]);
  const tickets: Ticket[] = Array.from({ length: spec.ticketCount }, (_, i) => {
    const id = `SQD-${n + i + 1}`;
    const route = spec.routes[i % spec.routes.length]!;
    const blockedBy = i === 0 ? [] : i < 3 ? [`SQD-${n + 1}`] : [`SQD-${n + i}`];
    return ticket(id, `${spec.title}: slice ${i + 1}`, route, blockedBy, i === 0 ? "ready" : "blocked");
  });
  board.lanes.splice(flyingCount(board), 0, {
    specId: spec.id,
    title: spec.title,
    lead: spec.routes[0]!,
    leadThreadId: thread(`lead-${n}`),
    branch: `squadron/${spec.id.toLowerCase()}`,
    state: "flying",
    minutes: 0,
    acceptOwner: spec.acceptOwner,
    tickets,
  });
}

export type BoardAction =
  | { type: "start"; specId: string }
  | { type: "answer"; ticketId: string }
  | { type: "resume"; specId: string }
  | { type: "stop"; specId: string }
  | { type: "cancel"; specId: string }
  | { type: "merge"; specId: string }
  | { type: "autoStart"; on: boolean };

export function apply(prev: Board, action: BoardAction): Board {
  const board: Board = structuredClone(prev);
  const lane = "specId" in action ? board.lanes.find((l) => l.specId === action.specId) : undefined;
  switch (action.type) {
    case "start":
      startSpec(board, action.specId);
      break;
    case "answer":
      for (const l of board.lanes) {
        for (const t of l.tickets) {
          if (t.id === action.ticketId && t.state === "question") {
            t.state = "working";
            t.question = undefined;
          }
        }
      }
      break;
    case "resume":
      if (lane?.state === "stopped") {
        lane.state = "flying";
        lane.stopReason = undefined;
        for (const t of lane.tickets) {
          if (t.state === "failed") {
            t.state = "working";
            t.failure = undefined;
            progress.set(t.id, 0);
          }
        }
      }
      break;
    case "stop":
      if (lane && lane.state === "flying") {
        lane.state = "stopped";
        lane.stopReason = "Stopped by you.";
      }
      break;
    case "cancel":
      if (lane && lane.state !== "landed") {
        board.lanes = board.lanes.filter((l) => l !== lane);
        board.ready.unshift({
          id: lane.specId,
          title: lane.title,
          ticketCount: lane.tickets.length,
          routes: [...new Map(lane.tickets.map((t) => [`${t.route.family}${t.route.model}`, t.route])).values()],
          blockedBy: [],
          acceptOwner: lane.acceptOwner,
        });
      }
      break;
    case "merge":
      if (lane && lane.state !== "landed" && canMerge(lane)) land(board, lane);
      break;
    case "autoStart":
      board.autoStart = action.on;
      break;
  }
  return board;
}

export { reviewerFor };
