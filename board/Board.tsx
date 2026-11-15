import { Autopilot, type AutopilotChange } from "./Autopilot.js";
import { autopilotContract } from "../lib/autopilot-contract.js";
import { Fragment, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { isActiveTicket } from "../lib/ticket-activity.js";
import type { LiveStep } from "../lib/live-step.js";
import { LIVE_STEP_MS } from "../lib/live-step.js";
import type { ReactNode, Ref } from "react";
import { experimental_FileLink as FileLink, experimental_ProviderIcon as ProviderIcon, experimental_useProviders as useProviders, useBbContext, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
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
import { formationSize, FORMATION_SIZE } from "../lib/dither.js";
import { layoutPixels } from "../lib/pixels.js";
import { DitherCanvas } from "./DitherCanvas.js";
import { DoctorPanel } from "./Doctor.js";
import { Term } from "./Term.js";
import { HowItWorks } from "./HowItWorks.js";
import { HelperControl } from "./HelperControl.js";
import { currentProject, pickerMeta, ProjectButton, ProjectListLoader } from "./ProjectPicker.js";
import type { ProjectCounts } from "../lib/board-contract.js";
import { trackerName, type TrackerKind } from "../lib/tracker-detection.js";

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

/** A 6x10 pixel chevron on 2px cells, pointing along the path. */
function Chevron({ className }: { className: string }) {
  return (
    <svg className={className} aria-hidden="true" width={6} height={10} viewBox="0 0 6 10" shapeRendering="crispEdges">
      {[[0, 0], [2, 2], [4, 4], [2, 6], [0, 8]].map(([x, y]) => <rect key={y} x={x} y={y} width={2} height={2} />)}
    </svg>
  );
}

/**
 * The header's formation mark: one plane slot per lane in this project's lane
 * limit, lit as lanes fly. Before a project has a lane limit, the slots are
 * the lanes flying, with one slot shown when none are.
 */
function FormationMark({ limit, flying }: { limit: number; flying: number }) {
  const slots = Math.max(1, limit, flying);
  const label = `${flying} of ${slots} ${slots === 1 ? "lane" : "lanes"} flying${limit > 0 && flying > limit ? ` (limit ${limit})` : ""}`;
  const { height } = formationSize(slots, flying);
  return <DitherCanvas fx={{ kind: "formation", slots, lit: flying }} className="sq-formation" label={label} title={label}
    style={height > FORMATION_SIZE.height ? { height, margin: 0 } : undefined} />;
}

// ---------- small parts ----------

/** The agent's family icon, model and effort. A compact chip with a prefix shows only the icon and prefix; the model stays in its hover title. */
function AiChip({ route, prefix, compact = false }: { route: Route; prefix?: string; compact?: boolean }) {
  const { providers } = useProviders();
  const id = route.family === "claude" ? "claude-code" : "codex";
  const provider = providers.find((p) => p.id === id) ?? { id };
  const title = `${route.family === "claude" ? "Claude Code" : "Codex"} · ${route.model} · ${route.effort} effort`;
  return (
    <span className="sq-ai" title={compact && prefix ? `${prefix}: ${title}` : title}>
      <ProviderIcon providerKind="agent" provider={provider} />
      {compact && prefix ? <span>{prefix}</span> : (
        <span>
          {prefix ? `${prefix} · ` : ""}
          {route.model}
          <span className="sq-ai-effort"> {route.effort === "high" ? "high" : "med"}</span>
        </span>
      )}
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
  held: "Held",
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

/** Where the board is shown: BB's full page, or a thread's side panel. */
export type Placement = "page" | "panel";
const PlacementContext = createContext<Placement>("page");

/** How the board lays out: wide, or narrow with one compact row per lane. */
export type BoardLayout = "wide" | "narrow";
const LayoutContext = createContext<BoardLayout>("wide");

/** The widest board, in CSS pixels, that still takes the narrow layout. */
export const NARROW_MAX = 900;

/** A side panel is always narrow; the full page is narrow at 900px and under, once its width is known. */
export function boardLayout(placement: Placement, width: number | null): BoardLayout {
  return placement === "panel" || (width !== null && width <= NARROW_MAX) ? "narrow" : "wide";
}

/** The board's own width, measured before paint and on every resize. */
function useWidth(ref: { current: HTMLElement | null }): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => { for (const entry of entries) setWidth(entry.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Beside the board on the full page; from a thread's side panel, in the main view the panel sits beside. */
export function openThread(navigate: { toThread(threadId: string, options?: { split?: boolean }): void }, placement: Placement, threadId: string) {
  if (placement === "panel") navigate.toThread(threadId);
  else navigate.toThread(threadId, { split: true });
}

function useOpen() {
  const navigate = useBbNavigate();
  const placement = useContext(PlacementContext);
  const where = placement === "panel" ? "in the main view" : "beside the board";
  return {
    /** Where a thread link opens, in words for titles and toasts. */
    where,
    thread(threadId: string, label: string) {
      if (threadId.startsWith("thr_demo_")) toast(`Prototype: opens ${label} ${where}.`);
      else openThread(navigate, placement, threadId);
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

/** Shared by the current pegs and compact rows. Activity stays quieter than the title. */
export function LiveStepLine({ activity }: { activity?: LiveStep }) {
  const status = activity?.status;
  const state = status === "error" ? "Error" : status === "waiting-for-host" ? "Waiting for machine"
    : status === "pending" ? "Queued" : status === "provisioning" ? "Preparing" : status === "starting" ? "Starting"
      : status === "stopping" ? "Stopping" : null;
  const minutes = activity?.since == null ? null : Math.max(0, Math.floor((Date.now() - activity.since) / 60_000));
  return <span className="sq-live-step" data-status={status}>
    {state ? <span className="sq-live-status">{state} · </span> : null}
    <span className="sq-live-text">{activity?.step ?? "No recent activity"}</span>
    {minutes !== null ? <span className="sq-num"> · {formatMinutes(minutes)}</span> : null}
  </span>;
}

/** Display BB's current owner interaction without changing the tracker's ticket state. */
function ticketDisplayState(ticket: Ticket, lane: Lane): TicketState {
  if (!isActiveTicket(ticket.state)) return ticket.state;
  const need = lane.needs?.find((need) => need.threadId === ticket.threadId);
  return need?.kind === "waiting" ? "question" : need?.kind === "failed" ? "failed" : ticket.state;
}

/** A narrow lane keeps each active ticket to a title line and a quiet activity line. */
function SlimTicketRow({ ticket, lane }: { ticket: Ticket; lane: Lane }) {
  const open = useOpen();
  const clickable = Boolean(ticket.threadId);
  const displayState = ticketDisplayState(ticket, lane);
  const state = TICKET_LABEL[displayState];
  const label = `${ticket.id}, ${ticket.title}: ${state}.`;
  const activity = lane.state === "flying"
    ? ticket.liveStep ? `${ticket.liveStep.status}. ${ticket.liveStep.step}. ` : "No recent activity. "
    : "";
  const body = <>
    <span className="sq-ticket-main">
      <span className="sq-peg-id">{ticket.id}</span>
      <span className="sq-ticket-title" title={ticket.title}>{ticket.title}</span>
    </span>
    <span className="sq-ticket-state"><Term text={state} nested={clickable} /></span>
    {lane.state === "flying" ? <LiveStepLine activity={ticket.liveStep} /> : null}
    <span className="sq-ticket-time sq-num" title="Ticket time">{formatMinutes(ticket.minutes)}</span>
  </>;
  return clickable ? (
    <button type="button" className="sq-ticket-row" data-state={displayState} aria-label={`${label} ${activity}${formatMinutes(ticket.minutes)}. Open thread.`}
      onClick={() => open.thread(ticket.threadId!, `the ${ticket.state === "review" ? "reviewer" : "worker"} thread for ${ticket.id}`)}>
      {body}
    </button>
  ) : <div className="sq-ticket-row" data-state={displayState} aria-label={label}>{body}</div>;
}

function Peg({ ticket, lane }: { ticket: Ticket; lane: Lane }) {
  const open = useOpen();
  const reviewer = laneReviewer(lane);
  const state = ticketDisplayState(ticket, lane);
  const fill = state === "blocked" || state === "held" || state === "ready" ? null : <DitherCanvas fx={{ kind: "peg", state }} className="sq-fx" />;
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
  const size = state === "branch" || state === "done" ? "compact" : state === "blocked" || state === "held" ? "slim" : "full";
  if (size === "compact") {
    const inner = (
      <>
        {fill}
        <span className="sq-peg-id">{ticket.id}</span>
        <span className="sq-peg-state"><Term text={TICKET_LABEL[state]} nested={clickable} /></span>
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
        {/* A waiting peg names its open blockers in the state's place. */}
        {state === "blocked" && waitsOn.length > 0
          ? <span className="sq-peg-after" title={`Waiting after ${waitsOn.join(", ")}`}>after {waitsOn.join(", ")}</span>
          : <span className="sq-peg-state"><Term text={sub} nested={clickable} /></span>}
      </span>
      <span className="sq-peg-title">{ticket.title}</span>
      {lane.state === "flying" && isActiveTicket(state) ? <LiveStepLine activity={ticket.liveStep} /> : null}
      {size === "full" ? (
        <span className="sq-peg-foot">
          <AiChip route={state === "review" ? reviewer : ticket.route} />
          {ticket.minutes > 0 ? <span className="sq-num">{formatMinutes(ticket.minutes)}</span> : null}
        </span>
      ) : null}
    </>
  );
  return clickable ? (
    <button
      type="button"
      className="sq-peg"
      data-size={size}
      data-state={state}
      onClick={() => open.thread(ticket.threadId!, `the ${state === "review" ? "reviewer" : "worker"} thread for ${ticket.id}`)}
      aria-label={`${ticket.id}, ${ticket.title}: ${sub}. ${ticket.liveStep ? `${ticket.liveStep.status}. ${ticket.liveStep.step}. ` : ""}Open thread.`}
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
function LaneActionButton({ type, specId, acting, tone, dispatch, localMerge = false }: {
  type: LaneAction["type"]; specId: string; acting: LaneAction | null; tone: "plain" | "primary" | "amber"; dispatch: (a: BoardAction) => void; localMerge?: boolean;
}) {
  const mine = acting?.specId === specId;
  return (
    <>
      {mine && acting.type === type ? <span className="sq-why" role="status">{type === "merge" && localMerge ? "Asking the Lead to merge locally" : LANE_ACTION_STATUS[type]}</span> : null}
      <Btn tone={tone} disabled={acting !== null} onClick={() => dispatch({ type, specId })}>
        {mine && acting.type === type ? LANE_ACTION_PENDING[type] : LANE_ACTION_LABEL[type]}
      </Btn>
    </>
  );
}

/** The Lead chip, with the Lead's current step while the lane flies. It opens the Lead thread. */
function LeadButton({ lane, compact = false }: { lane: Lane; compact?: boolean }) {
  const open = useOpen();
  return (
    <button type="button" className="sq-lead" onClick={() => open.thread(lane.leadThreadId, lane.outside ? `the thread flying ${lane.specId}` : `the Lead thread for ${lane.specId}`)}>
      <AiChip route={lane.lead} prefix="Lead" compact={compact} />
      {lane.state === "flying" ? <LiveStepLine activity={lane.liveStep} /> : null}
    </button>
  );
}

/** The lane's PR, with its checks in words beside the dot. */
function PrChip({ pr }: { pr: PullRequest }) {
  const open = useOpen();
  return (
    <button
      type="button"
      className="sq-pr"
      data-checks={pr.checks}
      data-pr={pr.state}
      aria-label={`PR #${pr.number}${pr.state && pr.state !== "open" ? `, ${pr.state}` : ""}, ${PR_CHECKS[pr.checks]}. Open on GitHub.`}
      onClick={() => open.external(pr.url, `PR #${pr.number} on GitHub`)}
    >
      <span className="sq-pr-dot" aria-hidden="true" />
      PR #{pr.number}
      {pr.state && pr.state !== "open" ? <span className="sq-pr-state">{pr.state}</span> : null}
      <span className="sq-pr-checks">{PR_CHECKS[pr.checks]}</span>
    </button>
  );
}

/** Merge, Resume and Stop for a lane Squadron started; an outside lane says why it has none. */
function LaneActions({ lane, dispatch, demo, acting }: { lane: Lane; dispatch: (a: BoardAction) => void; demo: boolean; acting: LaneAction | null }) {
  const stopped = lane.stopped ?? lane.state === "stopped";
  if (lane.outside) return <p className="sq-readonly">Read-only: Squadron didn't start this lane, so it has no Stop, Resume or Merge.</p>;
  if (lane.state === "landed") return null;
  return (
    <div className="sq-actions">
      {canMerge(lane) ? <LaneActionButton type="merge" tone="amber" specId={lane.specId} acting={acting} dispatch={dispatch} localMerge={lane.localMerge} /> : null}
      {stopped ? <LaneActionButton type="resume" tone="primary" specId={lane.specId} acting={acting} dispatch={dispatch} /> : null}
      {(demo ? lane.state === "flying" : !stopped) ? <LaneActionButton type="stop" tone="plain" specId={lane.specId} acting={acting} dispatch={dispatch} /> : null}
      {demo ? <span className="sq-isolated">
        <Btn tone="danger" onClick={() => dispatch({ type: "cancel", specId: lane.specId })}>
          Cancel
        </Btn>
      </span> : null}
    </div>
  );
}

function SpecTitle({ lane }: { lane: Lane }) {
  const open = useOpen();
  return (
    <h3 className="sq-line-title">
      {lane.url ? (
        <button type="button" className="sq-issue-link" title="Open the spec" onClick={() => open.external(lane.url!, `the spec ${lane.specId}`)}>
          {lane.title}
        </button>
      ) : (
        lane.title
      )}
    </h3>
  );
}

/**
 * The narrow layout's lane: one compact row in place of the tail card. The
 * tail number, title and time on top; the Lead and its step, the PR, the lane
 * state (never "Flying", which the section already says) and the actions
 * below; the airstream as a thin pace line along its bottom edge. The branch
 * is the row's hover title and sits in the lane's ticket list.
 */
function LaneRow({ lane, dispatch, landing, demo, acting }: { lane: Lane; dispatch: (a: BoardAction) => void; landing: boolean; demo: boolean; acting: LaneAction | null }) {
  return (
    <div className="sq-lane-row" title={`Branch ${lane.branch}`}>
      <div className="sq-lane-row-top">
        <PixelText text={lane.specId} cell={2} className="sq-tail-number" />
        <SpecTitle lane={lane} />
        <span className="sq-time sq-num">{formatMinutes(lane.minutes)}</span>
      </div>
      <div className="sq-lane-row-foot">
        <LeadButton lane={lane} compact />
        <div className="sq-lane-row-end">
          {lane.state !== "flying" ? <span className="sq-lane-state" data-lane={lane.state}><Term text={LANE_LABEL[lane.state]} /></span> : null}
          {lane.state === "spec-review" ? <AiChip route={laneReviewer(lane)} prefix="Reviewer" compact /> : null}
          {lane.pr ? <PrChip pr={lane.pr} /> : null}
          {lane.outside ? <span className="sq-outside">Started outside Squadron</span> : null}
          {lane.outside ? null : <LaneActions lane={lane} dispatch={dispatch} demo={demo} acting={acting} />}
        </div>
      </div>
      {lane.outside ? <LaneActions lane={lane} dispatch={dispatch} demo={demo} acting={acting} /> : null}
      <PaceLine lane={lane} landing={landing} />
    </div>
  );
}

/** The same thin pace line in a narrow lane row and a wide tail card. */
function PaceLine({ lane, landing }: { lane: Lane; landing: boolean }) {
  const working = lane.workingThreads ?? 0;
  return <span className="sq-pace-line" data-pace={working} aria-hidden="true">
    {landing ? <DitherCanvas fx={{ kind: "burst" }} className="sq-air" /> : <DitherCanvas fx={{ kind: "airstream", pace: working }} className="sq-air" />}
  </span>;
}

function SortieLine({ lane, dispatch, landing, demo, acting = null }: { lane: Lane; dispatch: (a: BoardAction) => void; landing: boolean; demo: boolean; acting?: LaneAction | null }) {
  const open = useOpen();
  const columns = useMemo(() => dependencyColumns(lane.tickets), [lane.tickets]);
  const done = lane.tickets.filter((t) => t.state === "branch" || t.state === "done").length;
  // The airstream's pace: the lane's working threads. A lane with none working is still.
  const working = lane.workingThreads ?? 0;
  const [railRef, overflow] = useOverflow<HTMLDivElement>();
  // In a narrow layout the lane is one compact row, then slim active tickets, with every ticket behind a disclosure.
  const narrow = useContext(LayoutContext) === "narrow";
  const air = landing ? <DitherCanvas fx={{ kind: "burst" }} className="sq-air" /> : <DitherCanvas fx={{ kind: "airstream", pace: working }} className="sq-air" />;
  const others = lane.unmatchedThreads?.length ? (
    <div className="sq-threads">
      <span className="sq-threads-label">Other threads</span>
      <ul>
        {lane.unmatchedThreads.map((t) => (
          <li key={t.threadId}>
            <button type="button" className="sq-issue-link" title={`Open the thread ${open.where}`} onClick={() => open.thread(t.threadId, t.title || "the thread")}>
              {t.title || "Untitled thread"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  ) : null;
  if (narrow) {
    // The tickets a narrow lane keeps in view: those an agent is on, or that wait on the owner.
    const active = lane.tickets.filter((t) => isActiveTicket(t.state));
    return (
      <article className="sq-line" data-lane={lane.state} aria-label={`${lane.specId}, ${lane.title}: ${LANE_LABEL[lane.state]}`}>
        <LaneRow lane={lane} dispatch={dispatch} landing={landing} demo={demo} acting={acting} />
        <div className="sq-track">
          {active.length ? <div className="sq-active">{active.map((t) => <SlimTicketRow key={t.id} ticket={t} lane={lane} />)}</div> : null}
          <details className="sq-all">
            <summary>
              {lane.tickets.length === 1 ? "1 " : `All ${lane.tickets.length} `}<Term text={lane.tickets.length === 1 ? "ticket" : "tickets"} word="Ticket" nested />
              <span className="sq-all-count sq-num"> · {done} in branch</span>
            </summary>
            <ol>
              {lane.tickets.map((t) => (
                <li key={t.id} data-state={t.state}><span className="sq-id">{t.id}</span><span>{t.title}</span><span data-st={t.state}><Term text={TICKET_LABEL[t.state]} /></span></li>
              ))}
            </ol>
            <p className="sq-all-branch">Branch <span className="sq-branch">{lane.branch}</span></p>
          </details>
          {others}
        </div>
      </article>
    );
  }
  const progress = (
    <div className="sq-progress" role="img" aria-label={`${done} of ${lane.tickets.length} tickets in the branch`}>
      {lane.tickets.map((t) => (
        <span key={t.id} data-state={t.state} title={`${t.id}: ${TICKET_LABEL[t.state]}`} />
      ))}
      <span className="sq-progress-count sq-num">
        {done}/{lane.tickets.length} in branch
      </span>
      {working > 0 ? <span className="sq-pace sq-num"><i aria-hidden="true" />{working} working {working === 1 ? "thread" : "threads"}</span> : null}
    </div>
  );
  return (
    <article className="sq-line" data-lane={lane.state} aria-label={`${lane.specId}, ${lane.title}: ${LANE_LABEL[lane.state]}`}>
      <div className="sq-tail">
        <PixelText text={lane.specId} cell={4} className="sq-tail-number" />
        <SpecTitle lane={lane} />
        <LeadButton lane={lane} />
        <div className="sq-tail-status">
          {lane.state !== "flying" ? <span className="sq-lane-state" data-lane={lane.state}>
            <Term text={LANE_LABEL[lane.state]} />
          </span> : null}
          <span className="sq-time sq-num">{formatMinutes(lane.minutes)}</span>
        </div>
        {lane.state === "spec-review" ? <AiChip route={laneReviewer(lane)} prefix="Reviewer" /> : null}
        {lane.pr ? <PrChip pr={lane.pr} /> : null}
        {lane.outside ? <span className="sq-outside">Started outside Squadron</span> : null}
        <span className="sq-branch">{lane.branch}</span>
        <LaneActions lane={lane} dispatch={dispatch} demo={demo} acting={acting} />
        <PaceLine lane={lane} landing={landing} />
      </div>
      <div className="sq-track">
        {progress}
        {/* The rail scrolls; the columns inside it are as wide as the pegs, so the airstream runs under all of them. */}
        <div className="sq-rail" data-overflow={overflow} ref={railRef}>
          <div className="sq-columns">
            {air}
            {columns.map((col, i) => (
              <div key={i} className="sq-column">
                {i > 0 ? <Chevron className="sq-chevron" /> : null}
                <div className="sq-column-stack">
                  {col.map((t) => (
                    <Peg key={t.id} ticket={t} lane={lane} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        {others}
      </div>
    </article>
  );
}

const NEEDS_LABEL: Record<NeedsYouItem["kind"], string> = {
  setup: "Setup", waiting: "Question", failed: "Failed", blocked: "Blocked", stopped: "Stopped", merge: "Merge",
  "autopilot-paused": "Autopilot paused",
};

export function NeedsYouStrip({ items, dispatch, setUp, demo = false, acting = null, onAutopilotResume, autopilotSaving = false }: {
  items: NeedsYouItem[];
  dispatch: (a: BoardAction) => void;
  /** The Set up button, shown once, on the first missing-setup row. */
  setUp?: ReactNode;
  demo?: boolean;
  acting?: LaneAction | null;
  onAutopilotResume?: () => void;
  autopilotSaving?: boolean;
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
            {item.log ? <FileLink target={{ kind: "host", hostId: item.log.hostId, path: item.log.path }}>Check log</FileLink> : null}
            {item.kind === "autopilot-paused" ? <Btn tone="amber" disabled={autopilotSaving} onClick={onAutopilotResume}>Resume</Btn> : null}
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
            {item.kind === "merge" ? <LaneActionButton type="merge" tone="amber" specId={item.specId} acting={acting} dispatch={dispatch} localMerge={item.localMerge} /> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** An issue's title, opening its tracker record when the row is real. */
function IssueTitle({ title, url, className }: { title: string; url?: string; className: string }) {
  const open = useOpen();
  return url ? (
    <button type="button" className={`${className} sq-issue-link`} title="Open the issue" onClick={() => open.external(url, title)}>
      {title}
    </button>
  ) : (
    <span className={className}>{title}</span>
  );
}

/** A spec number on the band plate that list rows share; landed plates carry the renderer's green grain. */
function Plate({ id, landed = false }: { id: string; landed?: boolean }) {
  return (
    <span className="sq-plate" data-landed={landed}>
      {landed ? <DitherCanvas fx={{ kind: "plate" }} className="sq-fx" /> : null}
      <PixelText text={id} cell={2} className="sq-plate-id" />
    </span>
  );
}

function ReadyRow({ spec, board, dispatch, opening = false, startBusy = false, next = false }: { spec: ReadySpec; next?: boolean; board: Board; dispatch: (a: BoardAction) => void; opening?: boolean; startBusy?: boolean }) {
  // Real specs carry the board model's reason; the demo computes its own.
  const blocked = (spec.startReason !== undefined ? spec.startReason : canStart(board, spec))
    ?? (startBusy ? "Wait for the Lead thread to open." : null);
  const waiting = spec.waiting ?? [];
  const held = spec.held ?? [];
  const canStartNow = Math.max(0, spec.ticketCount - waiting.length - held.length);
  return (
    <li className="sq-row sq-ready" data-blocked={blocked !== null}>
      <Plate id={spec.id} />
      <div className="sq-row-main">
        <IssueTitle title={spec.title} url={spec.url} className="sq-row-title" />
        <div className="sq-row-meta">
          {next ? <span className="sq-tag" aria-label={`${spec.id} is next in the queue`}>Next</span> : null}
          {spec.waitingFor?.length ? <span>Waiting for {spec.waitingFor.map((blocker, i) => <Fragment key={blocker.id}>{i ? ", " : ""}<IssueTitle title={blocker.id} url={blocker.url} className="sq-issue-link" /></Fragment>)}</span> : null}
          <span className="sq-num"><b>{spec.ticketCount}</b> {spec.ticketCount === 1 ? "ticket" : "tickets"}</span>
          {waiting.length || held.length ? <span className="sq-frontier sq-num">{canStartNow} can start</span> : null}
          {spec.routes.length ? (
            <span className="sq-ready-routes">
              {spec.routes.map((r, i) => <AiChip key={i} route={r} />)}
            </span>
          ) : null}
          {spec.acceptOwner ? <span className="sq-tag">accept:owner</span> : null}
        </div>
        {waiting.length ? (
          <details className="sq-waits">
            <summary>{waiting.length} {waiting.length === 1 ? "waits" : "wait"} on blockers</summary>
            <ul className="sq-ready-waiting" aria-label={`Tickets of ${spec.id} that wait on blockers`}>
              {waiting.map((ticket) => (
                <li key={ticket.id} title={ticket.title}>
                  <span className="sq-mono">{ticket.id}</span> waits on {list(ticket.blockedBy)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {held.length ? (
          <details className="sq-waits">
            <summary>{held.length} <Term text="held" word="Held" nested /></summary>
            <ul className="sq-ready-waiting" aria-label={`Held tickets of ${spec.id}, which the Lead skips`}>
              {held.map((ticket) => (
                <li key={ticket.id} title={ticket.title}>
                  <span className="sq-mono">{ticket.id}</span> {ticket.title}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      <div className="sq-row-actions">
        {opening || blocked ? <span className="sq-why" role={opening ? "status" : undefined}>{opening ? "Opening its Lead thread" : blocked}</span> : null}
        <Btn tone="primary" disabled={opening || blocked !== null} title={blocked ?? `Start a lane for ${spec.id}`} onClick={() => dispatch({ type: "start", specId: spec.id })}>
          {opening ? "Opening…" : "Start"}
        </Btn>
      </div>
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
    <li className="sq-row sq-shaping">
      <Plate id={spec.id} />
      <div className="sq-row-main">
        <IssueTitle title={spec.title} url={spec.url} className="sq-row-title" />
        <div className="sq-row-meta">
          <span className="sq-missing" role={opening ? "status" : undefined}>
            {opening ? (spec.action === "resume" ? "Opening its planning thread" : "Starting a planning thread for its tickets") : spec.missing}
          </span>
          <span className="sq-num">{spec.ticketCount} {spec.ticketCount === 1 ? "ticket" : "tickets"}</span>
        </div>
      </div>
      <div className="sq-row-actions">
        <Btn tone="primary" disabled={opening} title={opening ? undefined : `${label} for ${spec.id}`}
          onClick={() => (spec.action === "resume" ? onPlan(spec.id) : onPlan(spec.id, "tickets"))}>
          {opening ? "Opening…" : spec.action === "resume" ? label : <>Plan <Term text="tickets" word="Ticket" nested /></>}
        </Btn>
      </div>
    </li>
  );
}

/** An empty section: how work gets into it, and the button that does it. */
function EmptySection({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="sq-empty">
      <p className="sq-clear">{text}</p>
      {action}
    </div>
  );
}

function OpenIssueRow({ issue, onPlan, opening }: { issue: OpenIssue; onPlan: Plan; opening: boolean }) {
  const meta = issue.priority || issue.labels.length || issue.under || opening;
  return (
    <li className="sq-row sq-open-issue">
      <span className="sq-open-issues-id sq-num">{issue.id}</span>
      <div className="sq-row-main">
        <IssueTitle title={issue.title} url={issue.url} className="sq-row-title" />
        {meta ? (
          <div className="sq-row-meta">
            {issue.priority ? <PriorityDot priority={issue.priority} /> : null}
            {issue.labels.map((l) => <span key={l} className="sq-tag">{l}</span>)}
            {issue.under ? <span className="sq-open-issues-under">{issue.under}</span> : null}
            {opening ? <span className="sq-why" role="status">Starting its planning thread</span> : null}
          </div>
        ) : null}
      </div>
      <div className="sq-row-actions">
        <Btn disabled={opening} title={opening ? `Opening the planning thread for ${issue.id}` : undefined} onClick={() => onPlan(issue.id)}>
          {opening ? "Opening…" : "Plan"}
        </Btn>
      </div>
    </li>
  );
}

/** When a landed lane landed, in the owner's local time. */
function landedWhen(at: number | undefined, now: number): string | null {
  if (at === undefined) return null;
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === date.toDateString() ? time : `${date.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

function LandedRow({ lane, fresh }: { lane: Lane; fresh: boolean }) {
  const when = landedWhen(lane.landedAt, Date.now());
  const proof = lane.pr?.state === "merged" ? `PR #${lane.pr.number} merged` : "Lane landed";
  return (
    <li className="sq-row sq-landed-row" data-fresh={fresh}>
      <Plate id={lane.specId} landed />
      <div className="sq-row-main">
        <IssueTitle title={lane.title} url={lane.url} className="sq-row-title" />
        <div className="sq-row-meta sq-num">
          <span>{proof}</span>
          {when ? <span>landed {when}</span> : null}
          <span>flew {formatMinutes(lane.minutes)}</span>
        </div>
      </div>
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

/** How long a landed line takes to fold away at the end of its burst, and how long its Landed row arrives for. */
const LEAVE_MS = 420;
const ARRIVE_MS = 900;

interface LandingPhase {
  /** The burst is playing on the lane's sortie line. */
  landing(lane: Lane): boolean;
  /** The burst's line is folding away. */
  leaving(lane: Lane): boolean;
  /** The lane has just arrived in Landed. */
  fresh(lane: Lane): boolean;
}

/** Which lanes are landing now. Each landing this view sees plays once, then the lane moves to Landed. */
function useLandings(lanes: Lane[]): LandingPhase {
  const seen = useRef<Landings | null>(null);
  // Folded in as each board arrives, so a lane never flashes into Landed before its burst.
  const landings = useMemo(() => (seen.current = nextLandings(seen.current, lanes, Date.now())), [lanes]);
  const [now, setNow] = useState(() => Date.now());
  const marks = Object.values(landings.until).flatMap((until) => [until - LEAVE_MS, until, until + ARRIVE_MS]).filter((at) => at > now);
  useEffect(() => {
    if (marks.length === 0) return;
    const t = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(...marks) - Date.now()) + 20);
    return () => window.clearTimeout(t);
  });
  const until = (lane: Lane) => (lane.state === "landed" ? landings.until[lane.specId] ?? 0 : 0);
  return {
    landing: (lane) => until(lane) > now,
    leaving: (lane) => until(lane) > now && now >= until(lane) - LEAVE_MS,
    fresh: (lane) => until(lane) > 0 && until(lane) <= now && now < until(lane) + ARRIVE_MS,
  };
}

/** Where this project's issues come from: the tracker-kind tag, then the source, in one muted line under the header. */
export interface TrackerInfo {
  kind: TrackerKind | null;
  /** Why the tracker is unknown, when it is. */
  note?: string | null;
}

function TrackerLine({ board, tracker, now }: { board: Board; tracker?: TrackerInfo; now: number }) {
  const status = board.tracker;
  const kind = tracker ? tracker.kind : status?.kind !== undefined ? status.kind : status ? "linear" : undefined;
  if (kind === undefined) return null;
  if (kind === "linear") {
    if (!status || status.state === "disconnected" || status.state === "unscoped") return null;
    const age = status.syncedAt === null ? null : Math.max(0, Math.round((now - status.syncedAt) / 60_000));
    const read = age === null ? "" : age === 0 ? "Read from Linear just now." : `Read from Linear ${formatMinutes(age)} ago.`;
    return (
      <p className="sq-trackerline sq-linear" data-state={status.state} role="status" aria-live="polite">
        <span className="sq-kind">Linear</span>
        {status.project ? <strong className="sq-linear-project">{status.project}</strong> : null}
        <span>{status.state === "current" ? read : status.state === "failed" ? `${status.message} ${read}` : status.message}</span>
      </p>
    );
  }
  if (kind === null) {
    // Doctor's full reason sits in Needs you; the line only says what's missing.
    return (
      <p className="sq-trackerline">
        <span className="sq-kind">No tracker</span>
        <strong>No tracker found</strong>
        {tracker?.note ? <span>{tracker.note}</span> : null}
      </p>
    );
  }
  return (
    <p className="sq-trackerline">
      <span className="sq-kind">{trackerName(kind)}</span>
      {kind === "local-markdown"
        ? <><strong>.scratch/</strong><span>on main · Flying lanes read from their integration branch</span></>
        : <><strong>GitHub Issues</strong><span>read through gh</span></>}
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

/** Doctor's verdict in a few words, for the header: what it means for Start. */
function doctorStatus(board: Board): { text: string; tone: "pass" | "fix" | "setup" } | null {
  if (!board.doctor) return null;
  if (needsSetup(board)) return { text: "Needs Set up", tone: "setup" };
  const fixes = board.doctor.checks.filter((check) => check.status === "fix").length;
  return fixes ? { text: `${fixes} to fix before Start`, tone: "fix" } : { text: "Start ready", tone: "pass" };
}

type Station = "open" | "shaping" | "ready" | "flying" | "landed";
const STATIONS: [Station, string][] = [["open", "Open issues"], ["shaping", "Shaping"], ["ready", "Ready"], ["flying", "Flying"], ["landed", "Landed"]];

/** The path in one strip: each station's count, in path order, jumping to its section. */
function PathStrip({ counts, onJump }: { counts: Record<Station, number | null>; onJump: (station: Station) => void }) {
  return (
    <nav className="sq-path" aria-label="The path">
      {STATIONS.map(([key, label]) => {
        const n = counts[key];
        return (
          <button key={key} type="button" className="sq-station" data-zero={!n} data-hot={key === "flying" && !!n} onClick={() => onJump(key)}>
            <span className="sq-station-label">
              {key === "open" ? <><span className="sq-station-long">{label}</span><span className="sq-station-short" aria-hidden="true">Open</span></> : <Term text={label} nested />}
            </span>
            <span className="sq-station-count sq-num">{n ?? "–"}</span>
            {key !== "landed" ? <Chevron className="sq-station-chev" /> : null}
          </button>
        );
      })}
    </nav>
  );
}

/** A section's label on its pixel rule, with its count. Needs you counts in amber. */
function SectionHead({ id, title, count, amber = false }: { id: string; title: string; count: number; amber?: boolean }) {
  return (
    <div className="sq-label">
      <h2 id={id}><Term text={title} /></h2>
      {count > 0 ? <span className={amber ? "sq-count-amber sq-num" : "sq-count sq-num"}>{count}</span> : null}
    </div>
  );
}

interface BoardViewProps {
  rootRef?: Ref<HTMLDivElement>;
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
  /** The shown project's tracker, for the tracker line; undefined while unknown. */
  tracker?: TrackerInfo;
  /** False until the live board's first read, so the formation mark never counts lanes it hasn't read. */
  lanesKnown?: boolean;
  autopilotSaving?: boolean;
  onAutopilotChange?: (patch: AutopilotChange) => void;
  onAutopilotResume?: () => void;
  footer?: ReactNode;
  /** The full page, or a thread's side panel: always the narrow layout, with thread links opening in the main view. */
  placement?: Placement;
}

/** The board page, fed by the live reader or by the synthetic simulation. */
export function BoardView({ rootRef, board, dispatch, demo, modeSwitch, onPlan, planning = null, starting = null, acting = null, onSetUp, settingUp = false, notice, diagnostic = null, projectButton, projectList, projectId, tracker, lanesKnown = true, autopilotSaving = false, onAutopilotChange, onAutopilotResume, footer, placement = "page" }: BoardViewProps) {
  const [doctorOpen, setDoctorOpen] = useState(false);
  const doctorId = useId();
  const [howOpen, setHowOpen] = useState(false);
  const howId = useId();
  const howButton = useRef<HTMLButtonElement>(null);
  const navigate = useBbNavigate();
  const reduced = usePrefersReducedMotion();
  const ownRef = useRef<HTMLDivElement | null>(null);
  const layout = boardLayout(placement, useWidth(ownRef));
  const setRoot = useCallback((el: HTMLDivElement | null) => {
    ownRef.current = el;
    if (typeof rootRef === "function") rootRef(el);
    else if (rootRef) rootRef.current = el;
  }, [rootRef]);
  const items = needsYou(board);
  const phase = useLandings(board.lanes);
  const flying = board.lanes.filter((l) => l.state !== "landed");
  const onLine = board.lanes.filter((l) => l.state !== "landed" || phase.landing(l));
  const landed = board.lanes.filter((l) => l.state === "landed" && !phase.landing(l));
  const startable = board.ready.find((spec) => (spec.startReason !== undefined ? spec.startReason : canStart(board, spec)) === null);
  const sections = useRef<Partial<Record<Station, HTMLElement | null>>>({});
  const jump = (station: Station) => sections.current[station]?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  // New spec starts the path from nothing; one planning thread opens at a time.
  const newSpec = (tone: "primary" | "plain" = "plain") => (
    <Btn tone={tone} disabled={planning === ""} title={planning === "" ? "Opening a planning thread" : "Plan a new spec from nothing"} onClick={() => onPlan()}>
      {planning === "" ? "Opening…" : <>New <Term text="spec" word="Spec" nested /></>}
    </Btn>
  );
  const doctor = doctorStatus(board);
  const setUpButton = onSetUp && needsSetup(board) ? (
    <>
      {settingUp ? <span className="sq-why" role="status">Starting the setup thread</span> : null}
      <Btn tone="amber" disabled={settingUp} title={settingUp ? "Opening the setup thread" : "Start a thread that sets this project up for Squadron"} onClick={onSetUp}>
        {settingUp ? "Opening…" : "Set up"}
      </Btn>
    </>
  ) : null;
  // While the board can't show Ready, Shaping and Open issues, their stations show a dash, not a false zero.
  const counts: Record<Station, number | null> = {
    open: notice ? null : board.openIssues.length, shaping: notice ? null : board.shaping.length, ready: notice ? null : board.ready.length,
    flying: flying.length, landed: landed.length,
  };

  return (
    <PlacementContext.Provider value={placement}>
    <LayoutContext.Provider value={layout}>
    <div ref={setRoot} className="sq" data-reduced={reduced} data-layout={layout}>
      <div className="sq-page">
        <header className="sq-head">
          <div className="sq-brand">
            {lanesKnown ? <FormationMark limit={board.laneCapacity} flying={flying.length} /> : null}
            <h1>Squadron</h1>
          </div>
          {projectButton || projectList ? <div className="sq-pick">{projectButton}{projectList}</div> : null}
          {demo ? (
            <span className="sq-tag" data-tone="amber">
              Synthetic data
            </span>
          ) : null}
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
            {!demo ? <HelperControl projectId={projectId ?? null} openThread={(id) => openThread(navigate, placement, id)} /> : null}
            {planning === "" ? <span className="sq-why" role="status">Starting a planning thread</span> : null}
            <button type="button" ref={howButton} className="sq-btn sq-how-open" aria-expanded={howOpen} aria-controls={howOpen ? howId : undefined}
              title="See how an idea becomes a merged pull request, and where you step in" onClick={() => setHowOpen((open) => !open)}>How it works</button>
            <button type="button" className="sq-doctor" data-status={doctor?.tone ?? "unknown"} aria-expanded={doctorOpen} aria-controls={doctorId}
              title={doctor ? `Doctor: ${doctor.text}` : "Check this repo's setup"} onClick={() => setDoctorOpen((open) => !open)}>
              Doctor{doctor ? <span className="sq-sr">: </span> : null}
              {doctor ? <span className="sq-doctor-word">{doctor.text}</span> : null}
            </button>
            {newSpec("primary")}
          </div>
        </header>
        {howOpen ? <HowItWorks id={howId} onClose={() => { setHowOpen(false); howButton.current?.focus(); }} /> : null}
        <TrackerLine board={board} tracker={tracker} now={Date.now()} />
        {!demo && board.autopilot ? <Autopilot state={board.autopilot} saving={autopilotSaving} onChange={onAutopilotChange} /> : null}
        {diagnostic ? <p className="sq-signal" role="status">{diagnostic}</p> : null}
        <PathStrip counts={counts} onJump={jump} />

        <section className="sq-section" aria-labelledby="sq-needs-h">
          <SectionHead id="sq-needs-h" title="Needs you" count={items.length} amber />
          <NeedsYouStrip items={items} dispatch={dispatch} setUp={setUpButton} demo={demo} acting={acting} onAutopilotResume={onAutopilotResume} autopilotSaving={autopilotSaving} />
          <DoctorPanel open={doctorOpen} id={doctorId} projectId={projectId} />
        </section>

        <section className="sq-section" aria-labelledby="sq-flying-h" ref={(el) => { sections.current.flying = el; }}>
          <SectionHead id="sq-flying-h" title="Flying" count={flying.length} />
          {onLine.length === 0 ? (
            <EmptySection text="Nothing is flying. Start a Ready spec to launch its lane." action={startable ? (
              <Btn tone="primary" disabled={starting !== null} onClick={() => dispatch({ type: "start", specId: startable.id })}>
                {starting === startable.id ? "Opening…" : `Start ${startable.id}`}
              </Btn>
            ) : newSpec()} />
          ) : (
            onLine.map((lane) => (
              <div key={lane.specId} data-live-lane={lane.state === "flying" ? lane.specId : undefined} className="sq-line-wrap" data-leaving={phase.leaving(lane)}>
                <SortieLine lane={lane} dispatch={dispatch} landing={phase.landing(lane)} demo={demo} acting={acting} />
              </div>
            ))
          )}
        </section>

        <section className="sq-section" aria-labelledby="sq-ready-h" ref={(el) => { sections.current.ready = el; }}>
          <SectionHead id="sq-ready-h" title="Ready" count={notice ? 0 : board.ready.length} />
          {notice ? (
            <p className="sq-clear">{notice}</p>
          ) : board.ready.length === 0 ? (
            <EmptySection text="No spec is Ready. A spec is Ready once it has the ready-for-agent label and an open ticket nothing blocks."
              action={newSpec()} />
          ) : (
            <ul className="sq-list">
              {board.ready.map((spec) => (
                <ReadyRow key={spec.id} next={startable?.id === spec.id} spec={spec} board={board} dispatch={dispatch} opening={starting === spec.id} startBusy={starting !== null} />
              ))}
            </ul>
          )}
        </section>

        <section className="sq-section" aria-labelledby="sq-shaping-h" ref={(el) => { sections.current.shaping = el; }}>
          <SectionHead id="sq-shaping-h" title="Shaping" count={notice ? 0 : board.shaping.length} />
          {notice ? null : board.shaping.length === 0 ? (
            <EmptySection text="No spec is being shaped. Plan an open issue, or start a new spec from nothing." action={newSpec()} />
          ) : (
            <ul className="sq-list">
              {board.shaping.map((spec) => (
                <ShapingRow key={spec.id} spec={spec} onPlan={onPlan} opening={planning === spec.id} />
              ))}
            </ul>
          )}
        </section>

        <section className="sq-section sq-open" aria-labelledby="sq-open-issues-h" ref={(el) => { sections.current.open = el; }}>
          <SectionHead id="sq-open-issues-h" title="Open issues" count={notice ? 0 : board.openIssues.length} />
          {notice ? null : board.openIssues.length === 0 ? (
            <EmptySection text="No open issues. Issues in this project that aren't specs or tickets wait here for Plan." action={newSpec()} />
          ) : (
            <ul className="sq-list">
              {board.openIssues.map((issue) => (
                <OpenIssueRow key={issue.id} issue={issue} onPlan={onPlan} opening={planning === issue.id} />
              ))}
            </ul>
          )}
        </section>

        <section className="sq-section sq-landed" aria-labelledby="sq-landed-h" ref={(el) => { sections.current.landed = el; }}>
          <SectionHead id="sq-landed-h" title="Landed" count={landed.length} />
          {landed.length === 0 ? (
            <EmptySection text="Nothing has landed yet. A lane lands when its PR merges or, in a repo with no remote, when its integration branch merges into main." />
          ) : (
            <ul className="sq-list">
              {landed.map((lane) => <LandedRow key={lane.specId} lane={lane} fresh={phase.fresh(lane)} />)}
            </ul>
          )}
        </section>

        {footer}
      </div>
    </div>
    </LayoutContext.Provider>
    </PlacementContext.Provider>
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
  // The labelled simulation has synthetic Lead/worker threads instead of BB thread records.
  const board = { ...sim.board, lanes: sim.board.lanes.map((lane) => ({ ...lane,
    workingThreads: lane.state === "stopped" || lane.state === "landed" ? 0
      : 1 + lane.tickets.filter((ticket) => ticket.state === "working" || ticket.state === "review").length,
  })) };
  return (
    <BoardView
      board={board}
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
  const status = state.board.tracker?.state;
  if (status === "disconnected") return "Connect Linear to see this project's issues.";
  if (status === "unscoped") return "Set this project's Linear Scope in docs/agents/squadron.md to see its issues.";
  if (status === "catching-up" && state.board.tracker?.syncedAt === null) {
    const kind = state.board.tracker.kind;
    return kind ? `Reading this project's issues from ${trackerName(kind)}.` : "Reading this project's issues from Linear.";
  }
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

/** Merge a PR or ask the Lead to merge locally, then read the board again. */
export async function mergeFromBoard(deps: {
  merge: (input: { projectId: string; specId: string }) => Promise<{ number: number } | { threadId: string }>;
  notify: (text: string) => void;
  refresh: () => Promise<void>;
}, projectId: string, specId: string) {
  try {
    const merged = await deps.merge({ projectId, specId });
    deps.notify("threadId" in merged ? `Asked the Lead for ${specId} to merge locally. The lane lands when the merge is confirmed.`
      : `Squash-merged PR #${merged.number} for ${specId}. The lane lands when BB sees the merge.`);
  } catch (error) {
    deps.notify(error instanceof Error && error.message ? error.message : `Couldn't merge ${specId}'s PR. Try again.`);
  } finally { await deps.refresh(); }
}

/** How often the page reads the project it shows. The server polls only shown projects. */
const POLL_MS = LIVE_STEP_MS;

/** The real board for the project the owner picked, read from the reader. `context` is the project the
 * surface opens on: BB's sidebar selection on the full page, the thread's project in its side panel. */
export function LiveBoard({ modeSwitch, context, placement = "page" }: { modeSwitch: ReactNode; context: string | null; placement?: Placement }) {
  const rpc = useRpc<typeof boardContract & typeof planningContract & typeof setupContract & typeof laneContract & typeof autopilotContract>();
  const open = useOpen();
  const [listed, setListed] = useState<PickerProjects | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerId = useId();
  // Other projects' counts become available only when the picker opens.
  const [counts, setCounts] = useState<ProjectCounts | null>(null);
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
  const [autopilotSaving, setAutopilotSaving] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [planning, setPlanning] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [acting, setActing] = useState<LaneAction | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [failed, setFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const shown = useRef("");
  const load = useCallback(async (refreshLive = false) => {
    if (!projectId || document.visibilityState === "hidden") return;
    const root = rootRef.current;
    const box = root?.getBoundingClientRect();
    const visibleLaneIds = root && box ? Array.from(root.querySelectorAll<HTMLElement>("[data-live-lane]"))
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.bottom > Math.max(0, box.top) && bounds.top < Math.min(window.innerHeight, box.bottom);
      }).map((element) => element.dataset.liveLane!) : [];
    const current = ++request.current;
    try {
      const next = await rpc.call("board", { projectId, visibleLaneIds, refreshLive });
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
  // After the first board arrives, read just the lanes whose rows are on screen.
  const laneKey = board?.lanes.filter((lane) => lane.state === "flying").map((lane) => lane.specId).join("\n") ?? "";
  useEffect(() => { if (laneKey) void load(); }, [laneKey, load]);
  // Poll only the project this page shows, and only while the page is visible.
  useEffect(() => {
    if (!projectId) return;
    const id = window.setInterval(() => { void load(); }, POLL_MS);
    const visible = () => { if (document.visibilityState !== "hidden") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", visible); };
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
    if (payload.projectId === projectId) void load(true);
  }, invalid);
  useSquadronSignal(linearConnectionChanged, () => { loadSoon(); }, invalid);
  const changeAutopilot = useCallback(async (patch: AutopilotChange) => {
    if (!projectId || autopilotSaving) return;
    setAutopilotSaving(true);
    try {
      const state = await rpc.call("autopilot.set", { projectId, ...patch });
      request.current++;
      shown.current = "";
      setBoard((board) => board ? { ...board, autopilot: state, laneCapacity: state.laneLimit, autoStart: state.status === "on" } : board);
    }
    catch (error) { toast(error instanceof Error && error.message ? error.message : "Couldn't save Autopilot. Try again."); }
    finally { setAutopilotSaving(false); void load(); }
  }, [rpc, projectId, autopilotSaving, load]);
  const resumeAutopilot = useCallback(async () => {
    if (!projectId || autopilotSaving) return;
    setAutopilotSaving(true);
    try {
      const state = await rpc.call("autopilot.resume", { projectId });
      request.current++;
      shown.current = "";
      setBoard((board) => board ? { ...board, autopilot: state, laneCapacity: state.laneLimit, autoStart: state.status === "on" } : board);
    }
    catch (error) { toast(error instanceof Error && error.message ? error.message : "Couldn't resume Autopilot. Try again."); }
    finally { setAutopilotSaving(false); void load(); }
  }, [rpc, projectId, autopilotSaving, load]);
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
  // The open picker closes on Escape or a click outside it, unless it's asking for a project.
  useEffect(() => {
    if (!pickerOpen) return;
    const away = (event: PointerEvent) => { if (!(event.target instanceof Element && event.target.closest(".sq-pick"))) setPickerOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setPickerOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", escape); };
  }, [pickerOpen]);
  const notice = liveNotice({ projectId, board, failed });
  const projectName = listed?.projects.find((item) => item.id === projectId)?.name ?? null;
  const row = counts?.projects.find((item) => item.id === projectId);
  const trackerKind = board?.tracker?.kind !== undefined ? board.tracker.kind : row?.tracker;
  const shownCounts = board ? { ready: board.ready.length, flying: board.lanes.filter((lane) => lane.state !== "landed").length } : null;
  return (
    <BoardView
      rootRef={rootRef}
      projectId={projectId}
      tracker={board?.tracker?.kind !== undefined ? { kind: board.tracker.kind, note: board.tracker.message } : row ? { kind: row.tracker, note: row.note } : undefined}
      projectButton={listed ? <ProjectButton name={projectName} meta={pickerMeta(trackerKind, shownCounts)} open={pickerOpen || asking} controls={pickerId} onToggle={() => setPickerOpen((value) => !value)} /> : null}
      projectList={listed && (pickerOpen || asking) ? <ProjectListLoader id={pickerId} projects={listed.projects} current={projectId} onPick={pick} onCounts={setCounts} /> : null}
      lanesKnown={board !== null}
      onSetUp={() => void setUp()}
      settingUp={settingUp}
      autopilotSaving={autopilotSaving}
      onAutopilotChange={(patch) => void changeAutopilot(patch)}
      onAutopilotResume={() => void resumeAutopilot()}
      diagnostic={diagnostic}
      board={board ?? EMPTY_BOARD}
      demo={false}
      placement={placement}
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
    />
  );
}

export function BoardPage() {
  const context = useBbContext().projectId;
  const [demo, setDemo] = useState(false);
  const modeSwitch = <DemoSwitch on={demo} onChange={setDemo} />;
  return demo ? <DemoBoard modeSwitch={modeSwitch} /> : <LiveBoard modeSwitch={modeSwitch} context={context} />;
}
