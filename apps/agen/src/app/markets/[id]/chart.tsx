"use client";

import { useQuery } from "@tanstack/react-query";
import { candles as candleLib } from "@verdant/sdk";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  allRangeFor,
  asFloat,
  axisScaleFor,
  compactEth,
  formatInstant,
  parseSeries,
  seriesDelta,
  CHART_RANGES,
  DEFAULT_RANGE,
  POLL_MILLISECONDS,
  type AxisScale,
  type ChartPoint,
  type SerializedSeries,
} from "../../lib/candles";
import { marketCapUsd } from "../../lib/format";

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
  /**
   * The token's name and mark, rendered on the same row as the timeframe strip.
   *
   * Passed in rather than the range state being lifted out. The design puts the identity
   * and the timeframe on one line, and of the two ways to arrange that — this component
   * receiving a node it does not interpret, or the page owning `rangeId` and becoming a
   * client component to hold it — only this one leaves the page on the server.
   */
  readonly identity?: ReactNode;
  /** Rendered on the server, so the first paint has a line in it. Null when there is none. */
  readonly initial: SerializedSeries | null;
  /** Whether this deployment knows where the indexer is at all. */
  readonly feedConfigured: boolean;
  /**
   * Turns a price per token into the capitalisation the chart draws: the whole supply.
   * Null falls back to drawing the price itself.
   */
  readonly valueScale: number | null;
  /**
   * Dollars per ether, or null where no rate could be fetched.
   *
   * The market is quoted in ether and drawn in dollars, because a capitalisation exists
   * to be compared and almost nobody holds that comparison in ether. Null falls back to
   * the ether figure rather than to a stale rate, so a dollar sign on this axis always
   * means a rate was actually obtained.
   */
  readonly usdPerEth: number | null;
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
  identity,
  initial,
  feedConfigured,
  valueScale,
  usdPerEth,
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

  /**
   * What the series currently holds, and which series it is.
   *
   * The chart is polled every second, and almost every poll brings back the same buckets
   * with one number changed: the close of the bucket in progress. Handing all of that to
   * `setData` would be correct and would look wrong — it replaces the series wholesale, so
   * the marker under the crosshair blinks and any viewport work has to be redone. Keeping
   * the applied points here is what lets the common case become a single `update`.
   */
  const applied = useRef<{ key: string; points: readonly ChartPoint[] } | null>(null);

  /**
   * Whether the chart should keep framing the whole series, which stops the moment the
   * reader frames it themselves.
   *
   * A live chart wants to follow the data; a reader who has just zoomed into an hour wants
   * it to stay there. Those are only in conflict if following is unconditional, which is
   * what it was: `fitContent` ran on every poll, so a zoom lasted until the next second and
   * the chart was effectively impossible to examine. Following is the default because most
   * readers never touch it, and it yields to the first pan or zoom because that is an
   * unambiguous statement about which window they want.
   */
  const following = useRef(true);

  /*
   * The axis formatter is handed to a chart that outlives every series it draws, so it
   * reads the current scale and multiplier through refs rather than closing over whichever
   * ones were current when the chart was created.
   */
  const scale = useRef<AxisScale>({ significant: 3, minMove: 1e-12 });
  const scaleValue = useRef<number | null>(valueScale);
  const rate = useRef<number | null>(usdPerEth);
  useEffect(() => {
    scaleValue.current = valueScale;
    rate.current = usdPerEth;
  }, [valueScale, usdPerEth]);

  /**
   * A raw series value, as the reader should see it.
   *
   * Two conversions in one place: a price per token becomes a capitalisation, and a
   * capitalisation in ether becomes one in dollars. Written unsuffixed because it labels
   * an axis, where `$14.7k` says which unit it is in and ` ETH` on every gridline does
   * not earn its ink — the headline below carries the unit for the ether case.
   */
  const write = useRef((value: number): string => {
    const inEth = scaleValue.current === null ? value : value * scaleValue.current;
    return marketCapUsd(inEth, rate.current) ?? compactEth(inEth);
  }).current;

  const labelPrice = write;

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

    /*
     * A pan or a zoom, told apart from a click.
     *
     * The library's own range subscription cannot be used for this: it fires for our
     * `fitContent` too, so following would switch itself off on the first poll. Watching
     * the input instead is unambiguous — a wheel is always a zoom, and a drag is a pan
     * once it has actually moved. The threshold is what keeps a click, which is how the
     * crosshair is read, from being mistaken for one.
     */
    const stopFollowing = (): void => {
      following.current = false;
    };

    let from: { x: number; y: number } | null = null;

    const onDown = (event: PointerEvent): void => {
      from = { x: event.clientX, y: event.clientY };
    };
    const onMove = (event: PointerEvent): void => {
      if (from === null) return;
      if (Math.abs(event.clientX - from.x) > 3 || Math.abs(event.clientY - from.y) > 3) {
        stopFollowing();
        from = null;
      }
    };
    const onUp = (): void => {
      from = null;
    };

    element.addEventListener("wheel", stopFollowing, { passive: true });
    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onUp);

    return () => {
      disposed = true;
      element.removeEventListener("wheel", stopFollowing);
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onUp);
      chart.current?.remove();
      chart.current = null;
      area.current = null;
      applied.current = null;
      setReady(false);
    };
    // `labelPrice` is held in a ref and never changes, so this still builds one chart for
    // the life of the component. It is listed because it is used, not because it varies.
  }, [labelPrice]);

  /*
   * A new timeframe is a new question, so the chart frames the answer to it.
   *
   * Declared before the effect that applies data, and that is load-bearing rather than
   * stylistic: effects run in declaration order, so putting it after would mean the first
   * render of a new timeframe tried to restore the window a reader had framed on the
   * previous one — onto a series whose times may not overlap it at all.
   */
  useEffect(() => {
    following.current = true;
  }, [marketId, range.id]);

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
    const capped = valueScale === null ? raw : raw.map((value) => value * valueScale);
    const shownValues = usdPerEth === null ? capped : capped.map((value) => value * usdPerEth);
    scale.current = {
      significant: axisScaleFor(shownValues).significant,
      minMove: axisScaleFor(raw).minMove,
    };

    line.applyOptions({
      lineColor: rising ? palette.rise : palette.fall,
      topColor: rising ? palette.riseSoft : palette.fallSoft,
      priceFormat: { type: "custom", formatter: labelPrice, minMove: scale.current.minMove },
    });

    /*
     * A tail, or a redraw. `seriesDelta` decides and is tested on its own; the timeframe is
     * folded in here because a different one is a different series whatever its points say.
     */
    const key = `${marketId}:${range.id}`;
    const was = applied.current;
    const delta = was === null || was.key !== key ? { kind: "redraw" as const } : seriesDelta(was.points, points);

    if (delta.kind === "tail") {
      for (const point of points.slice(delta.from)) line.update(point);
    } else {
      // A reader who has framed their own window keeps it across the shift, which is the
      // whole point of not refitting: restoring the times rather than the logical indices,
      // because the indices have moved under them.
      const held = following.current ? null : (chart.current?.timeScale().getVisibleRange() ?? null);

      line.setData(points);

      if (held === null) chart.current?.timeScale().fitContent();
      else {
        try {
          chart.current?.timeScale().setVisibleRange(held);
        } catch {
          // A window that no longer overlaps the data cannot be restored. Framing what
          // there is beats leaving the reader looking at nothing.
          chart.current?.timeScale().fitContent();
        }
      }
    }

    applied.current = { key, points };
  }, [points, rising, ready, labelPrice, valueScale, usdPerEth, marketId, range.id]);

  const shown = hovered?.price ?? summary?.price;

  // The headline carries the unit where the axis cannot: `14.7 ETH` needs saying, and
  // `$14.7k` already says it.
  const headline =
    shown === undefined
      ? fallbackHeadline
      : usdPerEth === null
        ? `${write(asFloat(shown))} ETH`
        : write(asFloat(shown));

  /*
   * Whether the headline is a number at all.
   *
   * Tested on the rendered string rather than on `shown`, because the fallback is
   * sometimes a real figure — a launched market with no indexer history still knows its
   * market cap — and sometimes a phrase for a market that has none. A headline with no
   * digit in it is not a figure, and is set smaller: an em dash at headline size is a
   * heavy black bar that reads as a divider rather than as a missing number.
   */
  const hasFigure = /[0-9]/.test(headline);

  /** A stored price in whatever unit the chart is currently drawing. */
  const label = (price: bigint): string => write(asFloat(price));

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
    <section>
      <header className="ax-tk-top">
        {identity}

        <div className="ax-tk-ranges" role="tablist" aria-label="timeframe">
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

      <div className="ax-tk-cap">
        <span>{valueScale === null ? "Price" : "Market cap"}</span>

        <strong className={hasFigure ? undefined : "absent"}>{headline}</strong>

        <div className="ax-tk-move">
          {summary?.change == null ? null : (
            <span className={rising ? "up" : "down"}>
              {summary.change >= 0 ? "+" : "−"}
              {Math.abs(summary.change).toFixed(2)}%
            </span>
          )}
          <span>{hovered === null ? range.label : formatInstant(hovered.at)}</span>
          {summary === null || summary.trades === 0 ? null : (
            <span>
              low {label(summary.low)} · high {label(summary.high)} · {String(summary.trades)}{" "}
              {summary.trades === 1 ? "trade" : "trades"}
            </span>
          )}
        </div>
      </div>

      <div className="ax-tk-plot">
        <div ref={container} className="ax-tk-canvas" />

        {points.length === 0 ? <p className="ax-tk-empty">{empty}</p> : null}
      </div>
    </section>
  );
}
