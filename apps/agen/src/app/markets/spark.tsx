import { useId } from "react";

import { sparkArea } from "../lib/spark-path";

/**
 * A token's price, as a line — where there is one.
 *
 * The slot is always the same height so a shelf of cards keeps its rhythm, but the line
 * is drawn only from real points. Nothing has traded yet, so almost every card shows the
 * empty state instead, and that is the point: a plausible sparkline is indistinguishable
 * from a real one, and a launchpad that invents a shape once cannot be believed about any
 * of the shapes it draws afterwards.
 */
export function Spark({
  points,
  area = false,
}: {
  readonly points?: readonly number[] | undefined;
  /**
   * A filled chart rather than a hairline. The Spotlight is the only caller: a 46-pixel
   * card spark has no room for a fill that can be read as a shape.
   */
  readonly area?: boolean;
}) {
  const rawId = useId();

  if (points === undefined || points.length < 2) {
    return <span className={area ? "ax-spark-flat ax-spark-flat-area" : "ax-spark-flat"}>No price history yet</span>;
  }

  if (area) {
    return <AreaSpark points={points} rawId={rawId} />;
  }

  const low = Math.min(...points);
  const high = Math.max(...points);
  const span = high - low;

  // A flat series has no range to normalise against, so it is drawn down the middle
  // rather than divided by zero into a line of NaNs.
  const y = (value: number): number => (span === 0 ? 50 : 100 - ((value - low) / span) * 100);
  const step = 100 / (points.length - 1);

  const path = points
    .map((value, index) => `${index === 0 ? "M" : "L"}${(index * step).toFixed(2)} ${y(value).toFixed(2)}`)
    .join(" ");

  const rising = points[points.length - 1]! >= points[0]!;
  const stroke = rising ? "var(--ax-up)" : "var(--ax-down)";

  return (
    <svg
      className="ax-spark"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={path}
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function AreaSpark({
  points,
  rawId,
}: {
  readonly points: readonly number[];
  readonly rawId: string;
}) {
  const drawn = sparkArea(points);
  if (drawn === null) {
    return <span className="ax-spark-flat ax-spark-flat-area">No price history yet</span>;
  }

  const stroke = drawn.rising ? "var(--spark-up)" : "var(--spark-down)";
  const fillId = `ax-spark-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <span className="ax-spark-plot">
      <svg
        className="ax-spark ax-spark-area"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
            <stop offset="42%" stopColor={stroke} stopOpacity="0.1" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={drawn.area} fill={`url(#${fillId})`} />
        <path
          d={drawn.line}
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span
        className="ax-spark-tip"
        style={{
          left: `${drawn.lastX}%`,
          top: `${drawn.lastY}%`,
          background: stroke,
        }}
      />
    </span>
  );
}
