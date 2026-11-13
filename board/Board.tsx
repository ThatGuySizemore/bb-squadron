import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { experimental_ProviderIcon as ProviderIcon, experimental_useProviders as useProviders, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Board, Lane, LaneState, NeedsYouItem, ReadySpec, Route, Ticket, TicketState, UnplannedIssue } from "../lib/board-model";
import { dependencyColumns, formatMinutes, needsYou, reviewerFor } from "../lib/board-model";
import { apply, canStart, initialBoard, resetSimulation, step } from "../lib/fake-board";
import type { BoardAction } from "../lib/fake-board";
import { DITHER_VARS, layoutPixels } from "../lib/pixels";
import { DoctorPanel } from "./Doctor";

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

/** Three slots in a V: the lanes the board can fly at once. */
function FormationMark({ flying, capacity }: { flying: number; capacity: number }) {
  const chevron = ["  #  ", " # # ", "#   #"];
  const slots: Array<[number, number]> = [
    [7, 0],
    [0, 5],
    [14, 5],
  ];
  return (
    <svg
      role="img"
      aria-label={`${flying} of ${capacity} lanes flying`}
      width={21 * 4}
      height={9 * 4}
      viewBox="0 0 21 9"
      shapeRendering="crispEdges"
      className="sq-formation"
    >
      {slots.slice(0, capacity).map(([ox, oy], i) =>
        chevron.flatMap((row, y) =>
          [...row].map((c, x) =>
            c === "#" ? (
              <rect key={`${i}.${x}.${y}`} x={ox + x + 1} y={oy + y + 1} width={1} height={1} className={i < flying ? "sq-formation-on" : "sq-formation-off"} />
            ) : null,
          ),
        ),
      )}
    </svg>
  );
}

function Dither({ levels }: { levels: number[] }) {
  return (
    <span className="sq-dither" aria-hidden="true">
      {levels.map((level, i) => (
        <span key={i} className="sq-dither-layer" style={{ maskImage: `var(--sq-d${level})`, WebkitMaskImage: `var(--sq-d${level})`, animationDelay: `${(-i * 2.4) / levels.length}s` } as CSSProperties} data-layers={levels.length} />
      ))}
    </span>
  );
}

/** Pixels sweep along the sortie line when a spec lands. */
function Burst() {
  const bits = useMemo(
    () =>
      Array.from({ length: 28 }, (_, i) => ({
        dx: 120 + ((i * 53) % 760),
        dy: ((i * 29) % 37) - 18,
        size: i % 4 === 0 ? 4 : 2,
        delay: (i % 7) * 35,
      })),
    [],
  );
  return (
    <span className="sq-burst" aria-hidden="true">
      {bits.map((b, i) => (
        <span key={i} style={{ "--dx": `${b.dx}px`, "--dy": `${b.dy}px`, width: b.size, height: b.size, animationDelay: `${b.delay}ms` } as CSSProperties} />
      ))}
    </span>
  );
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

function PriorityDot({ priority }: { priority: UnplannedIssue["priority"] }) {
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
  "pr-open": "PR open",
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
      else window.open(url, "_blank", "noopener");
    },
  };
}

// ---------- the board ----------

function Peg({ ticket, lane }: { ticket: Ticket; lane: Lane }) {
  const open = useOpen();
  const reviewer = reviewerFor(ticket.route);
  const state = ticket.state;
  const levels =
    state === "working" ? [2, 3, 5] : state === "question" ? [2, 4, 6, 4] : state === "review" ? [2] : state === "branch" ? [3] : state === "failed" || state === "done" ? [4] : [];
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
        <Dither levels={levels} />
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
      {levels.length > 0 ? <Dither levels={levels} /> : null}
      <span className="sq-peg-top">
        <span className="sq-peg-id">{ticket.id}</span>
        <span className="sq-peg-state">{sub}</span>
      </span>
      {state === "blocked" ? <span className="sq-peg-after sq-num">after {waitsOn.join(", ") || "blockers"}</span> : null}
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
    <div className="sq-peg" data-size={size} data-state={state} aria-label={`${ticket.id}, ${ticket.title}: ${state === "blocked" ? `waits on ${waitsOn.join(", ")}` : sub}`}>
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

function SortieLine({ lane, dispatch, landing }: { lane: Lane; dispatch: (a: BoardAction) => void; landing: boolean }) {
  const open = useOpen();
  const columns = useMemo(() => dependencyColumns(lane.tickets), [lane.tickets]);
  const done = lane.tickets.filter((t) => t.state === "branch" || t.state === "done").length;
  const [railRef, overflow] = useOverflow<HTMLDivElement>();
  return (
    <article className="sq-line" data-lane={lane.state} aria-label={`${lane.specId}, ${lane.title}: ${LANE_LABEL[lane.state]}`}>
      {landing ? <Burst /> : null}
      <div className="sq-tail">
        <PixelText text={lane.specId} cell={4} className="sq-tail-number" />
        <h3 className="sq-line-title">{lane.title}</h3>
        <button type="button" className="sq-lead" onClick={() => open.thread(lane.leadThreadId, `the Lead thread for ${lane.specId}`)}>
          <AiChip route={lane.lead} prefix="Lead" />
        </button>
        <div className="sq-tail-status">
          <span className="sq-lane-state" data-lane={lane.state}>
            {LANE_LABEL[lane.state]}
          </span>
          <span className="sq-time sq-num">{formatMinutes(lane.minutes)}</span>
        </div>
        {lane.state === "spec-review" ? <AiChip route={reviewerFor(lane.lead)} prefix="Reviewer" /> : null}
        {lane.pr ? (
          <button type="button" className="sq-pr" data-checks={lane.pr.checks} onClick={() => open.external(lane.pr!.url, `PR #${lane.pr!.number} on GitHub`)}>
            <span className="sq-pr-dot" aria-hidden="true" />
            PR #{lane.pr.number}
            <span className="sq-pr-checks">{lane.pr.checks === "passing" ? "checks pass" : lane.pr.checks === "failing" ? "checks fail" : "checks running"}</span>
          </button>
        ) : null}
        <span className="sq-branch">{lane.branch}</span>
        {lane.state !== "landed" ? (
          <div className="sq-actions">
            {lane.state === "merge-waits" ? (
              <Btn tone="amber" onClick={() => dispatch({ type: "merge", specId: lane.specId })}>
                Merge
              </Btn>
            ) : null}
            {lane.state === "stopped" ? (
              <Btn tone="primary" onClick={() => dispatch({ type: "resume", specId: lane.specId })}>
                Resume
              </Btn>
            ) : null}
            {lane.state === "flying" ? <Btn onClick={() => dispatch({ type: "stop", specId: lane.specId })}>Stop</Btn> : null}
            <span className="sq-isolated">
              <Btn tone="danger" onClick={() => dispatch({ type: "cancel", specId: lane.specId })}>
                Cancel
              </Btn>
            </span>
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
      </div>
    </article>
  );
}

const NEEDS_LABEL = { question: "Question", stopped: "Stopped", merge: "Merge" } as const;

function NeedsYouStrip({ items, dispatch }: { items: NeedsYouItem[]; dispatch: (a: BoardAction) => void }) {
  const open = useOpen();
  if (items.length === 0) {
    return <p className="sq-clear">Nothing needs you. Every lane is flying on its own.</p>;
  }
  return (
    <ul className="sq-needs">
      {items.map((item) => (
        <li key={item.key} className="sq-need" data-kind={item.kind}>
          <Dither levels={[3, 6, 3]} />
          <span className="sq-need-kind">{NEEDS_LABEL[item.kind]}</span>
          <PixelText text={item.ticketId ?? item.specId} cell={2} className="sq-need-id" />
          <span className="sq-need-text">{item.text}</span>
          <span className="sq-need-actions">
            {item.kind === "question" ? (
              <Btn
                tone="amber"
                onClick={() => {
                  open.thread(item.threadId, `the worker thread for ${item.ticketId}`);
                  window.setTimeout(() => dispatch({ type: "answer", ticketId: item.ticketId! }), 900);
                }}
              >
                Answer in thread
              </Btn>
            ) : null}
            {item.kind === "stopped" ? (
              <>
                <Btn tone="amber" onClick={() => dispatch({ type: "resume", specId: item.specId })}>
                  Resume
                </Btn>
                <Btn onClick={() => toast(`Prototype: opens a planning thread on ${item.specId}.`)}>Re-plan</Btn>
              </>
            ) : null}
            {item.kind === "merge" ? (
              <Btn tone="amber" onClick={() => dispatch({ type: "merge", specId: item.specId })}>
                Merge
              </Btn>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ReadyRow({ spec, board, dispatch }: { spec: ReadySpec; board: Board; dispatch: (a: BoardAction) => void }) {
  const blocked = canStart(board, spec);
  return (
    <li className="sq-ready" data-blocked={blocked !== null}>
      <PixelText text={spec.id} cell={2} className="sq-ready-id" />
      <span className="sq-ready-title">{spec.title}</span>
      <span className="sq-ready-meta sq-num">{spec.ticketCount} tickets</span>
      <span className="sq-ready-routes">
        {spec.routes.map((r, i) => (
          <AiChip key={i} route={r} />
        ))}
      </span>
      {spec.acceptOwner ? <span className="sq-tag">accept:owner</span> : <span />}
      <span className="sq-ready-why">{blocked ?? ""}</span>
      <Btn tone="primary" disabled={blocked !== null} title={blocked ?? `Start a lane for ${spec.id}`} onClick={() => dispatch({ type: "start", specId: spec.id })}>
        Start
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

const LANDING_MS = 1600;

/** Re-renders once a landing's burst window has passed. */
function useLandingClock(lanes: Lane[]): number {
  const [now, setNow] = useState(() => Date.now());
  const pending = lanes.filter((l) => l.landedAt !== undefined && now - l.landedAt < LANDING_MS);
  useEffect(() => {
    if (pending.length === 0) return;
    const until = Math.min(...pending.map((l) => l.landedAt! + LANDING_MS));
    const t = window.setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()) + 20);
    return () => window.clearTimeout(t);
  });
  return Math.max(now, ...lanes.map((l) => l.landedAt ?? 0));
}

export function BoardPage() {
  const [sim, send] = useReducer(simReducer, undefined, () => ({ board: initialBoard(), playing: true, speed: 1 as const }));
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    if (!sim.playing) return;
    const id = window.setInterval(() => send({ type: "tick" }), sim.speed === 3 ? 700 : 2100);
    return () => window.clearInterval(id);
  }, [sim.playing, sim.speed]);
  const board = sim.board;
  const dispatch = (action: BoardAction) => send({ type: "board", action });
  const items = needsYou(board);
  const now = useLandingClock(board.lanes);
  const isLanding = (l: Lane) => l.state === "landed" && l.landedAt !== undefined && now - l.landedAt < LANDING_MS;
  const flying = board.lanes.filter((l) => l.state !== "landed");
  const onLine = board.lanes.filter((l) => l.state !== "landed" || isLanding(l));
  const landed = board.lanes.filter((l) => l.state === "landed" && !isLanding(l));
  const openTickets = flying.reduce((n, l) => n + l.tickets.filter((t) => t.state !== "branch" && t.state !== "done").length, 0);

  return (
    <div className="sq" style={DITHER_VARS as CSSProperties} data-reduced={reduced}>
      <div className="sq-page">
        <header className="sq-head">
          <div className="sq-head-title">
            <h1>Squadron</h1>
            <FormationMark flying={flying.length} capacity={board.laneCapacity} />
          </div>
          <p className="sq-head-counts sq-num">
            {flying.length} of {board.laneCapacity} lanes flying · {openTickets} tickets open · {items.length} {items.length === 1 ? "needs" : "need"} you
          </p>
          <div className="sq-head-actions">
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
            <Btn tone="primary" onClick={() => toast("Prototype: opens a planning thread (grill-with-docs → to-spec → to-tickets).")}>
              Plan a spec
            </Btn>
          </div>
        </header>

        <DoctorPanel />

        <section className="sq-section" aria-labelledby="sq-needs-h">
          <h2 id="sq-needs-h">
            Needs you {items.length > 0 ? <span className="sq-count sq-num">{items.length}</span> : null}
          </h2>
          <NeedsYouStrip items={items} dispatch={dispatch} />
        </section>

        <section className="sq-section" aria-labelledby="sq-flying-h">
          <h2 id="sq-flying-h">Flying</h2>
          {onLine.length === 0 ? (
            <p className="sq-clear">No lanes flying. Start a ready spec below.</p>
          ) : (
            onLine.map((lane) => <SortieLine key={lane.specId} lane={lane} dispatch={dispatch} landing={isLanding(lane)} />)
          )}
        </section>

        <section className="sq-section" aria-labelledby="sq-ready-h">
          <h2 id="sq-ready-h">Ready</h2>
          {board.ready.length === 0 ? (
            <p className="sq-clear">No specs are ready. Plan one from Unplanned.</p>
          ) : (
            <ul className="sq-ready-list">
              {board.ready.map((spec) => (
                <ReadyRow key={spec.id} spec={spec} board={board} dispatch={dispatch} />
              ))}
            </ul>
          )}
        </section>

        <section className="sq-section" aria-labelledby="sq-unplanned-h">
          <h2 id="sq-unplanned-h">Unplanned</h2>
          <ul className="sq-unplanned">
            {board.unplanned.map((issue) => (
              <li key={issue.id}>
                <PriorityDot priority={issue.priority} />
                <span className="sq-unplanned-id sq-num">{issue.id}</span>
                <span className="sq-unplanned-title">{issue.title}</span>
                <span className="sq-unplanned-labels">
                  {issue.labels.map((l) => (
                    <span key={l} className="sq-tag">
                      {l}
                    </span>
                  ))}
                </span>
                <Btn onClick={() => toast(`Prototype: opens a planning thread on ${issue.id}.`)}>Plan</Btn>
              </li>
            ))}
          </ul>
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
      </div>
    </div>
  );
}
