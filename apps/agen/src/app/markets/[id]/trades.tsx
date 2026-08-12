"use client";

import { useState } from "react";

import type { EnrichedTrade } from "../../lib/markets";
import { age, feeRate, usd } from "../../lib/format";

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
  trades,
  now,
}: {
  readonly trades: readonly EnrichedTrade[];
  readonly now: number;
}) {
  const [tab, setTab] = useState<Tab>("trades");

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
    <section className="activity">
      <div className="activity-head">
        <h2 className="section-title">Activity</h2>

        <div className="activity-tabs" role="tablist" aria-label="activity">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "trades"}
            className={tab === "trades" ? "on" : ""}
            onClick={() => {
              setTab("trades");
            }}
          >
            Trades
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
      </div>

      {tab === "trades" ? (
        trades.length === 0 ? (
          <p className="activity-empty">
            No trades yet. Every trade will appear here with the fee it paid and the rules
            it triggered.
          </p>
        ) : (
          <div className="trade-table">
            <div className="trade-row trade-headings" aria-hidden="true">
              <span>side</span>
              <span>amount</span>
              <span>tokens</span>
              <span>fee</span>
              <span>trader</span>
              <span>age</span>
            </div>

            {trades.map((trade) => (
              <div className={`trade-row trade-${trade.side}`} key={trade.id}>
                <span className="trade-side">{trade.side}</span>
                <span>{usd(trade.amountUsd)}</span>
                <span className="dim">—</span>
                <span className="dim">{feeRate(trade.feePpm)}</span>
                <span className="mono dim">{short(trade.trader)}</span>
                <span className="dim">{age(trade.at, now)}</span>
              </div>
            ))}
          </div>
        )
      ) : events.length === 0 ? (
        <p className="activity-empty">
          No events yet. When this token&apos;s rules fire — a round completing, a reward
          paid, a fee changing — each one is recorded here.
        </p>
      ) : (
        <ul className="event-list">
          {events.map((event) => (
            <li key={event.key}>
              <span className="event-label">{event.label}</span>
              {event.amountUsd === undefined ? null : (
                <span className="event-amount">{usd(event.amountUsd)}</span>
              )}
              <span className="event-age">{age(event.at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
