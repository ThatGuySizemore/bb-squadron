import { useMemo } from "react";
import { layoutPixels } from "../lib/pixels.js";

/** The board's shared 5x7 lettering, with an accessible text copy. */
/** `decorative` draws only the glyphs, for a caller that gives the whole text its own accessible copy. */
export function PixelText({ text, cell = 3, gap, className, decorative = false }: { text: string; cell?: number; gap?: number; className?: string; decorative?: boolean }) {
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
      {decorative ? null : <span className="sq-sr">{text}</span>}
    </span>
  );
}
