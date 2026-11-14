// SQD-204: "How Squadron works", opened from the board header. One diagram of
// the path from an idea to a merged pull request, who does each part and where
// the owner steps in, then a few short lines. Owner words only.
import { useEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Term } from "./Term.js";
import "./how.css";

type Stop = { key: string; name: ReactNode; who: string; you?: ReactNode };

const STOPS: Stop[] = [
  { key: "plan", name: "Plan", who: "You and an agent", you: "You plan it" },
  { key: "spec", name: <Term text="Spec" />, who: "The agent splits it into tickets" },
  { key: "ready", name: <Term text="Ready" />, who: "Squadron shows it once a ticket can start" },
  { key: "lane", name: <Term text="Lane" />, who: "A Lead and its workers build it", you: "You answer questions" },
  { key: "landed", name: <Term text="Landed" />, who: "The Lead opens one pull request", you: <>You merge <code>accept:owner</code> work</> },
];

/** The path's 6x10 pixel chevron on 2px cells. */
function Chevron() {
  return (
    <svg className="sq-how-chev" aria-hidden="true" width={6} height={10} viewBox="0 0 6 10" shapeRendering="crispEdges">
      {[[0, 0], [2, 2], [4, 4], [2, 6], [0, 8]].map(([x, y]) => <rect key={y} x={x} y={y} width={2} height={2} />)}
    </svg>
  );
}

export function HowItWorks({ id, onClose }: { id: string; onClose: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
  };
  return (
    <section id={id} className="sq-how" aria-label="How Squadron works" onKeyDown={onKeyDown}>
      <div className="sq-label sq-how-head">
        <h2 ref={heading} tabIndex={-1}>How Squadron works</h2>
        <button type="button" className="sq-btn" onClick={onClose}>Close</button>
      </div>
      <ol className="sq-how-path" aria-label="From an idea to a merged pull request">
        {STOPS.map((stop, i) => (
          <li key={stop.key} className="sq-how-stop" data-stop={stop.key}>
            <h3 className="sq-how-name">{stop.name}</h3>
            <span className="sq-how-rule" aria-hidden="true">{i < STOPS.length - 1 ? <Chevron /> : null}</span>
            <p className="sq-how-who">{stop.who}</p>
            {stop.you ? <p className="sq-how-you">{stop.you}</p> : null}
          </li>
        ))}
      </ol>
      <ul className="sq-how-lines">
        <li>Press Start on a <Term text="ready" word="Ready" /> spec to open its <Term text="lane" word="Lane" />.</li>
        <li>Workers each build one <Term text="ticket" word="Ticket" />, and the lane runs without you.</li>
        <li>Anything that needs you waits at the top of the <Term text="board" word="Board" />, in <Term text="Needs you" />.</li>
        <li>Talk to the <Term text="Helper" /> about your project, and ask it to act for you.</li>
        <li>Hover an underlined word to see what it means.</li>
      </ul>
    </section>
  );
}
