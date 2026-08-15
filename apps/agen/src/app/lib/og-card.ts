/**
 * What a shared token link claims, in words and as a picture.
 *
 * A crawler never runs the page. It reads `og:title`, `og:description` and `og:image`,
 * and those three are the whole product for anyone who has not clicked yet. The root
 * layout's card is the brand; this module is the per-token card — name, capitalisation,
 * the same line the page draws — so a link to `$VECST` does not look like a link to the
 * homepage.
 *
 * The image itself is drawn in `markets/[id]/opengraph-image.tsx`. This file is the
 * arithmetic and the copy, kept here so a test can check a path and a sentence without
 * standing up Satori.
 */

import { asFloat } from "./candles";

const UP = "#17c06b";
const DOWN = "#b4232a";
const UP_FILL = "rgba(23, 192, 107, 0.16)";
const DOWN_FILL = "rgba(180, 35, 42, 0.14)";

/** `$SYMBOL — Name`, which is what a card's title is for. */
export function shareTitle(symbol: string, name: string): string {
  return `$${symbol} — ${name}`;
}

/**
 * The sentence under the title.
 *
 * The creator's own line first, because that is what they wrote the token to say. A
 * capitalisation is appended when we have one, so a preview that never loads the image
 * still tells a reader what the market is worth. The fallback is the name, not a brand
 * slogan — a missing description is not a reason to advertise Agen over the token.
 */
export function shareDescription(input: {
  readonly headline: string;
  readonly name: string;
  readonly symbol: string;
  readonly marketCap: string | null;
}): string {
  const said = input.headline.trim();
  const lead = said === "" ? `${input.name} ($${input.symbol}) on agen.space.` : said;
  if (input.marketCap === null) return lead.endsWith(".") ? lead : `${lead}.`;
  const prefix = lead.endsWith(".") ? lead : `${lead}.`;
  return `${prefix} Market cap ${input.marketCap}.`;
}

/** The image's alt, which is the title plus where it lives. */
export function shareAlt(symbol: string, name: string): string {
  return `${shareTitle(symbol, name)} on agen.space`;
}

/**
 * Closes worth drawing on a share card.
 *
 * Same trim as the shelf sparkline: drop the leading flat before anyone traded, keep a
 * short carried-forward tail so a quiet market still shows that it went quiet. A single
 * point is not a line and is refused.
 */
export function chartValues(
  candles: readonly { readonly close: bigint; readonly traded: boolean }[] | null,
): readonly number[] | undefined {
  if (candles === null || candles.length === 0) return undefined;

  let first = candles.findIndex((candle) => candle.traded);
  if (first < 0) return undefined;

  let last = candles.length - 1;
  while (last > first && !candles[last]!.traded) last -= 1;

  first = Math.max(0, first - 1);
  const active = last - first + 1;
  const end = Math.min(candles.length - 1, last + active);
  const values = candles.slice(first, end + 1).map((candle) => asFloat(candle.close));
  return values.length < 2 ? undefined : values;
}

/** The line, the fill under it, and the colour that says whether the span rose. */
export interface AreaChart {
  readonly line: string;
  readonly area: string;
  readonly lastX: number;
  readonly lastY: number;
  readonly stroke: string;
  readonly fill: string;
  readonly rising: boolean;
}

/**
 * A series as two SVG paths, in the box the share card gives the chart.
 *
 * A flat series (every close the same) is drawn through the middle rather than divided
 * by zero into a line of NaNs. Colour follows the span, not the last tick: a card that
 * is shared is a picture of the window, and a window that closed lower than it opened
 * is red even if the last two buckets ticked up.
 */
export function areaChart(
  values: readonly number[],
  width: number,
  height: number,
): AreaChart | null {
  if (values.length < 2 || width <= 0 || height <= 0) return null;
  if (values.some((value) => !Number.isFinite(value))) return null;

  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  const padTop = 18;
  const padBottom = 10;
  const inner = Math.max(1, height - padTop - padBottom);

  const yOf = (value: number): number =>
    padTop + (span === 0 ? inner / 2 : (1 - (value - low) / span) * inner);

  const step = width / (values.length - 1);
  const points = values.map((value, index) => ({
    x: index * step,
    y: yOf(value),
  }));

  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");

  const last = points[points.length - 1]!;
  const rising = values[values.length - 1]! >= values[0]!;

  return {
    line,
    area: `${line} L ${width.toFixed(2)} ${height.toFixed(2)} L 0 ${height.toFixed(2)} Z`,
    lastX: last.x,
    lastY: last.y,
    stroke: rising ? UP : DOWN,
    fill: rising ? UP_FILL : DOWN_FILL,
    rising,
  };
}
