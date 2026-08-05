"use client";

import { useQuery } from "@tanstack/react-query";
import {
  formatCompact,
  formatFeeRate,
  formatPrice,
  lockedValueInQuote,
} from "@verdant/ui";
import type { ReactNode } from "react";

import { asFloat } from "../lib/candles";
import type { SerializedLive } from "../lib/live";
import { formatQuoteAmount, type QuoteDisplay } from "../lib/quote";
import { formatUsd, usdValueOf } from "../lib/usd";
import { Countdown } from "./countdown";
import { LiveValue } from "./live-value";

/**
 * The band of figures under the chart, kept current.
 *
 * These were server-rendered and then frozen: `revalidate` refreshes the HTML the next
 * visitor is handed, not the tab already open, so a reader watching a market trade saw
 * the volume, the holder count and the all-time high never move. Everything here is now
 * polled from `/api/markets/[id]/live` and seeded with what the server already rendered,
 * so the first paint has real figures rather than a row of dashes.
 *
 * The arithmetic is deliberately the same functions the page used on the server —
 * `impliedValueInQuote`, `lockedValueInQuote`, `usdValueOf` — run against `bigint`
 * rebuilt from the wire. Recomputing here rather than having the route send finished
 * strings is what stops the figures from drifting away from the ones the server drew a
 * second earlier.
 */

/**
 * How often the band asks.
 *
 * A second. Robinhood Chain produces a block roughly every hundred milliseconds, so this
 * is already far slower than the chain and is bounded by what is polite to the indexer
 * rather than by what would look live — one request per open tab per second, for a
 * payload of a dozen numbers. The chart polls on its own timer at the same cadence.
 */
const POLL_MILLISECONDS = 1_000;

export interface LiveFiguresProps {
  readonly poolId: string;
  /** What the server already rendered, so the band opens with figures rather than dashes. */
  readonly initial: SerializedLive;
  readonly quote: QuoteDisplay;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  /** The fee after the next transition, for the countdown's hint. Fixed at creation. */
  readonly nextFeePpm: number | null;
}

export function LiveFigures({
  poolId,
  initial,
  quote,
  tokenSymbol,
  tokenDecimals,
  nextFeePpm,
}: LiveFiguresProps) {
  const { data } = useQuery({
    queryKey: ["live", poolId],
    queryFn: async (): Promise<SerializedLive> => {
      const response = await fetch(`/api/markets/${poolId}/live`, { cache: "no-store" });
      if (!response.ok) throw new Error(`the feed answered ${response.status}`);
      return (await response.json()) as SerializedLive;
    },
    initialData: initial,
    refetchInterval: POLL_MILLISECONDS,
    // A failed poll keeps the figures already on screen. They were true when they
    // arrived, and a row of dashes would claim the market had no depth.
    placeholderData: (previous) => previous,
    refetchOnWindowFocus: true,
  });

  const live = data;

  const sqrtPriceX96 = BigInt(live.sqrtPriceX96);
  const totalSupply = BigInt(live.totalSupply);

  const liquidityValue = lockedValueInQuote(
    BigInt(live.liquidity),
    sqrtPriceX96,
    BigInt(live.initialSqrtPriceX96),
  );

  const liquidityUsd = usdValueOf(liquidityValue, quote, live.usdPerEth);
  const dayVolume = live.stats === null ? null : BigInt(live.stats.dayVolumeQuote);
  const dayVolumeUsd =
    dayVolume === null ? null : usdValueOf(dayVolume, quote, live.usdPerEth);

  /* The same multiplier the chart draws through: whole tokens times the dollar rate, so
     the all-time high here and the line above it are the same measurement. */
  const wholeSupply = Number(totalSupply) / 10 ** tokenDecimals;
  const valueScale =
    live.usdPerEth === null || !quote.isNative ? null : wholeSupply * live.usdPerEth;

  const allTimeHigh = live.stats === null ? null : BigInt(live.stats.allTimeHigh);
  const athUsd =
    allTimeHigh === null || valueScale === null ? null : asFloat(allTimeHigh) * valueScale;

  /** A quote-asset amount as dollars where possible, and as that asset otherwise. */
  const money = (usd: number | null, native: bigint): string =>
    usd === null ? formatQuoteAmount(native, quote, 3) : formatUsd(usd);

  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-7 border-y border-border py-7 sm:grid-cols-3 lg:grid-cols-6">
      <Metric
        label="Liquidity"
        value={money(liquidityUsd, liquidityValue)}
        amount={liquidityUsd ?? Number(liquidityValue)}
      />

      <Metric
        label="24h volume"
        value={dayVolume === null ? "—" : money(dayVolumeUsd, dayVolume)}
        amount={dayVolumeUsd ?? (dayVolume === null ? null : Number(dayVolume))}
        hint={live.stats === null ? undefined : `${live.stats.dayTrades} trades`}
      />

      <Metric
        label="All-time high"
        value={
          allTimeHigh === null
            ? "—"
            : athUsd === null
              ? `${formatPrice(allTimeHigh)} ${quote.symbol}`
              : formatUsd(athUsd)
        }
        amount={athUsd ?? (allTimeHigh === null ? null : asFloat(allTimeHigh))}
      />

      <Metric
        label="Holders"
        value={live.stats === null ? "—" : live.stats.holders.toLocaleString("en-US")}
        amount={live.stats?.holders ?? null}
      />

      <Metric
        label="Fee"
        tone="accent"
        value={formatFeeRate(live.fee.ppm)}
        amount={live.fee.ppm}
        hint={
          live.fee.nextTransitionAt === null ? (
            live.fee.stageCount === 1 ? (
              "never changes"
            ) : (
              "final stage"
            )
          ) : (
            <>
              {formatFeeRate(nextFeePpm ?? live.fee.ppm)} in{" "}
              <Countdown anchorAt={live.fee.at} targetAt={live.fee.nextTransitionAt} />
            </>
          )
        }
      />

      {/* No `amount`, and nothing to flash: a Verdant token has no mint and no burn, so
          this figure is the same one it was at creation and will be at the end. */}
      <Metric
        label="Supply"
        value={`${formatCompact(totalSupply)} ${tokenSymbol}`}
        amount={null}
        hint="no mint, no burn"
      />
    </dl>
  );
}

/**
 * One figure in the band.
 *
 * No border, no box, no fill. A row of six of these is separated by the space around them
 * and by one hairline above and below the band, which is the whole visual budget the band
 * gets — six bordered cells would be six more rectangles on a page whose point is that it
 * has very few. The label sits above the value in small caps so the row can be scanned
 * down the numbers rather than read across the words.
 */
function Metric({
  label,
  value,
  amount,
  hint,
  tone = "default",
}: {
  readonly label: string;
  readonly value: string;
  readonly amount: number | null;
  readonly hint?: ReactNode;
  readonly tone?: "default" | "accent";
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.66rem] font-medium uppercase tracking-[0.09em] text-ink-muted">
        {label}
      </dt>
      <dd
        className={`numeric mt-2 truncate text-[1.15rem] leading-none ${
          tone === "accent" ? "text-accent" : "text-ink"
        }`}
      >
        <LiveValue text={value} amount={amount} />
      </dd>
      {hint === undefined ? null : (
        <dd className="mt-1.5 truncate text-[0.7rem] text-ink-faint">{hint}</dd>
      )}
    </div>
  );
}
