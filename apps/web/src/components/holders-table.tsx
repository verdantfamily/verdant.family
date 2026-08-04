"use client";

import { formatAmount, formatCompact } from "@verdant/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { SerializedHolders } from "../lib/trades";
import { Pagination } from "./pagination";
import { AddressLink } from "./primitives";

/**
 * Who holds the token, largest first.
 *
 * ## What an address on this list is, and is not
 *
 * Balances are built from the transfer log, so this is every address the token has
 * reached rather than a list of people. A router holding tokens mid-trade is on it. So is
 * the splitter, sitting on fees nobody has claimed, and a vesting contract holding a
 * creator's allocation until it unlocks. Labelling those would mean this table deciding
 * which addresses are real holders, and the honest version of that judgement is the
 * address itself — which is why every row links to the explorer.
 *
 * The share is of total supply, which for a Verdant token is a constant: there is no mint
 * and no burn, so a percentage here does not move because the denominator did.
 */

/** Holders move on trades, not on blocks. Slower than the trade table, by a lot. */
const POLL_MILLISECONDS = 30_000;

/** Must match `ROWS` in the route this polls, which is what decides a page. */
const ROWS = 25;

export function HoldersTable({
  poolId,
  initial,
  tokenSymbol,
}: {
  readonly poolId: string;
  readonly initial: SerializedHolders;
  readonly tokenSymbol: string;
}) {
  const [page, setPage] = useState(0);

  const { data } = useQuery({
    queryKey: ["holders", poolId, page],
    queryFn: async (): Promise<SerializedHolders> => {
      const response = await fetch(`/api/markets/${poolId}/holders?offset=${page * ROWS}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`the feed answered ${response.status}`);
      return (await response.json()) as SerializedHolders;
    },
    initialData: page === 0 ? initial : undefined,
    refetchInterval: POLL_MILLISECONDS,
    placeholderData: (previous) => previous,
  });

  const list = data ?? initial;
  const supply = BigInt(list.totalSupply);

  if (list.holders.length === 0) {
    return <p className="px-6 py-8 text-[0.85rem] text-ink-muted">Nobody holds this yet.</p>;
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-[0.85rem]">
          <thead>
            <tr className="border-b border-border bg-surface-sunken text-[0.7rem] uppercase tracking-wider text-ink-muted">
              <th className="px-6 py-2.5 text-left font-medium">#</th>
              <th className="px-4 py-2.5 text-left font-medium">Address</th>
              <th className="px-4 py-2.5 text-right font-medium">{tokenSymbol}</th>
              <th className="px-6 py-2.5 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.holders.map((entry, index) => (
              <tr key={entry.address} className="transition-colors hover:bg-surface-sunken">
                <td className="numeric px-6 py-2.5 text-left text-ink-faint">
                  {list.offset + index + 1}
                </td>
                <td className="px-4 py-2.5 text-left">
                  <AddressLink address={entry.address} copyable />
                </td>
                <td className="numeric px-4 py-2.5 text-right text-ink">
                  {formatCompact(BigInt(entry.balance))}
                </td>
                <td className="numeric px-6 py-2.5 text-right text-ink-muted">
                  {shareOfSupply(BigInt(entry.balance), supply)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} pageCount={Math.ceil(list.total / ROWS)} onChange={setPage} />
    </div>
  );
}

/**
 * A balance as a percentage of supply.
 *
 * Scaled up before the division rather than after, so the arithmetic stays in integers
 * the whole way — the balances involved are past what a float holds exactly, and a holder
 * with 0.01% should not be rendered as holding nothing. Reuses `formatAmount`'s
 * truncation, which is the right direction here too: a share shown larger than it is
 * would be the more misleading error on a table people read for concentration.
 */
function shareOfSupply(balance: bigint, supply: bigint): string {
  if (supply <= 0n) return "—";
  const scaled = (balance * 100n * 10n ** 18n) / supply;
  if (scaled === 0n) return "0%";
  // Below a hundredth of a percent, two places would render every dust holder as 0.00%.
  return `${formatAmount(scaled, { places: scaled < 10n ** 16n ? 4 : 2 })}%`;
}
