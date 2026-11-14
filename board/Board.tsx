import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { experimental_ProviderIcon as ProviderIcon, experimental_useProviders as useProviders, useBbContext, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Board, Lane, LaneState, NeedsYouItem, PullRequest, ReadySpec, Route, ShapingSpec, Ticket, TicketState, OpenIssue } from "../lib/board-model.js";
import { canMerge, dependencyColumns, formatMinutes, needsYou, nextLandings, reviewerFor, type Landings } from "../lib/board-model.js";
import type { boardContract, PickerProjects } from "../lib/board-contract.js";
import { boardChanged, linearConnectionChanged } from "../lib/realtime-contract.js";
import { useSquadronSignal } from "../hooks/use-squadron-signal.js";
import type { PlanningStarted, planningContract, setupContract } from "../lib/planning-contract.js";
import type { laneContract } from "../lib/lane-contract.js";
import { apply, canStart, initialBoard, resetSimulation, step } from "../lib/fake-board.js";
import type { BoardAction } from "../lib/fake-board.js";
import { DITHER_VARS, layoutPixels } from "../lib/pixels.js";
import { DitherCanvas } from "./DitherCanvas.js";
import { BindProject } from "./BindProject.js";
import { DoctorPanel } from "./Doctor.js";
import { currentProject, fleetFlying, ProjectButton, ProjectListLoader } from "./ProjectPicker.js";
import type { ProjectCounts } from "../lib/board-contract.js";

// ---------- pixel primitives ----------

function PixelText({ text, cell = 3, gap, className }: { text: string; cell?: number; gap?: number; className?: string }) {
  gap ??= cell >= 3 ? 1 : 0;
  const run = useMemo(() => layoutPixels(text), [text]);
  const pitch = cell + gap;
  return (
    <span className={className}>
      <svg
        aria-hidden="true"
        width={run.width * pitch - gap}
        height={run.height * pitch - gap}
        viewBox={`0 0 ${run.width * pitch - gap} ${run.height * pitch - gap}`}
        shapeRendering="crispEdges"
        className="sq-pixeltext"
      >
        {run.cells.map(([x, y]) => (
          <rect key={`${x}.${y}`} x={x * pitch} y={y * pitch} width={cell} height={cell} />
        ))}
      </svg>
      <span className="sq-sr">{text}</span>
    </span>
  );
}

/** The header's formation mark: one chevron per lane flying, drawn by the dither renderer. */
function FormationMark({ flying, label }: { flying: number; label: string }) {
  return <DitherCanvas fx={{ kind: "formation", flying }} className="sq-formation" label={label} />;
}

// ---------- small parts ----------

function AiChip({ route, prefix }: { route: Route; prefix?: string }) {
  const { providers } = useProviders();
  const id = route.family === "claude" ? "claude-code" : "codex";
  const provider = providers.find((p) => p.id === id) ?? { id };
  return (
    <span className="sq-ai" title={`${route.family === "claude" ? "Claude Code" : "Codex"} · ${route.model} · ${route.effort} effort`}>
      <ProviderIcon providerKind="agent" provider={provider} />
      <span>
        {prefix ? `${prefix} · ` : ""}
        {route.model}
        <span className="sq-ai-effort"> {route.effort === "high" ? "high" : "med"}</span>
      </span>
    </span>
  );
}

function Btn({ children, onClick, tone = "plain", disabled, title }: { children: ReactNode; onClick?: () => void; tone?: "plain" | "primary" | "amber" | "danger"; disabled?: boolean; title?: string }) {
  return (
    <button type="button" className="sq-btn" data-tone={tone} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

const PRIORITY_LABEL = ["No priority", "Urgent", "High", "Medium", "Low"] as const;

function PriorityDot({ priority }: { priority: NonNullable<OpenIssue["priority"]> }) {
  const filled = priority === 1 ? 3 : priority === 0 ? 0 : 5 - priority;
  return (
    <span className="sq-priority" data-priority={priority} title={PRIORITY_LABEL[priority]}>
      {priority === 1 ? (
        <span className="sq-priority-urgent" aria-hidden="true" />
      ) : (
        [0, 1, 2].map((i) => <span key={i} aria-hidden="true" data-on={i < filled} />)
      )}
      <span className="sq-sr">{PRIORITY_LABEL[priority]}</span>
    </span>
  );
}

const TICKET_LABEL: Record<TicketState, string> = {
  blocked: "Waiting",
  ready: "Ready",
  working: "Working",
  question: "Needs you",
  review: "In review",
  branch: "In branch",
  failed: "Stopped",
  done: "Done",
};

const LANE_LABEL: Record<LaneState, string> = {
  flying: "Flying",
  stopped: "Stopped",
  "spec-review": "Spec review",
  "pr-open": "In review",
  "merge-waits": "Merge waits on you",
  landed: "Landed",
};

// ---------- navigation ----------

function useOpen() {
  const navigate = useBbNavigate();
  return {
    thread(threadId: string, label: string) {
      if (threadId.startsWith("thr_demo_")) toast(`Prototype: opens ${label} beside the board.`);
      else navigate.toThread(threadId, { split: true });
    },
    external(url: string, label: string) {
      if (url.includes("example")) toast(`Prototype: opens ${label}.`);
      else if (!navigate.openUrl(url)) toast(`Couldn't open ${label}.`);
    },
  };
}

// ---------- the board ----------

/** The settings' reviewer on a live lane; the demo pairs the other family from its own routes. */
function laneReviewer(lane: Lane): Route {
  return lane.reviewer ?? reviewerFor(lane.lead, "other", lane.tickets.map((t) => t.route));
}

const PR_CHECKS: Record<PullRequest["checks"], string> = {
  passing: "checks pass", failing: "checks fail", pending: "checks running", none: "no checks", unknown: "checks unknown",
};

function Peg({ ticket, lane }: { ticket: Ticket; lane: Lane }) {
  const open = useOpen();
  const reviewer = laneReviewer(lane);
  const state = ticket.state;
  const fill = state === "blocked" || state === "ready" ? null : <DitherCanvas fx={{ kind: "peg", state }} className="sq-fx" />;
  const waitsOn = ticket.blockedBy.filter((b) => {
    const blocker = lane.tickets.find((t) => t.id === b);
    return !blocker || (blocker.state !== "branch" && blocker.state !== "done");
  });
  const sub =
    state === "blocked"
      ? "Waiting"
      : state === "review"
        ? `Review · ${reviewer.model}`
        : TICKET_LABEL[state];
  const clickable = Boolean(ticket.threadId);
  const size = state === "branch" || state === "done" ? "compact" : state === "blocked" ? "slim" : "full";
  if (size === "compact") {
    const inner = (
      <>
        {fill}
        <span className="sq-peg-id">{ticket.id}</span>
        <span className="sq-peg-state">{TICKET_LABEL[state]}</span>
      </>
    );
    const label = `${ticket.id}, ${ticket.title}: ${TICKET_LABEL[state]}`;
    return clickable ? (
      <button type="button" className="sq-peg" data-size="compact" data-state={state} title={ticket.title} aria-label={`${label}. Open thread.`} onClick={() => open.thread(ticket.threadId!, `the worker thread for ${ticket.id}`)}>
        {inner}
      </button>
    ) : (
      <div className="sq-peg" data-size="compact" data-state={state} title={ticket.title} aria-label={label}>
        {inner}
      </div>
    );
  }
  const body = (
    <>
      {fill}
      <span className="sq-peg-top">
        <span className="sq-peg-id">{ticket.id}</span>
        <span className="sq-peg-state">{sub}</span>
      </span>
      {state === "blocked" && waitsOn.length > 0 ? <span className="sq-peg-after sq-num">after {waitsOn.join(", ")}</span> : null}
      <span className="sq-peg-title">{ticket.title}</span>
      <span className="sq-peg-foot">
        <AiChip route={state === "review" ? reviewer : ticket.route} />
        {ticket.minutes > 0 ? <span className="sq-num">{formatMinutes(ticket.minutes)}</span> : null}
      </span>
    </>
  );
  return clickable ? (
    <button
      type="button"
      className="sq-peg"
      data-size={size}
      data-state={state}
      onClick={() => open.thread(ticket.threadId!, `the ${state === "review" ? "reviewer" : "worker"} thread for ${ticket.id}`)}
      aria-label={`${ticket.id}, ${ticket.title}: ${sub}. Open thread.`}
    >
      {body}
    </button>
  ) : (
    <div className="sq-peg" data-size={size} data-state={state} aria-label={`${ticket.id}, ${ticket.title}: ${state === "blocked" && waitsOn.length > 0 ? `waits on ${waitsOn.join(", ")}` : sub}`}>
      {body}
    </div>
  );
}

function useOverflow<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollWidth - el.clientWidth - el.scrollLeft > 4);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener("scroll", check, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", check);
    };
  });
  return [ref, overflow] as const;
}

/** A Stop or Resume on its way to the Lead, or a Merge on its way to the pull-request plugin. */
export interface LaneAction { specId: string; type: "stop" | "resume" | "merge" }

const LANE_ACTION_LABEL: Record<LaneAction["type"], string> = { stop: "Stop", resume: "Resume", merge: "Merge" };
const LANE_ACTION_PENDING: Record<LaneAction["type"], string> = { stop: "Stopping…", resume: "Resuming…", merge: "Merging…" };
const LANE_ACTION_STATUS: Record<LaneAction["type"], string> = {
  stop: "Asking the Lead to wind down",
  resume: "Asking the Lead to carry on",
  merge: "Squash-merging the PR",
};

/** Stop, Resume or Merge, disabled while any lane action is on its way. */
function LaneActionButton({ type, specId, acting, tone, dispatch }: {
  type: LaneAction["type"]; specId: string; acting: LaneAction | null; tone: "plain" | "primary" | "amber"; dispatch: (a: BoardAction) => void;
}) {
  const mine = acting?.specId === specId;
  return (
    <>
      {mine && acting.type === type ? <span className="sq-plan-why" role="status">{LANE_ACTION_STATUS[type]}</span> : null}
      <Btn tone={tone} disabled={acting !== null} onClick={() => dispatch({ type, specId })}>
        {mine && acting.type === type ? LANE_ACTION_PENDING[type] : LANE_ACTION_LABEL[type]}
      </Btn>
    </>
  );
}

function SortieLine({ lane, dispatch, landing, demo, acting = null }: { lane: Lane; dispatch: (a: BoardAction) => void; landing: boolean; demo: boolean; acting?: LaneAction | null }) {
  const open = useOpen();
  const stopped = lane.stopped ?? lane.state === "stopped";
  const columns = useMemo(() => dependencyColumns(lane.tickets), [lane.tickets]);
  const done = lane.tickets.filter((t) => t.state === "branch" || t.state === "done").length;
  // The airstream's pace: the lane's working threads. A lane with none working is still.
  const working = lane.tickets.filter((t) => t.state === "working").length;
  const [railRef, overflow] = useOverflow<HTMLDivElement>();
  return (
    <article className="sq-line" data-lane={lane.state} aria-label={`${lane.specId}, ${lane.title}: ${LANE_LABEL[lane.state]}`}>
      <div className="sq-tail">
        <PixelText text={lane.specId} cell={4} className="sq-tail-number" />
        <h3 className="sq-line-title">
          {lane.url ? (
            <button type="button" className="sq-issue-link" title="Open the spec in Linear" onClick={() => open.external(lane.url!, `${lane.specId} in Linear`)}>
              {lane.title}
            </button>
          ) : (
            lane.title
          )}
        </h3>
        <button type="button" className="sq-lead" onClick={() => open.thread(lane.leadThreadId, `the Lead thread for ${lane.specId}`)}>
          <AiChip route={lane.lead} prefix="Lead" />
        </button>
        <div className="sq-tail-status">
          <span className="sq-lane-state" data-lane={lane.state}>
            {LANE_LABEL[lane.state]}
          </span>
          <span className="sq-time sq-num">{formatMinutes(lane.minutes)}</span>
        </div>
        {lane.state === "spec-review" ? <AiChip route={laneReviewer(lane)} prefix="Reviewer" /> : null}
        {lane.pr ? (
          <button
            type="button"
            className="sq-pr"
            data-checks={lane.pr.checks}
            data-pr={lane.pr.state}
            aria-label={`PR #${lane.pr.number}${lane.pr.state && lane.pr.state !== "open" ? `, ${lane.pr.state}` : ""}, ${PR_CHECKS[lane.pr.checks]}. Open on GitHub.`}
            onClick={() => open.external(lane.pr!.url, `PR #${lane.pr!.number} on GitHub`)}
          >
            <span className="sq-pr-dot" aria-hidden="true" />
            PR #{lane.pr.number}
            {lane.pr.state && lane.pr.state !== "open" ? <span className="sq-pr-state">{lane.pr.state}</span> : null}
            <span className="sq-pr-checks">{PR_CHECKS[lane.pr.checks]}</span>
          </button>
        ) : null}
        <span className="sq-branch">{lane.branch}</span>
        {lane.state !== "landed" ? (
          <div className="sq-actions">
            {canMerge(lane) ? <LaneActionButton type="merge" tone="amber" specId={lane.specId} acting={acting} dispatch={dispatch} /> : null}
            {stopped ? <LaneActionButton type="resume" tone="primary" specId={lane.specId} acting={acting} dispatch={dispatch} /> : null}
            {(demo ? lane.state === "flying" : !stopped) ? <LaneActionButton type="stop" tone="plain" specId={lane.specId} acting={acting} dispatch={dispatch} /> : null}
            {demo ? <span className="sq-isolated">
              <Btn tone="danger" onClick={() => dispatch({ type: "cancel", specId: lane.specId })}>
                Cancel
              </Btn>
            </span> : null}
          </div>
        ) : null}
      </div>
      <div className="sq-track">
        <div className="sq-progress" role="img" aria-label={`${done} of ${lane.tickets.length} tickets in the branch`}>
          {lane.tickets.map((t) => (
            <span key={t.id} data-state={t.state} title={`${t.id}: ${TICKET_LABEL[t.state]}`} />
          ))}
          <span className="sq-progress-count sq-num">
            {done}/{lane.tickets.length} in branch
          </span>
          {working > 0 ? <span className="sq-pace sq-num"><i aria-hidden="true" />{working} working</span> : null}
        </div>
        <div className="sq-rail" data-overflow={overflow}>
          {overflow ? (
            <span className="sq-fade" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          ) : null}
          <div className="sq-columns" ref={railRef}>
            {landing ? <DitherCanvas fx={{ kind: "burst" }} className="sq-air" /> : <DitherCanvas fx={{ kind: "airstream", pace: working }} className="sq-air" />}
            {columns.map((col, i) => (
              <div key={i} className="sq-column">
                {i > 0 ? <span className="sq-chevron" aria-hidden="true" /> : null}
                <div className="sq-column-stack">
                  {col.map((t) => (
                    <Peg key={t.id} ticket={t} lane={lane} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        {lane.unmatchedThreads?.length ? (
          <div className="sq-threads">
            <span className="sq-threads-label">Other threads</span>
            <ul>
              {lane.unmatchedThreads.map((t) => (
                <li key={t.threadId}>
                  <button type="button" className="sq-issue-link" title="Open the thread beside the board" onClick={() => open.thread(t.threadId, t.title || "the thread")}>
                    {t.title || "Untitled thread"}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </article>
  );
}

const NEEDS_LABEL: Record<NeedsYouItem["kind"], string> = {
  setup: "Setup", waiting: "Waiting", failed: "Failed", blocked: "Blocked", stopped: "Stopped", merge: "Merge",
};

export function NeedsYouStrip({ items, dispatch, setup, setUp, demo = false, acting = null }: {
  items: NeedsYouItem[];
  dispatch: (a: BoardAction) => void;
  /** Controls for the Linear setup item, such as choosing the Linear project. */
  setup?: ReactNode;
  /** The Set up button, shown once, on the first missing-setup row. */
  setUp?: ReactNode;
  demo?: boolean;
  acting?: LaneAction | null;
}) {
  const open = useOpen();
  const setUpKey = setUp ? items.find((item) => item.key === "setup:setup" || item.key === "setup:settings")?.key : undefined;
  if (items.length === 0) {
    return <p className="sq-clear">Nothing needs you. Every lane is flying on its own.</p>;
  }
  return (
    <ul className="sq-needs">
      {items.map((item) => (
        <li key={item.key} className="sq-need" data-kind={item.kind}>
          <DitherCanvas fx={{ kind: "needs-you" }} className="sq-fx" />
          <span className="sq-need-kind">{NEEDS_LABEL[item.kind]}</span>
          {item.ticketId ?? item.specId ? (
            <PixelText text={item.ticketId ?? item.specId} cell={2} className="sq-need-id" />
          ) : (
            <span />
          )}
          <span className="sq-need-text">
            {item.text}
          </span>
          <span className="sq-need-actions">
            {item.key === "setup" ? setup : null}
            {item.key === setUpKey ? setUp : null}
            {item.kind === "waiting" && item.threadId ? (
              <Btn
                tone="amber"
                onClick={() => {
                  open.thread(item.threadId!, `the thread waiting on you in ${item.specId}`);
                  if (item.ticketId) window.setTimeout(() => dispatch({ type: "answer", ticketId: item.ticketId! }), 900);
                }}
              >
                Answer in thread
              </Btn>
            ) : null}
            {(item.kind === "failed" || item.kind === "blocked") && item.threadId ? (
              <Btn onClick={() => open.thread(item.threadId!, `the ${item.kind} thread in ${item.specId}`)}>Open thread</Btn>
            ) : null}
            {item.kind === "stopped" ? (
              <>
                <LaneActionButton type="resume" tone="amber" specId={item.specId} acting={acting} dispatch={dispatch} />
                {demo ? (
                  <Btn onClick={() => toast(`Prototype: opens a planning thread on ${item.specId}.`)}>Re-plan</Btn>
                ) : item.threadId ? (
                  <Btn onClick={() => open.thread(item.threadId!, `the Lead thread for ${item.specId}`)}>Open Lead</Btn>
                ) : null}
              </>
            ) : null}
            {item.kind === "merge" ? <LaneActionButton type="merge" tone="amber" specId={item.specId} acting={acting} dispatch={dispatch} /> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** An issue's title, opening it in Linear when the row is real. */
function IssueTitle({ title, url, className }: { title: string; url?: string; className: string }) {
  const open = useOpen();
  return url ? (
    <button type="button" className={`${className} sq-issue-link`} title="Open in Linear" onClick={() => open.external(url, title)}>
      {title}
    </button>
  ) : (
    <span className={className}>{title}</span>
  );
}

function ReadyRow({ spec, board, dispatch, opening = false, startBusy = false }: { spec: ReadySpec; board: Board; dispatch: (a: BoardAction) => void; opening?: boolean; startBusy?: boolean }) {
  // Real specs carry the board model's reason; the demo computes its own.
  const blocked = (spec.startReason !== undefined ? spec.startReason : canStart(board, spec))
    ?? (startBusy ? "Wait for the Lead thread to open." : null);
  return (
    <li className="sq-ready" data-blocked={blocked !== null}>
      <PixelText text={spec.id} cell={2} className="sq-ready-id" />
      <IssueTitle title={spec.title} url={spec.url} className="sq-ready-title" />
      <span className="sq-ready-meta sq-num">
        {spec.ticketCount} {spec.ticketCount === 1 ? "ticket" : "tickets"}
      </span>
      <span className="sq-ready-routes">
        {spec.routes.map((r, i) => (
          <AiChip key={i} route={r} />
        ))}
      </span>
      {spec.acceptOwner ? <span className="sq-tag">accept:owner</span> : <span />}
      <span className="sq-ready-why" role={opening ? "status" : undefined}>{opening ? "Opening its Lead thread" : blocked ?? ""}</span>
      <Btn tone="primary" disabled={opening || blocked !== null} title={blocked ?? `Start a lane for ${spec.id}`} onClick={() => dispatch({ type: "start", specId: spec.id })}>
        {opening ? "Opening…" : "Start"}
      </Btn>
      {spec.waiting?.length ? (
        <ul className="sq-ready-waiting" aria-label={`Tickets of ${spec.id} that wait on blockers`}>
          {spec.waiting.map((ticket) => (
            <li key={ticket.id} title={ticket.title}>
              <span className="sq-mono">{ticket.id}</span> waits on {list(ticket.blockedBy)}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** "A", "A and B", "A, B and C". */
function list(ids: readonly string[]): string {
  return ids.length < 2 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
}

function ShapingRow({ spec, onPlan, opening }: { spec: ShapingSpec; onPlan: Plan; opening: boolean }) {
  const label = spec.action === "resume" ? "Resume planning" : "Plan tickets";
  return (
    <li className="sq-shaping">
      <PixelText text={spec.id} cell={2} className="sq-ready-id" />
      <IssueTitle title={spec.title} url={spec.url} className="sq-shaping-title" />
      <span className="sq-ready-meta sq-num">
        {spec.ticketCount} {spec.ticketCount === 1 ? "ticket" : "tickets"}
      </span>
      <span className="sq-shaping-missing" role={opening ? "status" : undefined}>
        {opening ? (spec.action === "resume" ? "Opening its planning thread" : "Starting a planning thread for its tickets") : spec.missing}
      </span>
      <Btn disabled={opening} title={opening ? undefined : `${label} for ${spec.id}`}
        onClick={() => (spec.action === "resume" ? onPlan(spec.id) : onPlan(spec.id, "tickets"))}>
        {opening ? "Opening…" : label}
      </Btn>
    </li>
  );
}

/** An empty section: how work gets into it, and the button that does it. */
function EmptySection({ text, action }: { text: string; action: ReactNode }) {
  return (
    <div className="sq-empty">
      <p className="sq-clear">{text}</p>
      {action}
    </div>
  );
}

function OpenIssueRow({ issue, onPlan, opening }: { issue: OpenIssue; onPlan: Plan; opening: boolean }) {
  return (
    <li>
      {issue.priority !== undefined ? <PriorityDot priority={issue.priority} /> : <span />}
      <span className="sq-open-issues-id sq-num">{issue.id}</span>
      <span className="sq-open-issues-main">
        <IssueTitle title={issue.title} url={issue.url} className="sq-open-issues-title" />
        {issue.under ? <span className="sq-open-issues-under">{issue.under}</span> : null}
      </span>
      <span className="sq-open-issues-labels">
        {issue.labels.map((l) => (
          <span key={l} className="sq-tag">
            {l}
          </span>
        ))}
        {opening ? <span className="sq-plan-why" role="status">Starting its planning thread</span> : null}
      </span>
      <Btn disabled={opening} title={opening ? `Opening the planning thread for ${issue.id}` : undefined} onClick={() => onPlan(issue.id)}>
        {opening ? "Opening…" : "Plan"}
      </Btn>
    </li>
  );
}


// ---------- simulation ----------

type Sim = { board: Board; playing: boolean; speed: 1 | 3 };
type SimAction = { type: "tick" } | { type: "board"; action: BoardAction } | { type: "play"; on: boolean } | { type: "speed"; speed: 1 | 3 } | { type: "reset" };

function simReducer(sim: Sim, action: SimAction): Sim {
  switch (action.type) {
    case "tick":
      return { ...sim, board: step(sim.board) };
    case "board":
      return { ...sim, board: apply(sim.board, action.action) };
    case "play":
      return { ...sim, playing: action.on };
    case "speed":
      return { ...sim, speed: action.speed };
    case "reset":
      resetSimulation();
      return { ...sim, board: initialBoard() };
  }
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** Which lanes are landing now. Each landing this view sees plays once, then the lane moves to Landed. */
function useLandings(lanes: Lane[]): (lane: Lane) => boolean {
  const seen = useRef<Landings | null>(null);
  // Folded in as each board arrives, so a lane never flashes into Landed before its burst.
  const landings = useMemo(() => (seen.current = nextLandings(seen.current, lanes, Date.now())), [lanes]);
  const [now, setNow] = useState(() => Date.now());
  const pending = Object.values(landings.until).filter((until) => until > now);
  useEffect(() => {
    if (pending.length === 0) return;
    const t = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(...pending) - Date.now()) + 20);
    return () => window.clearTimeout(t);
  });
  return (lane) => lane.state === "landed" && (landings.until[lane.specId] ?? 0) > now;
}

/** Where the board's copy of Linear stands, in one muted line under the header. */
function LinearLine({ board, now }: { board: Board; now: number }) {
  const linear = board.linear;
  if (!linear || linear.state === "disconnected" || linear.state === "unbound") return null;
  const age = linear.syncedAt === null ? null : Math.max(0, Math.round((now - linear.syncedAt) / 60_000));
  const read = age === null ? "" : age === 0 ? "Read from Linear just now." : `Read from Linear ${formatMinutes(age)} ago.`;
  return (
    <p className="sq-linear" data-state={linear.state} role="status" aria-live="polite">
      <span className="sq-linear-project">{linear.project}</span>
      <span>{linear.state === "current" ? read : linear.state === "failed" ? `${linear.message} ${read}` : linear.message}</span>
    </p>
  );
}

/** Plan an issue (or Resume its planning), Plan a spec's tickets, or with no issue start a New spec. */
type Plan = (issueId?: string, step?: "tickets") => void;

/** Set up is offered when Matt's setup files or docs/agents/squadron.md are missing.
 * A squadron.md that exists but needs a fix stays Doctor's job. */
export function needsSetup(board: Board): boolean {
  const doctor = board.doctor;
  if (!doctor) return false;
  return doctor.checks.some((check) => check.id === "setup" && check.status === "fix")
    || doctor.configurationFiles.some((file) => file.id === "project-settings" && !file.exists);
}

/** Doctor's verdict in a word or two, for the header. */
function doctorStatus(board: Board): { text: string; tone: "pass" | "fix" } | null {
  if (!board.doctor) return null;
  const fixes = board.doctor.checks.filter((check) => check.status === "fix").length;
  return fixes ? { text: `${fixes} to fix`, tone: "fix" } : { text: "Ready", tone: "pass" };
}

interface BoardViewProps {
  board: Board;
  dispatch: (a: BoardAction) => void;
  /** The synthetic simulation; the live board passes false. */
  demo: boolean;
  modeSwitch: ReactNode;
  onPlan: Plan;
  /** The planning button that is opening its thread: an issue id, or "" for New spec. */
  planning?: string | null;
  starting?: string | null;
  /** A Stop or Resume on its way to a Lead. */
  acting?: LaneAction | null;
  setup?: ReactNode;
  /** Starts the Set up thread; the button shows when needsSetup(board). */
  onSetUp?: () => void;
  settingUp?: boolean;
  /** Replaces Ready, Shaping and Open issues while the board can't show them. */
  notice?: ReactNode;
  /** A safe, visible note about an update the board couldn't use. */
  diagnostic?: string | null;
  /** The live board's project picker: its header button and its open list. */
  projectButton?: ReactNode;
  projectList?: ReactNode;
  /** The project Doctor checks; defaults to BB's context project. */
  projectId?: string | null;
  /** Lanes flying across every project, for the formation mark; null while unknown. */
  fleet?: number | null;
  footer?: ReactNode;
}

/** The board page, fed by the live reader or by the synthetic simulation. */
export function BoardView({ board, dispatch, demo, modeSwitch, onPlan, planning = null, starting = null, acting = null, setup, onSetUp, settingUp = false, notice, diagnostic = null, projectButton, projectList, projectId, fleet = null, footer }: BoardViewProps) {
  const [doctorOpen, setDoctorOpen] = useState(false);
  const doctorId = useId();
  const reduced = usePrefersReducedMotion();
  const items = needsYou(board);
  const isLanding = useLandings(board.lanes);
  const flying = board.lanes.filter((l) => l.state !== "landed");
  const onLine = board.lanes.filter((l) => l.state !== "landed" || isLanding(l));
  const landed = board.lanes.filter((l) => l.state === "landed" && !isLanding(l));
  const startable = board.ready.find((spec) => (spec.startReason !== undefined ? spec.startReason : canStart(board, spec)) === null);
  // New spec starts the path from nothing; one planning thread opens at a time.
  const newSpec = (tone: "primary" | "plain" = "plain") => (
    <Btn tone={tone} disabled={planning === ""} title={planning === "" ? "Opening a planning thread" : "Plan a new spec from nothing"} onClick={() => onPlan()}>
      {planning === "" ? "Opening…" : "New spec"}
    </Btn>
  );
  const openTickets = flying.reduce((n, l) => n + l.tickets.filter((t) => t.state !== "branch" && t.state !== "done").length, 0);
  const doctor = doctorStatus(board);
  const setUpButton = onSetUp && needsSetup(board) ? (
    <>
      {settingUp ? <span className="sq-plan-why" role="status">Starting the setup thread</span> : null}
      <Btn tone="amber" disabled={settingUp} title={settingUp ? "Opening the setup thread" : "Start a thread that sets this project up for Squadron"} onClick={onSetUp}>
        {settingUp ? "Opening…" : "Set up"}
      </Btn>
    </>
  ) : null;

  return (
    <div className="sq" style={DITHER_VARS as CSSProperties} data-reduced={reduced}>
      <div className="sq-page">
        <header className="sq-head">
          <div className="sq-head-title">
            {demo ? (
              <FormationMark flying={flying.length} label={`${flying.length} of ${board.laneCapacity} lanes flying`} />
            ) : fleet !== null ? (
              <FormationMark flying={fleet} label={`${fleet} ${fleet === 1 ? "lane" : "lanes"} flying across your projects`} />
            ) : null}
            <h1>Squadron</h1>
            {projectButton}
            {demo ? (
              <span className="sq-tag" data-tone="amber">
                Synthetic data
              </span>
            ) : null}
          </div>
          <p className="sq-head-counts sq-num">
            {demo ? `${flying.length} of ${board.laneCapacity} lanes flying` : `${flying.length} ${flying.length === 1 ? "lane" : "lanes"} on the board`} · {openTickets} tickets open · {items.length} {items.length === 1 ? "needs" : "need"} you
          </p>
          <div className="sq-head-actions">
            {demo ? (
              <button
                type="button"
                role="switch"
                aria-checked={board.autoStart}
                className="sq-switch"
                onClick={() => dispatch({ type: "autoStart", on: !board.autoStart })}
              >
                <span className="sq-switch-track" aria-hidden="true">
                  <span className="sq-switch-knob" />
                </span>
                Auto-start ready specs
              </button>
            ) : null}
            {modeSwitch}
            {planning === "" ? <span className="sq-plan-why" role="status">Starting a planning thread</span> : null}
            {newSpec("primary")}
            <button type="button" className="sq-btn sq-doctor-button" aria-expanded={doctorOpen} aria-controls={doctorId} onClick={() => setDoctorOpen((open) => !open)}>
              Doctor{doctor ? <span className="sq-sr">: </span> : null}
              {doctor ? <span className="sq-doctor-status" data-status={doctor.tone}>{doctor.text}</span> : null}
            </button>
          </div>
        </header>
        {projectList}
        <LinearLine board={board} now={Date.now()} />
        {diagnostic ? <p className="sq-signal" role="status">{diagnostic}</p> : null}

        <section className="sq-section" aria-labelledby="sq-needs-h">
          <h2 id="sq-needs-h">
            Needs you {items.length > 0 ? <span className="sq-count sq-num">{items.length}</span> : null}
          </h2>
          <NeedsYouStrip items={items} dispatch={dispatch} setup={setup} setUp={setUpButton} demo={demo} acting={acting} />
        </section>
        <DoctorPanel open={doctorOpen} id={doctorId} projectId={projectId} />

        <section className="sq-section" aria-labelledby="sq-flying-h">
          <h2 id="sq-flying-h">Flying</h2>
          {onLine.length === 0 ? (
            <EmptySection text="Nothing is flying. Start a Ready spec to launch its lane." action={startable ? (
              <Btn tone="primary" disabled={starting !== null} onClick={() => dispatch({ type: "start", specId: startable.id })}>
                {starting === startable.id ? "Opening…" : `Start ${startable.id}`}
              </Btn>
            ) : newSpec()} />
          ) : (
            onLine.map((lane) => <SortieLine key={lane.specId} lane={lane} dispatch={dispatch} landing={isLanding(lane)} demo={demo} acting={acting} />)
          )}
        </section>

        <section className="sq-section" aria-labelledby="sq-ready-h">
          <h2 id="sq-ready-h">Ready</h2>
          {notice ? (
            <p className="sq-clear">{notice}</p>
          ) : board.ready.length === 0 ? (
            <EmptySection text="No spec is Ready. A spec is Ready once it has the ready-for-agent label and an open ticket nothing blocks."
              action={newSpec()} />
          ) : (
            <ul className="sq-ready-list">
              {board.ready.map((spec) => (
                <ReadyRow key={spec.id} spec={spec} board={board} dispatch={dispatch} opening={starting === spec.id} startBusy={starting !== null} />
              ))}
            </ul>
          )}
        </section>

        <section className="sq-section" aria-labelledby="sq-shaping-h">
          <h2 id="sq-shaping-h">Shaping</h2>
          {notice ? null : board.shaping.length === 0 ? (
            <EmptySection text="No spec is being shaped. Plan an open issue, or start a new spec from nothing." action={newSpec()} />
          ) : (
            <ul className="sq-shaping-list">
              {board.shaping.map((spec) => (
                <ShapingRow key={spec.id} spec={spec} onPlan={onPlan} opening={planning === spec.id} />
              ))}
            </ul>
          )}
        </section>

        <section className="sq-section" aria-labelledby="sq-open-issues-h">
          <h2 id="sq-open-issues-h">Open issues</h2>
          {notice ? null : board.openIssues.length === 0 ? (
            <EmptySection text="No open issues. Issues in this project that aren't specs or tickets wait here for Plan." action={newSpec()} />
          ) : (
            <ul className="sq-open-issues">
              {board.openIssues.map((issue) => (
                <OpenIssueRow key={issue.id} issue={issue} onPlan={onPlan} opening={planning === issue.id} />
              ))}
            </ul>
          )}
        </section>

        {landed.length > 0 ? (
          <section className="sq-section" aria-labelledby="sq-landed-h">
            <h2 id="sq-landed-h">Landed</h2>
            <ul className="sq-landed">
              {landed.map((lane) => (
                <li key={lane.specId}>
                  <PixelText text={lane.specId} cell={2} className="sq-landed-id" />
                  <span>{lane.title}</span>
                  <span className="sq-num">PR #{lane.pr?.number ?? "—"}</span>
                  <span className="sq-num">{formatMinutes(lane.minutes)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {footer}
      </div>
    </div>
  );
}

function DemoSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="sq-switch" onClick={() => onChange(!on)}>
      <span className="sq-switch-track" aria-hidden="true">
        <span className="sq-switch-knob" />
      </span>
      Synthetic demo
    </button>
  );
}

/** The simulated factory. Every screen of it is labelled as synthetic. */
function DemoBoard({ modeSwitch }: { modeSwitch: ReactNode }) {
  const [sim, send] = useReducer(simReducer, undefined, () => ({ board: initialBoard(), playing: true, speed: 1 as const }));
  useEffect(() => {
    if (!sim.playing) return;
    const id = window.setInterval(() => send({ type: "tick" }), sim.speed === 3 ? 700 : 2100);
    return () => window.clearInterval(id);
  }, [sim.playing, sim.speed]);
  return (
    <BoardView
      board={sim.board}
      demo
      modeSwitch={modeSwitch}
      dispatch={(action) => send({ type: "board", action })}
      onPlan={(issueId, step) => toast(issueId ? `Prototype: opens a planning thread ${step === "tickets" ? "for the tickets of" : "on"} ${issueId}.` : "Prototype: opens a planning thread (grill-with-docs → to-spec → to-tickets).")}
      footer={
        <footer className="sq-sim">
          <span className="sq-tag" data-tone="amber">
            Synthetic data
          </span>
          <span>A simulated factory for judging the board. Nothing here is real.</span>
          <span className="sq-sim-controls">
            <Btn onClick={() => send({ type: "play", on: !sim.playing })}>{sim.playing ? "Pause" : "Play"}</Btn>
            <Btn onClick={() => send({ type: "speed", speed: sim.speed === 1 ? 3 : 1 })}>{sim.speed === 1 ? "Speed ×3" : "Speed ×1"}</Btn>
            <Btn onClick={() => send({ type: "reset" })}>Reset</Btn>
          </span>
        </footer>
      }
    />
  );
}

const EMPTY_BOARD: Board = { tick: 0, laneCapacity: 0, workersPerLane: 0, autoStart: false, lanes: [], ready: [], shaping: [], openIssues: [] };

/** What the live page shows before it has a board, or when it can't get one. */
export function liveNotice(state: { projectId: string | null; board: Board | null; failed: boolean }): string | null {
  if (!state.projectId) return "Choose a BB project to see its board.";
  if (state.failed) return "Couldn't load the board. Make sure BB is running, then try again.";
  if (!state.board) return "Reading the board.";
  const linear = state.board.linear?.state;
  if (linear === "disconnected") return "Connect Linear to see this project's issues.";
  if (linear === "unbound") return "Choose this project's Linear team and project above.";
  if (linear === "catching-up" && state.board.linear?.syncedAt === null) return "Reading this project's issues from Linear.";
  return null;
}

/** Start or reopen a planning thread, open it beside the board, and report a start failure. */
export async function planFromBoard(deps: {
  start: (input: { projectId: string; issueId?: string; step?: "tickets" }) => Promise<PlanningStarted>;
  openThread: (threadId: string) => void;
  notify: (text: string) => void;
}, projectId: string, issueId?: string, step?: "tickets"): Promise<void> {
  try {
    const started = await deps.start(issueId ? { projectId, issueId, ...(step ? { step } : {}) } : { projectId });
    deps.openThread(started.threadId);
  } catch (error) {
    // The server's refusals are written for the owner.
    deps.notify(error instanceof Error && error.message ? error.message : "Couldn't start planning. Try again.");
  }
}

/** Start a lane through the board's public RPC and follow its Lead. */
export async function startFromBoard(deps: {
  start: (input: { projectId: string; specId: string }) => Promise<{ threadId: string }>;
  openThread: (threadId: string) => void;
  notify: (text: string) => void;
  refresh: () => Promise<void>;
}, projectId: string, specId: string) {
  try {
    const started = await deps.start({ projectId, specId });
    deps.openThread(started.threadId);
  } catch (error) {
    deps.notify(error instanceof Error && error.message ? error.message : "Couldn't start this lane. Try again.");
  } finally { await deps.refresh(); }
}

type LeadMessage = { specId: string; type: "stop" | "resume" };
/** Send Stop or Resume to a lane's Lead through the board's public RPC, then read the board again. */
export async function messageLeadFromBoard(deps: {
  send: (type: LeadMessage["type"], input: { projectId: string; specId: string }) => Promise<{ threadId: string }>;
  notify: (text: string) => void;
  refresh: () => Promise<void>;
}, projectId: string, action: LeadMessage) {
  try {
    await deps.send(action.type, { projectId, specId: action.specId });
    deps.notify(action.type === "stop"
      ? `Asked the Lead for ${action.specId} to wind down. Its workers save their work first.`
      : `Asked the Lead for ${action.specId} to carry on from its last summary.`);
  } catch (error) {
    deps.notify(error instanceof Error && error.message ? error.message
      : `Couldn't ${action.type === "stop" ? "stop" : "resume"} ${action.specId}. Try again.`);
  } finally { await deps.refresh(); }
}

/** Squash-merge a lane's PR through the board's public RPC, then read the board again. */
export async function mergeFromBoard(deps: {
  merge: (input: { projectId: string; specId: string }) => Promise<{ number: number }>;
  notify: (text: string) => void;
  refresh: () => Promise<void>;
}, projectId: string, specId: string) {
  try {
    const merged = await deps.merge({ projectId, specId });
    deps.notify(`Squash-merged PR #${merged.number} for ${specId}. The lane lands when BB sees the merge.`);
  } catch (error) {
    deps.notify(error instanceof Error && error.message ? error.message : `Couldn't merge ${specId}'s PR. Try again.`);
  } finally { await deps.refresh(); }
}

/** How often the page reads the project it shows. The server polls only shown projects. */
const POLL_MS = 30_000;

/** The real board for the project the owner picked, read from the reader. */
function LiveBoard({ modeSwitch }: { modeSwitch: ReactNode }) {
  const context = useBbContext().projectId;
  const rpc = useRpc<typeof boardContract & typeof planningContract & typeof setupContract & typeof laneContract>();
  const open = useOpen();
  const [listed, setListed] = useState<PickerProjects | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerId = useId();
  // Every project's counts, read once when the page opens and again whenever the picker opens, for the formation mark.
  const [counts, setCounts] = useState<ProjectCounts | null>(null);
  useEffect(() => {
    let current = true;
    rpc.call("board.projectCounts", null).then((next) => { if (current) setCounts(next); }).catch(() => undefined);
    return () => { current = false; };
  }, [rpc]);
  // A new route context replaces an earlier pick in this page.
  useEffect(() => { setPicked(null); }, [context]);
  const projectId = currentProject({ picked, context, lastPick: listed?.lastPick ?? null });
  useEffect(() => {
    let current = true;
    rpc.call("board.projects", null).then((next) => { if (current) setListed(next); })
      .catch(() => { if (current) setListed({ projects: [], lastPick: null }); });
    return () => { current = false; };
  }, [rpc]);
  // With nothing to open, the picker is open and asking.
  const asking = listed !== null && projectId === null;
  const pick = useCallback((id: string) => {
    setPicked(id); setPickerOpen(false);
    setListed((value) => value && { ...value, lastPick: id });
    void rpc.call("board.pick", { projectId: id }).catch(() => undefined);
  }, [rpc]);
  const [settingUp, setSettingUp] = useState(false);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [planning, setPlanning] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [acting, setActing] = useState<LaneAction | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  const shown = useRef("");
  const load = useCallback(async () => {
    if (!projectId) return;
    const current = ++request.current;
    try {
      const next = await rpc.call("board", { projectId });
      if (current !== request.current) return;
      setFailed(false);
      // Duplicate signals often return the same board; keep the view as it is.
      const json = JSON.stringify(next);
      if (json !== shown.current) { shown.current = json; setBoard(next); }
    } catch {
      if (current === request.current) setFailed(true);
    }
  }, [rpc, projectId]);
  useEffect(() => {
    shown.current = ""; setBoard(null); setFailed(false);
    void load();
    return () => { request.current++; };
  }, [load]);
  // Poll only the project this page shows, and only while the page is visible.
  useEffect(() => {
    if (!projectId) return;
    const id = window.setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [load, projectId]);
  // Coalesce connection-change signals.
  const pending = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(pending.current), []);
  const loadSoon = useCallback(() => {
    window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => { void load(); }, 400);
  }, [load]);
  // A signal that fails validation is shown, and the board is read again in case it mattered.
  const invalid = useCallback((text: string) => { setDiagnostic(text); loadSoon(); }, [loadSoon]);
  useSquadronSignal(boardChanged, (payload) => {
    setDiagnostic(null);
    if (payload.projectId === projectId) void load();
  }, invalid);
  useSquadronSignal(linearConnectionChanged, () => { loadSoon(); }, invalid);
  const setUp = useCallback(async () => {
    if (!projectId || settingUp) return;
    setSettingUp(true);
    try {
      const started = await rpc.call("planning.setup", { projectId });
      open.thread(started.threadId, "the setup thread");
    } catch (error) {
      toast(error instanceof Error && error.message ? error.message : "Couldn't start the setup thread. Try again.");
    } finally { setSettingUp(false); }
  }, [rpc, projectId, settingUp, open]);
  const plan = useCallback(async (issueId?: string, step?: "tickets") => {
    if (!projectId || planning !== null) return;
    setPlanning(issueId ?? "");
    try {
      await planFromBoard({
        start: (input) => rpc.call("planning.start", input),
        openThread: (threadId) => open.thread(threadId, "the planning thread"),
        notify: (text) => { toast(text); },
      }, projectId, issueId, step);
    } finally { setPlanning(null); }
  }, [rpc, projectId, planning, open]);
  const start = useCallback(async (specId: string) => {
    if (!projectId || starting !== null) return;
    setStarting(specId);
    try {
      await startFromBoard({ start: (input) => rpc.call("lane.start", input),
        openThread: (threadId) => open.thread(threadId, "the Lead thread"), notify: (text) => toast(text), refresh: load,
      }, projectId, specId);
    } finally { setStarting(null); }
  }, [rpc, projectId, starting, open, load]);
  const act = useCallback(async (action: LaneAction) => {
    if (!projectId || acting !== null) return;
    setActing(action);
    try {
      if (action.type === "merge") {
        await mergeFromBoard({ merge: (input) => rpc.call("lane.merge", input), notify: (text) => toast(text), refresh: load },
          projectId, action.specId);
      } else {
        await messageLeadFromBoard({ send: (type, input) => rpc.call(type === "stop" ? "lane.stop" : "lane.resume", input),
          notify: (text) => toast(text), refresh: load }, projectId, { type: action.type, specId: action.specId });
      }
    } finally { setActing(null); }
  }, [rpc, projectId, acting, load]);
  const notice = liveNotice({ projectId, board, failed });
  const projectName = listed?.projects.find((item) => item.id === projectId)?.name ?? null;
  return (
    <BoardView
      projectId={projectId}
      projectButton={listed ? <ProjectButton name={projectName} open={pickerOpen || asking} controls={pickerId} onToggle={() => setPickerOpen((value) => !value)} /> : null}
      projectList={listed && (pickerOpen || asking) ? <ProjectListLoader id={pickerId} projects={listed.projects} current={projectId} onPick={pick} onCounts={setCounts} /> : null}
      fleet={board ? fleetFlying(counts, projectId, board.lanes.filter((lane) => lane.state !== "landed").length) : null}
      onSetUp={() => void setUp()}
      settingUp={settingUp}
      diagnostic={diagnostic}
      board={board ?? EMPTY_BOARD}
      demo={false}
      modeSwitch={modeSwitch}
      dispatch={(action) => {
        if (action.type === "start") void start(action.specId);
        else if (action.type === "stop" || action.type === "resume" || action.type === "merge") void act({ type: action.type, specId: action.specId });
      }}
      onPlan={(issueId, step) => void plan(issueId, step)}
      planning={planning}
      starting={starting}
      acting={acting}
      notice={notice ? (
        <>
          {notice}
          {failed ? <> <Btn onClick={() => void load()}>Try again</Btn></> : null}
        </>
      ) : undefined}
      setup={board?.linear?.state === "unbound" && projectId ? <BindProject projectId={projectId} onBound={() => void load()} /> : null}
    />
  );
}

export function BoardPage() {
  const [demo, setDemo] = useState(false);
  const modeSwitch = <DemoSwitch on={demo} onChange={setDemo} />;
  return demo ? <DemoBoard modeSwitch={modeSwitch} /> : <LiveBoard modeSwitch={modeSwitch} />;
}
