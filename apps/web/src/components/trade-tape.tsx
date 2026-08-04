"use client";

import { formatAge, formatAmount, formatCompact } from "@verdant/ui";
import { useQuery } from "@tanstack/react-query";

import type { SerializedHistory } from "../lib/trades";
import { formatUsd, usdValueOf } from "../lib/usd";
import { AddressLink } from "./primitives";

/**
 * The tape: trades as they land, in a column narrow enough to sit beside the chart.
 *
 * The same rows as the trades table and not the same component, because the two answer
 * different questions. The table is for going through a market's history — it pages,
 * it has a column for the fee each trade paid, and it is read deliberately. This is for
 * watching one: no paging, no header, the newest handful, and each row cut down to the
 * three things worth catching out of the corner of an eye. Making one component do both
 * would mean a dozen props whose only job is to switch between the two.
 */

/** The same cadence as the table below it, so the two never visibly disagree. */
const POLL_MILLISECONDS = 5_000;

/**
 * How far back the tape goes.
 *
 * More than fits, deliberately: the rail is a fixed height set by the card beside it, and
 * it scrolls, so the list should be long enough that there is something under the fold
 * rather than ending halfway down an empty column. Still short of the thirty the poll
 * returns — past twenty rows this stops being a tape and becomes the trades table, which
 * is a tab away and pages properly.
 */
const SHOWN = 20;

export function TradeTape({
  poolId,
  initial,
  quote,
  tokenSymbol,
  usdPerEth,
}: {
  readonly poolId: string;
  readonly initial: SerializedHistory;
  readonly quote: { readonly symbol: string; readonly decimals: number; readonly isNative: boolean };
  readonly tokenSymbol: string;
  readonly usdPerEth: number | null;
}) {
  const { data } = useQuery({
    queryKey: ["swaps", poolId, 0],
    queryFn: async (): Promise<SerializedHistory> => {
      const response = await fetch(`/api/markets/${poolId}/swaps?offset=0`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`the feed answered ${response.status}`);
      return (await response.json()) as SerializedHistory;
    },
    initialData: initial,
    refetchInterval: POLL_MILLISECONDS,
    placeholderData: (previous) => previous,
  });

  const rows = data.swaps.slice(0, SHOWN);

  if (rows.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-[0.8rem] text-ink-muted">
        No trades yet. The first one will appear here.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {rows.map((swap) => {
        const paid = usdValueOf(BigInt(swap.quoteAmount), quote, usdPerEth);

        return (
          <li key={swap.id} className="flex items-center gap-2.5 py-2">
            <Arrow buy={swap.buy} />

            <div className="min-w-0 flex-1">
              <p className="numeric truncate text-[0.78rem] text-ink">
                {formatCompact(BigInt(swap.tokenAmount))}{" "}
                <span className="text-ink-muted">{tokenSymbol}</span>
              </p>
              <p className="truncate text-[0.68rem]">
                <AddressLink address={swap.sender} />
              </p>
            </div>

            <div className="shrink-0 text-right">
              <p className="numeric text-[0.78rem] text-ink">
                {formatAmount(BigInt(swap.quoteAmount), {
                  decimals: quote.decimals,
                  places: 4,
                })}
              </p>
              {/* Dollars underneath where there is a rate, because the quote amount on an
                  ether-quoted market is four leading zeros and a digit. */}
              <p className="numeric text-[0.68rem] text-ink-faint">
                {paid === null ? quote.symbol : formatUsd(paid)}
              </p>
            </div>

            {/* No fixed width: `formatAge` runs from "4s ago" to "1h 57m ago", and a
                column sized for the short one truncates most of the long one. */}
            <span className="numeric shrink-0 whitespace-nowrap text-right text-[0.68rem] text-ink-faint">
              {formatAge(swap.timestamp, data.at)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Up and to the right for a buy, down and to the left for a sell. */
function Arrow({ buy }: { readonly buy: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-5 shrink-0 place-items-center ${buy ? "text-rise" : "text-fall"}`}
    >
      <svg
        viewBox="0 0 16 16"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {buy ? (
          <>
            <path d="M4.5 11.5 11.5 4.5" />
            <path d="M6 4.5h5.5V10" />
          </>
        ) : (
          <>
            <path d="M11.5 4.5 4.5 11.5" />
            <path d="M10 11.5H4.5V6" />
          </>
        )}
      </svg>
    </span>
  );
}
