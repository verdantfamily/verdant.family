"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { POLL_MILLISECONDS } from "../../lib/candles";
import type { EnrichedTrade } from "../../lib/markets";
import { DASH, age, eth, feeRate, tokens, usd } from "../../lib/format";

/**
 * Activity: what traded, and what the token's own rules did about it.
 *
 * Two tabs, because Agen has a second feed no other launchpad has. A swap list is a
 * solved problem and says nothing about this product; the interesting line is not
 * "0x12…43 sold $1,200" but the rule that fired underneath it — the extra fee, the
 * counter that advanced, the reward that got paid. Those are the token's mechanics
 * visible while they operate, which is the only way a trader ever sees a rule working
 * rather than reading that it exists.
 *
 * Both tabs are empty today and empty rather than sampled. A plausible fake trade on a
 * token page is indistinguishable from a real one, and the first person to screenshot it
 * would be quoting a transaction that never happened.
 *
 * Events are derived from trades rather than fetched separately: an effect a rule
 * produced is already attached to the trade that produced it, so the second tab is a
 * different reading of the same real data, not a second source that could disagree.
 */
type Tab = "trades" | "events";

function short(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function Trades({
  marketId,
  trades: initial,
  now,
  live,
}: {
  /** How this app's routes address the market, for the poll below. */
  readonly marketId: string;
  readonly trades: readonly EnrichedTrade[];
  readonly now: number;
  /** Nothing to poll for a market with no pool. */
  readonly live: boolean;
}) {
  const [tab, setTab] = useState<Tab>("trades");

  /*
   * Refetched beside the chart, at the same interval and for the same reason.
   *
   * The list used to be whatever the server had when the page was served, so a market could
   * take twenty swaps while somebody watched it and the history under the chart would not
   * move. A live chart above a frozen list is worse than two static things: it invites the
   * reader to believe the list is current.
   *
   * Seeded with the server's own render, so the first paint has real rows in it and the poll
   * only ever replaces them with newer ones.
   */
  const { data } = useQuery({
    queryKey: ["agen-trades", marketId],
    queryFn: async (): Promise<readonly EnrichedTrade[]> => {
      const response = await fetch(`/api/markets/${marketId}/trades`, { cache: "no-store" });
      if (!response.ok) throw new Error(`the feed answered ${String(response.status)}`);
      return ((await response.json()) as { trades: readonly EnrichedTrade[] }).trades;
    },
    initialData: initial,
    refetchInterval: POLL_MILLISECONDS,
    refetchOnWindowFocus: true,
    enabled: live,
  });

  const trades = data;

  const events = trades.flatMap((trade) =>
    trade.effects.map((effect, at) => ({
      key: `${trade.id}-${String(at)}`,
      at: trade.at,
      label: effect.label,
      ruleId: effect.ruleId,
      amountUsd: effect.amountUsd,
    })),
  );

  return (
    <section className="ax-tk-below">
      <div className="ax-tk-tabs" role="tablist" aria-label="activity">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "trades"}
          className={tab === "trades" ? "on" : ""}
          onClick={() => {
            setTab("trades");
          }}
        >
          Recent trades
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "events"}
          className={tab === "events" ? "on" : ""}
          onClick={() => {
            setTab("events");
          }}
        >
          Token events
        </button>
      </div>

      {tab === "trades" ? (
        trades.length === 0 ? (
          <p className="ax-tk-none">
            No trades yet. Every trade will appear here with the fee it paid and the rules
            it triggered.
          </p>
        ) : (
          <div className="ax-tk-rows">
            <div className="ax-tk-tr ax-tk-tr-head" aria-hidden="true">
              <span>side</span>
              <span>amount</span>
              <span>tokens</span>
              <span>fee</span>
              <span>trader</span>
              <span>age</span>
            </div>

            {/*
              Two denominations, because the two products report in different units.
              
              A programmable trade carries `amountUsd` and always has; an Instant trade
              carries the ether it actually moved, and putting that through a dollar
              formatter would print a `$` in front of a quantity of ETH. The fee column
              works the same way: v4 reports zero for an Instant swap because the hook
              overrides the LP fee and charges the ether leg instead, so the real 1.50%
              is stated once beneath the table rather than faked per row.
            */}
            {trades.map((trade) => (
              <div className="ax-tk-tr" key={trade.id}>
                <span className={trade.side}>{trade.side}</span>
                <span>
                  {trade.amountEth === undefined
                    ? usd(trade.amountUsd)
                    : `${eth(trade.amountEth)} ETH`}
                </span>
                <span className="dim">{trade.tokens === undefined ? "—" : tokens(trade.tokens)}</span>
                <span className="dim">{trade.amountEth === undefined ? feeRate(trade.feePpm) : DASH}</span>
                <span className="dim">{short(trade.trader)}</span>
                <span className="dim">{age(trade.at, now)}</span>
              </div>
            ))}
          </div>
        )
      ) : events.length === 0 ? (
        <p className="ax-tk-none">
          No events yet. When this token&apos;s rules fire — a round completing, a reward
          paid, a fee changing — each one is recorded here.
        </p>
      ) : (
        <div className="ax-tk-rows">
          {events.map((event) => (
            <div className="ax-tk-tr" key={event.key}>
              <span>{event.label}</span>
              {event.amountUsd === undefined ? null : <span>{usd(event.amountUsd)}</span>}
              <span className="dim">{age(event.at, now)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
