"use client";

import { useQuery } from "@tanstack/react-query";
import { candles as candleLib } from "@verdant/sdk";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  allRangeFor,
  asFloat,
  axisScaleFor,
  compactEth,
  formatInstant,
  parseSeries,
  CHART_RANGES,
  DEFAULT_RANGE,
  POLL_MILLISECONDS,
  type AxisScale,
  type SerializedSeries,
} from "../../lib/candles";

/**
 * A market's value over the span a reader chooses.
 *
 * This is the page. The headline above the line is the largest thing on the token page,
 * the timeframe strip is the only control beside it, and everything below is arranged
 * around the assumption that this figure is what somebody arrived for.
 *
 * ## What is drawn, and what is not
 *
 * The line is a market capitalisation rather than a price per token. A price on a young
 * market is `0.00000000209` and an axis cannot be labelled with a column of those;
 * supply is fixed for the life of an Agen token, so the two curves are the same shape and
 * the conversion is one multiplication. `valueScale` carries it.
 *
 * The series arrives gapless — a bucket nobody traded in still has a price, because a
 * pool holds whatever the last trade left it at — and the filling happens on the server.
 * This component does no filling and must not: a client that invented points would be
 * inventing prices.
 *
 * Prices cross the wire as `bigint` at 36 decimals and are converted to floats only for
 * the canvas, which needs far less precision than a pixel. Every figure a reader *reads*
 * is formatted from the integer.
 *
 * ## The three empty states are different and say so
 *
 * A market that has not launched has no pool. A market that has launched into an
 * unconfigured or unreachable indexer has a pool and no history we can see. A market
 * with both has no trades yet. Collapsing those into one "no data" message would tell a
 * visitor that nothing has traded when in fact our indexer is down, which is a claim
 * about the market rather than about us.
 */

export interface ChartProps {
  /** The build id, which is how this app's own routes address a market. */
  readonly marketId: string;
  readonly live: boolean;
  /** Rendered on the server, so the first paint has a line in it. Null when there is none. */
  readonly initial: SerializedSeries | null;
  /** Whether this deployment knows where the indexer is at all. */
  readonly feedConfigured: boolean;
  /**
   * Turns a price per token into the capitalisation the chart draws: the whole supply.
   * Null falls back to drawing the price itself.
   */
  readonly valueScale: number | null;
  /** Chain time and the market's birthday, for the range that means "everything". */
  readonly at: number;
  readonly createdAt: number;
  /** Shown as the headline when there is no series to take one from. */
  readonly fallbackHeadline: string;
}

/** The colours the canvas is handed, read from the stylesheet at mount. */
interface Palette {
  readonly rise: string;
  readonly riseSoft: string;
  readonly fall: string;
  readonly fallSoft: string;
  readonly text: string;
  readonly faint: string;
  readonly line: string;
  readonly grid: string;
}

/**
 * A colour as `rgba()`, whatever notation it was written in.
 *
 * The chart library parses colours itself rather than letting the canvas do it, and its
 * parser is older than several CSS colour functions. Rather than keep a second
 * hand-converted palette here to drift from the one in `globals.css`, the browser is
 * asked: a one-pixel canvas understands everything CSS can express, so painting the
 * colour and reading the pixel back converts anything into the four numbers the library
 * wants.
 *
 * The sentinel detects an unparseable value: assigning a colour the canvas rejects leaves
 * `fillStyle` untouched, so a result identical to the sentinel means the conversion did
 * not happen and the caller's fallback should stand.
 */
const SENTINEL = "#ff00ff";

function toRgba(value: string): string | null {
  if (value === "") return null;

  const context = document.createElement("canvas").getContext("2d");
  if (context === null) return null;

  context.fillStyle = SENTINEL;
  context.fillStyle = value;
  if (context.fillStyle === SENTINEL) return null;

  context.clearRect(0, 0, 1, 1);
  context.fillRect(0, 0, 1, 1);

  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (red === undefined || green === undefined || blue === undefined || alpha === undefined) {
    return null;
  }

  return `rgba(${String(red)}, ${String(green)}, ${String(blue)}, ${(alpha / 255).toFixed(3)})`;
}

/** The theme's own colours, so the chart cannot drift from the rest of the sheet. */
function readPalette(element: HTMLElement): Palette {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string): string =>
    toRgba(style.getPropertyValue(name).trim()) ?? fallback;

  return {
    rise: token("--up", "rgba(22, 163, 74, 1)"),
    riseSoft: "rgba(22, 163, 74, 0.14)",
    fall: token("--down", "rgba(220, 38, 38, 1)"),
    fallSoft: "rgba(220, 38, 38, 0.12)",
    text: token("--text", "rgba(10, 10, 10, 1)"),
    faint: token("--text-faint", "rgba(154, 154, 160, 1)"),
    line: token("--line", "rgba(230, 230, 232, 1)"),
    // Fainter than a border, but not so faint it is absent: at 0.045 on white the
    // dashes did not survive the canvas and the chart had no horizontals at all, which
    // is the one thing they exist for — reading a point on the line against the axis
    // without tracking across the gap.
    grid: "rgba(0, 0, 0, 0.085)",
  };
}

export function Chart({
  marketId,
  live,
  initial,
  feedConfigured,
  valueScale,
  at,
  createdAt,
  fallbackHeadline,
}: ChartProps) {
  /** Every span on offer, with "everything" sized from how old this market is. */
  const ranges = useMemo(
    () => [...CHART_RANGES, allRangeFor(at - createdAt, candleLib.CANDLE_INTERVALS)],
    [at, createdAt],
  );

  const [rangeId, chooseRange] = useState(DEFAULT_RANGE.id);
  const range = ranges.find((entry) => entry.id === rangeId) ?? DEFAULT_RANGE;

  const [ready, setReady] = useState(false);
  /** What the crosshair is over, or null when the cursor is elsewhere. */
  const [hovered, setHovered] = useState<{ at: number; price: bigint } | null>(null);

  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const area = useRef<ISeriesApi<"Area"> | null>(null);

  /*
   * The axis formatter is handed to a chart that outlives every series it draws, so it
   * reads the current scale and multiplier through refs rather than closing over whichever
   * ones were current when the chart was created.
   */
  const scale = useRef<AxisScale>({ significant: 3, minMove: 1e-12 });
  const scaleValue = useRef<number | null>(valueScale);
  useEffect(() => {
    scaleValue.current = valueScale;
  }, [valueScale]);

  const labelPrice = useRef((value: number): string =>
    compactEth(scaleValue.current === null ? value : value * scaleValue.current),
  ).current;

  // The server rendered one span and the rest are fetched. `initialData` is given only
  // for that one, so choosing another shows a load rather than the previous series
  // relabelled at a scale it was not drawn at.
  const { data, isPending, isError } = useQuery({
    queryKey: ["agen-candles", marketId, range.id],
    queryFn: async (): Promise<SerializedSeries | null> => {
      const response = await fetch(
        `/api/markets/${marketId}/candles?interval=${range.interval}&limit=${String(range.buckets)}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`the feed answered ${String(response.status)}`);
      return ((await response.json()) as { series: SerializedSeries | null }).series;
    },
    ...(range.id === DEFAULT_RANGE.id && initial !== null ? { initialData: initial } : {}),
    refetchInterval: POLL_MILLISECONDS,
    // A token page is often left open in a background tab, and a chart that resumed
    // hours behind is worse than one that reloads when looked at.
    refetchOnWindowFocus: true,
    // Nothing to poll for a market with no pool, and no indexer to poll without one.
    enabled: live && feedConfigured,
  });

  const series = useMemo(
    () => (data === undefined || data === null ? null : parseSeries(data).candles),
    [data],
  );

  const points = useMemo(
    () =>
      (series ?? []).map((candle) => ({
        time: candle.start as UTCTimestamp,
        value: asFloat(candle.close),
      })),
    [series],
  );

  /** The integer prices, so a readout shows the price rather than a rounded float. */
  const byTime = useMemo(() => {
    const map = new Map<number, bigint>();
    for (const candle of series ?? []) map.set(candle.start, candle.close);
    return map;
  }, [series]);

  /*
   * The crosshair handler is registered once on a chart that outlives every series it
   * draws, so it cannot close over `byTime` — it would read the map from the render it
   * was created in for as long as the page is open.
   */
  const byTimeRef = useRef(byTime);
  useEffect(() => {
    byTimeRef.current = byTime;
  }, [byTime]);

  const summary = useMemo(() => {
    if (series === null || series.length === 0) return null;

    const opened = series[0]!;
    const closed = series[series.length - 1]!;

    let low = opened.low;
    let high = opened.high;
    let trades = 0;
    for (const candle of series) {
      if (candle.low < low) low = candle.low;
      if (candle.high > high) high = candle.high;
      trades += candle.trades;
    }

    // Over the window shown rather than over a day: the reader chose the window, and a
    // figure that ignored the choice would contradict the line above it.
    const change =
      opened.open === 0n
        ? null
        : (Number(closed.close - opened.open) / Number(opened.open)) * 100;

    return { from: opened.start, to: closed.start, price: closed.close, low, high, trades, change };
  }, [series]);

  const rising = summary?.change == null || summary.change >= 0;

  // --- the chart, created once and then fed ----------------------------------------

  useEffect(() => {
    const element = container.current;
    if (element === null) return;

    let disposed = false;

    void (async () => {
      const { AreaSeries, ColorType, CrosshairMode, LineStyle, createChart } = await import(
        "lightweight-charts"
      );
      if (disposed) return;

      const palette = readPalette(element);

      const created = createChart(element, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: "rgba(0, 0, 0, 0)" },
          textColor: palette.faint,
          fontFamily: getComputedStyle(element).fontFamily,
          attributionLogo: false,
        },
        // Horizontals only. They are what let somebody put a point on the line against a
        // figure on the axis without tracking across the gap, which is most of what this
        // chart is read for; verticals add nothing but ink.
        grid: {
          vertLines: { visible: false },
          horzLines: { color: palette.grid, style: LineStyle.Dashed },
        },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.08 } },
        timeScale: {
          borderVisible: false,
          timeVisible: true,
          secondsVisible: false,
          // The line reaches the right edge, because its last point is now.
          rightOffset: 0,
          fixLeftEdge: true,
        },
        crosshair: {
          mode: CrosshairMode.Magnet,
          vertLine: {
            color: palette.line,
            width: 1,
            style: LineStyle.Solid,
            // The time is written into the readout above the chart instead, where it can
            // be typeset like the rest of the page.
            labelVisible: false,
          },
          horzLine: {
            color: palette.line,
            width: 1,
            style: LineStyle.Solid,
            labelBackgroundColor: palette.text,
          },
        },
        localization: { priceFormatter: labelPrice },
      });

      const line = created.addSeries(AreaSeries, {
        lineWidth: 2,
        lineColor: palette.rise,
        topColor: palette.riseSoft,
        bottomColor: "rgba(0, 0, 0, 0)",
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerBorderWidth: 0,
        crosshairMarkerRadius: 4,
        priceFormat: { type: "custom", formatter: labelPrice, minMove: scale.current.minMove },
      });

      created.subscribeCrosshairMove((move) => {
        const time = typeof move.time === "number" ? move.time : undefined;
        const price = time === undefined ? undefined : byTimeRef.current.get(time);
        setHovered(time === undefined || price === undefined ? null : { at: time, price });
      });

      chart.current = created;
      area.current = line;
      setReady(true);
    })();

    return () => {
      disposed = true;
      chart.current?.remove();
      chart.current = null;
      area.current = null;
      setReady(false);
    };
    // `labelPrice` is held in a ref and never changes, so this still builds one chart for
    // the life of the component. It is listed because it is used, not because it varies.
  }, [labelPrice]);

  // The data, and the two colours that depend on which way it went.
  useEffect(() => {
    const line = area.current;
    const element = container.current;
    if (line === null || element === null || !ready) return;

    const palette = readPalette(element);

    /*
     * Before `applyOptions`, which redraws the axis through the formatter that reads it.
     *
     * The two halves come from different sets of numbers on purpose. `minMove` is the
     * smallest step the library should distinguish and is expressed in the units of the
     * series, which are raw prices whatever the axis is labelled in. `significant` is how
     * many digits a *label* needs to differ from the one above it, judged on the figures
     * actually printed.
     */
    const raw = points.map((point) => point.value);
    const shownValues = valueScale === null ? raw : raw.map((value) => value * valueScale);
    scale.current = {
      significant: axisScaleFor(shownValues).significant,
      minMove: axisScaleFor(raw).minMove,
    };

    line.applyOptions({
      lineColor: rising ? palette.rise : palette.fall,
      topColor: rising ? palette.riseSoft : palette.fallSoft,
      priceFormat: { type: "custom", formatter: labelPrice, minMove: scale.current.minMove },
    });

    line.setData(points);
    chart.current?.timeScale().fitContent();
  }, [points, rising, ready, labelPrice, valueScale]);

  const shown = hovered?.price ?? summary?.price;

  const headline =
    shown === undefined
      ? fallbackHeadline
      : `${compactEth(valueScale === null ? asFloat(shown) : asFloat(shown) * valueScale)} ETH`;

  /** A stored price in whatever unit the chart is currently drawing. */
  const label = (price: bigint): string =>
    compactEth(valueScale === null ? asFloat(price) : asFloat(price) * valueScale);

  const empty =
    !live
      ? "This token has not launched, so it has no price history."
      : !feedConfigured
        ? "The price history is unavailable: this deployment has no indexer configured. The market is unaffected — it lives in contracts and trades through any interface."
        : isPending
          ? "Loading the price history."
          : isError || data === null
            ? "The price history is unavailable: the feed did not answer. The market is unaffected."
            : "Nothing has traded yet, so there is no price to draw.";

  return (
    <section className="chart">
      <header className="chart-head">
        <div>
          <p className="chart-label">{valueScale === null ? "price" : "market cap"}</p>

          {/* An em dash set at headline size reads as a heavy black bar rather than as
              a missing number, so an absent figure is drawn in the muted weight the
              rest of the page uses for one. */}
          <p className={shown === undefined ? "chart-headline absent" : "chart-headline"}>
            {headline}
          </p>

          <p className="chart-sub">
            {summary?.change == null ? null : (
              <span className={rising ? "up" : "down"}>
                {summary.change >= 0 ? "+" : "−"}
                {Math.abs(summary.change).toFixed(2)}%
              </span>
            )}
            <span className="chart-span">
              {hovered === null ? range.label : formatInstant(hovered.at)}
            </span>
          </p>
        </div>

        <div className="chart-ranges" role="tablist" aria-label="timeframe">
          {ranges.map((entry) => (
            <button
              type="button"
              role="tab"
              key={entry.id}
              aria-selected={range.id === entry.id}
              className={range.id === entry.id ? "on" : ""}
              onClick={() => {
                chooseRange(entry.id);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </header>

      <div className="chart-body">
        <div ref={container} className="chart-canvas" />

        {points.length === 0 ? <p className="chart-empty">{empty}</p> : null}
      </div>

      <footer className="chart-foot">
        <span>{summary === null ? "" : formatInstant(summary.from)}</span>
        <span className="chart-extremes">
          {summary === null
            ? ""
            : `low ${label(summary.low)} · high ${label(summary.high)} · ${String(summary.trades)} ${
                summary.trades === 1 ? "trade" : "trades"
              }`}
        </span>
        <span>{summary === null ? "" : formatInstant(summary.to)}</span>
      </footer>
    </section>
  );
}
