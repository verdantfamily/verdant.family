"use client";

import { formatInstant, formatPrice } from "@verdant/ui";
import { useMemo, useState } from "react";

import { Segmented } from "./form";

/**
 * Price history, from trades rather than from candles.
 *
 * Every point is a swap: the price the pool reported at the moment it executed. There is
 * no interpolation and no resampling, so a quiet market draws a sparse line rather than a
 * smooth one that implies trading nobody did. A market with one trade has one point and
 * gets a flat line, which is the truth about it.
 *
 * The window buttons filter what is plotted; they do not fetch. A range with no trades in
 * it says so instead of stretching the last known price across it, because a horizontal
 * line at the right edge of a chart reads as stability rather than as silence.
 */

export interface PricePoint {
  readonly timestamp: number;
  /**
   * Units of the market's quote asset per token, scaled by `PRICE_PRECISION`, as
   * `quotePerToken` returns it. The chart never converts, so every point in one series
   * must have been derived with the same quote decimals.
   */
  readonly price: bigint;
}

type Window = "hour" | "day" | "week" | "all";

const WINDOWS: readonly { readonly value: Window; readonly label: string; readonly seconds: number }[] =
  [
    { value: "hour", label: "1H", seconds: 3_600 },
    { value: "day", label: "1D", seconds: 86_400 },
    { value: "week", label: "1W", seconds: 604_800 },
    { value: "all", label: "All", seconds: Number.MAX_SAFE_INTEGER },
  ];

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 200;

export function PriceChart({
  points,
  at,
  quoteLabel,
}: {
  readonly points: readonly PricePoint[];
  /** Chain time the page was rendered at, so a window means the same thing server-side. */
  readonly at: number;
  /**
   * What the price is denominated in. Required rather than defaulted to ether, because
   * a default would be right for most markets and silently wrong for the rest — and a
   * price labelled with the wrong asset is worse than one with no label.
   */
  readonly quoteLabel: string;
}) {
  const [window, setWindow] = useState<Window>("all");

  const shown = useMemo(() => {
    const seconds = WINDOWS.find((entry) => entry.value === window)?.seconds ?? 0;
    if (window === "all") return points;
    return points.filter((point) => point.timestamp >= at - seconds);
  }, [points, window, at]);

  const geometry = useMemo(() => {
    if (shown.length === 0) return null;

    const prices = shown.map((point) => point.price);
    let low = prices[0]!;
    let high = prices[0]!;
    for (const price of prices) {
      if (price < low) low = price;
      if (price > high) high = price;
    }

    const first = shown[0]!.timestamp;
    const last = shown[shown.length - 1]!.timestamp;
    const span = last - first;

    // Numbers, not bigints, and only here: these are pixel coordinates. The prices
    // themselves stay integers everywhere they are compared or displayed.
    const spread = Number(high - low);
    const base = Number(low);

    const coordinates = shown.map((point, index) => {
      const x =
        span === 0
          ? shown.length === 1
            ? VIEW_WIDTH
            : (index / (shown.length - 1)) * VIEW_WIDTH
          : ((point.timestamp - first) / span) * VIEW_WIDTH;
      // A flat series would divide by zero, and belongs in the middle of the band.
      const y =
        spread === 0
          ? VIEW_HEIGHT / 2
          : VIEW_HEIGHT - ((Number(point.price) - base) / spread) * (VIEW_HEIGHT - 16) - 8;
      return { x, y };
    });

    const line = coordinates.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
    const area = `${coordinates[0]!.x.toFixed(2)},${VIEW_HEIGHT} ${line} ${coordinates[coordinates.length - 1]!.x.toFixed(2)},${VIEW_HEIGHT}`;

    return { line, area, low, high, first, last, rising: prices[prices.length - 1]! >= prices[0]! };
  }, [shown]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5">
        <div>
          <p className="text-[0.7rem] font-medium uppercase tracking-wider text-ink-muted">
            Price
          </p>
          <p className="numeric mt-1 text-[1.5rem] leading-none text-ink">
            {points.length === 0
              ? "—"
              : `${formatPrice(points[points.length - 1]!.price)} ${quoteLabel}`}
          </p>
        </div>
        <Segmented
          size="small"
          value={window}
          onChange={setWindow}
          options={WINDOWS.map((entry) => ({ value: entry.value, label: entry.label }))}
        />
      </div>

      {geometry === null ? (
        <p className="px-6 py-14 text-center text-[0.82rem] text-ink-muted">
          {points.length === 0
            ? "Nothing has traded yet, so there is no price history to draw."
            : "No trades in this window."}
        </p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Price history, ${shown.length} trades`}
            className="mt-4 h-48 w-full"
          >
            <defs>
              <linearGradient id="price-fill" x1="0" y1="0" x2="0" y2="1">
                {/* A shade more than the light theme used. The fill is read against the
                    card it lies on, and a card here is itself translucent over a dark
                    photograph, so the same alpha had less to work with. */}
                <stop
                  offset="0%"
                  stopColor={geometry.rising ? "var(--color-rise)" : "var(--color-fall)"}
                  stopOpacity="0.24"
                />
                <stop
                  offset="100%"
                  stopColor={geometry.rising ? "var(--color-rise)" : "var(--color-fall)"}
                  stopOpacity="0"
                />
              </linearGradient>
            </defs>

            <polygon points={geometry.area} fill="url(#price-fill)" />
            <polyline
              points={geometry.line}
              fill="none"
              stroke={geometry.rising ? "var(--color-rise)" : "var(--color-fall)"}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-6 py-3 text-[0.72rem] text-ink-muted">
            <span>{formatInstant(geometry.first)}</span>
            <span className="numeric">
              low {formatPrice(geometry.low)} · high {formatPrice(geometry.high)} ·{" "}
              {shown.length} {shown.length === 1 ? "trade" : "trades"}
            </span>
            <span>{formatInstant(geometry.last)}</span>
          </div>
        </>
      )}
    </div>
  );
}
