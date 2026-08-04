"use client";

import { formatAge, formatAmount, formatCompact, formatFeeRate } from "@verdant/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { SerializedHistory } from "../lib/trades";
import { Pagination } from "./pagination";
import { AddressLink, TransactionLink } from "./primitives";

/**
 * What has traded, kept current.
 *
 * A client component because trades arrive while somebody is reading. The page renders
 * the first set on the server — so the table is populated in the HTML, and a reader who
 * never runs the poll still sees history — and this asks for a newer set every few
 * seconds. Own trades already refresh the whole page through the trade panel; this is for
 * everybody else's.
 *
 * The rate on each row is what the pool reported charging *that* trade, not the rate in
 * force now. A market on a fee ladder has history at several rates, and showing today's
 * against an old trade would misreport what it cost.
 *
 * ## Polling stops when you page back
 *
 * Only the first page refreshes. Deeper pages are addressed by offset, so a trade
 * arriving while somebody reads page four pushes every row down one and the line they
 * were looking at moves to a page they are not on. The first page is the only one where
 * new rows belong at the top, so it is the only one that takes them.
 */

/** Often enough to feel live on a chain with sub-second blocks, rarely enough to be free. */
const POLL_MILLISECONDS = 5_000;

/** Must match `ROWS` in the route this polls, which is what decides a page. */
const ROWS = 30;

export function TradeHistoryTable({
  poolId,
  initial,
  quoteSymbol,
  quoteDecimals,
  tokenSymbol,
}: {
  readonly poolId: string;
  readonly initial: SerializedHistory;
  readonly quoteSymbol: string;
  readonly quoteDecimals: number;
  readonly tokenSymbol: string;
}) {
  const [page, setPage] = useState(0);

  const { data } = useQuery({
    queryKey: ["swaps", poolId, page],
    queryFn: async (): Promise<SerializedHistory> => {
      const response = await fetch(`/api/markets/${poolId}/swaps?offset=${page * ROWS}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`the feed answered ${response.status}`);
      return (await response.json()) as SerializedHistory;
    },
    // The server's rows are the first page's rows; any other page has to be fetched.
    initialData: page === 0 ? initial : undefined,
    refetchInterval: page === 0 ? POLL_MILLISECONDS : false,
    // A failed poll keeps the rows already on screen. They were true when they arrived,
    // and an empty table would claim the market had no history.
    placeholderData: (previous) => previous,
  });

  const history = data ?? initial;

  if (history.swaps.length === 0) {
    return <p className="px-6 py-8 text-[0.85rem] text-ink-muted">Nothing has traded yet.</p>;
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-[0.85rem]">
          <thead>
            {/* The header row is a well. Against a translucent card a rule under it is the
                same hairline as every other border, so the band is what separates it. */}
            <tr className="border-b border-border bg-surface-sunken text-[0.7rem] uppercase tracking-wider text-ink-muted">
              <th className="px-6 py-2.5 text-left font-medium">Side</th>
              <th className="px-4 py-2.5 text-right font-medium">{quoteSymbol}</th>
              <th className="px-4 py-2.5 text-right font-medium">{tokenSymbol}</th>
              <th className="hidden px-4 py-2.5 text-right font-medium md:table-cell">Fee paid</th>
              <th className="hidden px-4 py-2.5 text-left font-medium lg:table-cell">By</th>
              <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">When</th>
              <th className="hidden px-6 py-2.5 text-right font-medium sm:table-cell">Tx</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {history.swaps.map((swap) => (
              <tr key={swap.id} className="transition-colors hover:bg-surface-sunken">
                {/* A recessed chip with a coloured edge and a coloured word, rather than a
                    coloured wash with a coloured word on it: on dark, a wash lifts the
                    surface towards the label instead of away from it. */}
                <td className="px-6 py-2.5">
                  <span
                    className={`inline-flex rounded-full border bg-surface-sunken px-2 py-0.5 text-[0.7rem] font-medium ${
                      swap.buy ? "border-accent/35 text-rise" : "border-fall/35 text-fall"
                    }`}
                  >
                    {swap.buy ? "buy" : "sell"}
                  </span>
                </td>
                <td className="numeric px-4 py-2.5 text-right text-ink">
                  {formatAmount(BigInt(swap.quoteAmount), { decimals: quoteDecimals, places: 4 })}
                </td>
                <td className="numeric px-4 py-2.5 text-right text-ink-muted">
                  {formatCompact(BigInt(swap.tokenAmount))}
                </td>
                <td className="numeric hidden px-4 py-2.5 text-right text-ink-muted md:table-cell">
                  {formatFeeRate(swap.feePpm)}
                </td>
                {/* The caller, which on a routed swap is the router rather than the
                    trader. Labelled "by" rather than "trader" for that reason. */}
                <td className="hidden px-4 py-2.5 text-left lg:table-cell">
                  <AddressLink address={swap.sender} />
                </td>
                <td className="hidden px-4 py-2.5 text-right text-ink-muted sm:table-cell">
                  {formatAge(swap.timestamp, history.at)}
                </td>
                <td className="hidden px-6 py-2.5 text-right sm:table-cell">
                  <TransactionLink hash={swap.transactionHash} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        pageCount={Math.ceil(history.total / ROWS)}
        onChange={setPage}
      />
    </div>
  );
}
