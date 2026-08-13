/**
 * A token's price, as a line — where there is one.
 *
 * The slot is always the same height so a shelf of cards keeps its rhythm, but the line
 * is drawn only from real points. Nothing has traded yet, so almost every card shows the
 * empty state instead, and that is the point: a plausible sparkline is indistinguishable
 * from a real one, and a launchpad that invents a shape once cannot be believed about any
 * of the shapes it draws afterwards.
 */
export function Spark({ points }: { readonly points?: readonly number[] | undefined }) {
  if (points === undefined || points.length < 2) {
    return <span className="ax-spark-flat">No price history yet</span>;
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
        stroke={rising ? "var(--ax-up)" : "var(--ax-down)"}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
