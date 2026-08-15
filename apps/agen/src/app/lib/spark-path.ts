import { CURVE_TOLERANCE, curveOvershoot } from "./candles";

/** A Spotlight-sized area chart: the line, the fill under it, and where the tip sits. */
export interface SparkArea {
  readonly line: string;
  readonly area: string;
  readonly lastX: number;
  readonly lastY: number;
  readonly rising: boolean;
  /**
   * Whether the spline's control points were clamped to each segment.
   *
   * The token page refuses to curve when a cardinal spline would invent a high or a low.
   * The Spotlight still wants a smooth line at that size, so the same check decides
   * whether the handles may leave the segment — not whether the line is drawn straight.
   */
  readonly clamped: boolean;
}

const TENSION = 6;

/**
 * A series as a cubic path in a viewBox, using the same cardinal spline as the token page.
 *
 * `LineType.Curved` in lightweight-charts is this formula. When it would overshoot the
 * data, the handles are clamped to the segment so the line stays smooth without drawing
 * a price nobody paid.
 */
export function sparkArea(
  values: readonly number[],
  width = 100,
  height = 100,
): SparkArea | null {
  if (values.length < 2 || width <= 0 || height <= 0) return null;
  if (values.some((value) => !Number.isFinite(value))) return null;

  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  const padX = 1.4;
  const padTop = 10;
  const padBottom = 4;
  const innerW = Math.max(1, width - padX * 2);
  const innerH = Math.max(1, height - padTop - padBottom);

  const yOf = (value: number): number =>
    padTop + (span === 0 ? innerH / 2 : (1 - (value - low) / span) * innerH);

  const step = innerW / (values.length - 1);
  const points = values.map((value, index) => ({
    x: padX + index * step,
    y: yOf(value),
  }));

  const clamped = curveOvershoot(values) > CURVE_TOLERANCE;
  const line = cubicPath(points, clamped);
  const last = points[points.length - 1]!;

  return {
    line,
    area: `${line} L ${width.toFixed(2)} ${height.toFixed(2)} L 0 ${height.toFixed(2)} Z`,
    lastX: last.x,
    lastY: last.y,
    rising: values[values.length - 1]! >= values[0]!,
    clamped,
  };
}

function cubicPath(
  points: readonly { readonly x: number; readonly y: number }[],
  clamp: boolean,
): string {
  const first = points[0]!;
  let path = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;

  for (let i = 0; i < points.length - 1; i += 1) {
    const before = points[Math.max(0, i - 1)]!;
    const from = points[i]!;
    const to = points[i + 1]!;
    const after = points[Math.min(points.length - 1, i + 2)]!;

    const c1x = from.x + (to.x - before.x) / TENSION;
    const c2x = to.x - (after.x - from.x) / TENSION;
    let c1y = from.y + (to.y - before.y) / TENSION;
    let c2y = to.y - (after.y - from.y) / TENSION;

    if (clamp) {
      const lo = Math.min(from.y, to.y);
      const hi = Math.max(from.y, to.y);
      c1y = Math.min(hi, Math.max(lo, c1y));
      c2y = Math.min(hi, Math.max(lo, c2y));
    }

    path += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
  }

  return path;
}
