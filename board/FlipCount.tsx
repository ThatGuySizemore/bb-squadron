// A count whose digits flip when it changes, one after another from the units
// up: the Landed count, as each lane lands. The number is read once, whole; the
// faces are decoration. A first show and reduced motion draw no flip.
import { useRef, type ReactNode } from "react";

/** The pause between one digit's flip and the next one's, in milliseconds. */
const STAGGER_MS = 90;

export function FlipCount({ value, digit, className }: { value: number; digit: (d: string) => ReactNode; className?: string }) {
  // The last two values this count showed; a changed digit is one that differs from the value before.
  const seen = useRef<{ before: string | null; now: string }>({ before: null, now: String(value) });
  if (seen.current.now !== String(value)) seen.current = { before: seen.current.now, now: String(value) };
  const { before, now } = seen.current;
  const digits = [...now];
  return (
    <span className={className}>
      <span className="sq-flip" aria-hidden="true">
        {digits.map((d, i) => {
          const place = digits.length - 1 - i;
          const was = before === null ? d : before[before.length - 1 - place];
          const flip = was !== d;
          // A changed digit gets a new key, so React mounts a new face and its flip plays.
          return (
            <span key={`${place}:${flip ? `${d}:${before}` : d}`} className="sq-flip-digit" data-flip={flip}
              style={flip ? { animationDelay: `${place * STAGGER_MS}ms` } : undefined}>{digit(d)}</span>
          );
        })}
      </span>
      <span className="sq-sr">{now}</span>
    </span>
  );
}
