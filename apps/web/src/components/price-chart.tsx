"use client";

import { formatInstant, formatPrice, priceChangeBps } from "@verdant/ui";
import { useQuery } from "@tanstack/react-query";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  allRangeFor,
  asFloat,
  asPrice,
  axisScaleFor,
  parseSeries,
  CHART_RANGES,
  DEFAULT_RANGE,
  POLL_MILLISECONDS,
  type AxisScale,
  type SerializedSeries,
} from "../lib/candles";
import { formatUsdPrecise, formatUsdSignificant } from "../lib/usd";
import { Segmented } from "./form";
import { LiveValue } from "./live-value";

/**
 * A market's price, over the interval a reader chooses.
 *
 * ## Where the line comes from
 *
 * The indexer buckets swaps into candles and this draws their closes. Two consequences
 * are worth knowing while reading the code below.
 *
 * A bucket nobody traded in still has a price, because a constant-function pool holds
 * whatever the last trade left it at until somebody moves it. So the series arrives
 * gapless, already filled by `candles.fill` on the server, and the line is continuous
 * rather than dotted with holes. The chart does no filling of its own and must not: a
 * client that invented points would be inventing prices.
 *
 * And a price is a `bigint` scaled by 10^36, because a token here can be worth 10^-14 of
 * an ether. Only the canvas sees floats — `lightweight-charts` takes numbers, and at
 * these magnitudes a double has far more precision than a pixel needs. Every price a
 * reader *reads* is formatted from the integer, which is what `byTime` is for.
 *
 * ## Why the library
 *
 * It brings the crosshair, the axes, the autoscaling and the pan and zoom that a chart is
 * expected to have and that were not worth writing again. It is loaded inside the effect
 * rather than imported at the top for two reasons: it touches `document` as it
 * initialises, and it is 45kB that a reader who never scrolls here should not pay for.
 */

export interface PriceChartProps {
  readonly poolId: string;
  /** Rendered on the server, so the first paint has a line in it. */
  readonly initial: SerializedSeries;
  /** What the price is denominated in: this market's quote asset, never assumed. */
  readonly quoteLabel: string;
  /**
   * Multiplies a price into the figure the chart actually draws.
   *
   * The line is a market capitalisation rather than a price per token, because a price per
   * token on a market like this is `0.00000000209` and no axis can be labelled with a
   * column of those. Supply is fixed for the life of a Verdant token — there is no mint
   * and no burn — so the two curves are the same shape and this is one multiplication:
   * whole tokens, times the dollar rate where there is one.
   *
   * `null` leaves the chart drawing the price in the quote asset, which is what an
   * equity-quoted market gets, since no dollar rate reaches it.
   */
  readonly valueScale: number | null;
  /** Chain time and the market's birthday, for the range that means "everything". */
  readonly at: number;
  readonly createdAt: number;
  /**
   * How much room the chart is being given, and therefore how loud it is allowed to be.
   *
   * `hero` is for a chart that is the top of a page rather than one card in a row of
   * them: the readout is set at headline size, the canvas is given a much taller floor,
   * and the horizontal padding comes off because at that size the chart sits directly on
   * the page instead of inside a bordered card.
   *
   * This is a property of the composition, not of the data, which is why it is a prop
   * rather than something the component works out. The same series is drawn either way.
   */
  readonly size?: "default" | "hero";
}

/** The colours the canvas is handed, read from the stylesheet at mount. */
interface Palette {
  readonly rise: string;
  readonly riseSoft: string;
  readonly fall: string;
  readonly fallSoft: string;
  readonly ink: string;
  readonly inkFaint: string;
  readonly border: string;
  readonly grid: string;
}

/**
 * A colour as `rgba()`, whatever notation it was written in.
 *
 * The theme is authored in `oklch`, and the library parses colours itself rather than
 * letting the canvas do it — its parser predates `oklch` and throws on one, which takes
 * the whole chart down and leaves the axis unlabelled. Rather than keep a second,
 * hand-converted palette in this file to drift from the first, the browser is asked: a
 * one-pixel canvas *does* understand `oklch`, so painting the colour and reading the
 * pixel back converts anything CSS can express into the four numbers the library wants.
 *
 * The sentinel is how an unparseable value is detected: assigning a colour a canvas
 * rejects leaves `fillStyle` untouched, so a result identical to the sentinel means the
 * conversion did not happen and the caller's fallback should stand.
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

  return `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(3)})`;
}

/**
 * The theme's own colours, converted.
 *
 * Read from the cascade so that every colour in the interface stays declared in
 * `globals.css`. The fallbacks are for the case where this runs before the stylesheet
 * applies: the same hues, in the notation the library has always parsed.
 */
function readPalette(element: HTMLElement): Palette {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string): string =>
    toRgba(style.getPropertyValue(name).trim()) ?? fallback;

  return {
    rise: token("--color-rise", "rgba(122, 222, 168, 1)"),
    riseSoft: token("--color-rise-soft", "rgba(122, 222, 168, 0.26)"),
    fall: token("--color-fall", "rgba(255, 150, 138, 1)"),
    fallSoft: token("--color-fall-soft", "rgba(255, 150, 138, 0.26)"),
    ink: token("--color-ink", "rgba(255, 255, 255, 1)"),
    inkFaint: token("--color-ink-faint", "rgba(255, 255, 255, 0.46)"),
    border: token("--color-border", "rgba(255, 255, 255, 0.12)"),
    // Fainter than a border. A gridline is meant to be found when looked for and not
    // noticed otherwise, and `--color-border` at this density reads as a table.
    grid: "rgba(255, 255, 255, 0.06)",
  };
}

export function PriceChart({
  poolId,
  initial,
  quoteLabel,
  valueScale,
  at,
  createdAt,
  size = "default",
}: PriceChartProps) {
  const hero = size === "hero";
  /** Every range on offer, with "everything" sized from how old this market is. */
  const ranges = useMemo(
    () => [...CHART_RANGES, allRangeFor(at - createdAt)],
    [at, createdAt],
  );

  // The server renders `DEFAULT_RANGE`, so that is what `initial` holds and what this
  // opens on. Nothing about the range travels on the wire: the series carries its bucket
  // width, and which span asked for it is a choice this component owns.
  const [rangeId, chooseRange] = useState(DEFAULT_RANGE.id);
  const range = ranges.find((entry) => entry.id === rangeId) ?? DEFAULT_RANGE;

  const [ready, setReady] = useState(false);
  /** What the crosshair is over, or null when the cursor is elsewhere. */
  const [hovered, setHovered] = useState<{ at: number; price: bigint } | null>(null);

  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const area = useRef<ISeriesApi<"Area"> | null>(null);

  /*
   * The axis formatter is handed to a chart that outlives every series it draws, so — as
   * with the crosshair below — it reads the current scale and the current multiplier
   * through refs rather than closing over whichever ones happened to be current when the
   * chart was created.
   */
  const scale = useRef<AxisScale>({ significant: 3, minMove: 1e-12 });
  const scaleValue = useRef<number | null>(valueScale);
  useEffect(() => {
    scaleValue.current = valueScale;
  }, [valueScale]);

  const labelPrice = useRef((value: number): string =>
    scaleValue.current === null
      ? formatPrice(asPrice(value), { significant: scale.current.significant, round: true })
      : formatUsdSignificant(value * scaleValue.current, scale.current.significant),
  ).current;

  // The server rendered one range and the rest are fetched. `initialData` is given only
  // for that one, so choosing another shows a load rather than the previous series
  // relabelled with a scale it was not drawn at.
  const { data, isPending, isError } = useQuery({
    queryKey: ["candles", poolId, range.id],
    queryFn: async (): Promise<SerializedSeries> => {
      const response = await fetch(
        `/api/markets/${poolId}/candles?interval=${range.interval}&limit=${range.buckets}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`the feed answered ${response.status}`);
      return (await response.json()) as SerializedSeries;
    },
    ...(range.id === DEFAULT_RANGE.id ? { initialData: initial } : {}),
    // Fast, and deliberately not derived from the bucket width. What a trade changes is
    // the close of the bucket already on screen, which happens on every swap whatever the
    // bucket is — see `POLL_MILLISECONDS`.
    refetchInterval: POLL_MILLISECONDS,
    // A market page is often left open in a background tab, and a chart that resumed
    // hours behind is worse than one that reloads when looked at.
    refetchOnWindowFocus: true,
  });

  const series = useMemo(() => (data === undefined ? null : parseSeries(data).candles), [data]);

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
   * The crosshair handler is registered once, on a chart that outlives every series it
   * draws, so it cannot close over `byTime` — it would read the map from the render it was
   * created in for as long as the page is open. A ref is the smallest fix that keeps a
   * single subscription.
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

    return {
      from: opened.start,
      to: closed.start,
      price: closed.close,
      low,
      high,
      trades,
      // Over the window shown, not over a day: the reader chose the window, and a figure
      // that ignored the choice would contradict the line above it.
      change: priceChangeBps(closed.close, opened.open),
    };
  }, [series]);

  const rising = summary === null || summary.change === null || summary.change >= 0;

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
          textColor: palette.inkFaint,
          fontFamily: getComputedStyle(element).fontFamily,
          attributionLogo: false,
        },
        // Horizontal only. Verticals across a translucent panel over a photograph read as
        // noise, but the horizontals are what let somebody put a point on the line against
        // a figure on the axis without tracking across the gap, which is most of what this
        // chart is read for.
        grid: {
          vertLines: { visible: false },
          horzLines: { color: palette.grid, style: LineStyle.Dashed },
        },
        rightPriceScale: {
          borderVisible: false,
          scaleMargins: { top: 0.15, bottom: 0.08 },
        },
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
            color: palette.border,
            width: 1,
            style: LineStyle.Solid,
            // The time is written into the readout above the chart instead, where it can
            // be typeset like the rest of the page.
            labelVisible: false,
          },
          horzLine: {
            color: palette.border,
            width: 1,
            style: LineStyle.Solid,
            labelBackgroundColor: palette.ink,
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
        priceFormat: {
          type: "custom",
          formatter: labelPrice,
          minMove: scale.current.minMove,
        },
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
     * smallest step the library should distinguish and it is expressed in the units of the
     * series, which are raw prices whatever the axis is labelled in. `significant` is how
     * many digits a *label* needs to differ from the one above it, and that has to be
     * judged on the figures actually printed — a dollar range of forty across four
     * thousand needs four digits, and asking the raw prices would have answered about a
     * range of 10^-11.
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
    // `valueScale` belongs here because the axis digits are derived from it: the dollar
    // rate is refetched while the page is open, and a scale computed against the old one
    // would label the gridlines at the wrong resolution until the next series arrived.
  }, [points, rising, ready, labelPrice, valueScale]);

  const shown = hovered?.price ?? summary?.price;

  /** A stored price in whatever unit the chart is currently drawing. */
  const label = (price: bigint): string =>
    valueScale === null
      ? formatPrice(price)
      : formatUsdSignificant(asFloat(price) * valueScale, scale.current.significant);

  return (
    // A column, so the canvas can take whatever the header and the footer leave. The chart
    // is created with `autoSize`, so it follows that height rather than needing to be told.
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={`flex shrink-0 flex-wrap items-end justify-between gap-4 ${
          hero ? "" : "px-5 pt-4"
        }`}
      >
        <div>
          {/* The headline. A market capitalisation where a dollar rate exists, and the
              price in the quote asset where one does not — the figure changes but the
              treatment does not, so the chart always has one number at its top left. */}
          <p
            className={`numeric leading-none text-ink ${
              hero
                ? "text-[2.5rem] tracking-[-0.03em] sm:text-[3.25rem]"
                : "text-[1.9rem] tracking-tight"
            }`}
          >
            {/* The one figure the page is built around, so it says when it moves. Not
                while the crosshair is driving it: that number changes with the pointer
                rather than with the market, and washing it green on every pixel of a
                drag would be motion that means nothing. */}
            <LiveValue
              quiet={hovered !== null}
              text={
                shown === undefined
                  ? "—"
                  : valueScale === null
                    ? `${formatPrice(shown)} ${quoteLabel}`
                    : formatUsdPrecise(asFloat(shown) * valueScale)
              }
              amount={shown === undefined ? null : asFloat(shown)}
            />
          </p>

          <p
            className={`flex items-center gap-2 ${hero ? "mt-3 text-[0.82rem]" : "mt-1.5 text-[0.75rem]"}`}
          >
            {summary?.change === undefined || summary.change === null ? null : (
              <span className={rising ? "text-rise" : "text-fall"}>
                {summary.change >= 0 ? "+" : "−"}
                {Math.abs(summary.change / 100).toFixed(2)}%
              </span>
            )}
            <span className="text-ink-faint">
              {hovered === null ? range.label : formatInstant(hovered.at)}
            </span>
          </p>
        </div>

        {/* Scrolls rather than wraps: a control that reflowed onto two rows would push the
            chart down as it did. */}
        <div className="-mx-1 max-w-full overflow-x-auto px-1 pb-1">
          <Segmented
            size="small"
            wrap={false}
            value={range.id}
            onChange={chooseRange}
            options={ranges.map((entry) => ({ value: entry.id, label: entry.label }))}
          />
        </div>
      </div>

      {/*
       * In a card, a floor plus a share of the slack: the row has a height set by the
       * tallest panel in it, and a chart allowed to collapse to nothing is worse than one
       * that makes the card a little taller.
       *
       * As a hero, a stated height instead, because there is no row to take one from. The
       * library measures this element when it builds the chart and autoscales the price
       * axis against what it finds; asked to do that inside a box whose height is still
       * indefinite — `flex-1` against an auto-height parent — it lays the axis out for a
       * box of no height and never revisits it, which shows up as a price scale with no
       * labels on it and the line pressed flat against the bottom edge.
       */}
      <div
        className={`relative ${hero ? "mt-6 h-[17rem] sm:h-[24rem]" : "mt-4 min-h-64 flex-1"}`}
      >
        <div ref={container} className="size-full" />

        {points.length === 0 ? (
          <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-[0.82rem] text-ink-muted">
            {isPending
              ? "Loading the price history."
              : isError
                ? "The price history is unavailable: the feed did not answer."
                : "Nothing has traded yet, so there is no price to draw."}
          </p>
        ) : null}
      </div>

      <div
        className={`flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border text-[0.72rem] text-ink-muted ${
          hero ? "mt-2 pt-3" : "px-5 py-3"
        }`}
      >
        <span>{summary === null ? "" : formatInstant(summary.from)}</span>
        <span className="numeric">
          {summary === null
            ? ""
            : `low ${label(summary.low)} · high ${label(summary.high)} · ${summary.trades} ${summary.trades === 1 ? "trade" : "trades"}`}
        </span>
        <span>{summary === null ? "" : formatInstant(summary.to)}</span>
      </div>
    </div>
  );
}
